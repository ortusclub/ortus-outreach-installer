const cache = new Map();
export async function loadHistoryEvidence(entry, index, fetcher = fetch) {
  const id = entry.executionId || entry.runId;
  const key = `${id || entry.date}|${entry.duration}|${entry.totalProcessed}|${entry.endReason}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.evidence;
  const response = await fetcher(`/api/history/${index}/log${id ? `?executionId=${encodeURIComponent(id)}` : ''}`);
  if (!response.ok) throw new Error('Stored run log unavailable');
  const evidence = await response.json();
  if (id && evidence.executionId && evidence.executionId !== id) throw new Error('Run identity mismatch');
  cache.set(key, { evidence, at: Date.now() });
  if (cache.size > 256) cache.delete(cache.keys().next().value);
  return evidence;
}
