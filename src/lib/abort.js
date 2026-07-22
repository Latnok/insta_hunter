export function abortReason(signal, fallback = 'Operation aborted') {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(String(signal?.reason || fallback), 'AbortError');
}

export function signalWithTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
