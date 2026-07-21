import os
import json
import requests
from dotenv import load_dotenv

load_dotenv('/home/hermeswebui/.hermes/.env')
SCRAPE = {'x-api-key': os.environ['SCRAPECREATORS_API_KEY']}
SOCIAL = {'x-api-key': os.environ['SOCIALCRAWL_API_KEY']}

candidates = []
seen = set()
for q in ['wildberries style', 'fashion moscow']:
    r = requests.get('https://api.scrapecreators.com/v1/instagram/search/profiles', params={'query': q}, headers=SCRAPE, timeout=120)
    r.raise_for_status()
    for p in r.json().get('profiles', []):
        u = (p.get('username') or '').lower()
        if not u or u in seen:
            continue
        seen.add(u)
        candidates.append({
            'query': q,
            'username': p.get('username'),
            'full_name': p.get('full_name'),
            'followers': p.get('follower_count'),
            'bio': p.get('biography') or '',
            'matched_from': p.get('matched_from'),
            'url': p.get('url'),
        })
        if len(candidates) >= 5:
            break
    if len(candidates) >= 5:
        break

PROFILE_PATTERNS = ['fashion','style','outfit','look','ugc','creator','мода','стиль','женствен','образы','находки','обзоры покупок','распаков','wildberries','wb','стилист']
TRANSCRIPT_PATTERNS = ['жакет','плать','юбк','футболк','костюм','обув','сумк','трикотаж','ткан','качеств','посадк','размер','цвет','образ','примерк','wildberries','wb','где купить','с чем носить','стильн']

def text_has_any(text, patterns):
    t = (text or '').lower()
    return any(p in t for p in patterns)

results = []
for c in candidates:
    username = c['username']
    prof = requests.get('https://www.socialcrawl.dev/v1/instagram/profile', params={'username': username}, headers=SOCIAL, timeout=120)
    prof_body = prof.json() if 'application/json' in prof.headers.get('content-type','') else {}
    author = ((prof_body.get('data') or {}).get('author') or {}) if isinstance(prof_body, dict) else {}
    reels = requests.get('https://api.scrapecreators.com/v1/instagram/user/reels', params={'handle': username}, headers=SCRAPE, timeout=120)
    reels_body = reels.json() if 'application/json' in reels.headers.get('content-type','') else {}
    items = reels_body.get('items') or []
    captions = []
    for item in items[:3]:
        media = item.get('media') or item
        cap = ((media.get('caption') or {}).get('text') or '').strip()
        if cap:
            captions.append(cap[:220])
    combined_profile_text = ' '.join([c.get('full_name') or '', c.get('bio') or '', author.get('display_name') or '', author.get('bio') or ''])
    combined_caption_text = ' '.join(captions)
    results.append({
        'username': username,
        'full_name': c.get('full_name'),
        'followers_search': c.get('followers'),
        'followers_profile': author.get('followers'),
        'matched_from': c.get('matched_from'),
        'profile_signal': text_has_any(combined_profile_text, PROFILE_PATTERNS),
        'caption_signal': text_has_any(combined_caption_text, TRANSCRIPT_PATTERNS),
        'reels_found': len(items[:3]),
        'bio': (author.get('bio') or c.get('bio') or '')[:260],
        'captions': captions,
        'url': c.get('url'),
    })

print(json.dumps(results, ensure_ascii=False))
