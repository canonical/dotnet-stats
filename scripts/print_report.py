#!/usr/bin/env python3
"""Render an archived monthly report PDF with a headless browser.

The report's figures live in web/report.js and nowhere else. This script prints
the dashboard's report view for one month, so the archived PDF is exactly what a
reader sees at index.html?month=YYYY-MM.

What it does:

  1. assembles nothing -- it serves a site directory you have already staged,
     because the page fetches data/downloads.json over HTTP (file:// blocks it),
  2. drives Chrome with --headless=new --print-to-pdf,
  3. validates the result and retries with a longer virtual time budget,
     because a browser that prints before Plotly has drawn would otherwise
     publish a half-empty report.

The validation is meaningful rather than cosmetic: style.css withholds the whole
report body until app.js has confirmed every chart drew, so a premature print
collapses to a single short warning page and is rejected here.

Standard library only.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

CHROME_CANDIDATES = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
]

# Escalating virtual time budgets. The first is normally enough; the rest exist
# so a slow runner degrades into a slower render rather than a broken artifact.
DEFAULT_BUDGETS = (20000, 45000, 90000)

# A correctly rendered report is at least two pages even for a month with no
# data; a withheld one is a single short page.
DEFAULT_MIN_PAGES = 2
DEFAULT_MIN_BYTES = 40_000


def find_chrome(explicit: str | None) -> str:
    if explicit:
        if not (Path(explicit).exists() or shutil.which(explicit)):
            raise SystemExit(f"chrome not found at {explicit!r}")
        return explicit
    env = os.environ.get("CHROME")
    if env:
        return find_chrome(env)
    for name in CHROME_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit(
        "no Chrome/Chromium found. Install one, or pass --chrome /path/to/chrome"
    )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - silence the request log
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(directory: Path) -> tuple[Server, int, threading.Thread]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = Server(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port, thread


def pdf_page_count(path: Path) -> int:
    """Page count of a Chrome-produced PDF, without a PDF library.

    Chrome writes the page tree as plain objects, so /Count on the root Pages
    node is readable. Falls back to counting page objects.
    """
    raw = path.read_bytes()
    counts = [int(m) for m in re.findall(rb"/Count\s+(\d+)", raw)]
    if counts:
        return max(counts)
    return len(re.findall(rb"/Type\s*/Page[^s]", raw))


def render(
    chrome: str,
    url: str,
    out: Path,
    budget: int,
    timeout: int,
) -> tuple[int | None, str]:
    """Run Chrome once. Returns (returncode or None on timeout, log tail).

    Two details are load-bearing and were arrived at the hard way:

    * No --user-data-dir. Giving Chrome a profile directory activates its
      background network services (GCM registration and friends), which keep the
      browser alive indefinitely, so --print-to-pdf never completes. The profile
      is isolated by pointing HOME at a temporary directory instead.
    * Output goes to a file, not a pipe. The crashpad handler inherits the
      parent's stderr and outlives the browser, so a captured pipe never reaches
      EOF and the wait hangs even though the render finished.
    """
    with tempfile.TemporaryDirectory(prefix="chrome-report-") as tmp:
        logfile = Path(tmp) / "chrome.log"
        cmd = [
            chrome,
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--no-pdf-header-footer",
            f"--virtual-time-budget={budget}",
            f"--print-to-pdf={out}",
            url,
        ]
        env = dict(os.environ, HOME=tmp)
        with logfile.open("w") as handle:
            proc = subprocess.Popen(
                cmd, stdout=handle, stderr=subprocess.STDOUT, env=env
            )
            try:
                code = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                code = None
        tail = " | ".join(logfile.read_text(errors="replace").strip().splitlines()[-3:])
        return code, tail


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True,
                        help="staged site directory (must contain index.html "
                             "and data/downloads.json)")
    parser.add_argument("--month", required=True, help="month to render, YYYY-MM")
    parser.add_argument("--out", required=True, help="PDF path to write")
    parser.add_argument("--chrome", default=None,
                        help="Chrome/Chromium binary (default: $CHROME or the "
                             "first of %s on PATH)" % ", ".join(CHROME_CANDIDATES))
    parser.add_argument("--appendix", action="store_true",
                        help="include the full-breakdown appendix")
    parser.add_argument("--budgets", default=",".join(str(b) for b in DEFAULT_BUDGETS),
                        help="comma-separated virtual time budgets in ms "
                             "(default: %(default)s)")
    parser.add_argument("--min-pages", type=int, default=DEFAULT_MIN_PAGES,
                        help="reject a PDF with fewer pages (default: %(default)s)")
    parser.add_argument("--min-bytes", type=int, default=DEFAULT_MIN_BYTES,
                        help="reject a PDF smaller than this (default: %(default)s)")
    parser.add_argument("--timeout", type=int, default=300,
                        help="per-attempt timeout in seconds (default: %(default)s)")
    args = parser.parse_args(argv)

    if not re.fullmatch(r"\d{4}-\d{2}", args.month):
        raise SystemExit(f"--month must be YYYY-MM, got {args.month!r}")

    site = Path(args.site)
    if not (site / "index.html").is_file():
        raise SystemExit(f"{site}/index.html not found; stage the site first")
    if not (site / "data" / "downloads.json").is_file():
        raise SystemExit(f"{site}/data/downloads.json not found; stage the data first")

    chrome = find_chrome(args.chrome)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    budgets = [int(b) for b in args.budgets.split(",") if b.strip()]
    httpd, port, _thread = serve(site)
    query = f"?month={args.month}&print=1"
    if args.appendix:
        query += "&appendix=1"
    url = f"http://127.0.0.1:{port}/index.html{query}"
    print(f"chrome:  {chrome}")
    print(f"serving: {site} on port {port}")
    print(f"url:     {url}")

    try:
        for attempt, budget in enumerate(budgets, start=1):
            if out.exists():
                out.unlink()
            code, tail = render(chrome, url, out, budget, args.timeout)

            if code is None:
                print(f"attempt {attempt}: chrome timed out after {args.timeout}s"
                      + (f": {tail}" if tail else ""))
            elif code != 0:
                print(f"attempt {attempt}: chrome exited {code}"
                      + (f": {tail}" if tail else ""))

            # Validate whatever was produced, even after a non-zero exit: the
            # file is either a complete report or it is rejected below.
            if not out.exists():
                print(f"attempt {attempt}: chrome wrote no file")
                continue

            size = out.stat().st_size
            pages = pdf_page_count(out)
            print(f"attempt {attempt} (budget {budget}ms): {pages} pages, {size} bytes")

            if pages >= args.min_pages and size >= args.min_bytes:
                print(f"wrote {out} for {args.month}: {pages} pages, "
                      f"{size / 1024:.0f} kB")
                return 0

            print(
                f"attempt {attempt}: rejected (needs >= {args.min_pages} pages and "
                f">= {args.min_bytes} bytes). The report body is withheld until "
                "every chart has drawn, so this is a premature or failed render."
            )
    finally:
        httpd.shutdown()
        httpd.server_close()

    if out.exists():
        out.unlink()
    raise SystemExit(
        f"could not render a complete report for {args.month} after "
        f"{len(budgets)} attempt(s)"
    )


if __name__ == "__main__":
    sys.exit(main())
