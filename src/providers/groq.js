import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { downloadMediaToFile } from './media-download.js';
import { abortReason, signalWithTimeout } from '../lib/abort.js';

async function groqRequest(config, form, { signal } = {}) {
  const started = Date.now();
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { authorization: `Bearer ${config.GROQ_API_KEY}` }, body: form,
    signal: signalWithTimeout(signal, 300_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `Groq HTTP ${response.status}`), { statusCode: response.status, responseData: data });
  return { text: data.text?.trim() || null, rawPayload: data, requestMeta: { status: response.status, durationMs: Date.now() - started, requestId: data?.x_groq?.id || null } };
}

function baseForm(config) {
  const form = new FormData();
  form.set('model', config.GROQ_WHISPER_MODEL);
  form.set('language', config.GROQ_WHISPER_LANGUAGE);
  form.set('response_format', 'verbose_json');
  form.set('temperature', '0');
  return form;
}

export function runFfmpeg(input, output, { spawnImpl = spawn, timeoutMs = 180_000, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', '600', '-ar', '16000', '-ac', '1', '-c:a', 'flac', output], { windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('ffmpeg timed out'));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, abortReason(signal, 'ffmpeg aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => code === 0
      ? finish(resolve)
      : finish(reject, new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 1000)}`)));
  });
}

async function downloadAndTranscribe(config, mediaUrl, dependencies = {}) {
  const { signal } = dependencies;
  signal?.throwIfAborted();
  const tempDir = await mkdtemp(path.join(dependencies.tempRoot || os.tmpdir(), 'instagram-hunter-'));
  try {
    const input = path.join(tempDir, 'input.media');
    const output = path.join(tempDir, 'audio.flac');
    await (dependencies.downloadMedia || downloadMediaToFile)(mediaUrl, input, { signal });
    await (dependencies.runFfmpeg || runFfmpeg)(input, output, { signal });
    const audio = await readFile(output);
    const form = baseForm(config);
    form.set('file', new Blob([audio], { type: 'audio/flac' }), 'audio.flac');
    // Await before leaving the try block so a rejected provider request is
    // observed while asynchronous cleanup in finally is still running.
    return await (dependencies.groqRequest || groqRequest)(config, form, { signal });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function transcribeWithGroq(config, mediaUrl, dependencies = {}) {
  if (!config.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured');
  const form = baseForm(config);
  form.set('url', mediaUrl);
  try { return await (dependencies.groqRequest || groqRequest)(config, form, { signal: dependencies.signal }); }
  catch (error) {
    if (dependencies.signal?.aborted) throw error;
    if (![400, 413, 422].includes(error.statusCode)) throw error;
    return await downloadAndTranscribe(config, mediaUrl, dependencies);
  }
}
