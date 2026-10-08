// Workaround for electron-builder aggressively relocating hoisted transitive
// deps. Specifically, `call-bind-apply-helpers` is required by `dunder-proto`
// at top-level node_modules but electron-builder moves it inside
// `call-bind/node_modules/` because it can't see dunder-proto's runtime
// require. This hook copies any such packages back to the top level.

const fs = require('node:fs');
const path = require('node:path');

const NEEDED_AT_TOP_LEVEL = [
  'call-bind-apply-helpers',
];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

exports.default = async function afterPack(context) {
  const appDir = context.appOutDir; // e.g. dist/mac-arm64
  const appName = context.packager.appInfo.productFilename;
  const resourcesApp = path.join(appDir, `${appName}.app`, 'Contents', 'Resources', 'app');
  const nodeModulesDir = path.join(resourcesApp, 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) return;

  for (const pkg of NEEDED_AT_TOP_LEVEL) {
    const topLevel = path.join(nodeModulesDir, pkg);
    if (fs.existsSync(topLevel)) continue;

    // Find any nested copy and clone it to the top level.
    const queue = fs.readdirSync(nodeModulesDir).map(n => path.join(nodeModulesDir, n));
    let source = null;
    while (queue.length && !source) {
      const dir = queue.shift();
      const nested = path.join(dir, 'node_modules', pkg);
      if (fs.existsSync(nested)) { source = nested; break; }
    }

    if (source) {
      copyDirSync(source, topLevel);
      console.log(`[after-pack] Restored top-level ${pkg} from ${source}`);
    } else {
      console.warn(`[after-pack] WARNING: ${pkg} not found anywhere — skipping`);
    }
  }

  // Inject secrets that must ship in the DMG but must NOT live in git. The
  // committed build/release.env (copied to Contents/Resources/.env by
  // extraResources) carries only non-secret config; keys below are read from the
  // GITIGNORED repo .env at build time and appended to the packed bundle's .env.
  // So every DMG can run e.g. the Magellan→HubSpot import without the write-token
  // ever entering git history. Best-effort: a missing key just means the DMG
  // ships without it (and warns), never a failed build.
  try {
    const INJECT_KEYS = ['HUBSPOT_TOKEN'];
    const bundledEnv = path.join(appDir, `${appName}.app`, 'Contents', 'Resources', '.env');
    const repoEnv = path.join(process.cwd(), '.env');
    if (fs.existsSync(bundledEnv) && fs.existsSync(repoEnv)) {
      const repoLines = fs.readFileSync(repoEnv, 'utf8').split('\n');
      let bundled = fs.readFileSync(bundledEnv, 'utf8');
      let changed = false;
      for (const key of INJECT_KEYS) {
        if (new RegExp(`^${key}=`, 'm').test(bundled)) continue; // already present
        const line = repoLines.find((l) => l.startsWith(`${key}=`) && l.slice(key.length + 1).trim());
        if (line) {
          bundled = bundled.replace(/\n*$/, '\n') + line.trim() + '\n';
          changed = true;
          console.log(`[after-pack] injected ${key} into bundled .env (from gitignored repo .env)`);
        } else {
          console.warn(`[after-pack] WARNING: ${key} not in repo .env — this DMG ships without it`);
        }
      }
      if (changed) fs.writeFileSync(bundledEnv, bundled);
    } else if (!fs.existsSync(repoEnv)) {
      console.warn('[after-pack] no repo .env — skipping secret injection (DMG ships with committed config only)');
    }
  } catch (e) {
    console.warn(`[after-pack] secret injection skipped: ${e.message}`);
  }
};
