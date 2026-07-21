export async function requestJson(url, { method = 'GET', headers = {}, query, body, timeoutMs = 60_000 } = {}) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query || {})) if (value != null) target.searchParams.set(key, String(value));
  const started = Date.now();
  let response;
  try {
    response = await fetch(target, {
      method, headers: { accept: 'application/json', ...headers },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    error.durationMs = Date.now() - started;
    throw error;
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  const meta = {
    status: response.status, durationMs: Date.now() - started,
    requestId: response.headers.get('x-request-id') || response.headers.get('x-groq-id') || null
  };
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
    Object.assign(error, { statusCode: response.status, responseData: data, requestMeta: meta });
    throw error;
  }
  return { data, meta };
}

export function shouldFallback(error) {
  return !error.statusCode || error.statusCode === 404 || error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500;
}
