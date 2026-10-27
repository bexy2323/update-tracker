#!/usr/bin/env node
// Prints the readable text of a page or PDF, so an update can be read in full
// when writing its summary.
//
// Usage: node src/peek.js <url> [max-chars]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return require('/opt/node-tools/node_modules/playwright');
  }
}

async function main() {
  const [url, maxArg] = process.argv.slice(2);
  if (!url) throw new Error('Usage: node src/peek.js <url> [max-chars]');
  const max = Number(maxArg) || 15000;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let text;
  try {
    // curl honours the environment's proxy settings; Playwright's request API does not.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'peek-')), 'doc');
    const type = execFileSync('curl', ['-sSL', '-m', '60', '-A', 'Mozilla/5.0', '-o', file, '-w', '%{content_type}', url], { encoding: 'utf8' });
    if (type.includes('pdf') || /\.pdf($|\?)/i.test(url)) {
      text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const links = await page.$$eval('main a[href], article a[href], .content a[href]', as =>
        as.map(a => `${(a.innerText || '').trim()} -> ${a.href}`).filter(s => !s.startsWith(' ->')));
      text = `TITLE: ${await page.title()}\nURL: ${page.url()}\n\n${await page.innerText('body')}`
        + (links.length ? `\n\nLINKS:\n${[...new Set(links)].join('\n')}` : '');
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(text.slice(0, max) + (text.length > max ? `\n[... ${text.length - max} more characters]` : '') + '\n');
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
