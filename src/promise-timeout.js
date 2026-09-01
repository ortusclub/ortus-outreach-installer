export async function withTimeout(promise, { ms, label = 'Operation', onTimeout } = {}) {
  const timeoutMs = Math.max(1, Number(ms) || 1);
  let timer;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch { /* timeout is authoritative */ }
        reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
