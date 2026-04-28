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
};
