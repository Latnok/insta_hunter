import http from 'node:http';
import https from 'node:https';
import { signalWithTimeout } from '../lib/abort.js';
import { resolveSafeMediaUrl } from './media-download.js';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const allowedContentType = /^image\/(?:avif|gif|jpeg|png|webp)(?:\s*;|$)/i;

function requestImage(resolved, { maxBytes, timeoutMs, signal: externalSignal }) {
  const { url, addresses } = resolved;
  const pinned = addresses[0];
  const transport = url.protocol === 'https:' ? https : http;
  const signal = signalWithTimeout(externalSignal, timeoutMs);

  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8,*/*;q=0.1',
        referer: 'https://www.instagram.com/',
        'user-agent': 'Mozilla/5.0 (compatible; InstagramHunter/0.2)'
      },
      servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      signal
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Image download HTTP ${status}`));
        return;
      }

      const contentType = String(response.headers['content-type'] || '').trim();
      if (!allowedContentType.test(contentType)) {
        response.resume();
        reject(new Error('Upstream response is not a supported image'));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) {
        response.resume();
        reject(new Error('Image exceeds 8 MB'));
        return;
      }

      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(new Error('Image exceeds 8 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => resolve({
        body: Buffer.concat(chunks),
        contentType: contentType.split(';')[0].toLowerCase()
      }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}

export async function downloadImage(rawUrl, {
  lookupFn,
  maxBytes = MAX_IMAGE_BYTES,
  timeoutMs = 15_000,
  maxRedirects = 3,
  signal
} = {}) {
  let current = rawUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    signal?.throwIfAborted();
    const resolved = await resolveSafeMediaUrl(current, lookupFn, signal);
    const result = await requestImage(resolved, { maxBytes, timeoutMs, signal });
    if (!result.redirect) return result;
    if (redirects === maxRedirects) throw new Error('Too many image redirects');
    current = result.redirect.href;
  }
  throw new Error('Too many image redirects');
}
