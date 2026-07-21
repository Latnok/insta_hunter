import json
import sys
from urllib.parse import urlsplit

import instaloader

url = sys.argv[1]
path = urlsplit(url).path.strip('/')
username = path.split('/')[0]

L = instaloader.Instaloader(download_pictures=False, download_videos=False, download_video_thumbnails=False, download_geotags=False, download_comments=False, save_metadata=False, compress_json=False, quiet=True)
profile = instaloader.Profile.from_username(L.context, username)
items = []
for post in profile.get_posts():
    if post.is_video:
        items.append({
            'username': username,
            'shortcode': post.shortcode,
            'url': f'https://www.instagram.com/p/{post.shortcode}/',
            'video_url': post.video_url,
            'caption': (post.caption or '')[:120],
            'taken_at': str(post.date_utc),
            'likes': post.likes,
            'comments': post.comments,
        })
        if len(items) >= 3:
            break
print(json.dumps(items, ensure_ascii=False, default=str))
