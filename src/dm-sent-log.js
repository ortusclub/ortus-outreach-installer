// Cross-campaign record of which CC+DM messages have already been sent to
// each lead, keyed by LinkedIn public id. Lets the auto-DM pass skip
// re-sending an IDENTICAL message to someone we've already messaged with that
// exact text — even across different campaigns/sheets. Per-machine state
// (lives in the local data dir, same as bulk-check cooldown + drafts).
//
// NOTE: this is content-level dedup only. The pre-existing "DM Sent" terminal
// skip (campaign.js candidate filter) still short-circuits any row already
// stamped DM Sent — this module only fires for leads that reach the auto-DM
// pass without that stamp (e.g. an already-connected lead on a fresh sheet).
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { dataPath } from './paths.js';

const DM_LOG_FILE = dataPath('dm-sent-log.json');

// Compact, exact fingerprint of a rendered message. Trivial whitespace
// differences (CRLF, trailing spaces) are normalized so re-rendering the same
// template for the same person counts as identical.
export function dmFingerprint(message) {
  const norm = String(message || '').replace(/\r\n/g, '\n').trim();
  return createHash('sha1').update(norm).digest('hex');
}

async function _read() {
  try { return JSON.parse(await readFile(DM_LOG_FILE, 'utf8')); }
  catch { return {}; }
}

async function _write(map) {
  try {
    await mkdir(dirname(DM_LOG_FILE), { recursive: true });
    const tmp = DM_LOG_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
    await rename(tmp, DM_LOG_FILE);
  } catch (err) {
    console.warn(`[dm-sent-log] write failed: ${err.message}`);
  }
}

// Has this EXACT message already been sent to this lead before?
export async function hasDmBeenSent(leadKey, message) {
  if (!leadKey) return false;
  const map = await _read();
  const fps = map[leadKey];
  return Array.isArray(fps) && fps.includes(dmFingerprint(message));
}

// Record that we sent this message to this lead.
export async function recordDmSent(leadKey, message) {
  if (!leadKey) return;
  const map = await _read();
  const fp = dmFingerprint(message);
  const fps = Array.isArray(map[leadKey]) ? map[leadKey] : [];
  if (!fps.includes(fp)) fps.push(fp);
  map[leadKey] = fps;
  await _write(map);
}
