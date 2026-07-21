import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createInstagramProviders } from '../src/providers/instagram.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'providers');
const originalFetch = globalThis.fetch;

async function fixture(provider, name) {
  return JSON.parse(await readFile(path.join(fixturesDir, provider, `${name}.json`), 'utf8'));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' }
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('SocialCrawl success fixtures satisfy profile, reels and transcript contracts', async () => {
  const bodies = {
    profile: await fixture('socialcrawl', 'profile-success'),
    reels: await fixture('socialcrawl', 'reels-success'),
    transcript: await fixture('socialcrawl', 'transcript-success')
  };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/profile/reels')) return jsonResponse(bodies.reels);
    if (target.includes('/media/transcript')) return jsonResponse(bodies.transcript);
    return jsonResponse(bodies.profile);
  };
  const providers = createInstagramProviders({ SOCIALCRAWL_API_KEY: 'fixture' });

  const profile = await providers.profile('fixture_style');
  assert.equal(profile.profile.instagramId, 'sc-user-101');
  assert.equal(profile.profile.followers, 12500);
  const reels = await providers.reels('fixture_style', 1);
  assert.equal(reels.items[0].instagramMediaId, 'sc-media-201');
  assert.equal(reels.items[0].mediaUrl, 'https://cdn.example.invalid/socialcrawl/reel.mp4');
  const transcript = await providers.transcript('https://www.instagram.com/reel/SCFIXTURE/');
  assert.match(transcript.text, /обзора одежды/);
});

test('ScrapeCreators success fixtures satisfy search, profile, reels and transcript contracts', async () => {
  const bodies = {
    search: await fixture('scrapecreators', 'search-success'),
    profile: await fixture('scrapecreators', 'profile-success'),
    reels: await fixture('scrapecreators', 'reels-success'),
    transcript: await fixture('scrapecreators', 'transcript-success')
  };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/search/profiles')) return jsonResponse(bodies.search);
    if (target.includes('/user/reels')) return jsonResponse(bodies.reels);
    if (target.includes('/post/transcript')) return jsonResponse(bodies.transcript);
    return jsonResponse(bodies.profile);
  };
  const providers = createInstagramProviders({ SCRAPECREATORS_API_KEY: 'fixture' });

  const search = await providers.search('fixture', 1);
  assert.equal(search.items[0].username, 'fixture.style');
  const profile = await providers.profile('fixture_style');
  assert.equal(profile.profile.instagramId, 'scrape-user-301');
  const reels = await providers.reels('fixture_style', 1);
  assert.equal(reels.items[0].playCount, 5500);
  assert.equal(reels.items[0].mediaUrl, 'https://cdn.example.invalid/scrape/reel.mp4');
  const transcript = await providers.transcript('https://www.instagram.com/reel/SCRFIXTURE/');
  assert.match(transcript.text, /fallback transcript/);
});

test('schema-change fixtures are rejected as empty and fall back to the second provider', async () => {
  const changed = await fixture('socialcrawl', 'schema-change');
  const fallback = await fixture('scrapecreators', 'profile-success');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(calls === 1 ? changed : fallback);
  };
  const providers = createInstagramProviders({
    SOCIALCRAWL_API_KEY: 'fixture', SCRAPECREATORS_API_KEY: 'fixture'
  });
  const result = await providers.profile('fixture_style');
  assert.equal(result.provider, 'scrapecreators');
  assert.equal(result.fallbackErrors.length, 1);
  assert.match(result.fallbackErrors[0].message, /no author/);
});

for (const scenario of [
  { name: 'network error', response: () => { throw new TypeError('network unavailable'); } },
  { name: 'HTTP 404', response: async () => jsonResponse({ message: 'missing' }, 404) },
  { name: 'HTTP 408', response: async () => jsonResponse({ message: 'timeout' }, 408) },
  { name: 'HTTP 429', response: async () => jsonResponse({ message: 'limited' }, 429) },
  { name: 'HTTP 500', response: async () => jsonResponse({ message: 'temporary' }, 500) },
  { name: 'invalid JSON success', response: async () => new Response('<html>changed</html>', { status: 200 }) },
  { name: 'empty success', response: async () => jsonResponse({ data: {} }) }
]) {
  test(`profile falls back on ${scenario.name}`, async () => {
    const fallback = await fixture('scrapecreators', 'profile-success');
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1 ? scenario.response() : jsonResponse(fallback);
    };
    const providers = createInstagramProviders({
      SOCIALCRAWL_API_KEY: 'fixture', SCRAPECREATORS_API_KEY: 'fixture'
    });
    const result = await providers.profile('fixture_style');
    assert.equal(result.provider, 'scrapecreators');
    assert.equal(calls, 2);
    assert.equal(result.fallbackErrors.length, 1);
  });
}

test('non-retryable HTTP 400 stops fallback immediately', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ message: 'bad request' }, 400);
  };
  const providers = createInstagramProviders({
    SOCIALCRAWL_API_KEY: 'fixture', SCRAPECREATORS_API_KEY: 'fixture'
  });
  await assert.rejects(providers.profile('fixture_style'), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.fallbackErrors.length, 1);
    return true;
  });
  assert.equal(calls, 1);
});

test('provider-level not-found fixtures exhaust both profile providers', async () => {
  const social = await fixture('socialcrawl', 'error-not-found');
  const scrape = await fixture('scrapecreators', 'error-not-found');
  let calls = 0;
  globalThis.fetch = async () => jsonResponse(calls++ === 0 ? social : scrape);
  const providers = createInstagramProviders({
    SOCIALCRAWL_API_KEY: 'fixture', SCRAPECREATORS_API_KEY: 'fixture'
  });
  await assert.rejects(providers.profile('missing_fixture'), (error) => {
    assert.equal(error.message, 'All providers failed for profile');
    assert.equal(error.fallbackErrors.length, 2);
    return true;
  });
});

test('empty reels and transcript responses fall back to fixture results', async () => {
  const socialReels = await fixture('socialcrawl', 'reels-success');
  const scrapeTranscript = await fixture('scrapecreators', 'transcript-success');
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    if (String(url).includes('reels')) return jsonResponse(calls === 1 ? { items: [] } : socialReels);
    return jsonResponse(calls === 3 ? { transcript: '' } : scrapeTranscript);
  };
  const providers = createInstagramProviders({
    SOCIALCRAWL_API_KEY: 'fixture', SCRAPECREATORS_API_KEY: 'fixture'
  });
  const reels = await providers.reels('fixture_style', 1);
  assert.equal(reels.provider, 'socialcrawl');
  const transcript = await providers.transcript('https://www.instagram.com/reel/FIXTURE/');
  assert.equal(transcript.provider, 'scrapecreators');
  assert.equal(calls, 4);
});
