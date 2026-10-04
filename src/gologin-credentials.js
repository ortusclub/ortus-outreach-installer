import { sharedGoLoginStatus } from './shared-gologin.js';
import { getWorkspaceVerification } from './gologin-credential-check.js';
/**
 * src/gologin-credentials.js — operator-entered GoLogin workspace tokens.
 *
 * Ortus Basics 1.0. The packaged app ships with NO secrets: the DMG can be
 * handed to anyone and is worth nothing on its own. Each person pastes the
 * tokens they have into Settings, and what they can drive follows from that —
 * GL_ACCOUNTS already gates every workspace on its env var being present, so
 * a missing Linked Velocity token simply means that workspace contributes no
 * profiles. Somebody with the LV token pastes it and those accounts appear in
 * the picker; somebody without it never sees them.
 *
 * Stored in the app's own data directory (ORTUS_DATA_DIR — under
 * ~/Library/Application Support/<productName> in a packaged build), never in
 * the repo and never inside the bundle. tokenForAccount() reads process.env at
 * call time, so applying a saved token is a live mutation: no restart.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dataPath } from './paths.js';
import { GL_ACCOUNTS, setCustomAccounts, setOperatorCredentialAccounts } from './gologin-accounts.js';

const FILE = () => dataPath('gologin-credentials.json');

// Operator-added workspaces live under this key as [{ label, token }]. Their
// env names are derived, never supplied, so nothing from the request body can
// name an arbitrary environment variable.
const OTHERS_KEY = '_others';
const otherEnv = (id) => `GOLOGIN_API_TOKEN_OTHER_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;
const workspaceId = (o, i) => /^other[\w-]+$/.test(o?.id || '') ? o.id : otherId(i);
const otherId  = (i) => `other${i + 1}`;

/** Every token this app understands, in the order Settings should show them. */
export function credentialFields() {
  return GL_ACCOUNTS.map((a) => ({
    id: a.id,
    label: a.label,
    env: a.env,
    // Ortus is the fallback workspace for any unrecognised login, so without it
    // there is no roster at all. The others are genuinely optional.
    required: a.id === 'ortus',
  }));
}

export function readCredentials() {
  try {
    const p = FILE();
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (err) {
    console.warn(`[credentials] could not read: ${err.message}`);
    return {};
  }
}

/** Saved Settings take precedence over shipped defaults, including removals. */
export function applyCredentials(creds = readCredentials()) {
  const applied = [];
  for (const f of credentialFields()) {
    const v = String(creds[f.env] || '').trim();
    if (Object.hasOwn(creds, f.env)) {
      if (v) { process.env[f.env] = v; applied.push(f.id); }
      else delete process.env[f.env];
    }
  }
  // Register the operator's own workspaces, then put their tokens in place.
  const others = Array.isArray(creds[OTHERS_KEY]) ? creds[OTHERS_KEY] : [];
  const kept = others.filter((o) => o && String(o.token || '').trim());
  setCustomAccounts(kept.map((o, i) => ({
    id: workspaceId(o, i), label: String(o.label || `Other ${i + 1}`), env: otherEnv(workspaceId(o, i)),
  })));
  kept.forEach((o, i) => {
    process.env[otherEnv(workspaceId(o, i))] = String(o.token).trim();
    applied.push(workspaceId(o, i));
  });
  setOperatorCredentialAccounts(applied);
  return applied;
}

/** The operator's own workspaces, without their tokens. */
export function readOthers() {
  const others = readCredentials()[OTHERS_KEY];
  return (Array.isArray(others) ? others : [])
    .filter((o) => o && String(o.token || '').trim())
    .map((o, i) => ({ id: workspaceId(o, i), label: String(o.label || `Other ${i + 1}`), hint: `••••${String(o.token).trim().slice(-4)}`, verification: getWorkspaceVerification(workspaceId(o, i)) }));
}

/** Replace the whole custom-workspace list. Entries: { label, token }. */
export function saveOthers(list) {
  const creds = readCredentials();
  // A saved token is never sent to the browser, so the client cannot re-send it.
  // It marks rows to preserve as { keep: '<id>' } and the token is resolved here
  // from what is already on disk. Anything with an explicit token is new.
  const prevList = Array.isArray(creds[OTHERS_KEY]) ? creds[OTHERS_KEY] : [];
  const byId = new Map(prevList
    .filter((o) => o && String(o.token || '').trim())
    .map((o, i) => [workspaceId(o, i), { ...o, id: workspaceId(o, i) }]));
  const clean = (Array.isArray(list) ? list : [])
    .map((o) => {
      const explicit = String(o?.token || '').trim();
      if (explicit) return { id: `other-${randomUUID()}`, label: String(o?.label || '').trim(), token: explicit };
      const kept = o?.keep ? byId.get(String(o.keep)) : null;
      return kept ? { id: kept.id, label: String(o?.label || kept.label || '').trim(), token: String(kept.token).trim() } : null;
    })
    .filter((o) => o && o.token)
    .slice(0, 10); // a picker, not a directory
  // Clear the previous slots out of the environment before renumbering, or a
  // removed workspace would linger as a live token.
  prevList.forEach((o, i) => { delete process.env[otherEnv(workspaceId(o, i))]; });
  creds[OTHERS_KEY] = clean;
  const p = FILE();
  writeFileSync(`${p}.tmp`, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  applyCredentials(creds);
  return readOthers();
}

export function saveCredentials(input) {
  const creds = readCredentials();
  for (const f of credentialFields()) {
    if (!(f.env in input)) continue;
    const v = String(input[f.env] ?? '').trim();
    creds[f.env] = v; // Empty is an explicit removal, including bundled defaults.
    // Apply immediately, overwriting whatever was live — this IS the operator
    // changing the answer, so the environment must not win here.
    if (v) process.env[f.env] = v; else delete process.env[f.env];
  }
  const p = FILE();
  writeFileSync(`${p}.tmp`, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${p}.tmp`, p);
  applyCredentials(creds);
  return creds;
}

/** Settings needs to show WHICH tokens are set without ever echoing them. */
export function credentialStatus() {
  const creds = readCredentials();
  return credentialFields().map((f) => {
    const v = String(process.env[f.env] || creds[f.env] || '').trim();
    return {
      id: f.id,
      label: f.label,
      env: f.env,
      required: f.required,
      set: !!v || sharedGoLoginStatus(f.id).active,
      shared: !v && sharedGoLoginStatus(f.id).active,
      sharedEligible: sharedGoLoginStatus(f.id).eligible,
      sharedMessage: !v ? sharedGoLoginStatus(f.id).message : '',
      verification: getWorkspaceVerification(f.id),
      // Enough to recognise a token, useless to steal.
      hint: v ? `••••${v.slice(-4)}` : '',
      fromEnvironment: !!process.env[f.env] && !creds[f.env],
    };
  });
}
