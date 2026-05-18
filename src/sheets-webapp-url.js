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
 *     deployer, Antonio) can read/write it.
 */

// Apps Script web app deployment — the single endpoint every operator's app
// POSTs to for sheet reads/writes. Deployed under Antonio's Google account.
export const SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwZu0ormMlS2IfC7yarIZDBz0XJj_FbOcp5omJTWQPCGsQ8YO3_npqGUQojNc1fmHyXCg/exec';

// State of Operations sheet — the team-wide dashboard of which LinkedIn
// account is in use / cooling off / banned. Drives the SoO panel in the app
// and the signup allowlist. One sheet for everyone.
export const SOO_SHEET_ID = '1t49JaZppDZZNIUuOv2QQw7j1MCZC8vMMy1uZe_AkLwI';
export const SOO_SHEET_GID = '992076199';
