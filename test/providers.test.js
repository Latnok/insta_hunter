import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramProviders } from '../src/providers/instagram.js';

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

test('uses ScrapeCreators for search and normalizes results', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /scrapecreators.*search\/profiles/);
    return new Response(JSON.stringify({ profiles: [{ username: 'Fashion.Girl', url: 'https://instagram.com/Fashion.Girl' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const providers = createInstagramProviders({ SCRAPECREATORS_API_KEY: 'x', SOCIALCRAWL_API_KEY: 'y' });
  const result = await providers.search('fashion', 5);
  assert.equal(result.provider, 'scrapecreators');
  assert.equal(result.items[0].username, 'fashion.girl');
});

test('falls back from SocialCrawl to ScrapeCreators for profile', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(JSON.stringify({ error: { message: 'temporary' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ user: { username: 'fashion', full_name: 'Fashion', follower_count: 100 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const providers = createInstagramProviders({ SCRAPECREATORS_API_KEY: 'x', SOCIALCRAWL_API_KEY: 'y' });
  const result = await providers.profile('fashion');
  assert.equal(result.provider, 'scrapecreators');
  assert.equal(result.profile.followers, 100);
  assert.equal(calls.length, 2);
});

test('rejects provider-level not-found payloads returned with HTTP 200', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ error: { message: 'not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      handle: 'missing_account',
      userId: null,
      message: "Account doesn't exist",
      error: 'not_found',
      errorStatus: 404
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const providers = createInstagramProviders({ SCRAPECREATORS_API_KEY: 'x', SOCIALCRAWL_API_KEY: 'y' });
  await assert.rejects(
    providers.profile('missing_account'),
    (error) => error.message === 'All providers failed for profile' && error.fallbackErrors.length === 2
  );
});

test('normalizes nested Instagram video and thumbnail variants', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{
      pk: '123',
      code: 'ABC123',
      ig_play_count: 42,
      display_uri: 'https://cdn.example/fallback.jpg',
      image_versions2: { candidates: [{ url: 'https://cdn.example/thumbnail.jpg' }] },
      video_versions: [{ url: 'https://cdn.example/video.mp4' }]
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const providers = createInstagramProviders({ SCRAPECREATORS_API_KEY: 'x' });
  const result = await providers.reels('fashion', 1);
  assert.equal(result.items[0].mediaUrl, 'https://cdn.example/video.mp4');
  assert.equal(result.items[0].thumbnailUrl, 'https://cdn.example/fallback.jpg');
  assert.equal(result.items[0].playCount, 42);
});
