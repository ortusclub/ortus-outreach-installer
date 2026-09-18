import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagePath = new URL('../package.json', import.meta.url);
const lockPath = new URL('../package-lock.json', import.meta.url);
const htmlPath = new URL('../public/index.html', import.meta.url);

const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!match) throw new Error(`Expected four-part app version, got ${pkg.version}`);

const next = `${match[1]}.${match[2]}.${match[3]}.${Number(match[4]) + 1}`;
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const html = readFileSync(htmlPath, 'utf8');
const oldAsset = `?v=${pkg.version}`;
if (!html.includes(oldAsset)) throw new Error(`No HTML asset URLs use ${oldAsset}`);

pkg.version = next;
lock.version = next;
lock.packages[''].version = next;
writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
writeFileSync(htmlPath, html.replaceAll(oldAsset, `?v=${next}`));
console.log(`App version ${next} (${root})`);
