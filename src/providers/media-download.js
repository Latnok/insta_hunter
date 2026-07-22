import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { raceWithSignal, signalWithTimeout } from '../lib/abort.js';

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export function createByteLimitStream(maxBytes = MAX_MEDIA_BYTES) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new Error('Media exceeds 25 MB') : null, chunk);
    }
  });
}

function isPublicIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (/^(?:fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8:')) return false;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPublicIpv4(mapped[1]) : true;
}

export function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version === 6) return isPublicIpv6(address);
  return false;
}

export async function resolveSafeMediaUrl(rawUrl, lookupFn = dns.lookup, signal) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Media URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Media URL protocol is not allowed');
  if (url.username || url.password) throw new Error('Media URL credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/.test(hostname)) {
    throw new Error('Media URL host is not allowed');
  }

  const literalVersion = net.isIP(hostname);
  const addresses = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await raceWithSignal(lookupFn(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some((item) => !isPublicIp(item.address))) {
    throw new Error('Media URL resolves to a non-public address');
  }
  return { url, addresses };
}

async function requestToFile(resolved, outputPath, { maxBytes, timeoutMs, signal: externalSignal }) {
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
      headers: { accept: 'video/*,audio/*,application/octet-stream' },
      servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      signal
    }, async (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url) });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Media download HTTP ${status}`));
        return;
      }
      const contentType = String(response.headers['content-type'] || '');
      if (contentType && !/^(?:audio|video)\//i.test(contentType) && !/octet-stream/i.test(contentType)) {
        response.resume();
        reject(new Error(`Unsupported media content type: ${contentType}`));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > maxBytes) {
        response.resume();
        reject(new Error('Media exceeds 25 MB'));
        return;
      }

      let received = 0;
      response.on('data', (chunk) => { received += chunk.length; });
      const limiter = createByteLimitStream(maxBytes);
      try {
        await pipeline(response, limiter, createWriteStream(outputPath, { flags: 'wx' }), { signal });
        resolve({ bytes: received });
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
    request.end();
  });
}

export async function downloadMediaToFile(rawUrl, outputPath, {
  lookupFn = dns.lookup,
  maxBytes = MAX_MEDIA_BYTES,
  timeoutMs = 180_000,
  maxRedirects = 3,
  signal
} = {}) {
  let current = rawUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    signal?.throwIfAborted();
    const resolved = await resolveSafeMediaUrl(current, lookupFn, signal);
    const result = await requestToFile(resolved, outputPath, { maxBytes, timeoutMs, signal });
    if (!result.redirect) return result;
    if (redirects === maxRedirects) throw new Error('Too many media redirects');
    current = result.redirect.href;
  }
  throw new Error('Too many media redirects');
}
