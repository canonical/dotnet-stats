# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A static web dashboard showing download statistics for .NET packages on Ubuntu,
sourced from the Launchpad API. It has four parts:

1. **Collector** (`scripts/collect.py`) — a Python script that queries Launchpad
   for download counts and writes `data/downloads.{csv,json}` + `data/last-run.json`.
2. **Dashboard** (`web/`) — a no-build static site (Vanilla Framework + Plotly.js)
   that fetches `data/downloads.json` and renders charts.
3. **Monthly report** — an executive PDF per calendar month. Computed by
   `web/report.js`, rendered by the dashboard's report view, archived under
   `reports/` by `scripts/print_report.py` + `scripts/report_manifest.py`.
4. **Workflows** (`.github/workflows/`) — `collect-data.yml` runs the collector
   daily and commits the data; `monthly-report.yml` renders the report on the
   2nd of the month; both deploy via the shared reusable `deploy-pages.yml`
   (`on: workflow_call`) and share one concurrency group.

Read `README.md` for the full user-facing description before making changes.

## Repository layout

```
config.json                # PPA + tracked source packages (edit to change scope)
requirements.txt           # Python deps (launchpadlib only; stdlib otherwise)
scripts/collect.py         # data collector (the main backend logic)
scripts/report_manifest.py # indexes reports/ -> reports/index.json (no report maths)
scripts/print_report.py    # headless-Chrome renderer for one month's PDF
data/                      # generated data; committed by CI, do not hand-edit
web/                       # static dashboard (index.html, reports.html, app.js,
                           #   stats.js, report.js, style.css)
reports/                   # generated PDFs + index.json; committed by CI
.github/workflows/         # collect-data.yml, monthly-report.yml, deploy-pages.yml
```

## Setup & commands

```bash
pip install -r requirements.txt

# Validate the collector after any change:
python3 -m py_compile scripts/collect.py

# Quick live smoke test (narrow window keeps it fast):
python3 scripts/collect.py --verbose --start <recent-date> --end <recent-date> \
  --output-dir /tmp/collect-test

# Check the JS (no test runner; use node's syntax check):
node --check web/app.js
node --check web/stats.js
node --check web/report.js

# Validate the report scripts:
python3 -m py_compile scripts/report_manifest.py scripts/print_report.py
python3 scripts/report_manifest.py --print-target   # month a scheduled run picks

# Preview the dashboard (must be served over HTTP, not file://):
python3 -m http.server 8000   # then open http://localhost:8000/web/
#   ?month=2026-04            -> report view for one month
#   ?month=2026-04&print=1    -> the print layout the archived PDF is made from

# Render an archived report locally (needs Chrome/Chromium; see README):
site=$(mktemp -d); mkdir -p "$site/data"; cp -r web/* "$site/"
cp data/downloads.json data/last-run.json "$site/data/"
python3 scripts/print_report.py --site "$site" --month 2026-04 \
  --out /tmp/report.pdf

# Validate the workflow YAML:
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/collect-data.yml'))"
```

## Conventions & constraints

- **Python**: standard library only plus `launchpadlib`. Do not add `pandas` or
  other heavy deps — the collector deliberately uses `csv`/`json`. Target 3.12.
- **Web**: no build step, no bundler, no framework runtime. Plain ES5-ish
  browser JS in `web/app.js`; keep `stats.js` and `report.js` free of DOM/side
  effects (pure functions). Vanilla Framework CSS is hotlinked from the Canonical
  CDN; do not vendor it.
  - **Exception — sidebar icons.** The CDN build of Vanilla 4.55 compiles only
    44 of the ~190 icons in `vanilla-framework`'s SCSS, and the remaining icon
    classes the nav uses (`statistics`, `history`, `switcher-dashboard`,
    `change-version`, `plans`, `units`, `revisions`) would otherwise never
    render. There is no Sass build to opt into the fuller set, so the seven icon
    SVGs are vendored in `web/style.css` (marked "Sidebar navigation icons"),
    extracted verbatim from `vanilla-framework@4.55.1`'s
    `scss/_base_icon-definitions.scss` with Vanilla's own white dark-theme fill.
    This is the *only* sanctioned exception to the no-vendoring rule. Do not
    hand-edit those blocks; re-extract from the named source if they change.
- **Data files** (`data/downloads.*`, `data/last-run.json`) are generated
  artifacts. Never hand-edit or commit locally-generated real data; CI owns them.
  Keep `data/.gitkeep`.
- **Reports** (`reports/<YYYY>/<Month>.pdf`, `reports/index.json`) are
  generated artifacts too, on the same terms: CI owns them, do not commit a
  locally rendered PDF. Keep `reports/.gitkeep`.
- Preserve the CSV/JSON schema in `collect.py` (`CSV_FIELDS`, `BINARY_KEY_FIELDS`
  and the compact per-binary JSON shape). The dashboard depends on it — change
  both sides together if you must change the schema.

## Launchpad API gotchas (verified, important)

- `getPublishedBinaries` **silently ignores** `source_package_name` on both the
  PPA and the primary archive. Filter by source package **client-side**.
- **The primary Ubuntu archive exposes no download counts.** `getDownloadCounts`
  returns nothing for primary-archive publications (the archive ships via the
  mirror/CDN network, not Launchpad). Only PPAs have download telemetry, so the
  collector queries the PPA only — do not re-add a primary-archive phase.
- `getDownloadCounts` accepts `start_date`/`end_date` (both **inclusive**) and
  returns entries newest-first. Pass them as **ISO strings** (`date.isoformat()`),
  not `date` objects — launchpadlib JSON-encodes params and `date` is not
  serializable.
- launchpadlib objects are lazy and the shared session is not thread-safe: the
  collector enumerates single-threaded and uses **one Launchpad instance per
  worker thread** (`threading.local`) for parallel fetches.

## Collector design notes

- Single source: enumerates the PPA and filters by source package client-side.
- The data schema keeps an `origin` column (currently always `backports-ppa`) so
  another source could be added later; the dashboard builds its origin filter
  from the origins actually present in the data.
- Incremental: auto-derives `--start` from existing data unless overridden.
- Parallel fetch via `FetchPool` (jobs streamed to a thread pool as discovered),
  bounded by a shared `RateLimiter` (`--max-rps`, default 20; `--workers`
  default 8). Output is order-independent (final merge sorts + dedupes by
  composite key keeping `max(count)`).
- Skips publications removed before the window (`should_skip_removed`).
- `--verbose`/`-v` emits per-binary progress via `vlog`.

## Monthly report design notes (read before touching the report)

- **The arithmetic lives in JavaScript, once.** `web/report.js` is the single
  implementation; the archived PDF is the dashboard's own report view printed by
  a headless browser. Do **not** reimplement any report figure in Python —
  `report_manifest.py` deliberately only indexes files and recomputes nothing but
  coverage. Duplicating the maths is how the PDF and the dashboard start
  disagreeing.
- `Report.buildReport(binaries, month)` returns the whole facts bundle and is
  pure; the view only formats it. `Report.findings()` generates prose from fixed
  threshold rules, so every sentence is traceable to a figure. Keep it
  deterministic — no LLM, no `Date.now()` inside the pure functions.
- The report **ignores the global filter bar** on purpose (`UNFILTERED_VIEWS` in
  `app.js`) and always uses `Report.canonicalBinaries` (debug packages excluded),
  so a month always renders identically. Don't wire filters into it.
- **Degenerate months are load-bearing test cases.** The dataset really does
  contain a month with no data (2026-06 at the time of writing) and near-empty
  months. `status` is one of `ok` / `partial` / `insufficient_data` / `no_data`,
  and composition findings and KPI deltas are suppressed for `no_data` so the
  report never shows a fictional -100%. Check these months after any change.
- **Print CSS is the published artifact.** `@media print` in `style.css` defines
  the PDF. `PRINT_CHART_WIDTH` (676px) must stay consistent with the `@page`
  margins; Plotly needs explicit width/height when printing because its
  responsive resizing does not run during print layout. Vanilla's responsive
  tables collapse to cards at print width, hence the explicit table overrides.
- **The render self-checks.** `body.is-print:not(.is-report-ready)` withholds the
  report body, so a browser that prints before the charts have drawn produces a
  one-page warning that `print_report.py` rejects. Do not "fix" a failing render
  by relaxing `--min-pages`.
- `print_report.py` must not pass `--user-data-dir` (it activates Chrome
  background services that stop the browser exiting) and must not capture
  Chrome's output through a pipe (the crashpad handler holds it open). Both are
  commented in the script; they cost an hour to find.

## Verifying behavior changes

There is no unit-test suite. When changing the collector, verify with a live
windowed run and, for parallelism changes, confirm `--workers 1` and
`--workers 8` produce **identical** output over the same window.

When changing the report maths, reconcile against an independent implementation
rather than eyeballing: compute a month's total, per-version/series/architecture
totals and shares from `data/downloads.json` with a throwaway Python script and
compare against `Report.buildReport` for that month. Do this for a healthy month,
a partial month and the empty month. Then render the PDF and check the page count
and that no chart is clipped at the right margin.

## Do not

- Commit secrets or Launchpad credentials (`.gitignore` covers the cache).
- Re-introduce the deleted legacy scripts (`generate-csv.py`, `plot.py`).
- Add emojis to code or files unless explicitly requested.
