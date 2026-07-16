# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

A static web dashboard showing download statistics for .NET packages on Ubuntu,
sourced from the Launchpad API. It has three parts:

1. **Collector** (`scripts/collect.py`) — a Python script that queries Launchpad
   for download counts and writes `data/downloads.{csv,json}` + `data/last-run.json`.
2. **Dashboard** (`web/`) — a no-build static site (Vanilla Framework + Plotly.js)
   that fetches `data/downloads.json` and renders charts.
3. **Workflow** (`.github/workflows/collect-data.yml`) — a daily cron that runs
   the collector, commits the data, and deploys the site to GitHub Pages.

Read `README.md` for the full user-facing description before making changes.

## Repository layout

```
config.json                # PPA + tracked source packages (edit to change scope)
requirements.txt           # Python deps (launchpadlib only; stdlib otherwise)
scripts/collect.py         # data collector (the main backend logic)
data/                      # generated data; committed by CI, do not hand-edit
web/                       # static dashboard (index.html, app.js, stats.js, style.css)
.github/workflows/         # collect-data.yml
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

# Preview the dashboard (must be served over HTTP, not file://):
python3 -m http.server 8000   # then open http://localhost:8000/web/

# Validate the workflow YAML:
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/collect-data.yml'))"
```

## Conventions & constraints

- **Python**: standard library only plus `launchpadlib`. Do not add `pandas` or
  other heavy deps — the collector deliberately uses `csv`/`json`. Target 3.12.
- **Web**: no build step, no bundler, no framework runtime. Plain ES5-ish
  browser JS in `web/app.js` / `web/stats.js`; keep `stats.js` free of DOM/side
  effects (pure functions). Vanilla Framework CSS is hotlinked from the Canonical
  CDN; do not vendor it.
- **Data files** (`data/downloads.*`, `data/last-run.json`) are generated
  artifacts. Never hand-edit or commit locally-generated real data; CI owns them.
  Keep `data/.gitkeep`.
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

## Verifying behavior changes

There is no unit-test suite. When changing the collector, verify with a live
windowed run and, for parallelism changes, confirm `--workers 1` and
`--workers 8` produce **identical** output over the same window.

## Do not

- Commit secrets or Launchpad credentials (`.gitignore` covers the cache).
- Re-introduce the deleted legacy scripts (`generate-csv.py`, `plot.py`).
- Add emojis to code or files unless explicitly requested.
