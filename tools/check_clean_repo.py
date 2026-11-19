#!/usr/bin/env python3
"""Verify that no copyrighted DDLC assets or generated data are tracked in git.

Exits non-zero if any forbidden path or extension is tracked or staged in git.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

FORBIDDEN_PREFIXES = (
    "public/game-assets/",
    "src/generated/",
    ".cache/",
    "dist/",
)

FORBIDDEN_EXTENSIONS = {
    ".rpa",
    ".rpyc",
    ".chr",
    ".ogg",
    ".ttf",
    ".otf",
    ".zip",
}


def git_files(repo_root: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=repo_root,
        capture_output=True,
        check=True,
    )
    raw = proc.stdout.decode("utf-8", errors="replace")
    return [p for p in raw.split("\0") if p]


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    try:
        tracked = git_files(repo_root)
    except subprocess.CalledProcessError as exc:
        print(f"check_clean_repo: git ls-files failed: {exc}", file=sys.stderr)
        return 1

    violations: list[str] = []
    for rel in tracked:
        norm = rel.replace("\\", "/")
        if any(norm.startswith(prefix) for prefix in FORBIDDEN_PREFIXES):
            violations.append(f"forbidden directory: {norm}")
            continue
        ext = Path(norm).suffix.lower()
        if ext in FORBIDDEN_EXTENSIONS:
            violations.append(f"forbidden extension ({ext}): {norm}")

    if violations:
        print("ERROR: Copyrighted/generated DDLC files found in git index:", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1

    print(f"OK: {len(tracked)} tracked files checked; zero DDLC assets or generated data in git.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
