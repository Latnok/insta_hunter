import json
import os
from datetime import datetime, timezone
from urllib.parse import urlsplit

import psycopg
import requests

DB_URL = os.environ.get("HERMES_POSTGRES_URL")
API_KEY = os.environ.get("SOCIALCRAWL_API_KEY")
API_BASE = "https://www.socialcrawl.dev"


def username_from_url(url: str) -> str | None:
    path = urlsplit(url).path.strip("/")
    if not path:
        return None
    return path.split("/")[0]


def ensure_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists blogger_profiles (
                id bigserial primary key,
                blogger_id bigint not null unique references bloggers(id) on delete cascade,
                instagram_id text,
                username text,
                display_name text,
                bio text,
                avatar_url text,
                external_url text,
                followers bigint,
                following bigint,
                posts_count bigint,
                verified boolean,
                is_private boolean,
                engagement_rate double precision,
                language text,
                content_category text,
                profile_status text not null,
                unavailable_reason text,
                raw_json jsonb,
                last_checked_at timestamptz not null default now(),
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now(),
                constraint blogger_profiles_status_check check (profile_status in ('available', 'unavailable', 'error'))
            )
            """
        )
    conn.commit()


def fetch_profile(username: str) -> dict:
    headers = {"x-api-key": API_KEY}
    response = requests.get(
        f"{API_BASE}/v1/instagram/profile",
        params={"handle": username},
        headers=headers,
        timeout=60,
    )
    data = response.json() if "application/json" in response.headers.get("content-type", "") else {"raw": response.text}
    return {"status_code": response.status_code, "data": data}


def map_result(username: str, result: dict) -> dict:
    payload = result["data"]
    status_code = result["status_code"]

    if status_code == 200 and payload.get("success") and payload.get("data", {}).get("author"):
        author = payload["data"]["author"]
        computed = payload["data"].get("computed", {})
        return {
            "instagram_id": author.get("id"),
            "username": author.get("username") or username,
            "display_name": author.get("display_name"),
            "bio": author.get("bio"),
            "avatar_url": author.get("avatar_url"),
            "external_url": author.get("url"),
            "followers": author.get("followers"),
            "following": author.get("following"),
            "posts_count": author.get("posts_count"),
            "verified": author.get("verified"),
            "is_private": author.get("private"),
            "engagement_rate": computed.get("engagement_rate"),
            "language": computed.get("language"),
            "content_category": computed.get("content_category"),
            "profile_status": "available",
            "unavailable_reason": None,
            "raw_json": payload,
        }

    error = payload.get("error") if isinstance(payload, dict) else None
    message = None
    if isinstance(error, dict):
        message = error.get("message") or error.get("type")
    elif isinstance(error, str):
        message = error
    if not message:
        message = payload.get("message") if isinstance(payload, dict) else None

    if status_code == 404:
        return {
            "instagram_id": None,
            "username": username,
            "display_name": None,
            "bio": None,
            "avatar_url": None,
            "external_url": None,
            "followers": None,
            "following": None,
            "posts_count": None,
            "verified": None,
            "is_private": None,
            "engagement_rate": None,
            "language": None,
            "content_category": None,
            "profile_status": "unavailable",
            "unavailable_reason": message or "resource_not_found",
            "raw_json": payload,
        }

    return {
        "instagram_id": None,
        "username": username,
        "display_name": None,
        "bio": None,
        "avatar_url": None,
        "external_url": None,
        "followers": None,
        "following": None,
        "posts_count": None,
        "verified": None,
        "is_private": None,
        "engagement_rate": None,
        "language": None,
        "content_category": None,
        "profile_status": "error",
        "unavailable_reason": message or f"http_{status_code}",
        "raw_json": payload,
    }


def upsert_profile(conn, blogger_id: int, record: dict, checked_at):
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into blogger_profiles (
                blogger_id, instagram_id, username, display_name, bio, avatar_url,
                external_url, followers, following, posts_count, verified, is_private,
                engagement_rate, language, content_category, profile_status,
                unavailable_reason, raw_json, last_checked_at, created_at, updated_at
            ) values (
                %(blogger_id)s, %(instagram_id)s, %(username)s, %(display_name)s, %(bio)s, %(avatar_url)s,
                %(external_url)s, %(followers)s, %(following)s, %(posts_count)s, %(verified)s, %(is_private)s,
                %(engagement_rate)s, %(language)s, %(content_category)s, %(profile_status)s,
                %(unavailable_reason)s, %(raw_json)s::jsonb, %(last_checked_at)s, %(created_at)s, %(updated_at)s
            )
            on conflict (blogger_id) do update set
                instagram_id = excluded.instagram_id,
                username = excluded.username,
                display_name = excluded.display_name,
                bio = excluded.bio,
                avatar_url = excluded.avatar_url,
                external_url = excluded.external_url,
                followers = excluded.followers,
                following = excluded.following,
                posts_count = excluded.posts_count,
                verified = excluded.verified,
                is_private = excluded.is_private,
                engagement_rate = excluded.engagement_rate,
                language = excluded.language,
                content_category = excluded.content_category,
                profile_status = excluded.profile_status,
                unavailable_reason = excluded.unavailable_reason,
                raw_json = excluded.raw_json,
                last_checked_at = excluded.last_checked_at,
                updated_at = excluded.updated_at
            """,
            {
                "blogger_id": blogger_id,
                **{k: (json.dumps(v, ensure_ascii=False) if k == "raw_json" else v) for k, v in record.items()},
                "last_checked_at": checked_at,
                "created_at": checked_at,
                "updated_at": checked_at,
            },
        )


def main():
    if not DB_URL:
        raise RuntimeError("HERMES_POSTGRES_URL is not set")
    if not API_KEY:
        raise RuntimeError("SOCIALCRAWL_API_KEY is not set")

    checked_at = datetime.now(timezone.utc)
    summary = {"processed": 0, "available": 0, "unavailable": 0, "error": 0, "items": []}

    with psycopg.connect(DB_URL) as conn:
        ensure_table(conn)
        with conn.cursor() as cur:
            cur.execute("select id, url from bloggers order by coalesce(source_index, 1000000), id")
            bloggers = cur.fetchall()

        for blogger_id, url in bloggers:
            username = username_from_url(url)
            if not username:
                record = {
                    "instagram_id": None,
                    "username": None,
                    "display_name": None,
                    "bio": None,
                    "avatar_url": None,
                    "external_url": None,
                    "followers": None,
                    "following": None,
                    "posts_count": None,
                    "verified": None,
                    "is_private": None,
                    "engagement_rate": None,
                    "language": None,
                    "content_category": None,
                    "profile_status": "error",
                    "unavailable_reason": "cannot_extract_username",
                    "raw_json": {"url": url},
                }
            else:
                record = map_result(username, fetch_profile(username))

            upsert_profile(conn, blogger_id, record, checked_at)
            summary[record["profile_status"]] += 1
            summary["processed"] += 1
            summary["items"].append({
                "blogger_id": blogger_id,
                "username": record.get("username"),
                "status": record["profile_status"],
                "reason": record.get("unavailable_reason"),
            })

        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                "select profile_status, count(*) from blogger_profiles group by profile_status order by profile_status"
            )
            summary["db_status_counts"] = cur.fetchall()

    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
