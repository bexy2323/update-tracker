#!/usr/bin/env node
// Tax A Minute helper: which updates in a run can get a Tax A Minute, and
// where their generated files go.
//
// Usage:
//   node src/tam.js list [<run-id>]      eligible updates as JSON (defaults to data/runs/LATEST)
//
// Reads data/runs/<run-id>/updates.json, where the agent sets "tax_a_minute": true
// on rulings and guides (see CLAUDE.md, step 4). Each entry printed has:
//   index       position in updates.json
//   title, source, publication_date, change_type, link, replaces, replaces_link
//   output_dir  reports/tax-a-minute/<run-id>/<NN>-<slug>/  (where the skill's files go)
// Choices made in the chat are recorded in data/runs/<run-id>/tax-a-minute.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');

function slug(s) {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 60).replace(/-$/, '');
}

function list(runId) {
  const file = path.join(RUNS_DIR, runId, 'updates.json');
  if (!fs.existsSync(file)) throw new Error(`No ${path.relative(ROOT, file)}`);
  const updates = JSON.parse(fs.readFileSync(file, 'utf8'));
  return updates
    .map((u, index) => ({ u, index }))
    .filter(({ u }) => u.tax_a_minute === true)
    .map(({ u, index }) => ({
      index,
      title: u.title,
      source: u.source,
      publication_date: u.publication_date || 'Not stated',
      change_type: u.change_type,
      link: u.link,
      replaces: u.replaces || '',
      replaces_link: u.replaces_link || '',
      output_dir: path.posix.join('reports', 'tax-a-minute', runId,
        `${String(index + 1).padStart(2, '0')}-${slug(u.title)}`),
    }));
}

function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd !== 'list') {
    console.error('Usage: node src/tam.js list [<run-id>]');
    process.exit(2);
  }
  const runId = arg || fs.readFileSync(path.join(RUNS_DIR, 'LATEST'), 'utf8').trim();
  console.log(JSON.stringify(list(runId), null, 2));
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
