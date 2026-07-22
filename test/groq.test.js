import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

import { runFfmpeg, transcribeWithGroq } from '../src/providers/groq.js';
import {
  createByteLimitStream,
  createPinnedLookup,
  isPublicIp,
  resolveSafeMediaUrl
} from '../src/providers/media-download.js';

const config = {
  GROQ_API_KEY: 'fixture-key',
  GROQ_WHISPER_MODEL: 'whisper-fixture',
  GROQ_WHISPER_LANGUAGE: 'ru'
};

async function withTempRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'instagram-hunter-test-root-'));
  try {
    await callback(root);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Groq URL transcription does not create temporary files', async () => {
  await withTempRoot(async (tempRoot) => {
    const result = await transcribeWithGroq(config, 'https://cdn.example.com/video.mp4', {
      tempRoot,
      groqRequest: async (_config, form) => {
        assert.equal(form.get('url'), 'https://cdn.example.com/video.mp4');
        return { text: 'url transcript' };
      }
    });
    assert.equal(result.text, 'url transcript');
    assert.deepEqual(result.providerAttempts.map(({ provider, outcome }) => ({ provider, outcome })), [
      { provider: 'groq-whisper-url', outcome: 'succeeded' }
    ]);
  });
});

test('Groq file fallback removes temporary files after success', async () => {
  await withTempRoot(async (tempRoot) => {
    let calls = 0;
    const result = await transcribeWithGroq(config, 'https://cdn.example.com/video.mp4', {
      tempRoot,
      groqRequest: async (_config, form) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('URL unsupported'), { statusCode: 400 });
        assert.ok(form.get('file') instanceof Blob);
        return { text: 'file transcript' };
      },
      downloadMedia: async (_url, output) => writeFile(output, 'media'),
      runFfmpeg: async (_input, output) => writeFile(output, 'audio')
    });
    assert.equal(result.text, 'file transcript');
    assert.equal(calls, 2);
    assert.deepEqual(result.providerAttempts.map(({ provider, outcome }) => ({ provider, outcome })), [
      { provider: 'groq-whisper-url', outcome: 'failed' },
      { provider: 'groq-whisper-file', outcome: 'succeeded' }
    ]);
  });
});

for (const stage of ['download', 'ffmpeg', 'groq-file']) {
  test(`temporary files are removed after ${stage} failure`, async () => {
    await withTempRoot(async (tempRoot) => {
      let calls = 0;
      await assert.rejects(() => transcribeWithGroq(config, 'https://cdn.example.com/video.mp4', {
        tempRoot,
        groqRequest: async () => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error('URL unsupported'), { statusCode: 400 });
          throw new Error('file transcription failed');
        },
        downloadMedia: async (_url, output) => {
          if (stage === 'download') throw new Error('download failed');
          await writeFile(output, 'media');
        },
        runFfmpeg: async (_input, output) => {
          if (stage === 'ffmpeg') throw new Error('ffmpeg failed');
          await writeFile(output, 'audio');
        }
      }), (error) => {
        assert.match(error.message, new RegExp(stage === 'groq-file' ? 'file transcription' : stage));
        assert.deepEqual(error.providerAttempts.map(({ provider, outcome }) => ({ provider, outcome })), [
          { provider: 'groq-whisper-url', outcome: 'failed' },
          { provider: 'groq-whisper-file', outcome: 'failed' }
        ]);
        return true;
      });
    });
  });
}

test('private, loopback and metadata media URLs are rejected before download', async () => {
  for (const url of [
    'http://127.0.0.1/video.mp4',
    'http://10.0.0.2/video.mp4',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/video.mp4'
  ]) {
    await withTempRoot(async (tempRoot) => {
      await assert.rejects(() => transcribeWithGroq(config, url, {
        tempRoot,
        groqRequest: async () => { throw Object.assign(new Error('URL unsupported'), { statusCode: 400 }); }
      }), /non-public address/);
    });
  }
});

test('DNS results are all validated before a media connection is allowed', async () => {
  await assert.rejects(
    resolveSafeMediaUrl('https://cdn.example.com/video.mp4', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]),
    /non-public address/
  );
  const resolved = await resolveSafeMediaUrl('https://cdn.example.com/video.mp4', async () => [
    { address: '93.184.216.34', family: 4 }
  ]);
  assert.equal(resolved.addresses[0].address, '93.184.216.34');
  assert.equal(isPublicIp('93.184.216.34'), true);
  assert.equal(isPublicIp('192.168.1.1'), false);
});

test('pinned DNS lookup supports Node single-address and all-address callback modes', () => {
  const pinned = { address: '203.0.113.8', family: 4 };
  const lookup = createPinnedLookup(pinned);

  lookup('cdn.example', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, pinned.address);
    assert.equal(family, pinned.family);
  });
  lookup('cdn.example', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [pinned]);
  });
  lookup('cdn.example', (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, pinned.address);
    assert.equal(family, pinned.family);
  });
});

test('shutdown abort interrupts DNS resolution before media download', async () => {
  const controller = new AbortController();
  const pending = resolveSafeMediaUrl(
    'https://cdn.example.com/video.mp4',
    async () => new Promise(() => {}),
    controller.signal
  );
  controller.abort(new DOMException('worker stopping', 'AbortError'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('shutdown abort kills an in-flight ffmpeg process', async () => {
  const controller = new AbortController();
  let killedWith;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { killedWith = signal; };
  const pending = runFfmpeg('input', 'output', {
    signal: controller.signal,
    spawnImpl: () => child,
    timeoutMs: 60_000
  });
  controller.abort(new DOMException('worker stopping', 'AbortError'));
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(killedWith, 'SIGKILL');
});

test('streaming byte limiter stops chunked media at the configured boundary', async () => {
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await assert.rejects(
    pipeline(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), createByteLimitStream(10), sink),
    /Media exceeds 25 MB/
  );
});
