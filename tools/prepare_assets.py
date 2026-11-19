#!/usr/bin/env python3
"""Build-time asset preparation orchestrator for ddlcweb.

Extracts DDLC assets from a user-supplied copy of DDLC (`ddlc-win.zip`,
`ddlc-mac.zip`, or an extracted DDLC directory) and compiles all `.rpyc`
scripts into `src/generated/` and `public/game-assets/` (both gitignored).

Usage:
    python3 tools/prepare_assets.py /path/to/ddlc-win.zip
    python3 tools/prepare_assets.py --ddlc /path/to/ddlc-win.zip
    DDLC_ZIP=/path/to/ddlc-win.zip npm run build
    npm run build --ddlc=/path/to/ddlc-win.zip
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compile_data import PIPELINE_VERSION, compile_all
from extract_ddlc import ExtractionError, extract_ddlc


def _resolve_source(cli_arg: str | None) -> Path | None:
    candidates = [
        cli_arg,
        os.environ.get("DDLC_ZIP"),
        os.environ.get("DDLC_PATH"),
        os.environ.get("npm_config_ddlc"),
    ]
    for c in candidates:
        if c and c.strip():
            return Path(c.strip()).expanduser().resolve()
    return None


def _read_stamp(stamp_path: Path) -> dict | None:
    if not stamp_path.is_file():
        return None
    try:
        return json.loads(stamp_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _source_stat_sig(source: Path) -> dict:
    st = source.stat()
    return {
        "path": str(source),
        "size": st.st_size if source.is_file() else -1,
        "mtime_ns": st.st_mtime_ns,
        "pipelineVersion": PIPELINE_VERSION,
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Extract DDLC assets from ddlc-win.zip / ddlc-mac.zip and compile web manifests."
    )
    ap.add_argument(
        "source_pos",
        nargs="?",
        default=None,
        help="Path to ddlc-win.zip, ddlc-mac.zip, or an extracted DDLC folder",
    )
    ap.add_argument(
        "--ddlc",
        dest="source_flag",
        default=None,
        help="Path to ddlc-win.zip, ddlc-mac.zip, or an extracted DDLC folder",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Re-extract and recompile even if the cached build stamp matches",
    )
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    assets_dir = repo_root / "public" / "game-assets"
    rpyc_dir = repo_root / ".cache" / "rpyc"
    generated_dir = repo_root / "src" / "generated"
    stamp_path = repo_root / ".cache" / "build-stamp.json"

    source = _resolve_source(args.source_flag or args.source_pos)
    manifest_ready = (
        (generated_dir / "manifest.json").is_file()
        and (generated_dir / "index.ts").is_file()
    )
    assets_ready = (assets_dir / "game").is_dir()

    if source is None:
        if manifest_ready and assets_ready and not args.force:
            print(
                "[ddlcweb] Using previously extracted DDLC assets in "
                "public/game-assets/ & src/generated/."
            )
            return 0
        print(
            "ERROR: No DDLC archive path supplied and no extracted assets found.\n"
            "\n"
            "Supply your own legally obtained copy of Doki Doki Literature Club!:\n"
            "  DDLC_ZIP=/path/to/ddlc-win.zip npm run build\n"
            "  DDLC_ZIP=/path/to/ddlc-win.zip npm run dev\n"
            "  python3 tools/prepare_assets.py /path/to/ddlc-win.zip\n",
            file=sys.stderr,
        )
        return 1

    if not source.exists():
        print(f"ERROR: DDLC source does not exist: {source}", file=sys.stderr)
        return 1

    if not args.force and manifest_ready and assets_ready and source.is_file():
        prev = _read_stamp(stamp_path)
        cur = _source_stat_sig(source)
        if prev == cur:
            print(f"[ddlcweb] Assets up-to-date for {source.name} (pass --force to rebuild).")
            return 0

    print(f"[ddlcweb] Preparing DDLC assets from: {source}")
    try:
        summary = extract_ddlc(source, assets_dir, rpyc_dir)
        compile_all(
            rpyc_dir=rpyc_dir,
            assets_dir=assets_dir,
            out_dir=generated_dir,
            source_sha256=summary.source_sha256,
            game_files=summary.game_files,
            character_files=summary.character_files,
        )
    except ExtractionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    stamp_path.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        stamp_path.write_text(json.dumps(_source_stat_sig(source), indent=2), encoding="utf-8")

    print("[ddlcweb] Asset preparation complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
