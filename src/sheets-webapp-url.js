/**
 * Centralized config for shared Google Sheets infrastructure.
 *
 * Every value in this file is hard-coded so EVERY operator's Electron app
 * resolves to the same sheet / endpoint regardless of what's in their local
 * .env. Any matching .env values are IGNORED.
 *
 * Why centralized:
 *   Before v2.52.0, each operator pasted their own Apps Script URL + SoO sheet
 *   ID into a local .env. Newer operators often skipped this step ("Ask Antonio
 *   for values" in .env.example) and silently ran without SoO. Centralizing
 *   means everyone hits the same infrastructure without per-operator setup.
 *
 * Operational requirement:
 *   - Every Google Sheet referenced from the app must be shared
 *     "anyone with the link can edit" so the Apps Script (running as the
 *     deployer, mickey@ortusclub.com) can read/write it.
 */

// Apps Script web app deployment — the single endpoint every operator's app
// POSTs to for sheet reads/writes. Deployed under mickey@ortusclub.com.
// Container-bound to: "ORTUS OUTREACH - DO NOT DELETE"
//   https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM
export const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwwWhFXBLKke7HBJfwr-9e3Cv2Rv9oZh8BePxgCJSgKRGFm6Bu3e4hGLtOQeyjcLIPPnA/exec';

// Ortus gateway (Cloud Run) — shared with Ortus Basics. The app uses only its
// ORIGIN: GET /auth/config (public Google OAuth client id for the desktop PKCE
// flow), GET /auth/me (verifies a Google id_token and its Workspace domain),
// and POST /auth/email/{start,verify} (one-time email codes for signup and
// password reset; the gateway holds the SMTP credentials). Nothing here needs
// a per-operator .env value.
export const SHEETS_GATEWAY_URL = 'https://ortus-sheets-gateway-329664205285.asia-southeast1.run.app/bridge';

// State of Operations sheet — the team-wide dashboard of which LinkedIn
// account is in use / cooling off / banned. Drives the SoO panel in the app
// and the signup allowlist. One sheet for everyone.
export const SOO_SHEET_ID = '1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI';
export const SOO_SHEET_GID = '992076199';

// v2.56.0 — Operations Log + Campaign Activity Apps Script deployments.
// Centralized so every operator's app posts to the same team-wide log
// sheets, not to per-operator .env URLs (which Sam and new colleagues
// won't have set). Without these centralized, log-writer.js silently
// no-op'd for everyone except Antonio.
//
// Both deployed under mickey@ortusclub.com. The target Google Sheets
// must be shared "anyone with the link can edit" so the Apps Script
// can append rows on every operator's behalf.
// Container-bound to: "OPS AND LOGS - ORTUS OUTREACH - DO NOT DELETE"
//   https://docs.google.com/spreadsheets/d/1AC0xM8EfjHNApa_PnedrC1t5hw6UWMnuUI1Ox2edmzI
export const OPS_LOG_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxslZ__sz1PpWnFlQNhN9J2islicSU7vhM3Hu-AfdDvd-FfuFM_hiAFIZCBpo-s3uef/exec';
// Container-bound to: "CAMPAIGN ACTIVITY - ORTUS OUTREACH - DO NOT DELETE"
//   https://docs.google.com/spreadsheets/d/1NZtZdhwqoYMHzk0nC5sQWlsOg3ij0sZpWYUZMO79dOQ
export const CAMPAIGN_LOG_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxkxZIUZvddWp_Z5bKj5ryt968VlDdzv7UyGjnqKfBh2b7QfEfeWD7FG3g9z3p_AQlpCA/exec';

// v2.57.x — Domains allowed to sign up to the Ortus Outreach app (operator
// login). Replaces the previous "must be in the SoO sheet" check, which was
// wrong: the SoO sheet is keyed to LinkedIn-account-owner emails (e.g.
// jigar.chaudhary@ortus.solutions), not operator emails (e.g.
// sam@ortusclub.com). Anyone with a Google Workspace email on one of these
// domains is on the team and can sign up. SOO_BYPASS_EMAILS env stays as
// an escape hatch for emergency / non-domain access.
export const SIGNUP_ALLOWED_DOMAINS = ['ortusclub.com', 'ortus.solutions'];

// Per-email signup allowlist — individual external collaborators granted access
// WITHOUT opening their whole domain. Kept lowercase; matched exactly.
export const SIGNUP_ALLOWED_EMAILS = ['milee@linkedvelocity.com', 'jhan@apexstrategy.io'];

// v2.113 — Follower Growth campaign. SEPARATE Apps Script deployment from the
// master outreach script: it owns the central FG sheet (FG Invites / FG Budgets
// / FG Funnel). Paste fg-apps-script.js into a NEW Apps Script project, deploy
// as a web app ("execute as me", "anyone with the link"), and put its /exec URL
// here. Until then the app surfaces a friendly "not configured" error.
// A local FG_WEBAPP_URL env var overrides this (for testing against your own
// deployed copy without editing the committed default) — mirrors SCRAPER_ENGINE_URL.
export const FG_WEBAPP_URL = process.env.FG_WEBAPP_URL || 'https://script.google.com/macros/s/AKfycbz1PgDi1I2n9iDdOO2v968GiI_bhHOaKuAqwoHyJT2azxzgDKCueywjUGuLbbTZhhEekQ/exec';

// Operation Magellan. A THIRD Apps Script deployment, bound to its own
// "Operation Magellan" sheet — deliberately not the outreach sheet and not the
// FG one (the FG jobs hold that script's lock for minutes at a time).
// Container-bound to: "Operation Magellan"
//   https://docs.google.com/spreadsheets/d/1bAWvQ7xq6Iuke3tEpcCOMM_cNcCLMAbzcc5wUESBhls
// Deployed under antoniov@ortusclub.com (still working as of 2026-09-28).
// Newer deployment (Sep 25): https://script.google.com/macros/s/AKfycbzV4Aaf5rPK42R3B0RCplpW1ZSZ9LNdQo0-Lyjp3TdjNpbXj0wztD4_mDzQaL9LrtWR/exec
export const MAGELLAN_WEBAPP_URL = process.env.MAGELLAN_WEBAPP_URL || 'https://script.google.com/macros/s/AKfycbyxj7ySr0MxECDf8PQHWVi8ks93WxPCqWsEe4YZo02Ie3zuo0mSL5p3gU0n9JYM4Ypr/exec';

// Follower Growth Phase 2 — the Ortus Club page "Invite to follow" modal URL.
// The ?invite=true query opens the invite modal directly; the /posts/ path +
// feedView=all is the exact URL confirmed to open it for this page (slug ortus-club).
export const ORTUS_PAGE_INVITE_URL = 'https://www.linkedin.com/company/ortus-club/posts/?feedView=all&invite=true';
