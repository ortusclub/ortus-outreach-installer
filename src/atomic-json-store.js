import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';

const lanes = new Map();

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch {
    try {
      const recovered = JSON.parse(await readFile(`${path}.bak`, 'utf8'));
      try { await copyFile(path, `${path}.corrupt-${Date.now()}`); } catch {}
      return recovered;
    } catch { return structuredClone(fallback); }
  }
}

async function preserveLastGood(path) {
  try {
    JSON.parse(await readFile(path, 'utf8'));
    await copyFile(path, `${path}.bak`);
  } catch { /* missing or corrupt files must not replace the recovery copy */ }
}

export function writeJsonAtomic(path, value) {
  const previous = lanes.get(path) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await preserveLastGood(path);
    await rename(tmp, path);
  });
  lanes.set(path, next);
  return next.finally(() => { if (lanes.get(path) === next) lanes.delete(path); });
}

export function updateJsonAtomic(path, fallback, mutate) {
  const previous = lanes.get(path) || Promise.resolve();
  let result;
  const next = previous.catch(() => {}).then(async () => {
    const current = await readJson(path, fallback);
    result = await mutate(current);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await preserveLastGood(path);
    await rename(tmp, path);
  });
  lanes.set(path, next);
  return next.then(() => result).finally(() => { if (lanes.get(path) === next) lanes.delete(path); });
}
