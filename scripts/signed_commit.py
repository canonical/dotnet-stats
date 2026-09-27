#!/usr/bin/env python3
"""Commit files to a branch through the GitHub API, so GitHub signs the commit.

`main` is protected with "Require signed commits". A plain `git commit` +
`git push` from a workflow produces an unsigned commit, which the protection
rejects. Commits created through the REST Git Data API with the workflow's
GITHUB_TOKEN, and with no explicit author/committer, are instead signed by
GitHub and show as "Verified".

The Git Data API is used rather than GraphQL `createCommitOnBranch` because the
data files are large (downloads.csv is tens of MB): each file goes up as its
own blob request instead of all of them in one GraphQL payload.

Steps, for the paths given on the command line:

  1. compare each path in the working tree with the checked-out HEAD and keep
     only the ones that changed (exit 0 with nothing to do if none did),
  2. upload each changed file as a blob,
  3. create a tree on top of HEAD's tree, then a commit whose parent is HEAD,
  4. refuse to continue unless GitHub reports the commit as verified,
  5. fast-forward the branch ref to the new commit (no force). If the branch
     moved since checkout this fails, like a rejected non-fast-forward push.

The final ref update is still subject to the branch's other protection rules
(e.g. the pull-request requirement, which the GitHub Actions app must be
allowed to bypass).

Standard library only. Needs `git` and a token in GITHUB_TOKEN or GH_TOKEN
with `contents: write`.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_URL = os.environ.get("GITHUB_API_URL", "https://api.github.com")
# Blob uploads of the larger data files can take a while.
TIMEOUT_SECONDS = 300
RETRIES = 3


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def head_entry(path: str) -> tuple[str, str] | None:
    """(mode, blob sha) of `path` in HEAD, or None if it is not tracked."""
    out = git("ls-tree", "HEAD", "--", path)
    if not out:
        return None
    meta, _name = out.split("\t", 1)
    mode, _type, sha = meta.split()
    return mode, sha


class GitHub:
    def __init__(self, repo: str, token: str) -> None:
        self.base = f"{API_URL}/repos/{repo}"
        self.token = token

    def request(self, method: str, path: str, body: dict) -> dict:
        data = json.dumps(body).encode()
        for attempt in range(1, RETRIES + 1):
            req = urllib.request.Request(
                self.base + path,
                data=data,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "Content-Type": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as err:
                detail = err.read().decode(errors="replace")
                # Only server-side errors are worth retrying; 4xx (including a
                # protection rejection or a non-fast-forward) will not change.
                if err.code >= 500 and attempt < RETRIES:
                    print(f"{method} {path}: HTTP {err.code}, retrying",
                          file=sys.stderr)
                    time.sleep(5 * attempt)
                    continue
                sys.exit(f"error: {method} {path} failed: HTTP {err.code}\n{detail}")
            except urllib.error.URLError as err:
                if attempt < RETRIES:
                    print(f"{method} {path}: {err.reason}, retrying",
                          file=sys.stderr)
                    time.sleep(5 * attempt)
                    continue
                sys.exit(f"error: {method} {path} failed: {err.reason}")
        raise AssertionError("unreachable")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("paths", nargs="+",
                        help="files to commit (relative to the repo root)")
    parser.add_argument("-m", "--message", required=True, help="commit message")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"),
                        help="owner/name (default: $GITHUB_REPOSITORY)")
    parser.add_argument("--branch", default=os.environ.get("GITHUB_REF_NAME"),
                        help="branch to update (default: $GITHUB_REF_NAME)")
    parser.add_argument("--dry-run", action="store_true",
                        help="only report which paths would be committed")
    args = parser.parse_args()

    # Paths are resolved against the repo root, as git and the API see them.
    os.chdir(git("rev-parse", "--show-toplevel"))

    changes = []  # tree entries for the new commit
    for path in args.paths:
        path = Path(path).as_posix()
        current = head_entry(path)
        if not Path(path).is_file():
            if current is not None:
                changes.append({"path": path, "mode": current[0],
                                "type": "blob", "sha": None})
                print(f"delete  {path}")
            continue
        local_sha = git("hash-object", "--", path)
        if current is not None and current[1] == local_sha:
            continue
        mode = current[0] if current else "100644"
        changes.append({"path": path, "mode": mode, "type": "blob",
                        "local": path})
        print(f"{'modify' if current else 'add':<7} {path}")

    if not changes:
        print("No changes to commit.")
        return 0
    if args.dry_run:
        return 0

    if not args.repo or not args.branch:
        sys.exit("error: --repo and --branch are required outside Actions")
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not token:
        sys.exit("error: set GITHUB_TOKEN or GH_TOKEN")
    gh = GitHub(args.repo, token)

    parent = git("rev-parse", "HEAD")
    base_tree = git("rev-parse", "HEAD^{tree}")

    tree = []
    for entry in changes:
        local = entry.pop("local", None)
        if local is not None:
            content = base64.b64encode(Path(local).read_bytes()).decode()
            blob = gh.request("POST", "/git/blobs",
                              {"content": content, "encoding": "base64"})
            entry["sha"] = blob["sha"]
        tree.append(entry)

    new_tree = gh.request("POST", "/git/trees",
                          {"base_tree": base_tree, "tree": tree})
    # No author/committer: GitHub attributes the commit to the token's bot
    # identity and signs it. Setting either would produce an unsigned commit.
    commit = gh.request("POST", "/git/commits", {
        "message": args.message,
        "tree": new_tree["sha"],
        "parents": [parent],
    })
    verification = commit.get("verification") or {}
    if not verification.get("verified"):
        sys.exit(f"error: commit {commit['sha']} is not verified "
                 f"(reason: {verification.get('reason')}); not updating "
                 f"{args.branch}")

    gh.request("PATCH", f"/git/refs/heads/{args.branch}",
               {"sha": commit["sha"], "force": False})
    print(f"Committed {commit['sha']} to {args.branch} (verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
