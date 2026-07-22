import { requestJson, shouldFallback } from './http.js';
import { canonicalInstagramUrl, normalizeInstagramUsername } from '../domain/accounts.js';
import { Semaphore } from '../lib/semaphore.js';

function unwrapItems(data) {
  return data?.items || data?.profiles || data?.data?.items || data?.data?.profiles || data?.data || [];
}

function normalizeProfile(provider, username, payload, meta) {
  const providerError = payload?.error || payload?.data?.error;
  if (payload?.success === false || providerError || (payload?.userId === null && payload?.message)) {
    const message = typeof providerError === 'string'
      ? providerError
      : providerError?.message || payload?.message || `${provider} profile was not found`;
    throw Object.assign(new Error(message), {
      emptyResult: true,
      statusCode: payload?.errorStatus || providerError?.status || 404,
      responseData: payload
    });
  }
  const author = payload?.data?.author || payload?.author || payload?.data?.user || payload?.user || payload?.data || payload;
  if (!author || Array.isArray(author) || !(author.username || author.handle || author.id || author.pk)) {
    throw Object.assign(new Error(`${provider} profile response has no author`), { emptyResult: true, responseData: payload });
  }
  return {
    status: 'available', provider, rawPayload: payload, requestMeta: meta,
    profile: {
      instagramId: String(author.id || author.pk || '') || null,
      username: String(author.username || author.handle || username).toLowerCase(),
      displayName: author.display_name || author.full_name || author.fullName || null,
      bio: author.bio || author.biography || null,
      avatarUrl: author.avatar_url || author.profile_pic_url || author.profilePicUrl || null,
      externalUrl: author.url || author.external_url || null,
      followers: author.followers ?? author.follower_count ?? author.edge_followed_by?.count ?? null,
      following: author.following ?? author.following_count ?? author.edge_follow?.count ?? null,
      postsCount: author.posts_count ?? author.media_count ?? null,
      verified: author.verified ?? author.is_verified ?? null,
      isPrivate: author.private ?? author.is_private ?? null,
      engagementRate: payload?.data?.computed?.engagement_rate ?? payload?.computed?.engagement_rate ?? null,
      language: payload?.data?.computed?.language ?? payload?.computed?.language ?? null,
      contentCategory: payload?.data?.computed?.content_category ?? payload?.computed?.content_category ?? null
    }
  };
}

function normalizeReel(provider, accountUsername, item) {
  const media = item?.media || item?.node || item;
  const shortcode = media.code || media.shortcode || null;
  const id = media.pk || media.id || media.media_id || null;
  if (!id && !shortcode) return null;
  const captionValue = media.caption?.text ?? media.caption ?? media.content ?? null;
  return {
    instagramMediaId: id == null ? null : String(id), shortcode,
    reelUrl: media.url || media.post_url || (shortcode ? `https://www.instagram.com/reel/${shortcode}/` : canonicalInstagramUrl(accountUsername)),
    caption: typeof captionValue === 'string' ? captionValue : null,
    publishedAt: media.taken_at ? new Date(Number(media.taken_at) * (Number(media.taken_at) < 1e12 ? 1000 : 1)) : media.published_at || media.timestamp || null,
    playCount: media.play_count ?? media.ig_play_count ?? media.video_view_count ?? media.views ?? null,
    likeCount: media.like_count ?? media.likes_count ?? media.engagement?.likes ?? null,
    commentCount: media.comment_count ?? media.comments_count ?? media.engagement?.comments ?? null,
    thumbnailUrl: media.thumbnail_url || media.display_url || media.display_uri || media.image_url
      || media.image_versions2?.candidates?.[0]?.url || null,
    mediaUrl: media.video_url || media.videoUrl || media.media_url || media.download_url
      || media.video_versions?.[0]?.url || media.videoVersions?.[0]?.url || null,
    provider, rawPayload: media
  };
}

function normalizeSearch(provider, payload) {
  return unwrapItems(payload).map((item) => {
    try {
      const username = normalizeInstagramUsername(item.username || item.handle || item.user?.username || '');
      return { username, url: item.url || canonicalInstagramUrl(username), raw: item, provider };
    } catch { return null; }
  }).filter(Boolean);
}

function normalizeTranscript(provider, payload, meta) {
  const text = payload?.data?.transcript || payload?.data?.text || payload?.transcript || payload?.text || payload?.content || '';
  return { status: text.trim() ? 'available' : 'empty', provider, text: text.trim() || null, rawPayload: payload, requestMeta: meta };
}

function createSocialCrawl(config) {
  const base = 'https://www.socialcrawl.dev/v1/instagram';
  const headers = { 'x-api-key': config.SOCIALCRAWL_API_KEY };
  return {
    name: 'socialcrawl', enabled: Boolean(config.SOCIALCRAWL_API_KEY),
    async search(query, limit, options = {}) { const r = await requestJson(`${base}/search/profiles`, { headers, query: { query, limit }, signal: options.signal }); return { items: normalizeSearch('socialcrawl', r.data), ...r }; },
    async profile(username, options = {}) { const r = await requestJson(`${base}/profile`, { headers, query: { handle: username }, signal: options.signal }); return normalizeProfile('socialcrawl', username, r.data, r.meta); },
    async reels(username, limit, options = {}) { const r = await requestJson(`${base}/profile/reels`, { headers, query: { handle: username, limit }, signal: options.signal }); return { items: unwrapItems(r.data).map((x) => normalizeReel('socialcrawl', username, x)).filter(Boolean), rawPayload: r.data, requestMeta: r.meta, provider: 'socialcrawl' }; },
    async transcript(reelUrl, options = {}) { const r = await requestJson(`${base}/media/transcript`, { headers, query: { url: reelUrl }, signal: options.signal }); return normalizeTranscript('socialcrawl', r.data, r.meta); }
  };
}

function createScrapeCreators(config) {
  const base = 'https://api.scrapecreators.com/v1/instagram';
  const headers = { 'x-api-key': config.SCRAPECREATORS_API_KEY };
  return {
    name: 'scrapecreators', enabled: Boolean(config.SCRAPECREATORS_API_KEY),
    async search(query, limit, options = {}) { const r = await requestJson(`${base}/search/profiles`, { headers, query: { query }, signal: options.signal }); return { items: normalizeSearch('scrapecreators', r.data).slice(0, limit), rawPayload: r.data, requestMeta: r.meta, provider: 'scrapecreators' }; },
    async profile(username, options = {}) { const r = await requestJson(`${base}/profile`, { headers, query: { handle: username }, signal: options.signal }); return normalizeProfile('scrapecreators', username, r.data, r.meta); },
    async reels(username, limit, options = {}) { const r = await requestJson(`${base}/user/reels`, { headers, query: { handle: username }, signal: options.signal }); return { items: unwrapItems(r.data).slice(0, limit).map((x) => normalizeReel('scrapecreators', username, x)).filter(Boolean), rawPayload: r.data, requestMeta: r.meta, provider: 'scrapecreators' }; },
    async transcript(reelUrl, options = {}) { const r = await requestJson(`${base}/post/transcript`, { headers, query: { url: reelUrl }, signal: options.signal }); return normalizeTranscript('scrapecreators', r.data, r.meta); }
  };
}

export function createInstagramProviders(config) {
  const social = createSocialCrawl(config);
  const scrape = createScrapeCreators(config);
  const limits = new Map([
    [social.name, new Semaphore(config.PROVIDER_CONCURRENCY || 2)],
    [scrape.name, new Semaphore(config.PROVIDER_CONCURRENCY || 2)]
  ]);
  async function fallback(operation, providers, args, options = {}) {
    const errors = [];
    for (const provider of providers.filter((item) => item.enabled)) {
      try {
        const result = await limits.get(provider.name).run(() => provider[operation](...args, options), options);
        if (operation === 'search' || operation === 'reels') {
          if (!result.items.length) throw Object.assign(new Error(`${provider.name} returned no items`), { emptyResult: true });
        }
        if (operation === 'transcript' && result.status !== 'available') throw Object.assign(new Error(`${provider.name} returned no transcript`), { emptyResult: true });
        return { ...result, fallbackErrors: errors };
      } catch (error) {
        errors.push({ provider: provider.name, message: error.message, statusCode: error.statusCode, payload: error.responseData });
        if (options.signal?.aborted) throw Object.assign(error, { fallbackErrors: errors });
        if (!error.emptyResult && !shouldFallback(error)) throw Object.assign(error, { fallbackErrors: errors });
      }
    }
    const error = new Error(`All providers failed for ${operation}`);
    error.fallbackErrors = errors;
    throw error;
  }
  return {
    search: (query, limit, options) => fallback('search', [scrape, social], [query, limit], options),
    profile: (username, options) => fallback('profile', [social, scrape], [username], options),
    reels: (username, limit, options) => fallback('reels', [scrape, social], [username, limit], options),
    transcript: (url, options) => fallback('transcript', [social, scrape], [url], options)
  };
}
