import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source Electron is never an install target. When updating from the test app,
// update the installed product instead, after checking its package identity.
export function updateAppTarget(execPath, productName, { exists = existsSync, read = readFileSync } = {}) {
  const match = String(execPath || '').match(/^(.*\.app)\/Contents\/MacOS\//);
  if (match?.[1].endsWith(`/${productName}.app`) && !match[1].startsWith('/Volumes/')) return match[1];
  const installed = `/Applications/${productName}.app`;
  if (!exists(installed)) return null;
  try {
    const pkg = JSON.parse(read(join(installed, 'Contents/Resources/app/package.json'), 'utf8'));
    return pkg.name === 'ortus-outreach' && pkg.productName === productName ? installed : null;
  } catch { return null; }
}
