import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import imageio_ffmpeg
import psycopg
import requests

DB_URL = os.environ['HERMES_POSTGRES_URL']
SOCIAL_KEY = os.environ['SOCIALCRAWL_API_KEY']
AUDIO_DIR = Path('/workspace/reel_audio')
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
TRANSCRIPT_BUDGET = int(os.environ.get('TRANSCRIPT_BUDGET', '6'))
FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()


def ensure_columns(conn):
    with conn.cursor() as cur:
        cur.execute("alter table blogger_reels add column if not exists transcript_text text")
        cur.execute("alter table blogger_reels add column if not exists transcript_status text")
        cur.execute("alter table blogger_reels add column if not exists transcript_checked_at timestamptz")
        cur.execute("alter table blogger_reels add column if not exists transcript_source text")
        cur.execute("alter table blogger_reels add column if not exists audio_path text")
        cur.execute("alter table blogger_reels add column if not exists audio_status text")
        cur.execute("alter table blogger_reels add column if not exists audio_extracted_at timestamptz")
    conn.commit()


def ffmpeg_available():
    return Path(FFMPEG_BIN).exists()


def install_ffmpeg_if_missing():
    if ffmpeg_available():
        return True, FFMPEG_BIN
    return False, 'imageio_ffmpeg binary not found'


def fetch_transcript(reel_url: str):
    headers = {'x-api-key': SOCIAL_KEY}
    r = requests.get(
        'https://www.socialcrawl.dev/v1/instagram/media/transcript',
        params={'url': reel_url},
        headers=headers,
        timeout=180,
    )
    body = r.json() if 'application/json' in r.headers.get('content-type', '') else {'raw': r.text}
    return r.status_code, body


def extract_audio(media_url: str, shortcode: str):
    out = AUDIO_DIR / f'{shortcode}.m4a'
    tmp_mp4 = AUDIO_DIR / f'{shortcode}.mp4'

    with requests.get(media_url, stream=True, timeout=180) as r:
        r.raise_for_status()
        with open(tmp_mp4, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)

    cmd = [
        FFMPEG_BIN, '-y', '-i', str(tmp_mp4),
        '-vn', '-acodec', 'copy', str(out)
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
        tmp_mp4.unlink(missing_ok=True)
        return True, str(out)

    cmd2 = [
        FFMPEG_BIN, '-y', '-i', str(tmp_mp4),
        '-vn', '-acodec', 'aac', '-b:a', '128k', str(out)
    ]
    r2 = subprocess.run(cmd2, capture_output=True, text=True)
    tmp_mp4.unlink(missing_ok=True)
    if r2.returncode == 0 and out.exists() and out.stat().st_size > 0:
        return True, str(out)
    return False, (r.stderr + '\n' + r2.stderr)[-2000:]


def main():
    summary = {
        'ffmpeg': None,
        'transcript_attempts': 0,
        'transcripts_saved': 0,
        'audio_saved': 0,
        'audio_failed': 0,
        'errors': []
    }
    ok, msg = install_ffmpeg_if_missing()
    summary['ffmpeg'] = {'available': ok, 'detail': msg if isinstance(msg, str) else str(msg)}
    if not ok:
        print(json.dumps(summary, ensure_ascii=False, default=str))
        return

    now = datetime.now(timezone.utc)
    with psycopg.connect(DB_URL) as conn:
        ensure_columns(conn)
        with conn.cursor() as cur:
            cur.execute("""
                select id, blogger_id, shortcode, reel_url, media_url
                from blogger_reels
                where transcript_status is null
                order by taken_at desc nulls last, id desc
            """)
            rows = cur.fetchall()

        # First try transcripts on newest reels until budget exhausted.
        for reel_id, blogger_id, shortcode, reel_url, media_url in rows:
            if summary['transcript_attempts'] >= TRANSCRIPT_BUDGET:
                break
            if not reel_url:
                continue
            try:
                status, body = fetch_transcript(reel_url)
                summary['transcript_attempts'] += 1
                text = None
                transcript_status = 'missing'
                if status == 200 and body.get('success'):
                    transcripts = ((body.get('data') or {}).get('transcripts') or [])
                    if transcripts:
                        text = '\n'.join(t.get('text','').strip() for t in transcripts if t.get('text')).strip() or None
                        if text:
                            transcript_status = 'available'
                if status != 200 and transcript_status != 'available':
                    transcript_status = 'error'
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        update blogger_reels
                        set transcript_text = %s,
                            transcript_status = %s,
                            transcript_checked_at = %s,
                            transcript_source = %s,
                            updated_at = %s
                        where id = %s
                        """,
                        (text, transcript_status, now, 'socialcrawl', now, reel_id)
                    )
                if transcript_status == 'available':
                    summary['transcripts_saved'] += 1
                conn.commit()
            except Exception as e:
                conn.rollback()
                summary['errors'].append({'reel_id': reel_id, 'shortcode': shortcode, 'stage': 'transcript', 'error': repr(e)})

        # Then ensure audio for every reel without transcript.
        with conn.cursor() as cur:
            cur.execute("""
                select id, shortcode, media_url, transcript_status, audio_path
                from blogger_reels
                order by taken_at desc nulls last, id desc
            """)
            rows = cur.fetchall()

        for reel_id, shortcode, media_url, transcript_status, audio_path in rows:
            if transcript_status == 'available':
                continue
            if audio_path and Path(audio_path).exists():
                continue
            if not media_url or not shortcode:
                with conn.cursor() as cur:
                    cur.execute(
                        "update blogger_reels set audio_status=%s, audio_extracted_at=%s, updated_at=%s where id=%s",
                        ('missing_media_url', now, now, reel_id)
                    )
                conn.commit()
                summary['audio_failed'] += 1
                continue
            try:
                ok, result = extract_audio(media_url, shortcode)
                with conn.cursor() as cur:
                    cur.execute(
                        "update blogger_reels set audio_path=%s, audio_status=%s, audio_extracted_at=%s, updated_at=%s where id=%s",
                        ((result if ok else None), ('available' if ok else 'error'), now, now, reel_id)
                    )
                conn.commit()
                if ok:
                    summary['audio_saved'] += 1
                else:
                    summary['audio_failed'] += 1
                    summary['errors'].append({'reel_id': reel_id, 'shortcode': shortcode, 'stage': 'audio', 'error': result})
            except Exception as e:
                conn.rollback()
                summary['audio_failed'] += 1
                summary['errors'].append({'reel_id': reel_id, 'shortcode': shortcode, 'stage': 'audio', 'error': repr(e)})

        with conn.cursor() as cur:
            cur.execute("select count(*) filter (where transcript_status='available'), count(*) filter (where audio_status='available') from blogger_reels")
            summary['db_counts'] = cur.fetchone()

    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
