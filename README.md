# Update tracker

An agent that checks Malaysian tax websites (HASiL, LOM, MySST, MOF, Customs,
CTIM, Parlimen, MySToDS, RDS, MDEC, HRD Corp, MyTax, MIDA, CCH) twice a day. It
compares each page with what it saw on the last visit and compiles the updates
into one report.

- `config/sources.yaml`: the websites and subsections to check, taken from
  "Websites to Check.xlsx".
- `src/check.js`: visits the pages, saves snapshots to `data/snapshots/` and
  writes the differences to `data/runs/<run-id>/changes.json`.
- `src/peek.js`: prints the text of a page or PDF, used to read an update.
- `src/report.js`: turns the reviewed updates into `reports/<run-id>.md`,
  `reports/<run-id>.html` and `reports/updates-log.xlsx`.
- `CLAUDE.md`: the step-by-step runbook the agent follows on each run.

```sh
npm ci
node src/check.js                 # all sites
node src/check.js --only mof-news # one check
node src/report.js                # report for the latest run
```
