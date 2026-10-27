#!/usr/bin/env node
// Visits every page in config/sources.yaml, saves a snapshot of what it shows,
// and compares it with the snapshot from the previous visit.
//
// Usage: node src/check.js [--only <check-id>[,<check-id>...]]
//
// Writes:
//   data/snapshots/<check-id>.json     latest snapshot (git history keeps older ones)
//   data/runs/<run-id>/changes.json    raw differences found in this run
//   data/runs/LATEST                   the id of this run
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { chromium } = loadPlaywright();

const ROOT = path.resolve(__dirname, '..');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const TIMEZONE = 'Asia/Kuala_Lumpur';
const NAV_TIMEOUT = 60000;
const MAX_TEXT_LINES_IN_DIFF = 40;
// Failures that mean the host can't be reached at all (DNS, proxy refusal, reset).
const NETWORK_ERROR = /net::ERR_(TUNNEL_CONNECTION_FAILED|NAME_NOT_RESOLVED|CONNECTION_(RESET|REFUSED|CLOSED|TIMED_OUT)|PROXY_CONNECTION_FAILED|ADDRESS_UNREACHABLE)/;

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    // The cloud image ships Playwright globally rather than in node_modules.
    return require('/opt/node-tools/node_modules/playwright');
  }
}

function runId(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

function withTimeout(promise, ms) {
  return Promise.race([promise.catch(() => {}), new Promise(r => setTimeout(r, ms))]);
}

function parseArgs(argv) {
  const args = { only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = new Set(argv[++i].split(','));
  }
  return args;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match so short keywords such as "DTA" don't match inside other words.
function keywordMatcher(words) {
  const parts = words.map(w => {
    const e = escapeRegex(w);
    return `${/^\w/.test(w) ? '\\b' : ''}${e}${/\w$/.test(w) ? '\\b' : ''}`;
  });
  return new RegExp(parts.join('|'), 'i');
}

// Runs in the browser: returns the page's items (links with a readable label) and
// its visible text, leaving out the header, navigation menus and footer.
function extractPage(imageSelector) {
  const GENERIC = /^(more|read more|baca lagi|selanjutnya|lihat|view|details?|download|muat turun|pdf|click here|klik di sini|here|>+|»|›)$/i;
  const SKIP = 'header, nav, footer, [role=navigation], [role=banner], [role=contentinfo], script, style, noscript';
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  const anchors = [...document.querySelectorAll('a[href]')];
  let usable = anchors.filter(a => !a.closest(SKIP));
  if (usable.length === 0) usable = anchors;

  const items = [];
  const seen = new Set();
  for (const a of usable) {
    let href = a.href;
    if (!href || /^(mailto:|tel:)/i.test(href)) continue;
    // Script-driven links (e.g. CTIM's e-CTIM list) are kept, pointing at the page itself.
    const scripted = /^javascript:/i.test(href);
    if (scripted) href = location.href.split('#')[0];
    // In-page anchors such as "Skip to content" or "Scroll to top".
    else if (href.includes('#') && href.split('#')[0] === location.href.split('#')[0]) continue;
    // textContent also reads items in hidden tabs, which innerText skips.
    let label = norm(a.innerText || a.textContent || a.getAttribute('title') || a.getAttribute('aria-label'));
    if (scripted && (!label || GENERIC.test(label))) continue;
    // "More" / "Download" links: take the label from the surrounding row or card.
    if (!label || label.length < 12 || GENERIC.test(label)) {
      let el = a.parentElement;
      for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
        const t = norm(el.innerText || el.textContent);
        if (t.length > 400) break;
        if (t.length > label.length + 5) { label = t; break; }
      }
    }
    if (!label) continue;
    const key = `${label}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ label: label.slice(0, 400), href });
  }

  // Image-only content such as announcement banners in a slider.
  if (imageSelector) {
    for (const img of document.querySelectorAll(imageSelector)) {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src)) continue;
      seen.add(src);
      const alt = norm(img.alt);
      items.push({ label: `Image: ${alt && alt !== '...' ? alt : src.split('/').pop()}`, href: src, image: true });
    }
  }

  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(SKIP).forEach(n => n.remove());
  // innerText on a detached node ignores layout, so attach it hidden.
  clone.style.display = 'block';
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  const text = clone.innerText;
  holder.remove();

  return { title: document.title, items, text };
}

async function fetchPage(page, url, imageSelector = null) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const status = resp ? resp.status() : 0;
      if (status >= 400) throw new Error(`HTTP ${status}`);
      const data = await page.evaluate(extractPage, imageSelector);
      // Content inside iframes (some bulletin boards are embedded this way).
      for (const frame of page.frames()) {
        if (frame === page.mainFrame() || !frame.url().startsWith('http')) continue;
        if (new URL(frame.url()).host !== new URL(page.url()).host) continue;
        try {
          const f = await frame.evaluate(extractPage, imageSelector);
          data.items.push(...f.items);
          data.text += '\n' + f.text;
        } catch { /* cross-origin or detached frame */ }
      }
      data.finalUrl = page.url();
      return data;
    } catch (e) {
      lastError = e;
      if (NETWORK_ERROR.test(e.message)) break;
    }
  }
  throw new Error(String(lastError.message || lastError).split('\n')[0]);
}

function cleanLines(text, ignore) {
  const res = (ignore || []).map(r => new RegExp(r, 'i'));
  const out = [];
  const seen = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 3 || seen.has(line) || res.some(r => r.test(line))) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function filterItems(items, ignore) {
  const res = (ignore || []).map(r => new RegExp(r, 'i'));
  return items.filter(i => !res.some(r => r.test(i.label)));
}

async function resolveUrl(page, check, previous) {
  if (check.url) return check.url;
  if (previous && previous.url) return previous.url;
  const { from, link_text: texts = [], url_hint: hint } = check.discover || {};
  if (from) {
    try {
      await page.goto(from, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      const links = await page.$$eval('a[href]', as => as.map(a => ({
        text: (a.innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
        href: a.href,
      })));
      for (const t of texts) {
        const want = t.toLowerCase();
        const hit = links.find(l => l.text.toLowerCase() === want);
        if (hit && /^https?:/.test(hit.href)) return hit.href;
      }
    } catch { /* fall back to the hint */ }
  }
  if (hint) return hint;
  throw new Error('Could not find the page: no matching link and no url_hint');
}

// HASiL "Download Forms" pages are a search form (Category + Year). Records the
// years offered in the Year list, then searches all categories for the newest
// year and records the forms listed.
async function fetchHasilFormsPage(page, url) {
  const base = await fetchPage(page, url);
  const years = await page.$$eval('#crud-year-select option', os =>
    os.map(o => o.value).filter(v => /^\d{4}$/.test(v)).map(Number));
  if (!years.length) throw new Error('Year list not found on the forms page');
  const newest = Math.max(...years);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }),
    page.evaluate(year => {
      document.querySelector('#crud-cat-select').value = 'all';
      document.querySelector('#crud-year-select').value = String(year);
      document.querySelector('#crud-cat-select').form.submit();
    }, newest),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  const items = await page.$$eval('table', tables => {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const out = [];
    for (const t of tables) {
      const caption = norm((t.caption && t.caption.innerText) || (t.previousElementSibling && t.previousElementSibling.innerText) || '');
      for (const tr of t.querySelectorAll('tr')) {
        const a = tr.querySelector('a[href]');
        if (!a) continue;
        out.push({ label: norm(`${caption} | ${tr.innerText}`).slice(0, 400), href: a.href });
      }
    }
    return out;
  });
  const seen = new Set();
  const unique = items.filter(i => !seen.has(i.label + i.href) && seen.add(i.label + i.href));
  const category = (base.title || url).replace(/\s*[-–|].*$/, '').trim();
  return { title: base.title, items: unique, text: '', years, category, newest_year: newest };
}

// Forms mode: which years are listed for each form, e.g. "Form BE" -> [2024, 2025].
function formYears(items) {
  const forms = {};
  for (const { label } of items) {
    const years = label.match(/\b20\d\d\b/g);
    if (!years) continue;
    const key = label
      .replace(/\b(19|20)\d\d\b/g, '')
      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[\s\-–:|,]+$/, '')
      .trim()
      .slice(0, 120);
    if (!key) continue;
    forms[key] = [...new Set([...(forms[key] || []), ...years.map(Number)])].sort();
  }
  return forms;
}

async function snapshotCheck(page, check, previous) {
  const url = await resolveUrl(page, check, previous);
  const visit = u => (check.mode === 'hasil_forms' ? fetchHasilFormsPage(page, u) : fetchPage(page, u, check.images));
  const pages = [{ url, ...(await visit(url)) }];

  if (check.crawl) {
    const prefix = check.crawl.path_prefix;
    const max = check.crawl.max_pages || 30;
    const origin = new URL(url).origin;
    const queue = [...new Set(pages[0].items.map(i => i.href.split('#')[0]))].filter(h => {
      try {
        const u = new URL(h);
        return u.origin === origin && u.pathname.startsWith(prefix) && h !== url && !/\.(pdf|docx?|xlsx?|zip)$/i.test(u.pathname);
      } catch { return false; }
    });
    for (const sub of queue.slice(0, max)) {
      try {
        pages.push({ url: sub, ...(await visit(sub)) });
      } catch (e) {
        pages.push({ url: sub, error: e.message, items: [], text: '' });
      }
    }
  }

  const snapshot = {
    check_id: check.id,
    url,
    fetched_at: new Date().toISOString(),
    pages: pages.map(p => ({
      url: p.url,
      title: p.title || '',
      error: p.error,
      items: filterItems(p.items, check.ignore),
      lines: cleanLines(p.text, check.ignore),
    })),
  };
  if (check.mode === 'forms') {
    snapshot.forms = formYears(snapshot.pages.flatMap(p => p.items));
  } else if (check.mode === 'hasil_forms') {
    snapshot.forms = Object.fromEntries(pages.filter(p => p.years).map(p => [p.category, p.years]));
  }
  return snapshot;
}

function diffSnapshots(prev, curr, check, matcher) {
  const changes = { new_items: [], removed_items: [], text_changes: [], new_form_years: [], new_forms: [] };
  const prevPages = new Map(prev.pages.map(p => [p.url, p]));

  for (const p of curr.pages) {
    const old = prevPages.get(p.url);
    if (!old) {
      if (!p.error) changes.new_items.push({ page: p.url, label: `New page: ${p.title || p.url}`, href: p.url });
      continue;
    }
    if (p.error || old.error) continue;
    const oldKeys = new Set(old.items.map(i => `${i.label}|${i.href}`));
    const newKeys = new Set(p.items.map(i => `${i.label}|${i.href}`));
    const added = p.items.filter(i => !oldKeys.has(`${i.label}|${i.href}`));
    const removed = old.items.filter(i => !newKeys.has(`${i.label}|${i.href}`));
    changes.new_items.push(...added.map(i => ({ page: p.url, ...i })));
    changes.removed_items.push(...removed.map(i => ({ page: p.url, ...i })));

    // Text changes are only reported when no link changed, to keep noise down.
    if (added.length === 0 && removed.length === 0) {
      const oldLines = new Set(old.lines);
      const newLines = new Set(p.lines);
      const plus = p.lines.filter(l => !oldLines.has(l));
      const minus = old.lines.filter(l => !newLines.has(l));
      if (plus.length || minus.length) {
        changes.text_changes.push({
          page: p.url,
          added_lines: plus.slice(0, MAX_TEXT_LINES_IN_DIFF),
          removed_lines: minus.slice(0, MAX_TEXT_LINES_IN_DIFF),
        });
      }
    }
  }

  if (prev.forms && curr.forms) {
    for (const [form, years] of Object.entries(curr.forms)) {
      const before = prev.forms[form];
      if (!before) changes.new_forms.push({ form, years });
      else {
        const fresh = years.filter(y => !before.includes(y));
        if (fresh.length) changes.new_form_years.push({ form, new_years: fresh, previous_years: before });
      }
    }
  }

  if (matcher) {
    const keep = i => matcher.test(i.label);
    const dropped = changes.new_items.filter(i => !keep(i)).length;
    changes.new_items = changes.new_items.filter(keep);
    changes.removed_items = changes.removed_items.filter(keep);
    changes.text_changes = changes.text_changes
      .map(t => ({ ...t, added_lines: t.added_lines.filter(l => matcher.test(l)), removed_lines: t.removed_lines.filter(l => matcher.test(l)) }))
      .filter(t => t.added_lines.length || t.removed_lines.length);
    changes.not_relevant_count = dropped;
  }

  const has = changes.new_items.length || changes.removed_items.length || changes.text_changes.length
    || changes.new_form_years.length || changes.new_forms.length;
  return has ? changes : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = yaml.load(fs.readFileSync(path.join(ROOT, 'config', 'sources.yaml'), 'utf8'));
  const matchers = Object.fromEntries(
    Object.entries(config.keyword_lists || {}).map(([k, v]) => [k, keywordMatcher(v)]),
  );
  fs.mkdirSync(SNAP_DIR, { recursive: true });

  const id = runId();
  const result = {
    run_id: id,
    started_at: new Date().toISOString(),
    timezone: TIMEZONE,
    changed: [],
    unchanged: [],
    baselined: [],
    needs_login: [],
    errors: [],
  };

  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    locale: 'en-MY',
    timezoneId: TIMEZONE,
  });
  // Hosts that failed at network level; their other checks are skipped this run.
  const deadHosts = new Map();

  for (const source of config.sources) {
    for (const check of source.checks) {
      if (args.only && !args.only.has(check.id)) continue;
      const meta = { source: source.name, check_id: check.id, section: check.section };
      if (check.requires_login) {
        result.needs_login.push({ ...meta, url: check.url || source.url });
        continue;
      }
      const checkUrl = check.url || (check.discover && check.discover.url_hint) || source.url;
      const host = new URL(checkUrl).host;
      if (deadHosts.has(host)) {
        result.errors.push({ ...meta, url: checkUrl, error: deadHosts.get(host) });
        console.log(`${check.id} ... skipped (${host} unreachable)`);
        continue;
      }
      const snapFile = path.join(SNAP_DIR, `${check.id}.json`);
      const previous = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : null;
      process.stdout.write(`${check.id} ... `);
      // A fresh tab per check, so a failed navigation can't affect the next one.
      const page = await context.newPage();
      try {
        const snap = await snapshotCheck(page, check, previous);
        const reachable = snap.pages[0] && !snap.pages[0].error;
        if (!reachable) throw new Error(snap.pages[0].error || 'no content');
        // A check whose page changed in the config starts again from a new baseline.
        if (!previous || previous.url !== snap.url) {
          result.baselined.push({ ...meta, url: snap.url, items: snap.pages.reduce((n, p) => n + p.items.length, 0) });
          console.log('baseline saved');
        } else {
          const diff = diffSnapshots(previous, snap, check, check.keywords ? matchers[check.keywords] : null);
          if (diff) {
            result.changed.push({ ...meta, url: snap.url, ...diff });
            console.log('CHANGED');
          } else {
            result.unchanged.push({ ...meta, url: snap.url });
            console.log('no change');
          }
        }
        fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2) + '\n');
      } catch (e) {
        // Keep the previous snapshot so the next successful visit compares against it.
        result.errors.push({ ...meta, url: checkUrl, error: e.message });
        if (NETWORK_ERROR.test(e.message)) deadHosts.set(host, e.message);
        console.log(`ERROR: ${e.message}`);
      } finally {
        // page.close() can hang after a failed navigation, so don't wait on it forever.
        await withTimeout(page.close(), 5000);
      }
    }
  }

  await withTimeout(browser.close(), 10000);
  result.finished_at = new Date().toISOString();

  const runDir = path.join(RUNS_DIR, id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'changes.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(RUNS_DIR, 'LATEST'), id + '\n');
  console.log(`\nRun ${id}: ${result.changed.length} changed, ${result.unchanged.length} unchanged, `
    + `${result.baselined.length} baselined, ${result.needs_login.length} need sign-in, ${result.errors.length} errors`);
  console.log(`Wrote ${path.relative(ROOT, path.join(runDir, 'changes.json'))}`);
}

main().then(() => process.exit(0), e => {
  console.error(e);
  process.exit(1);
});
