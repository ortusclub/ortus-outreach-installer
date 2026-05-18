/**
 * Single source of truth for the Apps Script web app URL.
 *
 * Hard-coded so EVERY operator's Electron app POSTs to the SAME Apps Script
 * deployment (Antonio's). The .env value SHEETS_WEBAPP_URL is IGNORED — even
 * if an operator sets it locally, this constant wins.
 *
 * Why centralized:
 *   Before v2.52.0 each operator deployed their own copy of google-apps-script.js
 *   under their own Google account, and deployments drifted out of sync — one
 *   operator could be running an old revision while another was on the latest.
 *   Centralizing means every operator hits the same code automatically.
 *
 * Operational requirement:
 *   The Apps Script runs as the deployer (Antonio). For it to write to ANY
 *   operator's Google Sheet, that sheet must be shared "anyone with the link
 *   can edit". Operators are responsible for setting that permission on every
 *   sheet they configure in the app.
 */
export const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwZu0ormMlS2IfC7yarIZDBz0XJj_FbOcp5omJTWQPCGsQ8YO3_npqGUQojNc1fmHyXCg/exec';
