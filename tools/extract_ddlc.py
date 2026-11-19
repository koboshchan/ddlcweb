#!/usr/bin/env python3
"""Pure-Python RPA-3.0 + ZIP extractor for Doki Doki Literature Club!

Extracts game assets directly from a user-provided copy of DDLC:
  - ddlc-win.zip (DDLC-1.1.1-pc/...)
  - ddlc-mac.zip (DDLC.app/Contents/Resources/autorun/...)
  - An already-extracted DDLC directory (or its `game/` subdirectory)

Uses only the Python 3 standard library (no pip dependencies, no unrpa needed).
Unpickling of RPA indices uses a zero-class RestrictedUnpickler so arbitrary
code can never be executed.

Outputs (all gitignored):
  - <assets_dir>/game/...        (extracted images, audio, fonts, data files)
  - <assets_dir>/characters/...  (extracted initial *.chr files)
  - <rpyc_dir>/*.rpyc            (extracted compiled scripts for compile_data.py)
"""

from __future__ import annotations

import codecs
import hashlib
import io
import pickle
import shutil
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterator


RPA_ARCHIVES = ("scripts.rpa", "images.rpa", "audio.rpa", "fonts.rpa")


class ExtractionError(RuntimeError):
    """Raised when the DDLC input archive/directory is invalid or incomplete."""


_SAFE_RPA_GLOBALS: dict[tuple[str, str], object] = {
    ("_codecs", "encode"): codecs.encode,
    ("__builtin__", "bytes"): bytes,
    ("builtins", "bytes"): bytes,
}


class _SafeIndexUnpickler(pickle.Unpickler):
    """Allows only primitive bytes helpers; blocks all arbitrary code execution."""

    def find_class(self, module: str, name: str) -> object:
        allowed = _SAFE_RPA_GLOBALS.get((module, name))
        if allowed is not None:
            return allowed
        raise pickle.UnpicklingError(
            f"Disallowed global {module}.{name} in RPA index"
        )


def _safe_relpath(raw_name: str) -> Path:
    """Validate and normalize an archive-relative path against traversal."""
    normalized = raw_name.replace("\\", "/").lstrip("/")
    rel = Path(normalized)
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise ExtractionError(f"Unsafe archive entry path: {raw_name!r}")
    return rel


def iter_rpa_entries(blob: bytes) -> Iterator[tuple[str, bytes]]:
    """Yield (relative_path, file_bytes) for every entry in an RPA-3.0 archive."""
    nl = blob.find(b"\n")
    if nl < 0:
        raise ExtractionError("Corrupt RPA archive (missing header newline)")

    header_parts = blob[:nl].decode("ascii", errors="replace").strip().split()
    if len(header_parts) < 3 or header_parts[0] != "RPA-3.0":
        raise ExtractionError(f"Unsupported RPA header: {header_parts!r}")

    index_offset = int(header_parts[1], 16)
    key = int(header_parts[2], 16)

    raw_index = zlib.decompress(blob[index_offset:])
    index = _SafeIndexUnpickler(io.BytesIO(raw_index), encoding="latin1").load()
    if not isinstance(index, dict):
        raise ExtractionError("Invalid RPA index structure")

    for raw_name, spans in index.items():
        if isinstance(raw_name, bytes):
            name = raw_name.decode("utf-8", errors="replace")
        else:
            name = str(raw_name)
        chunks: list[bytes] = []
        for entry in spans:
            if len(entry) == 2:
                offset, length = entry
                prefix = b""
            else:
                offset, length, prefix = entry[0], entry[1], entry[2]
                if isinstance(prefix, str):
                    prefix = prefix.encode("latin1")
            real_offset = offset ^ key
            real_length = length ^ key
            body = blob[real_offset : real_offset + real_length - len(prefix)]
            chunks.append(prefix + body)
        yield name, b"".join(chunks)


@dataclass
class ExtractionSummary:
    source_path: str
    source_sha256: str
    rpyc_files: list[str]
    game_files: list[str]
    character_files: list[str]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _load_rpa_blobs_from_zip(zip_path: Path) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """Read required game/*.rpa and characters/*.chr from ddlc-win.zip or ddlc-mac.zip."""
    rpas: dict[str, bytes] = {}
    chrs: dict[str, bytes] = {}

    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            norm = info.filename.replace("\\", "/")
            parts = norm.split("/")
            if len(parts) >= 2 and parts[-2] == "game" and parts[-1] in RPA_ARCHIVES:
                rpas[parts[-1]] = zf.read(info)
            elif (
                len(parts) >= 2
                and parts[-2] == "characters"
                and parts[-1].lower().endswith(".chr")
            ):
                chrs[parts[-1]] = zf.read(info)

    missing = [name for name in RPA_ARCHIVES if name not in rpas]
    if missing:
        raise ExtractionError(
            f"{zip_path} is missing required RPA archive(s): {', '.join(missing)}"
        )
    return rpas, chrs


def _load_rpa_blobs_from_dir(root: Path) -> tuple[dict[str, bytes], dict[str, bytes]]:
    """Read required game/*.rpa and characters/*.chr from an extracted DDLC directory."""
    mac_autorun = root / "DDLC.app" / "Contents" / "Resources" / "autorun"
    if (root / "scripts.rpa").is_file():
        game_dir = root
        base_dir = root.parent
    elif (root / "game" / "scripts.rpa").is_file():
        game_dir = root / "game"
        base_dir = root
    elif (mac_autorun / "game" / "scripts.rpa").is_file():
        base_dir = mac_autorun
        game_dir = base_dir / "game"
    else:
        raise ExtractionError(
            f"Could not locate game/scripts.rpa under {root}. "
            "Pass ddlc-win.zip, ddlc-mac.zip, or an extracted DDLC folder."
        )

    rpas: dict[str, bytes] = {}
    for name in RPA_ARCHIVES:
        p = game_dir / name
        if not p.is_file():
            raise ExtractionError(f"Missing {p}")
        rpas[name] = p.read_bytes()

    chrs: dict[str, bytes] = {}
    chr_dir = base_dir / "characters"
    if chr_dir.is_dir():
        for p in sorted(chr_dir.iterdir()):
            if p.is_file() and p.suffix.lower() == ".chr":
                chrs[p.name] = p.read_bytes()

    return rpas, chrs


def extract_ddlc(source: Path, assets_dir: Path, rpyc_dir: Path) -> ExtractionSummary:
    """Extract all DDLC archives from `source` into `assets_dir` and `rpyc_dir`."""
    source = source.expanduser().resolve()
    if not source.exists():
        raise ExtractionError(f"DDLC source not found: {source}")

    if source.is_file() and zipfile.is_zipfile(source):
        rpas, chrs = _load_rpa_blobs_from_zip(source)
        fingerprint = _sha256_file(source)
    elif source.is_dir():
        rpas, chrs = _load_rpa_blobs_from_dir(source)
        h = hashlib.sha256()
        for name in RPA_ARCHIVES:
            h.update(hashlib.sha256(rpas[name]).digest())
        fingerprint = h.hexdigest()
    else:
        raise ExtractionError(
            f"Unsupported DDLC source {source}: expected ddlc-win.zip, ddlc-mac.zip, or a directory."
        )

    game_out = assets_dir / "game"
    chars_out = assets_dir / "characters"

    # Clean output directories so stale files never linger across rebuilds.
    if assets_dir.exists():
        shutil.rmtree(assets_dir)
    if rpyc_dir.exists():
        shutil.rmtree(rpyc_dir)

    game_out.mkdir(parents=True, exist_ok=True)
    chars_out.mkdir(parents=True, exist_ok=True)
    rpyc_dir.mkdir(parents=True, exist_ok=True)

    rpyc_files: list[str] = []
    game_files: list[str] = []
    character_files: list[str] = []

    for rpa_name in RPA_ARCHIVES:
        print(f"  [extract] {rpa_name}...")
        for entry_name, payload in iter_rpa_entries(rpas[rpa_name]):
            rel = _safe_relpath(entry_name)
            rel_posix = rel.as_posix()
            if rpa_name == "scripts.rpa" and rel.suffix.lower() == ".rpyc":
                dest = rpyc_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(payload)
                rpyc_files.append(rel_posix)
            else:
                dest = game_out / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(payload)
                game_files.append(rel_posix)

    for chr_name, payload in sorted(chrs.items()):
        rel = _safe_relpath(chr_name)
        dest = chars_out / rel.name
        dest.write_bytes(payload)
        character_files.append(rel.name)

    rpyc_files.sort()
    game_files.sort()
    character_files.sort()

    return ExtractionSummary(
        source_path=str(source),
        source_sha256=fingerprint,
        rpyc_files=rpyc_files,
        game_files=game_files,
        character_files=character_files,
    )
