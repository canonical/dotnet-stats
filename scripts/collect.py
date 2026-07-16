#!/usr/bin/env python3
"""Collect .NET package download counts from Launchpad.

Gathers download-count statistics for a configured set of source packages from
the dotnet team's backports PPA (origin "backports-ppa").

Only the PPA is queried. The primary Ubuntu archive is intentionally not
collected: Launchpad exposes no per-package download counts for it
(``getDownloadCounts`` returns nothing for primary-archive publications, since
the archive is distributed via the mirror/CDN network rather than Launchpad).

Because the Launchpad API silently ignores the ``source_package_name`` filter
on ``getPublishedBinaries``, published binaries are enumerated from the PPA and
filtered by source package client-side.

The script is incremental: it merges freshly fetched counts into the existing
data files, deduplicating by a composite key and keeping the maximum count.

Usage:
    python scripts/collect.py [--config config.json]
                              [--start YYYY-MM-DD] [--end YYYY-MM-DD]
                              [--output-dir data/]
                              [--workers N] [--max-rps N]
                              [--verbose]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from launchpadlib.launchpad import Launchpad

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

CACHE_DIR = "~/.cache/launchpadlib"
APPLICATION_NAME = "dotnet-stats-collector"
LAUNCHPAD_INSTANCE = "production"

ORIGIN_PPA = "backports-ppa"

# Courtesy delay between API calls (seconds) during single-threaded pagination.
API_SLEEP = 0.1

# Page size used when paging through published binaries.
PAGE_SIZE = 300

# Parallelism defaults (overridable via CLI flags).
DEFAULT_WORKERS = 8
DEFAULT_MAX_RPS = 20

# Per-task retry policy for transient download-count failures.
FETCH_RETRIES = 3
RETRY_BACKOFF = 0.5  # seconds; multiplied by 2**attempt

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
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"number of parallel fetch workers (default: {DEFAULT_WORKERS}; "
        "use 1 for fully sequential)",
    )
    parser.add_argument(
        "--max-rps",
        type=float,
        default=DEFAULT_MAX_RPS,
        help=f"aggregate cap on API requests per second across all workers "
        f"(default: {DEFAULT_MAX_RPS})",
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
# Concurrency infrastructure
# --------------------------------------------------------------------------- #


class RateLimiter:
    """Thread-safe token bucket enforcing an aggregate max requests/second.

    ``acquire`` blocks until a token is available, so all worker threads
    combined never exceed ``rate`` requests per second regardless of how many
    threads are running.
    """

    def __init__(self, rate: float) -> None:
        self.rate = max(rate, 0.0)
        # Cap burst size to ~1 second's worth of requests, and start with a
        # small bucket so we don't fire a large burst at startup.
        self.capacity = max(rate, 1.0)
        self.tokens = min(1.0, self.capacity)
        self.timestamp = time.monotonic()
        self.lock = threading.Lock()

    def acquire(self) -> None:
        if self.rate <= 0:
            return
        with self.lock:
            while True:
                now = time.monotonic()
                elapsed = now - self.timestamp
                self.timestamp = now
                self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return
                # Wait just long enough for the next token to accrue.
                sleep_for = (1.0 - self.tokens) / self.rate
                time.sleep(sleep_for)


# Per-thread Launchpad instance (Option B: no shared HTTP state across threads).
_thread_local = threading.local()


def thread_launchpad() -> Launchpad:
    """Return this thread's own anonymous Launchpad instance, creating it once."""
    lp = getattr(_thread_local, "launchpad", None)
    if lp is None:
        lp = Launchpad.login_anonymously(
            APPLICATION_NAME, LAUNCHPAD_INSTANCE, CACHE_DIR, version="devel"
        )
        _thread_local.launchpad = lp
    return lp


# --------------------------------------------------------------------------- #
# Download-count fetching
# --------------------------------------------------------------------------- #


def fetch_download_counts(
    self_link: str,
    base_fields: dict,
    start: dt.date | None,
    end: dt.date | None,
    limiter: RateLimiter,
) -> list[dict]:
    """Return per-day download-count records for a single binary publication.

    Runs on a worker thread: re-resolves the publication on this thread's own
    Launchpad instance (Option B isolation), then fetches its download counts
    for the requested window. ``getDownloadCounts`` returns entries newest-first,
    so the client-side ``start`` check acts as a safety net alongside the
    server-side ``start_date``/``end_date`` parameters.
    """
    records: list[dict] = []
    kwargs: dict = {}
    if start is not None:
        # launchpadlib JSON-encodes operation parameters, so pass ISO strings
        # rather than date objects (which are not JSON serializable).
        kwargs["start_date"] = start.isoformat()
    if end is not None:
        kwargs["end_date"] = end.isoformat()

    last_exc: Exception | None = None
    counts = None
    for attempt in range(FETCH_RETRIES):
        try:
            limiter.acquire()
            lp = thread_launchpad()
            binary = lp.load(self_link)
            limiter.acquire()
            counts = binary.getDownloadCounts(**kwargs)
            last_exc = None
            break
        except Exception as exc:  # pragma: no cover - network issues
            last_exc = exc
            if attempt + 1 < FETCH_RETRIES:
                time.sleep(RETRY_BACKOFF * (2 ** attempt))
    if counts is None:
        log(
            f"  ! failed to get download counts for "
            f"{base_fields['package_name']} {base_fields['package_version']} "
            f"[{base_fields['series']}/{base_fields['architecture']}]: {last_exc}"
        )
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
    return records


def should_skip_removed(binary, start: dt.date | None) -> bool:
    """True when a publication was removed before the window and so cannot have
    accrued any new download counts within it. Never skips on a full backfill."""
    if start is None:
        return False
    removed = getattr(binary, "date_removed", None)
    if removed is None:
        return False
    if hasattr(removed, "date"):
        removed = removed.date()
    return removed < start


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
# Parallel fetch driver
# --------------------------------------------------------------------------- #


class FetchPool:
    """Streams download-count fetch jobs to a thread pool as they are discovered.

    Jobs are submitted via :meth:`submit` during enumeration so that fetching
    overlaps with enumeration and progress/verbose output appears immediately
    (rather than only after the whole archive has been scanned). Call
    :meth:`results` once all jobs have been submitted to drain and aggregate
    every result. Output is order-independent (the final merge sorts).

    With ``workers <= 1`` the work runs inline on submit, preserving the fully
    sequential behaviour.
    """

    def __init__(
        self,
        start: dt.date | None,
        end: dt.date | None,
        limiter: RateLimiter,
        workers: int,
    ) -> None:
        self.start = start
        self.end = end
        self.limiter = limiter
        self.workers = workers
        self._records: list[dict] = []
        self._futures: list = []
        self._submitted = 0
        self._done = 0
        self._executor = (
            ThreadPoolExecutor(max_workers=workers) if workers > 1 else None
        )

    def submit(self, self_link: str, base_fields: dict) -> None:
        self._submitted += 1
        if self._executor is None:
            self._records.extend(
                fetch_download_counts(
                    self_link, base_fields, self.start, self.end, self.limiter
                )
            )
            self._progress()
        else:
            self._futures.append(
                self._executor.submit(
                    fetch_download_counts,
                    self_link,
                    base_fields,
                    self.start,
                    self.end,
                    self.limiter,
                )
            )

    def _progress(self) -> None:
        self._done += 1
        if self._done % 25 == 0:
            log(f"  fetched {self._done}/{self._submitted} binaries ...")

    def results(self) -> list[dict]:
        """Drain all in-flight futures and return the aggregated records."""
        if self._executor is not None:
            for future in as_completed(self._futures):
                self._records.extend(future.result())
                self._progress()
            self._executor.shutdown(wait=True)
        return self._records


# --------------------------------------------------------------------------- #
# Collection - backports PPA
# --------------------------------------------------------------------------- #


def collect_ppa(
    ppa,
    source_packages: set[str],
    start: dt.date | None,
    end: dt.date | None,
    limiter: RateLimiter,
    workers: int,
) -> list[dict]:
    """Collect download counts for tracked source packages from the PPA."""
    log("Collecting from backports PPA ...")
    binary_names: dict[str, set[str]] = defaultdict(set)
    pool = FetchPool(start, end, limiter, workers)

    matched = 0
    skipped = 0
    submitted = 0
    total_seen = 0
    # Enumeration stays single-threaded (the lazy collection is not thread-safe),
    # but fetch jobs are streamed to the pool as they are discovered.
    for binary in ppa.getPublishedBinaries():
        total_seen += 1
        if total_seen % 500 == 0:
            vlog(f"  scanned {total_seen} PPA binaries ({matched} matched so far) ...")
        source = binary.source_package_name
        if source not in source_packages:
            continue
        matched += 1
        binary_names[source].add(binary.binary_package_name)

        if should_skip_removed(binary, start):
            skipped += 1
            continue

        base = binary_base_fields(binary, ORIGIN_PPA)
        pool.submit(binary.self_link, base)
        submitted += 1

    vlog(
        "  discovered binary names: "
        + ", ".join(
            f"{src}={sorted(names)}" for src, names in sorted(binary_names.items())
        )
    )
    log(
        f"  matched {matched} binaries (of {total_seen} scanned); "
        f"{skipped} skipped (removed before window); "
        f"fetching {submitted} with {workers} worker(s)"
    )
    records = pool.results()
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

    workers = max(1, args.workers)
    limiter = RateLimiter(args.max_rps)
    vlog(f"Parallelism: {workers} worker(s), max {args.max_rps} req/s")

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

    fresh = collect_ppa(ppa, source_packages, start, args.end, limiter, workers)
    vlog(
        f"Fetched {len(fresh)} fresh rows; merging with {len(existing)} existing rows"
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
