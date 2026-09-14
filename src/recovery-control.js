// Recovery must not turn an absent UI activity flag into proof of shutdown.
export async function confirmRecoveryShutdown({ generation, stop, close, tracking, status, currentGeneration,
  timeoutMs = 5000 }) {
  let timer;
  const attempt = (async () => {
    const results = await Promise.all([Promise.resolve().then(stop), Promise.resolve().then(close), Promise.resolve().then(tracking)]);
    if (results[1]?.browserClosed !== true || results[2]?.ok !== true) return { ok: false, reason: 'shutdown-unconfirmed' };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (currentGeneration() !== generation) return { ok: false, reason: 'superseded' };
      const s = status();
      if (!s.running && s.state !== 'monitoring' && !s.monitoringCheckInProgress) return { ok: true, generation };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { ok: false, reason: 'foreground-unconfirmed' };
  })().catch(error => ({ ok: false, reason: 'shutdown-failed', error: error.message }));
  try {
    return await Promise.race([attempt, new Promise(resolve => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'shutdown-unconfirmed' }), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function unresolvedHandoverLeads(leads) {
  return (Array.isArray(leads) ? leads : []).filter(lead =>
    ['claimed', 'in_progress', 'interrupted', 'needs_review', 'needs-review'].includes(lead?.status));
}

export async function waitForDestinationStart({ started, failure, timeoutMs = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const error = failure();
    if (error) return { ok: false, error: String(error.message || error) };
    if (started()) return { ok: true, destinationStarted: true };
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return { ok: false, pending: true, error: 'Destination startup is not yet confirmed. Source remains released; inspect destination status before retrying.' };
}
