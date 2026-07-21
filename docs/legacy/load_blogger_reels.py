import json
import os
from datetime import datetime, timezone

import psycopg
import requests

DB_URL = os.environ.get("HERMES_POSTGRES_URL")
API_KEY = os.environ.get("SCRAPECREATORS_API_KEY")
API_BASE = "https://api.scrapecreators.com"


def ensure_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists blogger_reels (
                id bigserial primary key,
                blogger_id bigint not null references bloggers(id) on delete cascade,
                profile_id bigint references blogger_profiles(id) on delete set null,
                instagram_media_pk text not null unique,
                shortcode text,
                reel_url text,
                caption text,
                taken_at timestamptz,
                play_count bigint,
                like_count bigint,
                comment_count bigint,
                thumbnail_url text,
                media_url text,
                owner_username text,
                raw_json jsonb,
                fetched_at timestamptz not null default now(),
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            )
            """
        )
        cur.execute(
            "create index if not exists idx_blogger_reels_blogger_taken_at on blogger_reels(blogger_id, taken_at desc)"
        )
    conn.commit()


def fetch_reels(username: str):
    headers = {"x-api-key": API_KEY}
    r = requests.get(
        f"{API_BASE}/v1/instagram/user/reels",
        params={"handle": username},
        headers=headers,
        timeout=120,
    )
    body = r.json() if "application/json" in r.headers.get("content-type", "") else {"raw": r.text}
    return r.status_code, body


def parse_items(body: dict):
    items = body.get("items") or []
    out = []
    for item in items[:3]:
        media = item.get("media") or item
        owner = media.get("user") or media.get("owner") or {}
        caption_obj = media.get("caption") or {}
        video_versions = media.get("video_versions") or []
        thumb = media.get("image_versions2", {}).get("candidates", [])
        out.append(
            {
                "instagram_media_pk": str(media.get("pk") or media.get("id") or ""),
                "shortcode": media.get("code"),
                "reel_url": media.get("url") or (f"https://www.instagram.com/reel/{media.get('code')}/" if media.get("code") else None),
                "caption": caption_obj.get("text"),
                "taken_at": datetime.fromtimestamp(media.get("taken_at"), tz=timezone.utc) if media.get("taken_at") else None,
                "play_count": media.get("play_count") or media.get("ig_play_count"),
                "like_count": media.get("like_count"),
                "comment_count": media.get("comment_count"),
                "thumbnail_url": (thumb[0].get("url") if thumb else None) or media.get("display_uri"),
                "media_url": video_versions[0].get("url") if video_versions else None,
                "owner_username": owner.get("username"),
                "raw_json": media,
            }
        )
    return [x for x in out if x["instagram_media_pk"]]


def upsert_reel(conn, blogger_id: int, profile_id: int, reel: dict, fetched_at):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into blogger_reels (
                blogger_id, profile_id, instagram_media_pk, shortcode, reel_url, caption,
                taken_at, play_count, like_count, comment_count, thumbnail_url, media_url,
                owner_username, raw_json, fetched_at, created_at, updated_at
            ) values (
                %(blogger_id)s, %(profile_id)s, %(instagram_media_pk)s, %(shortcode)s, %(reel_url)s, %(caption)s,
                %(taken_at)s, %(play_count)s, %(like_count)s, %(comment_count)s, %(thumbnail_url)s, %(media_url)s,
                %(owner_username)s, %(raw_json)s::jsonb, %(fetched_at)s, %(created_at)s, %(updated_at)s
            )
            on conflict (instagram_media_pk) do update set
                blogger_id = excluded.blogger_id,
                profile_id = excluded.profile_id,
                shortcode = excluded.shortcode,
                reel_url = excluded.reel_url,
                caption = excluded.caption,
                taken_at = excluded.taken_at,
                play_count = excluded.play_count,
                like_count = excluded.like_count,
                comment_count = excluded.comment_count,
                thumbnail_url = excluded.thumbnail_url,
                media_url = excluded.media_url,
                owner_username = excluded.owner_username,
                raw_json = excluded.raw_json,
                fetched_at = excluded.fetched_at,
                updated_at = excluded.updated_at
            """,
            {
                "blogger_id": blogger_id,
                "profile_id": profile_id,
                **{k: (json.dumps(v, ensure_ascii=False) if k == "raw_json" else v) for k, v in reel.items()},
                "fetched_at": fetched_at,
                "created_at": fetched_at,
                "updated_at": fetched_at,
            },
        )


def main():
    if not DB_URL:
        raise RuntimeError("HERMES_POSTGRES_URL is not set")
    if not API_KEY:
        raise RuntimeError("SCRAPECREATORS_API_KEY is not set")

    fetched_at = datetime.now(timezone.utc)
    summary = {"profiles_processed": 0, "reels_saved": 0, "profiles_with_no_reels": 0, "errors": []}

    with psycopg.connect(DB_URL) as conn:
        ensure_table(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                select bp.id, bp.blogger_id, bp.username
                from blogger_profiles bp
                where bp.profile_status = 'available' and bp.username is not null
                order by bp.blogger_id
                """
            )
            profiles = cur.fetchall()

        for profile_id, blogger_id, username in profiles:
            try:
                status, body = fetch_reels(username)
                if status != 200 or not body.get("success"):
                    summary["errors"].append({"blogger_id": blogger_id, "username": username, "status": status})
                    continue
                reels = parse_items(body)
                if not reels:
                    summary["profiles_with_no_reels"] += 1
                for reel in reels:
                    upsert_reel(conn, blogger_id, profile_id, reel, fetched_at)
                    summary["reels_saved"] += 1
                summary["profiles_processed"] += 1
                conn.commit()
            except Exception as e:
                conn.rollback()
                summary["errors"].append({"blogger_id": blogger_id, "username": username, "error": repr(e)})

        with conn.cursor() as cur:
            cur.execute("select count(*) from blogger_reels")
            summary["total_reels_in_db"] = cur.fetchone()[0]
            cur.execute("select count(distinct blogger_id) from blogger_reels")
            summary["bloggers_with_reels"] = cur.fetchone()[0]

    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
