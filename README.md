# dotnet-stats

Download statistics for .NET packages on Ubuntu, gathered from
[Launchpad](https://launchpad.net) and presented as a static dashboard built
with [Vanilla Framework](https://vanillaframework.io) and
[Plotly.js](https://plotly.com/javascript/).

Data is collected from the **dotnet backports PPA** (`dotnet/backports`).

> **Note:** The primary Ubuntu archive is *not* collected. Launchpad only tracks
> per-package download counts for PPAs; the primary archive is distributed via
> the mirror/CDN network, so `getDownloadCounts` returns nothing for it. The
> dashboard keeps an "origin" dimension (currently just Backports PPA) so another
> source can be added later without a data migration.

You can filter by origin, pocket, .NET version and package type.

## Repository layout

```
config.json                  # PPA + tracked source packages
requirements.txt             # Python dependencies (launchpadlib)
scripts/collect.py           # data collection (run by CI or locally)
scripts/report_manifest.py   # indexes the archived reports (reports/index.json)
scripts/print_report.py      # renders one month's report to PDF with headless Chrome
data/                        # generated data (committed by CI)
  downloads.csv              #   flat, git-diffable table
  downloads.json             #   compact per-binary time series (used by the site)
  last-run.json              #   run metadata
web/                         # static dashboard (no build step)
  index.html
  reports.html               #   archive of monthly reports
  app.js
  stats.js
  report.js                  #   monthly report arithmetic (pure)
  style.css
reports/                     # generated monthly reports (committed by CI)
  <YYYY-MM>/report.pdf
  index.json                 #   manifest read by the dashboard and reports.html
.github/workflows/
  collect-data.yml           # daily cron: collect -> commit -> deploy
  monthly-report.yml         # monthly cron: render report -> commit -> deploy
  deploy-pages.yml           # reusable Pages deploy, called by the two above
```

## Configuration

Edit `config.json` to change what is tracked:

```json
{
  "team": "dotnet",
  "ppa": "backports",
  "source_packages": ["dotnet6", "dotnet7", "dotnet8", "dotnet9", "dotnet10"]
}
```

- `source_packages` — the source packages to track. Their binary packages are
  discovered from the PPA automatically.

## How collection works

Launchpad silently ignores the `source_package_name` filter on
`getPublishedBinaries`, so the collector enumerates every published binary in
the PPA and keeps those whose `source_package_name` is in the config, recording
each publication's download counts.

Only the PPA is collected. The primary Ubuntu archive is not queried because
Launchpad exposes no per-package download counts for it (`getDownloadCounts`
returns nothing for primary-archive publications).

Fetched counts are merged with the existing data, deduplicated by
`(origin, source_package, name, version, series, arch, pocket, status, date)`,
keeping the maximum count per key.

The collector is **incremental**: on subsequent runs it only re-fetches counts
from a few days before the last recorded date (adjustable via `--start`).

### Performance

Download counts are fetched one publication at a time, so the collector applies
several optimizations:

- **Windowed queries** — when a start/end date is in effect, it is passed to
  Launchpad's `getDownloadCounts(start_date=…, end_date=…)` so each response
  carries only the relevant days (both bounds inclusive).
- **Skipping dead publications** — a publication that was *removed* from its
  archive before the window can no longer accrue downloads, so its fetch is
  skipped entirely (never applied during a full backfill).
- **Parallel fetching** — fetches run across a thread pool (`--workers`, default
  8). Each worker uses its own Launchpad session for thread safety, and a shared
  rate limiter (`--max-rps`, default 20) caps the aggregate request rate so the
  anonymous API is not overwhelmed. Output is identical regardless of worker
  count (the merge is order-independent).

## Running locally

```bash
pip install -r requirements.txt

# Full backfill on first run; incremental afterwards.
python scripts/collect.py

# Limit the window for quick test turnarounds.
python scripts/collect.py --start 2026-06-01 --end 2026-06-30
```

Options:

| Flag | Description |
|------|-------------|
| `--config` | Path to the config file (default `config.json`). |
| `--start`  | Only collect counts on or after this date (`YYYY-MM-DD`). |
| `--end`    | Only collect counts on or before this date (`YYYY-MM-DD`). |
| `--output-dir` | Where to write the data files (default `data/`). |
| `--workers` | Number of parallel fetch workers (default `8`; use `1` for sequential). |
| `--max-rps` | Aggregate cap on API requests per second across all workers (default `20`). |
| `-v`, `--verbose` | Emit detailed per-binary and per-request progress. |

### Previewing the dashboard

The dashboard fetches `data/downloads.json`, so it must be served over HTTP
(opening `index.html` via `file://` will fail due to browser security):

```bash
python -m http.server 8000
# then open http://localhost:8000/web/
#   http://localhost:8000/web/#report                  -> monthly report view
#   http://localhost:8000/web/?month=2026-04           -> a specific month
#   http://localhost:8000/web/?month=2026-04&print=1   -> print layout
#   http://localhost:8000/web/reports.html             -> report archive
```

## Deployment

Two scheduled workflows publish the site; both delegate the actual Pages deploy
to a shared reusable workflow (`deploy-pages.yml`, `on: workflow_call`).

- **`.github/workflows/collect-data.yml`** — runs daily at 06:00 UTC (and on
  demand). Collects download counts with `scripts/collect.py`, commits the data
  files, then deploys.
- **`.github/workflows/monthly-report.yml`** — runs at 07:00 UTC on the **2nd of
  each month** (and on demand). Renders the executive report for the month just
  ended, commits it under `reports/`, then deploys. The 2nd rather than the 31st
  because the final day's counts aren't in yet at month end and the collector's
  incremental window only reaches back three days.

Both workflows share a single concurrency group, so they can never race a `git
push` or a Pages deploy. Enable GitHub Pages for the repository with **Source:
GitHub Actions**.

## Monthly executive report

A per-month report aimed at readers who want the trend rather than the
dashboard: headline volume, which .NET releases and Ubuntu series the downloads
came from, where the trend is heading, and what needs a human explanation.

Three ways to get one:

- **Dashboard** — the **Reports** button in the header, or the **Monthly report**
  view, which renders any month on demand and offers *Save as PDF*.
- **Archive** — `reports/<YYYY-MM>/report.pdf`, published at
  `/reports/<YYYY-MM>/report.pdf` and listed on `reports.html`.
- **Locally** — see the commands below.

### What it contains

| Section | Contents |
|---------|----------|
| At a glance | Total downloads, average/day, month-on-month and year-on-year change, peak day, leading and newest .NET version, SDK-per-runtime ratio, lifetime total. Monthly totals for the last 13 months, and the daily shape of the month against the previous one. |
| Composition & adoption | Share of downloads by .NET version over 13 months, by Ubuntu series and by architecture (each against the previous month), the SDK versus runtime-only split, and the top ten packages. |
| Trajectory & watch items | Cumulative projection into the next month, per-version momentum (7-day, 30-day, trend slope, half-life), days more than 2σ above the month's mean, and a data-coverage table. |
| Methodology & limitations | What the numbers are and are not. Always included. |
| Appendix (optional) | Full breakdowns per dimension, a package-type glossary and the full monthly history. |

Four indicators are given consistent prominence because they speak to developer
adoption rather than raw volume: **SDK download trend** (development and build
environments rather than deployment targets), **newest-version adoption speed**,
**arm64 share**, and **LTS series share**.

The written *Key findings* are generated from fixed, threshold-driven rules over
the computed figures — not an LLM — so every sentence traces back to a number in
the tables and the same data always produces the same prose.

### Honest limits

The report says this itself, but it bears repeating:

- Figures are **PPA download counts only**. The primary Ubuntu archive publishes
  no download telemetry, so the report is a *directional indicator*, not total
  .NET usage on Ubuntu.
- **Downloads are not users.** CI/CD, container builds, mirrors and repeated
  installs all inflate counts.
- There is **no data for any other language**, so the report makes no
  cross-language comparison. Adding one would need a separate data source.
- Months with missing collection days are labelled `partial`,
  `insufficient_data` or `no_data`, and a month that is entirely a collection gap
  suppresses its own comparisons rather than reporting a fictional -100%.

### Generating a report locally

```bash
# Which month would a scheduled run pick? (the latest fully elapsed month)
python scripts/report_manifest.py --print-target

# Stage the site exactly as the deploy job does.
site=$(mktemp -d)
mkdir -p "$site/data"
cp -r web/* "$site/"
cp data/downloads.json data/last-run.json "$site/data/"

# Render it. Requires Chrome or Chromium on PATH (or $CHROME / --chrome).
python scripts/print_report.py --site "$site" --month 2026-04 \
  --out reports/2026-04/report.pdf

# Refresh the manifest so the dashboard lists the new PDF.
python scripts/report_manifest.py
```

`print_report.py` serves the staged site itself (the page fetches
`downloads.json`, which `file://` blocks), then validates the PDF and retries
with a longer render budget if it is incomplete. That check has teeth: the print
stylesheet withholds the report body until the browser confirms every chart has
drawn, so a premature render collapses to a single page and is rejected instead
of being published half-empty.

## Dashboard views

- **Overview** — totals, per-origin split, top packages.
- **Time series** — daily downloads with 7/30-day moving averages and cumulative.
- **Calendar** — GitHub-style heatmap of daily download intensity with a year/month selector, surfacing weekday/seasonal patterns and the busiest day of the week.
- **Trends** — week-over-week / month-over-month growth and regression slope.
- **Version share** — stacked share of dotnet6/7/8/9/10 over time.
- **Breakdowns** — by origin, series, architecture, package type and pocket.
- **Peaks & anomalies** — top peak days and statistical outliers (> mean + 2σ).
- **Lifecycle** — adoption/decline curves and half-life estimates.
- **Forecast** — 90-day cumulative projection with a confidence band.
- **Monthly report** — the executive report described above, for any month, with
  *Save as PDF*.

### Backfilling the report archive

Run **monthly-report.yml** manually with **month** set to a month (`YYYY-MM`) to
render and commit that month; set **appendix** to include the full breakdowns.
`python scripts/report_manifest.py --print-months` lists every month present in
the data. The scheduled run guards against stale data and fails (rather than
publishing a stale report) if the collector hasn't run within `--max-age-days`.
