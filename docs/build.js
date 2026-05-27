#!/usr/bin/env node
/**
 * Builds docs/Ortus-Outreach-Manual.pdf from docs/manual.md + docs/template.html.
 *
 * Usage:  node docs/build.js
 *
 * Dependencies (auto-installed by the Makefile / npm script):
 *   - marked          (Markdown → HTML)
 *   - puppeteer-core  (HTML → PDF via system Chrome; already in package.json)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { marked } from 'marked';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MANUAL_MD = resolve(__dirname, 'manual.md');
const TEMPLATE_HTML = resolve(__dirname, 'template.html');
const OUT_PDF = resolve(__dirname, 'Ortus-Outreach-Manual.pdf');
const OUT_HTML = resolve(__dirname, '.manual.rendered.html'); // kept for debugging

// ─── Chrome discovery ────────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'Could not find a Chrome/Chromium binary.\n' +
    'Set PUPPETEER_EXECUTABLE_PATH to your Chrome path, e.g.:\n' +
    '  PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node docs/build.js'
  );
}

// ─── Build ───────────────────────────────────────────────────────────────
async function main() {
  console.log('[build] Reading inputs…');

  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf-8'));
  const version = pkg.version || '0.0.0';

  const today = new Date();
  const date = today.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const [md, template] = await Promise.all([
    readFile(MANUAL_MD, 'utf-8'),
    readFile(TEMPLATE_HTML, 'utf-8'),
  ]);

  // ─── Markdown → HTML ───
  marked.setOptions({
    gfm: true,
    breaks: false,
    pedantic: false,
  });

  // Replace placeholders in the MD first (so they flow through to the rendered HTML)
  const mdWithMeta = md
    .replaceAll('{{VERSION}}', `v${version}`)
    .replaceAll('{{DATE}}', date);

  let content = marked.parse(mdWithMeta);

  // Rewrite relative image paths to file:// so puppeteer can load them from disk.
  content = content.replaceAll(
    /src="(screenshots\/[^"]+)"/g,
    (_, p) => `src="file://${resolve(__dirname, p)}"`
  );

  // Handle the one markdown image with width attribute (img.inline-right)
  // Pattern: ![alt](url){width=240px .inline-right} → <img src="url" class="inline-right" style="width:240px">
  // marked doesn't natively parse the {attrs} suffix; we strip it and add the class/style.
  content = content.replace(
    /<img ([^>]*?)src="([^"]+)"([^>]*?)alt="([^"]*)"([^>]*?)>(\{[^}]+\})?/g,
    (m, pre, src, mid, alt, post, attrs) => {
      if (!attrs) return m;
      const hasRight = attrs.includes('.inline-right');
      const widthMatch = attrs.match(/width=([^\s}]+)/);
      const cls = hasRight ? ' class="inline-right"' : '';
      const style = widthMatch ? ` style="width:${widthMatch[1]}"` : '';
      return `<img src="${src}" alt="${alt}"${cls}${style}>`;
    }
  );

  // Same content may appear with attrs after the closing paren in raw form — clean up.
  content = content.replace(/\{width=[^}]+\}/g, '');

  // ─── Template → HTML ───
  const html = template
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{DATE}}', date)
    .replace('{{CONTENT}}', content);

  await writeFile(OUT_HTML, html, 'utf-8');
  console.log(`[build] Rendered HTML → ${OUT_HTML}`);

  // ─── HTML → PDF ───
  const execPath = findChrome();
  console.log(`[build] Using Chrome at: ${execPath}`);
  console.log('[build] Launching headless Chrome…');

  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: 'new',
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Load the rendered HTML directly from disk so file:// image URLs resolve.
    await page.goto(`file://${OUT_HTML}`, { waitUntil: 'networkidle0' });

    // Ensure webfonts are ready before rendering the PDF.
    await page.evaluateHandle('document.fonts.ready');

    console.log('[build] Rendering PDF…');
    await page.pdf({
      path: OUT_PDF,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false, // @page rules in CSS handle headers/footers
    });

    console.log(`[build] ✓ PDF ready → ${OUT_PDF}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[build] ✗ Failed:', err.message);
  process.exit(1);
});
