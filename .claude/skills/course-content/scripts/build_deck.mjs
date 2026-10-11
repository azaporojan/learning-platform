#!/usr/bin/env node
// Build a lesson deck: slide HTML → PDF (+ PNG previews and a contact sheet), fully offline.
//
//   node build_deck.mjs deck.html [--out deck.pdf] [--png dir] [--sheet sheet.png]
//
// The deck is plain HTML: one <section class="slide"> per slide (see assets/deck-template.html).
// The builder adds, so the deck file stays short:
//   - the course theme (assets/deck-theme.css) and local fonts (Inter, JetBrains Mono);
//   - icons: <i data-icon="bug"></i> → inline Lucide SVG (https://lucide.dev/icons);
//   - diagrams: <pre class="mermaid">…</pre> rendered by a local Mermaid;
//   - footers: <body data-footer="QA Automation · Урок 2.1"> + page numbers (skip with data-no-footer).
// Then it checks every slide for overflowing content and prints all links, so they can be verified.
//
// Needs: npm install --prefix <this dir>; Chromium at $CHROMIUM_PATH or /opt/pw-browsers/chromium.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, 'package.json'));
const mod = (p) => dirname(require.resolve(`${p}/package.json`));
let chromium;
try { ({ chromium } = require('playwright-core')); } catch {
  console.error(`Dependencies missing. Run: npm install --prefix ${HERE}`); process.exit(2);
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const outPdf = opt('--out'); const pngDir = opt('--png'); const sheet = opt('--sheet');
const input = args[0];
if (!input) { console.error('usage: node build_deck.mjs deck.html [--out deck.pdf] [--png dir] [--sheet sheet.png]'); process.exit(2); }
const deckPath = resolve(input);
const pdfPath = resolve(outPdf || deckPath.replace(/\.html?$/i, '.pdf'));

// ---- 1. preprocess the HTML -------------------------------------------------------------------
let html = readFileSync(deckPath, 'utf8');
const url = (p) => pathToFileURL(p).href;

const iconDir = join(mod('lucide-static'), 'icons');
const missing = new Set();
html = html.replace(/<i\s+data-icon="([a-z0-9-]+)"([^>]*)>\s*<\/i>/g, (_, name, rest) => {
  const f = join(iconDir, `${name}.svg`);
  if (!existsSync(f)) { missing.add(name); return `<b style="color:red">[icon ${name}?]</b>`; }
  const cls = (rest.match(/class="([^"]*)"/) || [])[1];
  const style = (rest.match(/style="([^"]*)"/) || [])[1];
  return readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    .replace('class="lucide', `${style ? `style="${style}" ` : ''}class="${cls ? cls + ' ' : ''}lucide`).trim();
});
if (missing.size) {
  console.error(`Unknown icons: ${[...missing].join(', ')}. Names are listed in ${iconDir} (or https://lucide.dev/icons).`);
  process.exit(1);
}

const inter = mod('@fontsource/inter'); const mono = mod('@fontsource/jetbrains-mono');
const head = [
  ...['400', '500', '700', '800'].map((w) => `<link rel="stylesheet" href="${url(join(inter, `${w}.css`))}">`),
  ...['400', '700'].map((w) => `<link rel="stylesheet" href="${url(join(mono, `${w}.css`))}">`),
  `<link rel="stylesheet" href="${url(join(HERE, '..', 'assets', 'deck-theme.css'))}">`,
];
const hasMermaid = /class="[^"]*\bmermaid\b/.test(html);
if (hasMermaid) {
  head.push(`<script src="${url(join(mod('mermaid'), 'dist', 'mermaid.min.js'))}"></script>`);
  head.push(`<script>
    mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose',
      flowchart: { htmlLabels: true, curve: 'basis', padding: 14 },
      themeVariables: { fontFamily: 'Inter, sans-serif', fontSize: '18px', primaryColor: '#e6f2f0',
        primaryBorderColor: '#0f766e', primaryTextColor: '#1f2933', lineColor: '#52606d',
        secondaryColor: '#ffffff', tertiaryColor: '#fafaf7', clusterBkg: '#ffffff', clusterBorder: '#d9dee3',
        noteBkgColor: '#fdf3e2', noteBorderColor: '#d97706', actorBkg: '#e6f2f0', actorBorder: '#0f766e' } });
    window.addEventListener('load', () => mermaid.run().then(() => { window.__mermaidDone = true; },
      (e) => { window.__mermaidError = String(e); window.__mermaidDone = true; }));
  </script>`);
}
html = html.includes('</head>') ? html.replace('</head>', `${head.join('\n')}\n</head>`) : head.join('\n') + html;

const buildPath = join(dirname(deckPath), `.${basename(deckPath)}.build.html`); // next to the deck: relative images keep working
writeFileSync(buildPath, html);

// ---- 2. render ---------------------------------------------------------------------------------
const exe = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium'].find(existsSync);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('requestfailed', (r) => { if (!r.url().startsWith('data:')) problems.push(`failed to load ${r.url()} (no network for decks: keep assets local)`); });
await page.goto(url(buildPath), { waitUntil: 'load' });
if (hasMermaid) {
  await page.waitForFunction(() => window.__mermaidDone, null, { timeout: 30000 });
  const err = await page.evaluate(() => window.__mermaidError);
  if (err) problems.push(`mermaid: ${err}`);
}
await page.evaluate(() => document.fonts.ready);

// footers + page numbers, then the overflow check
const report = await page.evaluate(() => {
  const slides = [...document.querySelectorAll('section.slide')];
  const footer = document.body.dataset.footer || '';
  slides.forEach((s, i) => {
    if (s.hasAttribute('data-no-footer')) return;
    const f = document.createElement('div'); f.className = 'footer';
    f.innerHTML = `<span></span><span>${i + 1} / ${slides.length}</span>`;
    f.firstChild.textContent = footer; s.appendChild(f);
  });
  const issues = [];
  slides.forEach((s, i) => {
    const box = s.getBoundingClientRect();
    const limitBottom = box.bottom - 46; // keep clear of the footer line
    for (const el of s.querySelectorAll('*')) {
      if (el.closest('.footer') || el.closest('svg') && el.tagName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const over = r.bottom > limitBottom + 1 || r.right > box.right - 20 || r.left < box.left;
      const clipped = el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflow === 'hidden' && el.clientHeight > 0;
      if (over || clipped) {
        issues.push({ slide: i + 1, what: over ? 'outside the safe area' : 'clipped content',
          el: `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? ` class="${el.className}"` : ''}> ${(el.textContent || '').trim().slice(0, 60)}` });
        break; // one issue per slide is enough to send you back to it
      }
    }
  });
  const links = [...document.querySelectorAll('a[href]')].map((a) => ({
    slide: slides.indexOf(a.closest('section.slide')) + 1, href: a.href, text: a.textContent.trim().slice(0, 60) }));
  return { count: slides.length, issues, links };
});

await page.pdf({ path: pdfPath, width: '1280px', height: '720px', printBackground: true, preferCSSPageSize: true });

// ---- 3. previews -------------------------------------------------------------------------------
if (pngDir || sheet) {
  const dir = resolve(pngDir || join(dirname(pdfPath), '.deck-png'));
  mkdirSync(dir, { recursive: true });
  const shots = [];
  const slides = await page.$$('section.slide');
  for (let i = 0; i < slides.length; i++) {
    const f = join(dir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    await slides[i].screenshot({ path: f }); shots.push(f);
  }
  if (sheet) {
    const cols = 4; const w = 400; const h = 225;
    const grid = `<body style="margin:0;background:#cfd4da;display:grid;grid-template-columns:repeat(${cols},${w}px);gap:8px;padding:8px;font:12px sans-serif">${
      shots.map((s, i) => `<div style="position:relative"><img src="${url(s)}" style="width:${w}px;height:${h}px;display:block"><span style="position:absolute;left:4px;top:4px;background:#000a;color:#fff;padding:0 4px">${i + 1}</span></div>`).join('')}</body>`;
    const sheetHtml = join(dir, 'sheet.html'); writeFileSync(sheetHtml, grid);
    const p2 = await browser.newPage({ viewport: { width: cols * (w + 8) + 8, height: 200 } });
    await p2.goto(url(sheetHtml)); await p2.screenshot({ path: resolve(sheet), fullPage: true });
  }
  if (!pngDir) rmSync(dir, { recursive: true, force: true });
}
await browser.close();
rmSync(buildPath, { force: true });

// ---- 4. report ---------------------------------------------------------------------------------
console.log(`PDF: ${pdfPath} (${report.count} slides)`);
if (sheet) console.log(`Contact sheet: ${resolve(sheet)}`);
for (const p of problems) console.log(`PROBLEM ${p}`);
for (const i of report.issues) console.log(`OVERFLOW slide ${i.slide}: ${i.what}: ${i.el}`);
if (report.links.length) {
  console.log('Links (verify each one resolves and says what the slide claims):');
  for (const l of report.links) console.log(`  slide ${l.slide}: ${l.href}  [${l.text}]`);
}
process.exit(problems.length || report.issues.length ? 1 : 0);
