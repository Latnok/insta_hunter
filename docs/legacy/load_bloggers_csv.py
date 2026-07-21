import csv
import json
import os
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import psycopg

CSV_PATH = "/home/hermeswebui/.hermes/webui/attachments/d92d1844132c/Блогеры_-_Лист1.csv"


def normalize_instagram_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url.lstrip("/")
    parts = urlsplit(url)
    scheme = "https"
    netloc = parts.netloc.lower()
    if netloc == "instagram.com":
        netloc = "www.instagram.com"
    path = parts.path or ""
    path = path.rstrip("/")
    if path.endswith("/profilecard"):
        path = path[: -len("/profilecard")]
    if not path.startswith("/"):
        path = "/" + path
    return urlunsplit((scheme, netloc, path, "", ""))


rows = []
seen = set()
with open(CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
    reader = csv.reader(f)
    for raw_row in reader:
        if not raw_row or all(not (c or "").strip() for c in raw_row):
            continue
        first = (raw_row[0] if len(raw_row) > 0 else "").strip()
        second = (raw_row[1] if len(raw_row) > 1 else "").strip()
        if not second:
            continue
        source_index = int(first) if first.isdigit() else None
        normalized_url = normalize_instagram_url(second)
        if not normalized_url:
            continue
        if normalized_url in seen:
            continue
        seen.add(normalized_url)
        rows.append({
            "source_index": source_index,
            "url": normalized_url,
            "rating": None,
        })

now = datetime.now(timezone.utc)

with psycopg.connect(os.environ["HERMES_POSTGRES_URL"]) as conn:
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists bloggers (
                id bigserial primary key,
                source_index integer,
                url text not null unique,
                rating smallint,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now(),
                constraint bloggers_rating_check check (rating is null or rating between 1 and 10)
            )
            """
        )
        inserted = 0
        updated = 0
        for row in rows:
            cur.execute(
                """
                insert into bloggers (source_index, url, rating, created_at, updated_at)
                values (%s, %s, %s, %s, %s)
                on conflict (url) do update
                set source_index = excluded.source_index,
                    rating = excluded.rating,
                    updated_at = excluded.updated_at
                returning (xmax = 0) as inserted_flag
                """,
                (row["source_index"], row["url"], row["rating"], now, now),
            )
            was_inserted = cur.fetchone()[0]
            if was_inserted:
                inserted += 1
            else:
                updated += 1
        conn.commit()

    with conn.cursor() as cur:
        cur.execute("select count(*) from bloggers")
        total = cur.fetchone()[0]
        cur.execute("select source_index, url, rating, created_at, updated_at from bloggers order by coalesce(source_index, 1000000), id limit 10")
        sample = cur.fetchall()

print(json.dumps({
    "parsed_rows": len(rows),
    "inserted": inserted,
    "updated": updated,
    "total_in_table": total,
    "sample": sample,
}, default=str, ensure_ascii=False))
