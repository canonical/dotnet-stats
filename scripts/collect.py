#!/usr/bin/env python3
"""Collect .NET package download counts from Launchpad.

Gathers download-count statistics for a configured set of source packages,
across two origins:

  * "backports-ppa"  - the dotnet team's backports PPA
  * "ubuntu-archive" - the primary Ubuntu archive

Because the Launchpad API silently ignores the ``source_package_name`` filter
on ``getPublishedBinaries``, the binary package names produced by each source
package are discovered from the (small) PPA first, then reused to query the
(very large) primary archive via the ``binary_name`` filter.

The script is incremental: it merges freshly fetched counts into the existing
data files, deduplicating by a composite key and keeping the maximum count.

Usage:
    python scripts/collect.py [--config config.json]
                              [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                              [--output-dir data/]
                              [--verbose]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

from launchpadlib.launchpad import Launchpad

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

CACHE_DIR = "~/.cache/launchpadlib"
APPLICATION_NAME = "dotnet-stats-collector"
LAUNCHPAD_INSTANCE = "production"

ORIGIN_PPA = "backports-ppa"
ORIGIN_ARCHIVE = "ubuntu-archive"

# Courtesy delay between API calls (seconds) to be gentle on the anonymous API.
API_SLEEP = 0.1

# Page size used when paging through published binaries.
PAGE_SIZE = 300

# When running incrementally we re-fetch a few days before the last known date
# to catch any late corrections/missed runs.
INCREMENTAL_SAFETY_DAYS = 3

# CSV column order (also the field order used everywhere in the script).
CSV_FIELDS = [
    "origin",
    "source_package",
    "display_name",
    "package_name",
    "package_version",
    "series",
    "architecture",
    "pocket",
    "status",
    "is_debug",
    "date",
    "count",
]

# Fields (minus date/count) that uniquely identify a binary publication.
BINARY_KEY_FIELDS = [
    "origin",
    "source_package",
    "package_name",
    "package_version",
    "series",
    "architecture",
    "pocket",
    "status",
]


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        config = json.load(fh)

    for required in ("team", "ppa", "source_packages"):
        if required not in config:
            raise ValueError(f"config is missing required key: {required!r}")

    config.setdefault("binary_names", {})
    return config


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def parse_date(value: str) -> dt.date:
    try:
        return dt.datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"invalid date {value!r}, expected YYYY-MM-DD"
        ) from exc


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=Path("config.json"),
        help="path to the JSON config file (default: config.json)",
    )
    parser.add_argument(
        "--start",
        type=parse_date,
        default=None,
        help="only collect download counts on or after this date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--end",
        type=parse_date,
        default=None,
        help="only collect download counts on or before this date (YYYY-MM-DD)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data"),
        help="directory to write downloads.csv/json (default: data/)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="emit detailed per-binary and per-request progress",
    )
    return parser.parse_args(argv)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# Toggled by the --verbose CLI flag.
VERBOSE = False


def vlog(message: str) -> None:
    """Log only when verbose output is enabled."""
    if VERBOSE:
        print(message, file=sys.stderr, flush=True)


def series_and_arch(distro_arch_series_link: str) -> tuple[str, str]:
    """Extract (series, architecture) from a distro_arch_series link."""
    return tuple(distro_arch_series_link.rstrip("/").split("/")[-2:])  # type: ignore[return-value]


def record_key(record: dict) -> tuple:
    return tuple(record[field] for field in BINARY_KEY_FIELDS) + (record["date"],)


def binary_key(record: dict) -> tuple:
    return tuple(record[field] for field in BINARY_KEY_FIELDS)


# --------------------------------------------------------------------------- #
# Download-count fetching
# --------------------------------------------------------------------------- #


def fetch_download_counts(
    binary,
    base_fields: dict,
    start: dt.date | None,
    end: dt.date | None,
) -> list[dict]:
    """Return per-day download-count records for a single binary publication.

    ``getDownloadCounts`` returns entries newest-first, so once we walk past the
    ``start`` date we can stop early.
    """
    records: list[dict] = []
    try:
        counts = binary.getDownloadCounts()
    except Exception as exc:  # pragma: no cover - network/permission issues
        log(f"  ! failed to get download counts: {exc}")
        return records

    for download in counts:
        day = download.day  # datetime.date or datetime.datetime
        if hasattr(day, "date"):
            day = day.date()
        if start is not None and day < start:
            # Newest-first ordering => everything remaining is older.
            break
        if end is not None and day > end:
            continue
        record = dict(base_fields)
        record["date"] = day.strftime("%Y-%m-%d")
        record["count"] = int(download.count)
        records.append(record)

    vlog(
        f"      {base_fields['package_name']} "
        f"{base_fields['package_version']} "
        f"[{base_fields['series']}/{base_fields['architecture']}]: "
        f"{len(records)} day(s)"
    )
    time.sleep(API_SLEEP)
    return records


def binary_base_fields(binary, origin: str) -> dict:
    series, architecture = series_and_arch(binary.distro_arch_series_link)
    return {
        "origin": origin,
        "source_package": binary.source_package_name,
        "display_name": binary.display_name,
        "package_name": binary.binary_package_name,
        "package_version": binary.binary_package_version,
        "series": series,
        "architecture": architecture,
        "pocket": binary.pocket,
        "status": binary.status,
        "is_debug": bool(getattr(binary, "is_debug", False)),
    }


# --------------------------------------------------------------------------- #
# Phase 1 - backports PPA
# --------------------------------------------------------------------------- #


def collect_ppa(
    ppa,
    source_packages: set[str],
    start: dt.date | None,
    end: dt.date | None,
) -> tuple[list[dict], dict[str, set[str]]]:
    """Collect PPA download counts and discover binary names per source package."""
    log("Phase 1: collecting from backports PPA ...")
    records: list[dict] = []
    binary_names: dict[str, set[str]] = defaultdict(set)

    matched = 0
    total_seen = 0
    for binary in ppa.getPublishedBinaries():
        total_seen += 1
        if total_seen % 500 == 0:
            vlog(f"  scanned {total_seen} PPA binaries ({matched} matched so far) ...")
        source = binary.source_package_name
        if source not in source_packages:
            continue
        matched += 1
        binary_names[source].add(binary.binary_package_name)

        base = binary_base_fields(binary, ORIGIN_PPA)
        records.extend(fetch_download_counts(binary, base, start, end))
        if matched % 25 == 0:
            log(f"  processed {matched} matching PPA binaries ...")

    vlog(
        "  discovered binary names: "
        + ", ".join(
            f"{src}={sorted(names)}" for src, names in sorted(binary_names.items())
        )
    )
    log(
        f"  done: {matched} matching binaries "
        f"(of {total_seen} scanned), {len(records)} download-count rows"
    )
    return records, binary_names


# --------------------------------------------------------------------------- #
# Phase 2 - primary Ubuntu archive
# --------------------------------------------------------------------------- #


def collect_archive(
    primary,
    source_packages: set[str],
    binary_names: dict[str, set[str]],
    start: dt.date | None,
    end: dt.date | None,
) -> list[dict]:
    """Collect primary-archive download counts using discovered binary names."""
    log("Phase 2: collecting from primary Ubuntu archive ...")
    records: list[dict] = []

    # The set of binary names to query (deduplicated across source packages).
    names_to_query: set[str] = set()
    for names in binary_names.values():
        names_to_query.update(names)

    if not names_to_query:
        log("  no binary names discovered; skipping primary archive")
        return records

    log(f"  querying {len(names_to_query)} binary name(s) in primary archive")
    for name in sorted(names_to_query):
        vlog(f"    querying binary_name={name!r} ...")
        try:
            published = primary.getPublishedBinaries(
                binary_name=name, exact_match=True
            )
        except Exception as exc:  # pragma: no cover
            log(f"  ! failed to query binary_name={name!r}: {exc}")
            continue

        matched = 0
        for binary in published:
            if binary.source_package_name not in source_packages:
                continue
            matched += 1
            base = binary_base_fields(binary, ORIGIN_ARCHIVE)
            records.extend(fetch_download_counts(binary, base, start, end))
        log(f"    {name}: {matched} matching binaries")
        time.sleep(API_SLEEP)

    log(f"  done: {len(records)} download-count rows")
    return records


# --------------------------------------------------------------------------- #
# Merge & persistence
# --------------------------------------------------------------------------- #


def load_existing(csv_path: Path) -> list[dict]:
    if not csv_path.exists():
        return []
    records: list[dict] = []
    with csv_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            row["is_debug"] = row.get("is_debug", "False") == "True"
            row["count"] = int(row["count"])
            records.append(row)
    return records


def max_existing_date(records: list[dict]) -> dt.date | None:
    best: dt.date | None = None
    for record in records:
        day = dt.datetime.strptime(record["date"], "%Y-%m-%d").date()
        if best is None or day > best:
            best = day
    return best


def merge_records(existing: list[dict], fresh: list[dict]) -> list[dict]:
    """Merge by composite key, keeping the maximum count for each key."""
    merged: dict[tuple, dict] = {}
    for record in existing:
        merged[record_key(record)] = record
    for record in fresh:
        key = record_key(record)
        current = merged.get(key)
        if current is None or record["count"] >= current["count"]:
            merged[key] = record
    return list(merged.values())


def write_csv(records: list[dict], path: Path) -> None:
    records_sorted = sorted(
        records,
        key=lambda r: (
            r["origin"],
            r["source_package"],
            r["package_name"],
            r["package_version"],
            r["series"],
            r["architecture"],
            r["pocket"],
            r["date"],
        ),
    )
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for record in records_sorted:
            row = dict(record)
            row["is_debug"] = str(bool(row["is_debug"]))
            writer.writerow(row)


def write_json(records: list[dict], path: Path, last_updated: str) -> int:
    """Write the compact per-binary time-series JSON. Returns binary count."""
    grouped: dict[tuple, dict] = {}
    for record in records:
        key = binary_key(record)
        entry = grouped.get(key)
        if entry is None:
            entry = {
                "origin": record["origin"],
                "source_package": record["source_package"],
                "name": record["package_name"],
                "version": record["package_version"],
                "series": record["series"],
                "architecture": record["architecture"],
                "pocket": record["pocket"],
                "status": record["status"],
                "is_debug": bool(record["is_debug"]),
                "counts": [],
            }
            grouped[key] = entry
        entry["counts"].append([record["date"], int(record["count"])])

    binaries = list(grouped.values())
    for entry in binaries:
        entry["counts"].sort(key=lambda pair: pair[0])

    payload = {"last_updated": last_updated, "binaries": binaries}
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    return len(binaries)


def write_metadata(
    path: Path,
    last_updated: str,
    row_count: int,
    binary_count: int,
    origins: dict[str, int],
) -> None:
    payload = {
        "last_updated": last_updated,
        "row_count": row_count,
        "binary_count": binary_count,
        "rows_by_origin": origins,
    }
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    global VERBOSE
    VERBOSE = args.verbose
    config = load_config(args.config)
    source_packages = set(config["source_packages"])

    output_dir = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    csv_path = output_dir / "downloads.csv"
    json_path = output_dir / "downloads.json"
    meta_path = output_dir / "last-run.json"

    existing = load_existing(csv_path)
    vlog(f"Loaded {len(existing)} existing rows from {csv_path}")
    vlog(f"Tracking source packages: {sorted(source_packages)}")

    # Determine effective start date (auto-incremental if not specified).
    start = args.start
    if start is None and existing:
        last = max_existing_date(existing)
        if last is not None:
            start = last - dt.timedelta(days=INCREMENTAL_SAFETY_DAYS)
            log(f"Incremental mode: fetching counts since {start.isoformat()}")
    elif start is None:
        log("Full backfill: fetching all available history")

    log(f"Connecting to Launchpad ({LAUNCHPAD_INSTANCE}) anonymously ...")
    launchpad = Launchpad.login_anonymously(
        APPLICATION_NAME, LAUNCHPAD_INSTANCE, CACHE_DIR, version="devel"
    )

    ppa = launchpad.people[config["team"]].getPPAByName(name=config["ppa"])
    primary = launchpad.distributions["ubuntu"].main_archive

    ppa_records, binary_names = collect_ppa(ppa, source_packages, start, args.end)

    # Fold in any configured binary-name overrides (for source packages that
    # may not be present in the PPA at all).
    for source, names in config["binary_names"].items():
        binary_names.setdefault(source, set()).update(names)

    archive_records = collect_archive(
        primary, source_packages, binary_names, start, args.end
    )

    fresh = ppa_records + archive_records
    vlog(
        f"Fetched {len(ppa_records)} PPA rows + {len(archive_records)} archive rows "
        f"= {len(fresh)} fresh rows; merging with {len(existing)} existing rows"
    )
    merged = merge_records(existing, fresh)

    last_updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_csv(merged, csv_path)
    binary_count = write_json(merged, json_path, last_updated)

    origins: dict[str, int] = defaultdict(int)
    for record in merged:
        origins[record["origin"]] += 1

    write_metadata(meta_path, last_updated, len(merged), binary_count, dict(origins))

    log(
        f"Wrote {len(merged)} rows ({binary_count} binaries) to "
        f"{csv_path} and {json_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
