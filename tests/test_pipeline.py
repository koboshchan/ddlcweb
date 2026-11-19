"""Unit tests for the pure-Python DDLC extraction and compilation pipeline."""

from __future__ import annotations

import pickle
import sys
import unittest
import zlib
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from compile_data import compile_py_block, compile_py_expr, parse_audio_spec
from extract_ddlc import ExtractionError, _safe_relpath, iter_rpa_entries


def _build_synthetic_rpa3(entries: dict[str, bytes], key: int = 0x42424242) -> bytes:
    """Create a minimal valid RPA-3.0 archive in memory for testing."""
    header_placeholder = b"RPA-3.0 0000000000000000 00000000\n"
    body = bytearray(header_placeholder)
    index: dict[str, list[tuple[int, int, bytes]]] = {}

    for name, payload in entries.items():
        offset = len(body)
        body.extend(payload)
        index[name] = [(offset ^ key, len(payload) ^ key, b"")]

    index_offset = len(body)
    packed_index = zlib.compress(pickle.dumps(index, protocol=2))
    body.extend(packed_index)

    real_header = f"RPA-3.0 {index_offset:016x} {key:08x}\n".encode("ascii")
    assert len(real_header) == len(header_placeholder)
    body[: len(real_header)] = real_header
    return bytes(body)


class TestExtractionPipeline(unittest.TestCase):
    def test_rpa3_roundtrip(self) -> None:
        sample = {
            "hello.txt": b"literature club",
            "nested/test.bin": b"\x00\x01\x02\x03",
        }
        blob = _build_synthetic_rpa3(sample)
        extracted = dict(iter_rpa_entries(blob))
        self.assertEqual(extracted, sample)

    def test_rpa3_rejects_arbitrary_pickle_globals(self) -> None:
        class _Evil:
            def __reduce__(self) -> tuple[object, tuple[str]]:
                import os

                return (os.system, ("echo should-never-run",))

        header_placeholder = b"RPA-3.0 0000000000000000 00000000\n"
        body = bytearray(header_placeholder)
        index_offset = len(body)
        body.extend(zlib.compress(pickle.dumps({"x": _Evil()}, protocol=2)))
        real_header = f"RPA-3.0 {index_offset:016x} 00000001\n".encode("ascii")
        body[: len(real_header)] = real_header

        with self.assertRaises(pickle.UnpicklingError):
            list(iter_rpa_entries(bytes(body)))

    def test_safe_relpath_blocks_traversal(self) -> None:
        self.assertEqual(_safe_relpath("gui/logo.png"), Path("gui/logo.png"))
        with self.assertRaises(ExtractionError):
            _safe_relpath("../secret.txt")
        with self.assertRaises(ExtractionError):
            _safe_relpath("foo/../../bar.txt")

    def test_parse_audio_spec(self) -> None:
        plain = parse_audio_spec("sfx/pageflip.ogg")
        self.assertEqual(plain["path"], "sfx/pageflip.ogg")
        self.assertNotIn("loop", plain)

        looped = parse_audio_spec("<from 4.499 loop 4.499>bgm/2.ogg")
        self.assertEqual(looped["path"], "bgm/2.ogg")
        self.assertAlmostEqual(looped["from"], 4.499)
        self.assertAlmostEqual(looped["loop"], 4.499)

        bounded = parse_audio_spec("<loop 4.316 to 12.453>bgm/7.ogg")
        self.assertEqual(bounded["path"], "bgm/7.ogg")
        self.assertAlmostEqual(bounded["loop"], 4.316)
        self.assertAlmostEqual(bounded["to"], 12.453)

    def test_compile_py_expr_and_block(self) -> None:
        expr_ast = compile_py_expr("persistent.playthrough == 2 and chapter == 1")
        self.assertEqual(expr_ast["t"], "bool")
        self.assertEqual(expr_ast["op"], "and")

        block_ast = compile_py_block("  s_name = 'Sayori'\n  pause(0.5)\n")
        self.assertEqual(len(block_ast), 2)
        self.assertEqual(block_ast[0]["t"], "assign")
        self.assertEqual(block_ast[1]["t"], "expr")


if __name__ == "__main__":
    unittest.main()
