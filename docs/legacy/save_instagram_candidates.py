import json
import os
from datetime import datetime, timezone

import psycopg
import requests
from dotenv import load_dotenv

load_dotenv('/home/hermeswebui/.hermes/.env')

DB_URL = os.environ['HERMES_POSTGRES_URL']
SCRAPE = {'x-api-key': os.environ['SCRAPECREATORS_API_KEY']}
SOCIAL = {'x-api-key': os.environ['SOCIALCRAWL_API_KEY']}

SEARCH_QUERIES = ['wildberries style', 'fashion moscow']
PROFILE_PATTERNS = ['fashion','style','outfit','look','ugc','creator','мода','стиль','женствен','образы','находки','обзоры покупок','распаков','wildberries','wb','стилист']
CAPTION_PATTERNS = ['жакет','плать','юбк','футболк','костюм','обув','сумк','трикотаж','ткан','качеств','посадк','размер','цвет','образ','примерк','wildberries','wb','где купить','с чем носить','стильн']


def has_any(text: str, patterns: list[str]) -> bool:
    t = (text or '').lower()
    return any(p in t for p in patterns)


def fetch_top5() -> list[dict]:
    out = []
    seen = set()
    for query in SEARCH_QUERIES:
        r = requests.get(
            'https://api.scrapecreators.com/v1/instagram/search/profiles',
            params={'query': query},
            headers=SCRAPE,
            timeout=120,
        )
        r.raise_for_status()
        for p in r.json().get('profiles', []):
            username = (p.get('username') or '').strip()
            key = username.lower()
            if not key or key in seen:
                continue
            seen.add(key)
            out.append({
                'search_query': query,
                'username': username,
                'full_name': p.get('full_name') or '',
                'followers_search': p.get('follower_count'),
                'bio': p.get('biography') or '',
                'matched_from': p.get('matched_from') or '',
                'url': p.get('url') or (f'https://www.instagram.com/{username}/' if username else ''),
            })
            if len(out) >= 5:
                return out
    return out


def enrich(candidate: dict) -> dict:
    username = candidate['username']
    prof = requests.get(
        'https://www.socialcrawl.dev/v1/instagram/profile',
        params={'username': username},
        headers=SOCIAL,
        timeout=120,
    )
    prof_body = prof.json() if 'application/json' in prof.headers.get('content-type', '') else {}
    author = ((prof_body.get('data') or {}).get('author') or {}) if isinstance(prof_body, dict) else {}

    reels = requests.get(
        'https://api.scrapecreators.com/v1/instagram/user/reels',
        params={'handle': username},
        headers=SCRAPE,
        timeout=120,
    )
    reels_body = reels.json() if 'application/json' in reels.headers.get('content-type', '') else {}
    items = reels_body.get('items') or []
    captions = []
    for item in items[:3]:
        media = item.get('media') or item
        cap = ((media.get('caption') or {}).get('text') or '').strip()
        if cap:
            captions.append(cap[:400])

    combined_profile = ' '.join([
        candidate.get('full_name') or '',
        candidate.get('bio') or '',
        author.get('display_name') or '',
        author.get('bio') or '',
    ])
    combined_caption = ' '.join(captions)

    candidate.update({
        'followers_profile': author.get('followers'),
        'profile_signal': has_any(combined_profile, PROFILE_PATTERNS),
        'caption_signal': has_any(combined_caption, CAPTION_PATTERNS),
        'reels_found': len(items[:3]),
        'captions': captions,
        'candidate_label': 'candidate',
    })
    return candidate


def main():
    candidates = [enrich(c) for c in fetch_top5()]
    now = datetime.now(timezone.utc)
    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                create table if not exists instagram_search_candidates (
                    id bigserial primary key,
                    username text not null unique,
                    url text not null,
                    full_name text,
                    bio text,
                    search_query text,
                    matched_from text,
                    followers_search integer,
                    followers_profile integer,
                    reels_found integer,
                    profile_signal boolean not null default false,
                    caption_signal boolean not null default false,
                    candidate_label text not null default 'candidate',
                    sample_captions jsonb,
                    created_at timestamptz not null default now(),
                    updated_at timestamptz not null default now()
                )
            """)
            for c in candidates:
                cur.execute("""
                    insert into instagram_search_candidates (
                        username, url, full_name, bio, search_query, matched_from,
                        followers_search, followers_profile, reels_found,
                        profile_signal, caption_signal, candidate_label,
                        sample_captions, created_at, updated_at
                    ) values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    on conflict (username) do update set
                        url = excluded.url,
                        full_name = excluded.full_name,
                        bio = excluded.bio,
                        search_query = excluded.search_query,
                        matched_from = excluded.matched_from,
                        followers_search = excluded.followers_search,
                        followers_profile = excluded.followers_profile,
                        reels_found = excluded.reels_found,
                        profile_signal = excluded.profile_signal,
                        caption_signal = excluded.caption_signal,
                        candidate_label = excluded.candidate_label,
                        sample_captions = excluded.sample_captions,
                        updated_at = excluded.updated_at
                """, (
                    c['username'], c['url'], c.get('full_name') or None, c.get('bio') or None,
                    c.get('search_query') or None, c.get('matched_from') or None,
                    c.get('followers_search'), c.get('followers_profile'), c.get('reels_found'),
                    c.get('profile_signal', False), c.get('caption_signal', False), c.get('candidate_label', 'candidate'),
                    json.dumps(c.get('captions') or [], ensure_ascii=False), now, now,
                ))
    print(json.dumps({'saved': len(candidates), 'usernames': [c['username'] for c in candidates]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
