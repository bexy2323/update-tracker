# Update tracker: runbook

This repo is an agent that checks the Malaysian tax websites in
`config/sources.yaml` for updates. It compares each page with the snapshot from
the last visit and reports what changed. The saved snapshots in `data/snapshots/`
are the agent's memory, and the git history of that folder keeps every past
visit.

Branch: `claude/cool-cerf-dsfp4z`. Commit and push all run results there.
Timezone for everything: Malaysia (MYT, UTC+8).
Reports are delivered in the chat of the session that runs the check. Do not send email.

## A check run (twice a day, 08:38 and 16:38 MYT, Monday–Friday, in the user's session)

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
     the image with `curl -sSL -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0' -o <scratch file> <href>`
     (HASiL's firewall blocks downloads without a browser user-agent) and look at it with the
     Read tool to see what it announces.
   - **HASiL e-Invoice infographics**
     (https://www.hasil.gov.my/en/e-invois/komunikasi-dan-hebahan/infografik/):
     every new infographic is an announcement to review. Open the image as
     above and report its title and content in English. HASiL publishes most of
     them in Malay only (titles end in "(BM)"); if an English version exists
     (title ending "(BI)"/"(EN)", or a file name ending -EN/-BI), link to that,
     otherwise give the BM link and say it is the Malay version.
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
     "link": "Direct link to the updated document",
     "tax_a_minute": true
   }
   ```
   Always fill in `replaces` when the document says it replaces, supersedes or
   amends an earlier guideline, public ruling, order or circular.

   Set `tax_a_minute` to `true` only for **rulings and guides**: gazette orders
   (P.U.(A)/P.U.(B)), public rulings, guidelines and guides (LHDN, RMCD/MySST,
   MIDA and the like), FAQs, and RMCD Service Tax / Sales Tax Policies. Set it
   to `false` for everything else: new form years, infographics and banners,
   general announcements, news, bills, the Principal Acts list, RDS Tax Focus
   publications and events.

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

8. **Offer a Tax A Minute for each ruling or guide.** Run `node src/tam.js list`.
   It prints the updates with `tax_a_minute: true`, each with an `output_dir`.
   If the list is empty, stop here. Otherwise, after the step 7 summary, ask
   with the AskUserQuestion tool (these are the buttons the user clicks):
   - **One candidate:** one question, "Generate a Tax A Minute for <title>?",
     with the options "Generate" and "Skip".
   - **Two or more:** a `multiSelect` question, "Which updates need a Tax A
     Minute?", with one option per candidate (label: short title, at most 5
     words; description: source, publication date and change type). A question
     takes at most 4 options, so put candidates 5–8 in a second question, and
     so on (up to 4 questions, 16 candidates). If there are more than 16, ask
     again for the rest.
   The user can also answer by typing (e.g. "none", or naming items); follow that.

   For each update the user picks, invoke the `anthropic-skills:tax-a-minute`
   skill with the Skill tool, one update at a time. In `args` give the title,
   source, publication date, what it replaces, the summary and the link from
   `updates.json`, and tell it to save its files in that update's `output_dir`.
   The skill works from the source document, so open it with
   `node src/peek.js <link>` if the skill needs the text.

   Then write `data/runs/<run-id>/tax-a-minute.json`, one object per candidate:
   `{"index": <n>, "title": "...", "decision": "generated | skipped | failed",
   "output_dir": "...", "files": ["..."]}`. Commit and push:
   `git add data reports && git commit -m "Tax A Minute for check run <run-id>: <N> generated"`,
   then `git push -u origin claude/cool-cerf-dsfp4z` (same retry rule as step 6).
   Finally, send the generated files to the user with SendUserFile and paste
   each WhatsApp message into the chat. If generation fails for an update,
   say so and mark it `failed`; never invent its content.

## Rules

- Never invent an update, a date or a link. If a document can't be opened, say
  so in the summary and give the best link available.
- Never edit files in `data/snapshots/` by hand.
- To add, remove or adjust a site, edit `config/sources.yaml`. The first run
  after that saves a new baseline for the affected check.
