"""Safely read the Ren'Py AST out of a compiled .rpyc file.

DDLC's scripts.rpa ships no .rpy sources, only compiled .rpyc bytecode. Each
file is a "RENPY RPC2" container whose slot 1 is a zlib-compressed,
protocol-2 pickle of `(metadata_dict, list_of_top_level_nodes)`.

SAFETY: pickle.Unpickler can run arbitrary code if allowed to instantiate
arbitrary classes/functions. This module uses a strict allowlist that returns
only inert Stub subclasses (which merely capture __dict__) plus a minimal set
of harmless builtins. Nothing from the pickle stream is ever invoked.
"""

from __future__ import annotations

import io
import pickle
import struct
import zlib
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional


class RpycFormatError(Exception):
    """Raised when a file is not a valid RENPY RPC2 .rpyc archive."""


class Stub:
    """Inert stand-in for any renpy.* class. Captures __dict__, nothing else."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __setstate__(self, state: Any) -> None:
        if isinstance(state, tuple) and len(state) == 2 and isinstance(state[1], dict):
            state = state[1]
        if isinstance(state, dict):
            self.__dict__.update(state)
        else:
            self.__dict__["_state"] = state

    def __repr__(self) -> str:
        fields = {k: v for k, v in self.__dict__.items() if not k.startswith("_")}
        return f"{type(self).__name__}{fields!r}"


class PyExprStr(str):
    """Stand-in for renpy.ast.PyExpr (a str subclass with source location)."""

    def __new__(
        cls,
        s: str = "",
        filename: str | None = None,
        linenumber: int | None = None,
        py: int | None = None,
    ) -> PyExprStr:
        return str.__new__(cls, s)

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass


_SAFE_BUILTINS: dict[tuple[str, str], Any] = {
    ("__builtin__", "set"): set,
    ("builtins", "set"): set,
    ("__builtin__", "frozenset"): frozenset,
    ("builtins", "frozenset"): frozenset,
    ("collections", "OrderedDict"): dict,
}


class _StubUnpickler(pickle.Unpickler):
    def find_class(self, module: str, name: str) -> Any:
        if module == "renpy.ast" and name == "PyExpr":
            return PyExprStr
        safe = _SAFE_BUILTINS.get((module, name))
        if safe is not None:
            return safe
        return type(name, (Stub,), {"__renpy_module__": module})


_MAGIC = b"RENPY RPC2"
_SLOT_HEADER = struct.Struct("<III")


def _read_slots(blob: bytes) -> dict[int, bytes]:
    if blob[: len(_MAGIC)] != _MAGIC:
        raise RpycFormatError(f"not a RENPY RPC2 file (got {blob[:10]!r})")
    slots: dict[int, bytes] = {}
    pos = len(_MAGIC)
    while pos + _SLOT_HEADER.size <= len(blob):
        slot, offset, length = _SLOT_HEADER.unpack_from(blob, pos)
        pos += _SLOT_HEADER.size
        if slot == 0:
            break
        slots[slot] = blob[offset : offset + length]
    return slots


def load_rpyc(source: str | Path | bytes) -> tuple[Any, list[Any]]:
    """Load a .rpyc file (path or raw bytes) and return (metadata, top_nodes)."""
    blob = source if isinstance(source, bytes) else Path(source).read_bytes()
    slots = _read_slots(blob)
    if 1 not in slots:
        raise RpycFormatError("no AST slot (1) in .rpyc file")
    data = zlib.decompress(slots[1])
    meta, nodes = _StubUnpickler(io.BytesIO(data), encoding="utf-8", errors="replace").load()
    return meta, nodes


def kind(node: Any) -> str:
    """Return the Ren'Py AST class name, e.g. 'Say', 'Label', 'Image'."""
    return type(node).__name__


def pycode_source(code_obj: Any) -> Optional[str]:
    """Extract Python source text from a stubbed PyCode object."""
    if isinstance(code_obj, str):
        return str(code_obj)
    state = getattr(code_obj, "_state", None)
    if isinstance(state, tuple) and len(state) >= 2 and isinstance(state[1], str):
        return str(state[1])
    src = getattr(code_obj, "source", None)
    if isinstance(src, str):
        return str(src)
    return None


def _children(node: Any) -> Iterator[list[Any]]:
    d = getattr(node, "__dict__", None)
    if not d:
        return
    block = d.get("block")
    if isinstance(block, list):
        yield block
    items = d.get("items")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, tuple) and item and isinstance(item[-1], list):
                yield item[-1]
    entries = d.get("entries")
    if isinstance(entries, list):
        for entry in entries:
            if isinstance(entry, tuple) and len(entry) >= 2 and isinstance(entry[-1], list):
                yield entry[-1]


def flatten(nodes: Iterable[Any]) -> list[Any]:
    """Depth-first flatten of a node list, preserving source order."""
    out: list[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        nested = list(_children(node))
        for block in reversed(nested):
            stack.extend(reversed(block))
    return out
