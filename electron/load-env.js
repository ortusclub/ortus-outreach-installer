// Load .env BEFORE any other module evaluates.
//
// CRITICAL ORDERING: src/sheets-webapp-url.js captures process.env.FG_WEBAPP_URL
// (and friends) at MODULE-LOAD time — `export const FG_WEBAPP_URL =
// process.env.FG_WEBAPP_URL || <hardcoded default>`. That module is pulled in
// transitively during the Electron main import phase (main.js → log-writer.js →
// sheets-webapp-url.js), which runs BEFORE main.js's body. If dotenv only ran in
// main.js's body (as it used to), the capture had already fallen back to the
// hardcoded default and the operator's .env override was silently ignored — so
// FG_WEBAPP_URL pointed at the shared default script (no listTabs/getSheetUrl),
// breaking the "bring your own" tab dropdown while budgets/fgState still worked.
//
// Importing this side-effect module FIRST in main.js guarantees the env is
// populated before any of those constants are read. ESM evaluates a module's
// imports depth-first in source order, so "first import" == "runs first".
//
// Dev:      <repo>/.env
// Packaged: process.resourcesPath/.env   (shipped via electron-builder extraResources)
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.resourcesPath ? resolve(process.resourcesPath, '.env') : null, // packaged build
  resolve(__dirname, '..', '.env'),                                      // dev (repo root)
].filter(Boolean);

for (const p of candidates) {
  if (existsSync(p)) { dotenv.config({ path: p }); break; }
}
