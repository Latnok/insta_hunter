import json
import os
import re
from datetime import datetime, timezone

import psycopg

DB_URL = os.environ['HERMES_POSTGRES_URL']

NOISE_PATTERNS = [
    r'dimatorzok',
    r'субтитры сделал',
    r'субтитры создавал',
    r'субтитры подогнал',
]

LOW_VALUE_PATTERNS = [
    r'^музыка[.!… ]*$',
    r'^music[.!… ]*$',
    r'^аплодисменты[.!… ]*$',
    r'^смех[.!… ]*$',
    r'^шум[.!… ]*$',
]


def classify(text: str | None) -> tuple[str, str | None]:
    if not text or not text.strip():
        return 'empty', 'empty transcript text'

    normalized = re.sub(r'\s+', ' ', text.strip().lower())

    for pattern in NOISE_PATTERNS:
        if re.search(pattern, normalized):
            return 'noise', f'matched noise pattern: {pattern}'

    for pattern in LOW_VALUE_PATTERNS:
        if re.search(pattern, normalized):
            return 'low_value', f'matched low-value pattern: {pattern}'

    if len(normalized) < 12:
        return 'low_value', 'too short'

    word_count = len(normalized.split())
    if word_count <= 2:
        return 'low_value', 'too few words'

    return 'useful', None


def main():
    now = datetime.now(timezone.utc)
    summary = {'updated': 0, 'counts': {}, 'samples': {}}

    with psycopg.connect(DB_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("alter table blogger_reels add column if not exists transcript_quality text")
            cur.execute("alter table blogger_reels add column if not exists transcript_quality_reason text")
        conn.commit()

        with conn.cursor() as cur:
            cur.execute(
                """
                select id, shortcode, transcript_text
                from blogger_reels
                where transcript_status = 'available'
                order by id
                """
            )
            rows = cur.fetchall()

        for reel_id, shortcode, transcript_text in rows:
            quality, reason = classify(transcript_text)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    update blogger_reels
                    set transcript_quality = %s,
                        transcript_quality_reason = %s,
                        updated_at = %s
                    where id = %s
                    """,
                    (quality, reason, now, reel_id),
                )
            summary['updated'] += 1
            summary['counts'][quality] = summary['counts'].get(quality, 0) + 1
            summary['samples'].setdefault(quality, [])
            if len(summary['samples'][quality]) < 3:
                summary['samples'][quality].append({
                    'shortcode': shortcode,
                    'text_preview': (transcript_text or '')[:120],
                    'reason': reason,
                })

        conn.commit()

    print(json.dumps(summary, ensure_ascii=False, default=str))


if __name__ == '__main__':
    main()
