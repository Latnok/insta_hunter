import argparse
import json
import os
from urllib.parse import urlsplit

import instaloader
import psycopg


def username_from_url(url: str) -> str | None:
    path = urlsplit(url).path.strip('/')
    if not path:
        return None
    return path.split('/')[0]


def make_loader(session_file: str | None) -> instaloader.Instaloader:
    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )
    if session_file:
        ig_user = os.environ.get('INSTAGRAM_USERNAME')
        if not ig_user:
            raise RuntimeError('INSTAGRAM_USERNAME is required when using --session-file')
        loader.load_session_from_file(ig_user, session_file)
    return loader


def ensure_table(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists blogger_videos (
                id bigserial primary key,
                blogger_id bigint not null references bloggers(id) on delete cascade,
                username text not null,
                shortcode text not null unique,
                post_url text not null,
                video_url text,
                caption text,
                taken_at timestamptz,
                likes integer,
                comments integer,
                fetched_at timestamptz not null default now(),
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            )
            """
        )
        cur.execute(
            "create index if not exists idx_blogger_videos_blogger_id_taken_at on blogger_videos(blogger_id, taken_at desc)"
        )
    conn.commit()


def upsert_video(conn, blogger_id: int, username: str, post) -> None:
    post_url = f'https://www.instagram.com/p/{post.shortcode}/'
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into blogger_videos (
                blogger_id, username, shortcode, post_url, video_url, caption,
                taken_at, likes, comments, fetched_at, created_at, updated_at
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now(), now())
            on conflict (shortcode) do update
            set blogger_id = excluded.blogger_id,
                username = excluded.username,
                post_url = excluded.post_url,
                video_url = excluded.video_url,
                caption = excluded.caption,
                taken_at = excluded.taken_at,
                likes = excluded.likes,
                comments = excluded.comments,
                fetched_at = now(),
                updated_at = now()
            """,
            (
                blogger_id,
                username,
                post.shortcode,
                post_url,
                getattr(post, 'video_url', None),
                post.caption,
                post.date_utc,
                post.likes,
                post.comments,
            ),
        )


def main():
    parser = argparse.ArgumentParser(description='Fetch latest Instagram videos for bloggers in Postgres')
    parser.add_argument('--limit-bloggers', type=int, default=None, help='Only process first N bloggers')
    parser.add_argument('--videos-per-blogger', type=int, default=3, help='How many latest videos to store per blogger')
    parser.add_argument('--session-file', default=None, help='Path to Instaloader session file')
    args = parser.parse_args()

    db_url = os.environ.get('HERMES_POSTGRES_URL')
    if not db_url:
        raise RuntimeError('HERMES_POSTGRES_URL is not set')

    loader = make_loader(args.session_file)

    with psycopg.connect(db_url) as conn:
        ensure_table(conn)
        with conn.cursor() as cur:
            sql = 'select id, url from bloggers order by coalesce(source_index, 1000000), id'
            if args.limit_bloggers:
                sql += ' limit %s'
                cur.execute(sql, (args.limit_bloggers,))
            else:
                cur.execute(sql)
            bloggers = cur.fetchall()

        summary = {'processed': 0, 'videos_saved': 0, 'errors': []}

        for blogger_id, url in bloggers:
            username = username_from_url(url)
            if not username:
                summary['errors'].append({'blogger_id': blogger_id, 'url': url, 'error': 'cannot extract username'})
                continue
            try:
                profile = instaloader.Profile.from_username(loader.context, username)
                saved = 0
                for post in profile.get_posts():
                    if not post.is_video:
                        continue
                    upsert_video(conn, blogger_id, username, post)
                    saved += 1
                    summary['videos_saved'] += 1
                    if saved >= args.videos_per_blogger:
                        break
                conn.commit()
                summary['processed'] += 1
            except Exception as e:
                conn.rollback()
                summary['errors'].append({'blogger_id': blogger_id, 'username': username, 'error': str(e)})

        print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
