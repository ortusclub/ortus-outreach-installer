/**
 * Notifier — sends campaign notifications via Email.
 *
 * Configure via env vars:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   NOTIFY_EMAILS — comma-separated list of recipients
 */

import nodemailer from 'nodemailer';

export async function initNotifier() {
  // No-op for now — kept for symmetry and future transport initialization.
}

function getRecipients() {
  const raw = (process.env.NOTIFY_EMAILS || '').trim();
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  const fallback = process.env.SMTP_FROM || process.env.SMTP_USER;
  return fallback ? [fallback] : [];
}

let emailTransport = null;

function getEmailTransport() {
  if (emailTransport !== null) return emailTransport;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    emailTransport = false;
    return false;
  }
  emailTransport = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass },
  });
  return emailTransport;
}

async function sendOne(to, { title, body, link }) {
  const t = getEmailTransport();
  if (!t) return { ok: false, error: 'SMTP not configured' };
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `[Ortus] ${title}`,
      text: body + (link ? `\n\n${link}` : ''),
    });
    return { ok: true };
  } catch (err) {
    console.warn('[notifier] email error:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function notifyAll({ title, body, link }) {
  const recipients = getRecipients();
  if (!recipients.length) return { sent: 0, reason: 'no recipients configured' };
  const results = await Promise.all(recipients.map((to) => sendOne(to, { title, body, link })));
  const sent = results.filter((r) => r.ok).length;
  return { sent, total: recipients.length };
}

// Send to a specific recipient — used when the notification has a clear owner
// (schedule creator, campaign runner, current user clicking a button).
export async function notifyEmail(to, { title, body, link }) {
  if (!to) return { sent: 0, reason: 'no recipient' };
  const result = await sendOne(to, { title, body, link });
  return result.ok
    ? { sent: 1, total: 1 }
    : { sent: 0, total: 1, error: result.error };
}

// In-memory ring buffer of recent notifications, polled by the renderer to
// fire native browser-push (desktop) notifications. Server-side state only —
// not persisted; on restart the renderer just starts watching from "now".
const DESKTOP_BUFFER_CAP = 50;
const desktopBuffer = [];
let _nextId = 1;

export function enqueueDesktopNotification({ title, body, link, audience }) {
  const item = {
    id: _nextId++,
    ts: Date.now(),
    title: title || '',
    body: body || '',
    link: link || '',
    audience: audience || null, // null = broadcast (all signed-in users see it)
  };
  desktopBuffer.push(item);
  if (desktopBuffer.length > DESKTOP_BUFFER_CAP) desktopBuffer.shift();
  return item;
}

export function getRecentNotifications({ sinceTs = 0, audience = null } = {}) {
  return desktopBuffer.filter((n) => {
    if (n.ts <= sinceTs) return false;
    if (n.audience && audience && n.audience !== audience) return false;
    return true;
  });
}
