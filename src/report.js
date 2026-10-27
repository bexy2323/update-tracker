#!/usr/bin/env node
// Compiles a run's updates into the report formats.
//
// Usage: node src/report.js [<run-id>]   (defaults to data/runs/LATEST)
//
// Reads:
//   data/runs/<run-id>/changes.json   written by src/check.js
//   data/runs/<run-id>/updates.json   written by the agent: the reviewed updates
// Writes:
//   reports/<run-id>.md               Markdown report
//   reports/<run-id>.html             HTML report (also used as the email body)
//   reports/updates-log.xlsx          every update from every run, one row each
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const REPORTS_DIR = path.join(ROOT, 'reports');
const LOG_FILE = path.join(REPORTS_DIR, 'updates-log.xlsx');

const COLUMNS = [
  { header: 'Run', key: 'run_id', width: 16 },
  { header: 'Source', key: 'source', width: 28 },
  { header: 'Section', key: 'section', width: 30 },
  { header: 'Title', key: 'title', width: 50 },
  { header: 'Publication date', key: 'publication_date', width: 16 },
  { header: 'Type', key: 'change_type', width: 14 },
  { header: 'What changed', key: 'summary', width: 70 },
  { header: 'Replaces / supersedes', key: 'replaces', width: 40 },
  { header: 'Link', key: 'link', width: 50 },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function md(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function groupBySource(updates) {
  const groups = new Map();
  for (const u of updates) {
    if (!groups.has(u.source)) groups.set(u.source, []);
    groups.get(u.source).push(u);
  }
  return groups;
}

function heading(changes) {
  const [date, time] = changes.run_id.split('_');
  return `Website update check: ${date} ${time.slice(0, 2)}:${time.slice(2)} (MYT)`;
}

function buildMarkdown(changes, updates) {
  const out = [`# ${heading(changes)}`, ''];
  out.push(`**${updates.length} update(s) found.** `
    + `${changes.unchanged.length} page(s) unchanged, ${changes.baselined.length} baselined, `
    + `${changes.errors.length} unreachable, ${changes.needs_login.length} need your sign-in.`, '');

  if (updates.length) {
    for (const [source, list] of groupBySource(updates)) {
      out.push(`## ${source}`, '');
      for (const u of list) {
        out.push(`### ${u.title}`, '');
        out.push(`- **Section:** ${u.section}`);
        out.push(`- **Publication date:** ${u.publication_date || 'Not stated'}`);
        out.push(`- **Type:** ${u.change_type}`);
        out.push(`- **What changed:** ${u.summary}`);
        if (u.replaces) out.push(`- **Replaces / supersedes:** ${u.replaces}`);
        out.push(`- **Link:** ${u.link}`, '');
      }
    }
  } else {
    out.push('No updates since the last check.', '');
  }

  if (changes.needs_login.length) {
    out.push('## Needs your sign-in', '', 'These sites need a login, so they were not checked automatically:', '');
    for (const s of changes.needs_login) out.push(`- **${s.source}** (${s.section}): ${s.url}`);
    out.push('');
  }
  if (changes.errors.length) {
    out.push('## Could not be checked', '', '| Source | Section | Error | URL |', '|---|---|---|---|');
    for (const e of changes.errors) out.push(`| ${md(e.source)} | ${md(e.section)} | ${md(e.error)} | ${md(e.url)} |`);
    out.push('');
  }
  if (changes.baselined.length) {
    out.push('## First visit (baseline saved)', '');
    for (const b of changes.baselined) out.push(`- ${b.source}: ${b.section} (${b.items} items)`);
    out.push('');
  }
  return out.join('\n');
}

function buildHtml(changes, updates) {
  const out = [`<h2>${esc(heading(changes))}</h2>`];
  out.push(`<p><b>${updates.length} update(s) found.</b> ${changes.unchanged.length} page(s) unchanged, `
    + `${changes.baselined.length} baselined, ${changes.errors.length} unreachable, `
    + `${changes.needs_login.length} need your sign-in.</p>`);

  if (updates.length) {
    for (const [source, list] of groupBySource(updates)) {
      out.push(`<h3>${esc(source)}</h3>`);
      for (const u of list) {
        out.push(`<h4>${esc(u.title)}</h4><ul>`
          + `<li><b>Section:</b> ${esc(u.section)}</li>`
          + `<li><b>Publication date:</b> ${esc(u.publication_date || 'Not stated')}</li>`
          + `<li><b>Type:</b> ${esc(u.change_type)}</li>`
          + `<li><b>What changed:</b> ${esc(u.summary)}</li>`
          + (u.replaces ? `<li><b>Replaces / supersedes:</b> ${esc(u.replaces)}</li>` : '')
          + `<li><b>Link:</b> <a href="${esc(u.link)}">${esc(u.link)}</a></li></ul>`);
      }
    }
  } else {
    out.push('<p>No updates since the last check.</p>');
  }

  if (changes.needs_login.length) {
    out.push('<h3>Needs your sign-in</h3><p>These sites need a login, so they were not checked automatically:</p><ul>');
    for (const s of changes.needs_login) {
      out.push(`<li><b>${esc(s.source)}</b> (${esc(s.section)}): <a href="${esc(s.url)}">${esc(s.url)}</a></li>`);
    }
    out.push('</ul>');
  }
  if (changes.errors.length) {
    out.push('<h3>Could not be checked</h3><table border="1" cellpadding="4"><tr><th>Source</th><th>Section</th><th>Error</th></tr>');
    for (const e of changes.errors) {
      out.push(`<tr><td>${esc(e.source)}</td><td><a href="${esc(e.url)}">${esc(e.section)}</a></td><td>${esc(e.error)}</td></tr>`);
    }
    out.push('</table>');
  }
  if (changes.baselined.length) {
    out.push('<h3>First visit (baseline saved)</h3><ul>');
    for (const b of changes.baselined) out.push(`<li>${esc(b.source)}: ${esc(b.section)} (${b.items} items)</li>`);
    out.push('</ul>');
  }
  return out.join('\n');
}

async function appendToLog(runId, updates) {
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(LOG_FILE)) await wb.xlsx.readFile(LOG_FILE);
  let ws = wb.getWorksheet('Updates');
  if (!ws) {
    ws = wb.addWorksheet('Updates', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = COLUMNS;
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: 'A1', to: 'I1' };
  } else {
    // Column keys are not stored in the file; restore them so addRow maps by key.
    ws.columns = COLUMNS;
  }
  // Re-running the report for the same run replaces that run's rows.
  for (let r = ws.rowCount; r >= 2; r--) {
    if (ws.getRow(r).getCell(1).value === runId) ws.spliceRows(r, 1);
  }
  for (const u of updates) {
    const row = ws.addRow({ ...u, run_id: runId });
    row.getCell('link').value = { text: u.link, hyperlink: u.link };
    row.alignment = { vertical: 'top', wrapText: true };
  }
  await wb.xlsx.writeFile(LOG_FILE);
}

async function main() {
  const runId = process.argv[2] || fs.readFileSync(path.join(RUNS_DIR, 'LATEST'), 'utf8').trim();
  const runDir = path.join(RUNS_DIR, runId);
  const changes = readJson(path.join(runDir, 'changes.json'), null);
  if (!changes) throw new Error(`No changes.json in ${runDir}`);
  const updatesFile = path.join(runDir, 'updates.json');
  if (changes.changed.length && !fs.existsSync(updatesFile)) {
    throw new Error(`${changes.changed.length} page(s) changed but ${path.relative(ROOT, updatesFile)} is missing. Review the changes first.`);
  }
  const updates = readJson(updatesFile, []);
  for (const [i, u] of updates.entries()) {
    for (const f of ['source', 'section', 'title', 'change_type', 'summary', 'link']) {
      if (!u[f]) throw new Error(`updates.json entry ${i} is missing "${f}"`);
    }
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, `${runId}.md`), buildMarkdown(changes, updates) + '\n');
  fs.writeFileSync(path.join(REPORTS_DIR, `${runId}.html`), buildHtml(changes, updates) + '\n');
  await appendToLog(runId, updates);
  console.log(`Wrote reports/${runId}.md, reports/${runId}.html and reports/updates-log.xlsx (${updates.length} update(s))`);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
