import os
import subprocess
from pathlib import Path

import imageio_ffmpeg
import psycopg
import requests

ff = imageio_ffmpeg.get_ffmpeg_exe()
base = Path('/workspace/reel_audio_test')
base.mkdir(exist_ok=True)

with psycopg.connect(os.environ['HERMES_POSTGRES_URL']) as conn:
    with conn.cursor() as cur:
        cur.execute("select shortcode, media_url from blogger_reels where media_url is not null order by taken_at desc nulls last limit 1")
        shortcode, media_url = cur.fetchone()

mp4 = base / f'{shortcode}.mp4'
m4a = base / f'{shortcode}.m4a'
with requests.get(media_url, stream=True, timeout=180) as r:
    r.raise_for_status()
    with open(mp4, 'wb') as f:
        for chunk in r.iter_content(chunk_size=1024*1024):
            if chunk:
                f.write(chunk)

r = subprocess.run([ff, '-y', '-i', str(mp4), '-vn', '-acodec', 'copy', str(m4a)], capture_output=True, text=True)
if r.returncode != 0:
    r = subprocess.run([ff, '-y', '-i', str(mp4), '-vn', '-acodec', 'aac', '-b:a', '128k', str(m4a)], capture_output=True, text=True)

print({'shortcode': shortcode, 'mp4_exists': mp4.exists(), 'mp4_size': mp4.stat().st_size if mp4.exists() else 0, 'audio_exists': m4a.exists(), 'audio_size': m4a.stat().st_size if m4a.exists() else 0, 'exit': r.returncode, 'stderr_tail': (r.stderr or '')[-1500:]})
