#!/usr/bin/env python3
"""Build the manifest of archived monthly reports.

The report's arithmetic lives in web/report.js and nowhere else: the archived
PDF is that view printed by a headless browser. This script deliberately does
not recompute any report figure. It only:

  * enumerates the months present in data/downloads.json,
  * records how well each month is covered by the data,
  * notes which months already have a rendered PDF on disk,

and writes reports/index.json, which the dashboard reads to populate its
"Reports" menu and reports.html reads to list the archive.

Standard library only.
"""
from __future__ import annotations

import argparse
import json
import sys
from calendar import monthrange
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Kept in step with COVERAGE_OK / COVERAGE_MIN in web/report.js so the manifest
# and the report itself agree on how usable a month is.
COVERAGE_OK = 95.0
COVERAGE_MIN = 50.0

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def month_label(month: str) -> str:
    year, mon = int(month[:4]), int(month[5:7])
    return f"{MONTH_NAMES[mon - 1]} {year}"


def add_months(month: str, n: int) -> str:
    year, mon = int(month[:4]), int(month[5:7])
    total = year * 12 + (mon - 1) + n
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


def days_in_month(month: str) -> int:
    return monthrange(int(month[:4]), int(month[5:7]))[1]


def month_end(month: str) -> str:
    return f"{month}-{days_in_month(month):02d}"


def months_between(first: str, last: str) -> list[str]:
    out = []
    cursor = first
    while cursor <= last:
        out.append(cursor)
        cursor = add_months(cursor, 1)
    return out


def load_daily(path: Path) -> tuple[dict[str, int], dict[str, int], str | None]:
    """Return (downloads per day, downloads per month, last-updated timestamp).

    Debug-symbol packages are excluded to match Report.canonicalBinaries. The
    timestamp comes from the collector's ``last_updated`` field, recording when
    the data was last *fetched* -- distinct from the most recent date that has a
    count, which a genuine collection gap leaves behind.
    """
    with path.open() as handle:
        data = json.load(handle)

    daily: dict[str, int] = defaultdict(int)
    monthly: dict[str, int] = defaultdict(int)
    for binary in data.get("binaries", []):
        if binary.get("is_debug"):
            continue
        for day, count in binary.get("counts", []):
            daily[day] += count
            monthly[day[:7]] += count
    return dict(daily), dict(monthly), data.get("last_updated")


def coverage(daily: dict[str, int], month: str, dataset_last: str) -> dict:
    """Days of `month` carrying counts, clipped to the end of the dataset."""
    expected_end = min(month_end(month), dataset_last)
    year, mon = int(month[:4]), int(month[5:7])
    cursor = date(year, mon, 1)
    expected: list[str] = []
    while cursor.isoformat() <= expected_end:
        expected.append(cursor.isoformat())
        cursor += timedelta(days=1)

    with_data = [day for day in expected if daily.get(day)]
    pct = (len(with_data) / len(expected) * 100) if expected else 0.0
    return {
        "days_in_month": days_in_month(month),
        "days_expected": len(expected),
        "days_with_data": len(with_data),
        "coverage_pct": round(pct, 1),
        "complete": dataset_last >= month_end(month),
    }


def status_for(total: int, cov: dict) -> str:
    if not total:
        return "no_data"
    if cov["coverage_pct"] < COVERAGE_MIN:
        return "insufficient_data"
    if not cov["complete"] or cov["coverage_pct"] < COVERAGE_OK:
        return "partial"
    return "ok"


def build_manifest(data_file: Path, reports_dir: Path, site_root: Path) -> dict:
    daily, monthly, last_updated = load_daily(data_file)
    if not daily:
        raise SystemExit(f"no download counts found in {data_file}")

    dataset_first = min(daily)
    dataset_last = max(daily)
    # Extend the month range to the month the collector last *ran*, not just the
    # last month that happens to carry a count. A month with zero recorded
    # downloads is a collection gap worth reporting on, not one to skip.
    last_month = dataset_last[:7]
    if last_updated:
        run_month = last_updated[:7]
        if run_month > last_month:
            last_month = run_month
    months = months_between(dataset_first[:7], last_month)

    entries = []
    for month in months:
        total = monthly.get(month, 0)
        cov = coverage(daily, month, dataset_last)
        pdf_path = reports_dir / month / "report.pdf"
        entry = {
            "month": month,
            "label": month_label(month),
            "total": total,
            "status": status_for(total, cov),
            "coverage_pct": cov["coverage_pct"],
            "days_with_data": cov["days_with_data"],
            "days_expected": cov["days_expected"],
            "complete": cov["complete"],
            # Relative to the deployed site root so the dashboard can link to it
            # directly from any page.
            "html": f"index.html?month={month}",
            "pdf": None,
        }
        if pdf_path.exists():
            entry["pdf"] = str(pdf_path.relative_to(site_root)).replace("\\", "/")
            entry["pdf_bytes"] = pdf_path.stat().st_size
            entry["pdf_generated"] = datetime.fromtimestamp(
                pdf_path.stat().st_mtime, tz=timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%SZ")
        entries.append(entry)

    # Newest first: both consumers show recent months at the top.
    entries.reverse()

    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "last_updated": last_updated,
        "data_window": {"first": dataset_first, "last": dataset_last},
        "latest_complete_month": next(
            (e["month"] for e in entries if e["complete"]), None
        ),
        "reports": entries,
    }


def check_freshness(manifest: dict, max_age_days: int) -> None:
    """Fail if the collector has not run within ``max_age_days``.

    This guards the scheduled report against being built on stale data after a
    collector outage. It is deliberately keyed on the collector's ``last_updated``
    timestamp, not on the most recent count: a genuine data gap passes (the
    collector ran, there was nothing to record, and the report should document
    the gap), whereas a collector that has silently stopped running fails.
    """
    last_updated = manifest.get("last_updated")
    if not last_updated:
        raise SystemExit(
            "data/downloads.json has no last_updated field; cannot verify the "
            "collector has run recently"
        )
    stamp = datetime.strptime(last_updated, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    age = datetime.now(timezone.utc) - stamp
    if age.days >= max_age_days:
        raise SystemExit(
            f"data is stale: the collector last ran {age.days} day(s) ago "
            f"({last_updated}), which is beyond the {max_age_days}-day limit. "
            "Fix the daily collection workflow before generating a report on "
            "stale data."
        )
    print(f"data freshness OK: collector last ran {age.days} day(s) ago "
          f"({last_updated})")


def target_month(manifest: dict, requested: str | None) -> str:
    """Month a scheduled run should render: the latest fully elapsed month."""
    if requested:
        if not (len(requested) == 7 and requested[4] == "-"):
            raise SystemExit(f"--month must be YYYY-MM, got {requested!r}")
        return requested
    latest = manifest.get("latest_complete_month")
    if not latest:
        raise SystemExit("no fully elapsed month present in the data")
    return latest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default="data/downloads.json",
                        help="collector output to enumerate (default: %(default)s)")
    parser.add_argument("--reports-dir", default="reports",
                        help="directory holding reports/<YYYY-MM>/report.pdf")
    parser.add_argument("--site-root", default=".",
                        help="root the pdf paths in the manifest are relative to")
    parser.add_argument("--out", default=None,
                        help="manifest path (default: <reports-dir>/index.json)")
    parser.add_argument("--month", default=None,
                        help="month to report on; only used by --print-target")
    parser.add_argument("--print-target", action="store_true",
                        help="print the month a run should render, and exit")
    parser.add_argument("--print-months", action="store_true",
                        help="print every month present in the data, and exit")
    parser.add_argument("--max-age-days", type=int, default=None,
                        help="fail if the collector last ran more than N days "
                             "ago (guards a scheduled report against stale data)")
    args = parser.parse_args(argv)

    data_file = Path(args.data)
    reports_dir = Path(args.reports_dir)
    site_root = Path(args.site_root)
    out = Path(args.out) if args.out else reports_dir / "index.json"

    manifest = build_manifest(data_file, reports_dir, site_root)

    if args.max_age_days is not None:
        check_freshness(manifest, args.max_age_days)
        # A bare freshness check (as in the workflow's guard step) exits here.
        if not args.print_target and not args.print_months and args.out is None:
            return 0

    if args.print_months:
        print(" ".join(e["month"] for e in reversed(manifest["reports"])))
        return 0
    if args.print_target:
        print(target_month(manifest, args.month))
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")

    have_pdf = sum(1 for e in manifest["reports"] if e["pdf"])
    print(
        f"wrote {out}: {len(manifest['reports'])} months, {have_pdf} with a PDF, "
        f"latest complete month {manifest['latest_complete_month']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
