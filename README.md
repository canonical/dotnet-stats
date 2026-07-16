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
data/                        # generated data (committed by CI)
  downloads.csv              #   flat, git-diffable table
  downloads.json             #   compact per-binary time series (used by the site)
  last-run.json              #   run metadata
web/                         # static dashboard (no build step)
  index.html
  app.js
  stats.js
  style.css
.github/workflows/
  collect-data.yml           # daily cron: collect -> commit -> deploy Pages
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
```

## Deployment

`.github/workflows/collect-data.yml` runs daily at 06:00 UTC (and can be
triggered manually via **Run workflow**). It:

1. runs `scripts/collect.py` and commits the refreshed data files, then
2. assembles the site (`web/` + `data/downloads.json`) and deploys it to
   GitHub Pages.

Enable GitHub Pages for the repository with **Source: GitHub Actions**.

## Dashboard views

- **Overview** — totals, per-origin split, top packages.
- **Time series** — daily downloads with 7/30-day moving averages and cumulative.
- **Trends** — week-over-week / month-over-month growth and regression slope.
- **Version share** — stacked share of dotnet6/7/8/9/10 over time.
- **Breakdowns** — by origin, series, architecture, package type and pocket.
- **Peaks & anomalies** — top peak days and statistical outliers (> mean + 2σ).
- **Lifecycle** — adoption/decline curves and half-life estimates.
- **Forecast** — 90-day cumulative projection with a confidence band.
