// Auth module — user store, password hashing, signed-cookie sessions, SoO allowlist.
//
// Users are stored in data/users.json as { email: { passwordHash, createdAt } }.
// Sessions are HMAC-signed cookies carrying the email + expiry (no server-side
// session table needed — restart-safe, Vercel-friendly).
//
// The SoO sheet acts as the allowlist: only emails present in column A of the
// sheet can sign up. The existing DASHBOARD_USERS env var still works as a
// fallback so current logins don't break during migration.

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { fetchSoOData } from './soo.js';
import { dataPath } from './paths.js';

const USERS_PATH = dataPath('users.json');
const SECRET_PATH = dataPath('.session-secret');

const COOKIE_NAME = 'ortus_session';
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// ── Session secret ─────────────────────────────────────────────────
let _secret = null;
async function getSecret() {
  if (_secret) return _secret;
  if (process.env.SESSION_SECRET) {
    _secret = process.env.SESSION_SECRET;
    return _secret;
  }
  try {
    _secret = (await readFile(SECRET_PATH, 'utf-8')).trim();
    if (_secret) return _secret;
  } catch {}
  _secret = crypto.randomBytes(32).toString('hex');
  await mkdir(dirname(SECRET_PATH), { recursive: true });
  await writeFile(SECRET_PATH, _secret, 'utf-8');
  return _secret;
}

// ── User store ─────────────────────────────────────────────────────
async function loadUsers() {
  try {
    return JSON.parse(await readFile(USERS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveUsers(users) {
  await mkdir(dirname(USERS_PATH), { recursive: true });
  await writeFile(USERS_PATH, JSON.stringify(users, null, 2), 'utf-8');
}

export async function createUser(email, password) {
  const normalized = email.trim().toLowerCase();
  const users = await loadUsers();
  if (users[normalized]) throw new Error('Account already exists for this email');
  const passwordHash = await bcrypt.hash(password, 10);
  users[normalized] = { passwordHash, createdAt: new Date().toISOString() };
  await saveUsers(users);
  return normalized;
}

export async function verifyCredentials(email, password) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !password) return null;

  const users = await loadUsers();
  const user = users[normalized];
  if (user && user.passwordHash) {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (ok) return normalized;
  }

  // Fallback: DASHBOARD_USERS env var (legacy plaintext). Lets existing logins
  // keep working until everyone has migrated.
  const raw = (process.env.DASHBOARD_USERS || '').trim();
  if (raw) {
    for (const pair of raw.split(',')) {
      const [e, p] = pair.split(':');
      if ((e || '').trim().toLowerCase() === normalized && (p || '').trim() === password) {
        return normalized;
      }
    }
  }
  if (process.env.DASHBOARD_USER && process.env.DASHBOARD_PASS) {
    if (process.env.DASHBOARD_USER.trim().toLowerCase() === normalized
      && process.env.DASHBOARD_PASS === password) {
      return normalized;
    }
  }
  return null;
}

export async function userExists(email) {
  const normalized = (email || '').trim().toLowerCase();
  const users = await loadUsers();
  return Boolean(users[normalized]);
}

// ── Signed cookie sessions ─────────────────────────────────────────
// Token format: base64url(JSON).HMAC-hex. No server-side table needed.
async function signToken(payload) {
  const secret = await getSecret();
  const body = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const secret = await getSecret();
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export async function issueSessionCookie(res, email) {
  const token = await signToken({ email, exp: Date.now() + COOKIE_MAX_AGE_MS });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export async function readSessionFromRequest(req) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = await verifyToken(token);
  return payload?.email || null;
}

// ── SoO allowlist ──────────────────────────────────────────────────
// Uses the shared src/soo.js helper so timeout, error-shape, and redirect
// handling match /api/soo-status exactly.
export async function fetchAllowedEmails() {
  const data = await fetchSoOData();
  const set = new Set();
  for (const acc of data.accounts || []) {
    const e = (acc.email || '').trim().toLowerCase();
    if (e && e.includes('@')) set.add(e);
  }
  return set;
}

export async function isEmailAllowed(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized.includes('@')) return false;

  // SOO_BYPASS_EMAILS — comma-separated allowlist that skips the SoO check.
  // For dev / emergency access when the SoO sheet is unreachable or
  // unconfigured. Listed emails are still subject to the per-user store.
  const bypassRaw = (process.env.SOO_BYPASS_EMAILS || '').trim();
  if (bypassRaw) {
    const bypass = new Set(
      bypassRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    );
    if (bypass.has(normalized)) return true;
  }

  const allowed = await fetchAllowedEmails();
  return allowed.has(normalized);
}
