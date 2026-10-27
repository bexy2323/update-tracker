# Update tracker: runbook

This repo is an agent that checks the Malaysian tax websites in
`config/sources.yaml` for updates. It compares each page with the snapshot from
the last visit and reports what changed. The saved snapshots in `data/snapshots/`
are the agent's memory, and the git history of that folder keeps every past
visit.

Branch: `claude/cool-cerf-dsfp4z`. Commit and push all run results there.
Timezone for everything: Malaysia (MYT, UTC+8).
Reports are delivered in the chat of the session that runs the check. Do not send email.

## A check run (hourly 09:07–17:07 MYT, Monday–Friday, in the user's session)

1. **Get up to date.**
   `git fetch origin claude/cool-cerf-dsfp4z && git checkout claude/cool-cerf-dsfp4z && git pull --ff-only origin claude/cool-cerf-dsfp4z`
   then `npm ci`.

2. **Visit every website.** Run `node src/check.js`. It visits every page, saves new
   snapshots and writes `data/runs/<run-id>/changes.json`. `data/runs/LATEST`
   holds the run id. In that file:
   - `changed`: pages that differ from the last visit, with `new_items`,
     `removed_items`, `text_changes`, `new_form_years` and `new_forms`.
   - `unchanged`: same as last visit. Skip these.
   - `baselined`: first visit. A snapshot is saved and there is nothing to compare yet.
   - `needs_login`: sites that need the user's sign-in. They are not checked.
   - `errors`: sites that could not be reached. The previous snapshot is kept.

3. **Review each change** in `changed` and decide whether it is a real update.
   Open the item to read it with `node src/peek.js <url>`, which works for web
   pages and PDFs. When a link points to a list page (for example MySST's "More"
   links go to the whole Service Tax Policy list), find the specific document
   on that page and link to it.
   - **Not an update:** layout or menu changes, rotating banners, counters,
     reordered lists, or an item that moved pages. Leave these out.
   - **Removed items:** report one only when a document was withdrawn or
     replaced, not when an old item simply scrolled off a "latest" list.
   - **Image items** (`"image": true`, e.g. MyTax announcement banners): download
     the image with `curl -sSL -o <scratch file> <href>` and look at it with the
     Read tool to see what it announces.
   - **Forms** (`new_form_years` / `new_forms`): report a new year that is now
     available for a form, e.g. "Form BE 2026 now available".
   - **Relevance:** LOM P.U.(A), MOF, MIDA and the Principal Acts list must be
     relevant to tax or taxpayers in Malaysia. Parlimen and the LOM bills list
     are limited to Income Tax Act bills and Finance Bills. The keyword filter
     in `check.js` already narrows these, but use judgement too.
   - **RDS Tax Focus:** note publications worth covering in the monthly update class.

4. **Write `data/runs/<run-id>/updates.json`**: a JSON array with one object per
   real update (`[]` if none):
   ```json
   {
     "source": "<source name from changes.json>",
     "section": "<section from changes.json>",
     "title": "Short descriptive title of the change",
     "publication_date": "DD/MM/YYYY as published (or 'Not stated')",
     "change_type": "new | amendment | replacement | withdrawn | new form year",
     "summary": "What the update is and what it changes, in 1-4 sentences.",
     "replaces": "Name and date of the earlier guideline / public ruling / order it replaces or amends, or empty",
     "link": "Direct link to the updated document"
   }
   ```
   Always fill in `replaces` when the document says it replaces, supersedes or
   amends an earlier guideline, public ruling, order or circular.

5. **Compile the report.** Run `node src/report.js`. It writes
   `reports/<run-id>.md`, `reports/<run-id>.html` and appends to
   `reports/updates-log.xlsx`.

6. **Save to the cloud folder.** `git add data reports && git commit -m "Check run <run-id>: <N> update(s)"`,
   then `git push -u origin claude/cool-cerf-dsfp4z`. If the push fails because
   of a network error, retry up to 4 times, waiting 2s, 4s, 8s and 16s.

7. **Notify the user in the chat** with a short summary: each update's title,
   publication date, what changed (and what it replaces or amends) and its
   link, or say there are no updates. Also list the sites that need the user's
   sign-in and the sites that could not be reached. Do not send email.

## Rules

- Never invent an update, a date or a link. If a document can't be opened, say
  so in the summary and give the best link available.
- Never edit files in `data/snapshots/` by hand.
- To add, remove or adjust a site, edit `config/sources.yaml`. The first run
  after that saves a new baseline for the affected check.
