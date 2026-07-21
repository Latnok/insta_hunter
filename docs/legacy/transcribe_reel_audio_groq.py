import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import psycopg
import requests
from dotenv import load_dotenv

load_dotenv('/home/hermeswebui/.hermes/.env')

DB_URL = os.environ['HERMES_POSTGRES_URL']
GROQ_API_KEY = os.environ['GROQ_API_KEY']
API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
MODEL = os.environ.get('GROQ_WHISPER_MODEL', 'whisper-large-v3-turbo')
DEFAULT_LANGUAGE = os.environ.get('GROQ_WHISPER_LANGUAGE', 'ru')
MAX_ATTEMPTS = int(os.environ.get('GROQ_WHISPER_RETRIES', '3'))
TIMEOUT = int(os.environ.get('GROQ_WHISPER_TIMEOUT', '300'))


def ensure_columns(conn):
    with conn.cursor() as cur:
        cur.execute("alter table blogger_reels add column if not exists transcript_error_message text")
        cur.execute("alter table blogger_reels add column if not exists transcript_http_status integer")
        cur.execute("alter table blogger_reels add column if not exists transcript_attempts integer")
    conn.commit()


def call_groq(audio_path: Path):
    with audio_path.open('rb') as f:
        response = requests.post(
            API_URL,
            headers={'Authorization': f'Bearer {GROQ_API_KEY}'},
            data={
                'model': MODEL,
                'response_format': 'verbose_json',
                'language': DEFAULT_LANGUAGE,
            },
            files={'file': (audio_path.name, f, 'audio/mp4')},
            timeout=TIMEOUT,
        )
    try:
        body = response.json()
    except Exception:
        body = {'raw': response.text[:4000]}
    return response.status_code, body


def classify_result(status, body):
    text = (body.get('text') or '').strip() if isinstance(body, dict) else ''
    if status == 200 and text:
        return 'available', text, None
    if status == 200 and not text:
        return 'empty', None, 'Groq returned 200 but empty text'
    if isinstance(body, dict):
        err = body.get('error')
        if isinstance(err, dict):
            msg = err.get('message') or json.dumps(err, ensure_ascii=False)[:1000]
        else:
            msg = json.dumps(body, ensure_ascii=False)[:1000]
    else:
        msg = str(body)[:1000]
    return 'api_error', None, msg or f'HTTP {status}'


def transcribe_with_retry(audio_path: Path):
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            status, body = call_groq(audio_path)
            transcript_status, text, error_message = classify_result(status, body)
            result = {
                'attempts': attempt,
                'http_status': status,
                'transcript_status': transcript_status,
                'text': text,
                'error_message': error_message,
            }
            if transcript_status in {'available', 'empty'}:
                return result
            last = result
        except requests.Timeout as e:
            last = {
                'attempts': attempt,
                'http_status': None,
                'transcript_status': 'timeout',
                'text': None,
                'error_message': repr(e)[:1000],
            }
        except requests.RequestException as e:
            last = {
                'attempts': attempt,
                'http_status': None,
                'transcript_status': 'network_error',
                'text': None,
                'error_message': repr(e)[:1000],
            }
        except Exception as e:
            last = {
                'attempts': attempt,
                'http_status': None,
                'transcript_status': 'exception',
                'text': None,
                'error_message': repr(e)[:1000],
            }
        if attempt < MAX_ATTEMPTS:
            time.sleep(min(2 ** (attempt - 1), 5))
    return last


def update_row(conn, reel_id, now, result):
    with conn.cursor() as cur:
        cur.execute(
            """
            update blogger_reels
            set transcript_text = %s,
                transcript_status = %s,
                transcript_source = %s,
                transcript_checked_at = %s,
                transcript_error_message = %s,
                transcript_http_status = %s,
                transcript_attempts = %s,
                updated_at = %s
            where id = %s
            """,
            (
                result.get('text'),
                result.get('transcript_status'),
                'groq-whisper',
                now,
                result.get('error_message'),
                result.get('http_status'),
                result.get('attempts'),
                now,
                reel_id,
            ),
        )


def main():
    now = datetime.now(timezone.utc)
    summary = {
        'processed': 0,
        'available': 0,
        'empty': 0,
        'api_error': 0,
        'network_error': 0,
        'timeout': 0,
        'exception': 0,
        'missing_audio': 0,
        'samples': [],
        'error_samples': [],
    }

    with psycopg.connect(DB_URL) as conn:
        ensure_columns(conn)
        with conn.cursor() as cur:
            cur.execute(
                """
                select id, shortcode, audio_path
                from blogger_reels
                where audio_status = 'available'
                  and transcript_status = 'error'
                order by transcript_checked_at desc nulls last, id desc
                """
            )
            rows = cur.fetchall()

        for reel_id, shortcode, audio_path_str in rows:
            audio_path = Path(audio_path_str or '')
            if not audio_path.exists():
                result = {
                    'attempts': 0,
                    'http_status': None,
                    'transcript_status': 'missing_audio',
                    'text': None,
                    'error_message': f'Audio file not found: {audio_path}',
                }
                update_row(conn, reel_id, now, result)
                conn.commit()
                summary['processed'] += 1
                summary['missing_audio'] += 1
                continue

            result = transcribe_with_retry(audio_path)
            update_row(conn, reel_id, now, result)
            conn.commit()
            summary['processed'] += 1
            status = result['transcript_status']
            summary[status] = summary.get(status, 0) + 1
            if status == 'available' and len(summary['samples']) < 5:
                summary['samples'].append({'shortcode': shortcode, 'text_preview': (result.get('text') or '')[:120]})
            if status != 'available' and len(summary['error_samples']) < 5:
                summary['error_samples'].append({'shortcode': shortcode, 'status': status, 'error': (result.get('error_message') or '')[:200], 'http_status': result.get('http_status'), 'attempts': result.get('attempts')})

        with conn.cursor() as cur:
            cur.execute(
                """
                select transcript_status, count(*) as cnt
                from blogger_reels
                where audio_status = 'available'
                group by transcript_status
                order by transcript_status
                """
            )
            cols = [d.name for d in cur.description]
            summary['final_status_counts'] = [dict(zip(cols, row)) for row in cur.fetchall()]

    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
