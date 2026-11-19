#!/usr/bin/env python3
"""Compile extracted DDLC .rpyc ASTs into structured JSON manifests for the web engine.

All output is written to `src/generated/` (gitignored). Nothing is ever eval'd
or exec'd — expressions and Python blocks are parsed structurally with Python's
`ast` module into safe JSON ASTs (`pyAst`) executed by `src/engine/PyRuntime.ts`.
"""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any, Optional

from rpyc_ast import flatten, kind, load_rpyc, pycode_source

PIPELINE_VERSION = 2

_HEX_COLOR_RE = re.compile(
    r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$"
)
_AUDIO_TAG_RE = re.compile(r"^<([^>]+)>(.+)$")
_AUDIO_TOKEN_RE = re.compile(r"\b(from|to|loop)\s+([0-9]+(?:\.[0-9]+)?)\b")

# Support/metadata modules whose top-level statements are handled via dedicated
# extractors (not executable story scripts). Note: `console` and `poems` and
# `splash` and `credits` ARE executable scripts and MUST remain included.
SCRIPT_EXCLUDE = {
    "definitions",
    "gui",
    "options",
    "screens",
    "transforms",
    "effects",
    "cgs",
    "glitchtext",
}


def parse_audio_spec(raw: str) -> dict[str, Any]:
    """Parse a Ren'Py audio string like '<from 4.499 loop 4.499>bgm/2.ogg'."""
    spec: dict[str, Any] = {"raw": raw, "path": raw}
    m = _AUDIO_TAG_RE.match(raw.strip())
    if m:
        tags_str, path_str = m.group(1), m.group(2).strip()
        spec["path"] = path_str
        for key, val in _AUDIO_TOKEN_RE.findall(tags_str):
            spec[key] = float(val)
    return spec


def _literal_value(expr: ast.AST) -> Any:
    """Safely evaluate basic Python literals (str, int, float, bool, None, tuple, list)."""
    if isinstance(expr, ast.Constant):
        return expr.value
    if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.USub):
        v = _literal_value(expr.operand)
        if isinstance(v, (int, float)):
            return -v
    if isinstance(expr, ast.UnaryOp) and isinstance(expr.op, ast.UAdd):
        v = _literal_value(expr.operand)
        if isinstance(v, (int, float)):
            return +v
    if isinstance(expr, (ast.Tuple, ast.List)):
        return [_literal_value(e) for e in expr.elts]
    return None


def _call_name(node: ast.Call) -> str:
    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        parts: list[str] = [node.func.attr]
        cur: ast.AST = node.func.value
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        return ".".join(reversed(parts))
    return ""


def _py_expr_to_json(node: ast.AST | None) -> Any:
    """Convert a Python `ast.expr` node into a compact JSON-serializable AST."""
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return {"t": "const", "v": node.value}
    if isinstance(node, ast.Name):
        return {"t": "name", "id": node.id}
    if isinstance(node, ast.Attribute):
        return {
            "t": "attr",
            "obj": _py_expr_to_json(node.value),
            "attr": node.attr,
        }
    if isinstance(node, ast.Subscript):
        if isinstance(node.slice, ast.Slice):
            return {
                "t": "slice",
                "obj": _py_expr_to_json(node.value),
                "lower": _py_expr_to_json(node.slice.lower),
                "upper": _py_expr_to_json(node.slice.upper),
                "step": _py_expr_to_json(node.slice.step),
            }
        return {
            "t": "sub",
            "obj": _py_expr_to_json(node.value),
            "key": _py_expr_to_json(node.slice),
        }
    if isinstance(node, (ast.List, ast.Tuple)):
        return {
            "t": "list" if isinstance(node, ast.List) else "tuple",
            "elts": [_py_expr_to_json(e) for e in node.elts],
        }
    if isinstance(node, ast.Dict):
        return {
            "t": "dict",
            "keys": [_py_expr_to_json(k) for k in node.keys],
            "vals": [_py_expr_to_json(v) for v in node.values],
        }
    if isinstance(node, ast.UnaryOp):
        op_map = {
            ast.Not: "not",
            ast.USub: "-",
            ast.UAdd: "+",
            ast.Invert: "~",
        }
        return {
            "t": "unary",
            "op": op_map.get(type(node.op), type(node.op).__name__),
            "arg": _py_expr_to_json(node.operand),
        }
    if isinstance(node, ast.BinOp):
        op_map = {
            ast.Add: "+",
            ast.Sub: "-",
            ast.Mult: "*",
            ast.Div: "/",
            ast.FloorDiv: "//",
            ast.Mod: "%",
            ast.Pow: "**",
        }
        return {
            "t": "bin",
            "op": op_map.get(type(node.op), type(node.op).__name__),
            "l": _py_expr_to_json(node.left),
            "r": _py_expr_to_json(node.right),
        }
    if isinstance(node, ast.BoolOp):
        op = "and" if isinstance(node.op, ast.And) else "or"
        return {
            "t": "bool",
            "op": op,
            "vals": [_py_expr_to_json(v) for v in node.values],
        }
    if isinstance(node, ast.Compare):
        op_map = {
            ast.Eq: "==",
            ast.NotEq: "!=",
            ast.Lt: "<",
            ast.LtE: "<=",
            ast.Gt: ">",
            ast.GtE: ">=",
            ast.In: "in",
            ast.NotIn: "not in",
            ast.Is: "is",
            ast.IsNot: "is not",
        }
        return {
            "t": "cmp",
            "left": _py_expr_to_json(node.left),
            "ops": [op_map.get(type(op), type(op).__name__) for op in node.ops],
            "comps": [_py_expr_to_json(c) for c in node.comparators],
        }
    if isinstance(node, ast.IfExp):
        return {
            "t": "ifexp",
            "test": _py_expr_to_json(node.test),
            "body": _py_expr_to_json(node.body),
            "else": _py_expr_to_json(node.orelse),
        }
    if isinstance(node, ast.Call):
        return {
            "t": "call",
            "fn": _py_expr_to_json(node.func),
            "args": [_py_expr_to_json(a) for a in node.args],
            "kwargs": [
                {"k": kw.arg, "v": _py_expr_to_json(kw.value)}
                for kw in node.keywords
                if kw.arg is not None
            ],
        }
    if isinstance(node, ast.GeneratorExp):
        comp = node.generators[0]
        return {
            "t": "gen",
            "elt": _py_expr_to_json(node.elt),
            "target": _py_expr_to_json(comp.target),
            "iter": _py_expr_to_json(comp.iter),
        }
    return {"t": "raw", "src": ast.unparse(node) if hasattr(ast, "unparse") else ""}


def _py_stmt_to_json(stmt: ast.stmt) -> dict[str, Any]:
    """Convert a Python `ast.stmt` node into a compact JSON-serializable AST."""
    if isinstance(stmt, ast.Assign):
        return {
            "t": "assign",
            "targets": [_py_expr_to_json(tgt) for tgt in stmt.targets],
            "val": _py_expr_to_json(stmt.value),
        }
    if isinstance(stmt, ast.AugAssign):
        op_map = {
            ast.Add: "+=",
            ast.Sub: "-=",
            ast.Mult: "*=",
            ast.Div: "/=",
        }
        return {
            "t": "aug",
            "op": op_map.get(type(stmt.op), "+="),
            "target": _py_expr_to_json(stmt.target),
            "val": _py_expr_to_json(stmt.value),
        }
    if isinstance(stmt, ast.Expr):
        return {"t": "expr", "val": _py_expr_to_json(stmt.value)}
    if isinstance(stmt, ast.If):
        return {
            "t": "if",
            "test": _py_expr_to_json(stmt.test),
            "body": [_py_stmt_to_json(s) for s in stmt.body],
            "else": [_py_stmt_to_json(s) for s in stmt.orelse],
        }
    if isinstance(stmt, ast.While):
        return {
            "t": "while",
            "test": _py_expr_to_json(stmt.test),
            "body": [_py_stmt_to_json(s) for s in stmt.body],
        }
    if isinstance(stmt, ast.For):
        return {
            "t": "for",
            "target": _py_expr_to_json(stmt.target),
            "iter": _py_expr_to_json(stmt.iter),
            "body": [_py_stmt_to_json(s) for s in stmt.body],
        }
    if isinstance(stmt, ast.Try):
        return {
            "t": "try",
            "body": [_py_stmt_to_json(s) for s in stmt.body],
            "handlers": [
                [_py_stmt_to_json(s) for s in h.body] for h in stmt.handlers
            ],
        }
    if isinstance(stmt, ast.With):
        items = [
            {
                "ctx": _py_expr_to_json(it.context_expr),
                "var": _py_expr_to_json(it.optional_vars),
            }
            for it in stmt.items
        ]
        return {
            "t": "with",
            "items": items,
            "body": [_py_stmt_to_json(s) for s in stmt.body],
        }
    if isinstance(stmt, ast.Delete):
        return {
            "t": "del",
            "targets": [_py_expr_to_json(tgt) for tgt in stmt.targets],
        }
    if isinstance(stmt, ast.FunctionDef):
        return {
            "t": "def",
            "name": stmt.name,
            "args": [a.arg for a in stmt.args.args],
            "body": [_py_stmt_to_json(s) for s in stmt.body],
        }
    if isinstance(stmt, ast.ClassDef):
        return {
            "t": "class",
            "name": stmt.name,
            "body": [_py_stmt_to_json(s) for s in stmt.body],
        }
    if isinstance(stmt, ast.Return):
        return {"t": "return", "val": _py_expr_to_json(stmt.value)}
    if isinstance(stmt, ast.Pass):
        return {"t": "pass"}
    if isinstance(stmt, ast.Break):
        return {"t": "break"}
    if isinstance(stmt, ast.Continue):
        return {"t": "continue"}
    if isinstance(stmt, ast.Global):
        return {"t": "global", "names": list(stmt.names)}
    if isinstance(stmt, ast.Import):
        return {"t": "import", "names": [a.name for a in stmt.names]}
    return {"t": "noop"}


def compile_py_expr(src: str | None) -> Any:
    if not src or not src.strip():
        return None
    try:
        tree = ast.parse(src.strip(), mode="eval")
        return _py_expr_to_json(tree.body)
    except SyntaxError:
        return None


def compile_py_block(src: str | None) -> list[dict[str, Any]]:
    if not src or not src.strip():
        return []
    try:
        tree = ast.parse(src.strip("\r\n"), mode="exec")
    except SyntaxError:
        # Handle leading indentation on multiline Ren'Py python blocks
        lines = src.splitlines()
        non_empty = [ln for ln in lines if ln.strip()]
        if not non_empty:
            return []
        min_indent = min(len(ln) - len(ln.lstrip()) for ln in non_empty)
        dedented = "\n".join(ln[min_indent:] if len(ln) >= min_indent else ln for ln in lines)
        try:
            tree = ast.parse(dedented, mode="exec")
        except SyntaxError:
            return []
    return [_py_stmt_to_json(s) for s in tree.body]


def parse_image_expr(expr: ast.AST, raw_src: str) -> dict[str, Any]:
    """Structurally parse a Ren'Py image expression AST into a JSON descriptor."""
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        val = expr.value
        if _HEX_COLOR_RE.match(val):
            return {"kind": "color", "hex": val}
        return {"kind": "file", "path": val}

    if isinstance(expr, ast.Call):
        cname = _call_name(expr)
        if cname == "Image" and expr.args:
            val = _literal_value(expr.args[0])
            if isinstance(val, str):
                return {"kind": "file", "path": val}

        if cname in ("im.Composite", "LiveComposite"):
            size = _literal_value(expr.args[0]) if expr.args else [0, 0]
            layers: list[dict[str, Any]] = []
            rest = expr.args[1:]
            for i in range(0, len(rest) - 1, 2):
                pos = _literal_value(rest[i]) or [0, 0]
                child = parse_image_expr(rest[i + 1], raw_src)
                layers.append({"x": pos[0], "y": pos[1], "image": child})
            return {"kind": "composite", "size": size, "layers": layers}

        if cname == "LiveTile" and expr.args:
            return {"kind": "tile", "child": parse_image_expr(expr.args[0], raw_src)}

        if cname == "Solid" and expr.args:
            hex_val = _literal_value(expr.args[0])
            if isinstance(hex_val, str):
                return {"kind": "color", "hex": hex_val}

        if cname == "im.Flip" and expr.args:
            kw = {k.arg: _literal_value(k.value) for k in expr.keywords if k.arg}
            return {
                "kind": "flip",
                "child": parse_image_expr(expr.args[0], raw_src),
                "horizontal": bool(kw.get("horizontal", False)),
                "vertical": bool(kw.get("vertical", False)),
            }

        if cname == "im.Crop" and len(expr.args) >= 2:
            rect = _literal_value(expr.args[1])
            return {
                "kind": "crop",
                "child": parse_image_expr(expr.args[0], raw_src),
                "rect": rect,
            }

        if cname == "im.FactorScale" and len(expr.args) >= 2:
            return {
                "kind": "scale",
                "child": parse_image_expr(expr.args[0], raw_src),
                "factor": _literal_value(expr.args[1]),
            }

        if cname == "im.MatrixColor" and len(expr.args) >= 2:
            return {
                "kind": "matrixColor",
                "child": parse_image_expr(expr.args[0], raw_src),
                "matrix": ast.unparse(expr.args[1]) if hasattr(ast, "unparse") else raw_src,
            }

        if cname == "Alpha" and len(expr.args) >= 2:
            return {
                "kind": "alpha",
                "child": parse_image_expr(expr.args[0], raw_src),
                "alpha": _literal_value(expr.args[1]),
            }

        if cname == "ConditionSwitch":
            branches = []
            for i in range(0, len(expr.args) - 1, 2):
                cond_str = _literal_value(expr.args[i])
                val_node = parse_image_expr(expr.args[i + 1], raw_src)
                branches.append(
                    {
                        "condition": str(cond_str) if cond_str is not None else "True",
                        "condAst": compile_py_expr(str(cond_str)) if cond_str else None,
                        "image": val_node,
                    }
                )
            return {"kind": "conditionSwitch", "branches": branches}

        if cname == "AnimatedMask" and len(expr.args) >= 5:
            kw = {k.arg: _literal_value(k.value) for k in expr.keywords if k.arg}
            return {
                "kind": "animatedMask",
                "child": parse_image_expr(expr.args[0], raw_src),
                "mask": _literal_value(expr.args[1]),
                "maskb": _literal_value(expr.args[2]),
                "oc": _literal_value(expr.args[3]),
                "op": _literal_value(expr.args[4]),
                "moving": bool(kw.get("moving", True)),
                "speed": float(kw.get("speed", 1.0) or 1.0),
                "frequency": float(kw.get("frequency", 1.0) or 1.0),
                "amount": float(kw.get("amount", 0.5) or 0.5),
            }

        if cname in ("Text", "ParameterizedText"):
            kw = {k.arg: _literal_value(k.value) for k in expr.keywords if k.arg}
            text_val = _literal_value(expr.args[0]) if expr.args else None
            return {
                "kind": "text",
                "parameterized": cname == "ParameterizedText",
                "text": text_val if isinstance(text_val, str) else None,
                "props": kw,
            }

    return {"kind": "expr", "raw": raw_src.strip()}


def serialize_atl_block(block: Any) -> list[dict[str, Any]]:
    """Serialize a Ren'Py ATL RawBlock into JSON-friendly statement objects."""
    out: list[dict[str, Any]] = []
    for stmt in getattr(block, "statements", ()):
        sk = kind(stmt)
        if sk == "RawMultipurpose":
            entry: dict[str, Any] = {"type": "step"}
            if getattr(stmt, "warper", None):
                entry["warper"] = str(stmt.warper)
                entry["duration"] = str(stmt.duration)
            elif getattr(stmt, "warp_function", None):
                entry["warpFunction"] = str(stmt.warp_function)
                entry["duration"] = str(stmt.duration)
            elif getattr(stmt, "duration", None) is not None and str(stmt.duration) != "0":
                entry["duration"] = str(stmt.duration)

            exprs = []
            for ex in getattr(stmt, "expressions", ()):
                exprs.append(
                    {
                        "expr": str(ex[0]),
                        "with": str(ex[1]) if ex[1] else None,
                    }
                )
            if exprs:
                entry["expressions"] = exprs

            props = []
            for kv in getattr(stmt, "properties", ()):
                props.append([str(kv[0]), str(kv[1])])
            if props:
                entry["properties"] = props

            if getattr(stmt, "circles", None):
                entry["circles"] = str(stmt.circles)
            out.append(entry)
        elif sk == "RawParallel":
            out.append(
                {
                    "type": "parallel",
                    "blocks": [
                        serialize_atl_block(sub) for sub in getattr(stmt, "blocks", ())
                    ],
                }
            )
        elif sk == "RawChoice":
            choices = []
            for w, sub in getattr(stmt, "choices", ()):
                weight_val: float | str = (
                    float(w) if isinstance(w, (int, float)) else str(w)
                )
                choices.append(
                    {
                        "weight": weight_val,
                        "block": serialize_atl_block(sub),
                    }
                )
            out.append({"type": "choice", "choices": choices})
        elif sk == "RawRepeat":
            out.append({"type": "repeat", "count": getattr(stmt, "repeats", None)})
        elif sk == "RawTime":
            out.append({"type": "time", "time": str(stmt.time)})
        elif sk == "RawOn":
            out.append(
                {
                    "type": "on",
                    "handlers": {
                        str(k): serialize_atl_block(v)
                        for k, v in getattr(stmt, "handlers", {}).items()
                    },
                }
            )
        elif sk == "RawEvent":
            out.append({"type": "event", "name": str(stmt.name)})
        elif sk == "RawBlock":
            out.append({"type": "block", "statements": serialize_atl_block(stmt)})
        elif sk == "RawFunction":
            out.append({"type": "function", "expr": str(getattr(stmt, "expr", ""))})
        elif sk == "RawContainsExpr":
            out.append(
                {"type": "contains", "expr": str(getattr(stmt, "expression", ""))}
            )
        else:
            out.append({"type": sk})
    return out


def _extract_atl_first_image(atl_steps: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Find the first quoted image/color literal inside an ATL block for preview."""
    for step in atl_steps:
        if step.get("type") == "step":
            for ex in step.get("expressions", []):
                raw = ex.get("expr", "").strip()
                is_dq = raw.startswith('"') and raw.endswith('"')
                is_sq = raw.startswith("'") and raw.endswith("'")
                if is_dq or is_sq:
                    val = raw[1:-1]
                    if _HEX_COLOR_RE.match(val):
                        return {"kind": "color", "hex": val}
                    return {"kind": "file", "path": val}
        elif step.get("type") == "choice":
            for ch in step.get("choices", []):
                found = _extract_atl_first_image(ch.get("block", []))
                if found:
                    return found
        elif step.get("type") == "block":
            found = _extract_atl_first_image(step.get("statements", []))
            if found:
                return found
    return None


def _serialize_imspec(imspec: Any) -> dict[str, Any]:
    """Normalize a Ren'Py Show/Scene/Hide imspec tuple."""
    if not isinstance(imspec, (tuple, list)):
        return {"name": []}
    name = (
        list(imspec[0])
        if len(imspec) > 0 and isinstance(imspec[0], (tuple, list))
        else []
    )
    res: dict[str, Any] = {"name": [str(x) for x in name]}
    if len(imspec) > 1 and imspec[1]:
        expr_str = str(imspec[1])
        res["expression"] = expr_str
        res["exprAst"] = compile_py_expr(expr_str)
    if len(imspec) > 2 and imspec[2]:
        res["tag"] = str(imspec[2])
    if len(imspec) > 3 and imspec[3]:
        res["at"] = [str(a) for a in imspec[3]]
    if len(imspec) > 4 and imspec[4]:
        res["layer"] = str(imspec[4])
    if len(imspec) > 5 and imspec[5] is not None:
        res["zorder"] = str(imspec[5])
    if len(imspec) > 6 and imspec[6]:
        res["behind"] = [str(b) for b in imspec[6]]
    return res


def _serialize_user_statement(node: Any) -> dict[str, Any]:
    """Decode Ren'Py UserStatement nodes (`play`, `stop`, `pause`, `window`, `screen`)."""
    line = str(getattr(node, "line", "")).strip()
    lineno = getattr(node, "linenumber", 0)

    parts = line.split(None, 2)
    verb = parts[0] if parts else ""
    if verb in ("play", "queue", "stop") and len(parts) >= 2:
        return {
            "type": verb,
            "channel": parts[1],
            "args": parts[2] if len(parts) > 2 else "",
            "line": lineno,
        }
    if verb == "pause":
        dur = parts[1] if len(parts) > 1 else None
        return {
            "type": "pause",
            "duration": dur,
            "durationAst": compile_py_expr(dur),
            "line": lineno,
        }
    if verb == "window":
        return {
            "type": "window",
            "mode": parts[1] if len(parts) > 1 else "auto",
            "transition": parts[2] if len(parts) > 2 else None,
            "line": lineno,
        }

    # Screen statements: `show screen foo(a, b)`, `hide screen foo`, `call screen foo(...)`
    m = re.match(r"^(show|hide|call)\s+screen\s+([a-zA-Z0-9_]+)(?:\((.*)\))?$", line, re.DOTALL)
    if m:
        action = m.group(1)
        screen_name = m.group(2)
        args_raw = m.group(3)
        call_ast = compile_py_expr(f"_screen({args_raw})" if args_raw else "_screen()")
        return {
            "type": "screen",
            "action": action,
            "name": screen_name,
            "argsRaw": args_raw,
            "callAst": call_ast,
            "line": lineno,
        }

    return {
        "type": "user",
        "lineText": line,
        "line": lineno,
    }


def serialize_script_nodes(nodes: list[Any]) -> list[dict[str, Any]]:
    """Convert Ren'Py AST nodes into a clean JSON statement list."""
    out: list[dict[str, Any]] = []
    for node in nodes:
        nk = kind(node)
        lineno = getattr(node, "linenumber", 0)

        if nk == "Init":
            block = serialize_script_nodes(getattr(node, "block", []))
            if block:
                out.append(
                    {
                        "type": "init",
                        "priority": getattr(node, "priority", 0),
                        "block": block,
                        "line": lineno,
                    }
                )
        elif nk == "Label":
            params = getattr(node, "parameters", None)
            param_defs: list[dict[str, Any]] = []
            if params is not None:
                for p in getattr(params, "parameters", ()) or ():
                    if isinstance(p, (tuple, list)) and len(p) >= 2:
                        default_src = str(p[1]) if p[1] is not None else None
                        param_defs.append(
                            {
                                "name": str(p[0]),
                                "defaultAst": compile_py_expr(default_src),
                            }
                        )
                    else:
                        param_defs.append({"name": str(p), "defaultAst": None})
            out.append(
                {
                    "type": "label",
                    "name": str(node.name),
                    "params": [p["name"] for p in param_defs],
                    "paramDefs": param_defs,
                    "block": serialize_script_nodes(getattr(node, "block", [])),
                    "line": lineno,
                }
            )
        elif nk == "Say":
            entry: dict[str, Any] = {
                "type": "say",
                "who": str(node.who) if getattr(node, "who", None) is not None else None,
                "what": str(getattr(node, "what", "")),
                "line": lineno,
            }
            if getattr(node, "with_", None):
                entry["with"] = str(node.with_)
            if getattr(node, "interact", True) is False:
                entry["interact"] = False
            out.append(entry)
        elif nk == "Scene":
            entry = {
                "type": "scene",
                "imspec": _serialize_imspec(getattr(node, "imspec", None)),
                "layer": str(getattr(node, "layer", "master") or "master"),
                "line": lineno,
            }
            atl = getattr(node, "atl", None)
            if atl is not None:
                entry["atl"] = serialize_atl_block(atl)
            out.append(entry)
        elif nk == "Show":
            entry = {
                "type": "show",
                "imspec": _serialize_imspec(getattr(node, "imspec", None)),
                "line": lineno,
            }
            atl = getattr(node, "atl", None)
            if atl is not None:
                entry["atl"] = serialize_atl_block(atl)
            out.append(entry)
        elif nk == "Hide":
            out.append(
                {
                    "type": "hide",
                    "imspec": _serialize_imspec(getattr(node, "imspec", None)),
                    "line": lineno,
                }
            )
        elif nk == "With":
            expr = getattr(node, "expr", None)
            paired = getattr(node, "paired", None)
            expr_str = str(expr) if expr is not None else None
            out.append(
                {
                    "type": "with",
                    "expr": expr_str,
                    "exprAst": compile_py_expr(expr_str),
                    "paired": str(paired) if paired is not None else None,
                    "line": lineno,
                }
            )
        elif nk == "Jump":
            target = str(getattr(node, "target", ""))
            is_expr = bool(getattr(node, "expression", False))
            out.append(
                {
                    "type": "jump",
                    "target": target,
                    "expression": is_expr,
                    "targetAst": compile_py_expr(target) if is_expr else None,
                    "line": lineno,
                }
            )
        elif nk == "Call":
            args = getattr(node, "arguments", None)
            call_args: list[dict[str, Any]] = []
            if args is not None:
                for a in getattr(args, "arguments", ()) or ():
                    if isinstance(a, (tuple, list)) and len(a) >= 2:
                        kw_name = str(a[0]) if a[0] is not None else None
                        expr_src = str(a[1])
                        call_args.append(
                            {
                                "name": kw_name,
                                "expr": expr_src,
                                "ast": compile_py_expr(expr_src),
                            }
                        )
            label_str = str(getattr(node, "label", ""))
            is_expr = bool(getattr(node, "expression", False))
            out.append(
                {
                    "type": "call",
                    "label": label_str,
                    "expression": is_expr,
                    "labelAst": compile_py_expr(label_str) if is_expr else None,
                    "args": call_args,
                    "line": lineno,
                }
            )
        elif nk == "Return":
            expr = getattr(node, "expression", None)
            expr_str = str(expr) if expr is not None else None
            out.append(
                {
                    "type": "return",
                    "expression": expr_str,
                    "exprAst": compile_py_expr(expr_str),
                    "line": lineno,
                }
            )
        elif nk == "Menu":
            items = []
            for caption, cond, blk in getattr(node, "items", ()):
                cond_str = str(cond) if cond is not None else "True"
                items.append(
                    {
                        "caption": str(caption) if caption is not None else None,
                        "condition": cond_str,
                        "condAst": compile_py_expr(cond_str),
                        "block": serialize_script_nodes(blk) if isinstance(blk, list) else None,
                    }
                )
            out.append({"type": "menu", "items": items, "line": lineno})
        elif nk == "If":
            branches = []
            for cond, blk in getattr(node, "entries", ()):
                cond_str = str(cond)
                branches.append(
                    {
                        "condition": cond_str,
                        "condAst": compile_py_expr(cond_str),
                        "block": serialize_script_nodes(blk) if isinstance(blk, list) else [],
                    }
                )
            out.append({"type": "if", "branches": branches, "line": lineno})
        elif nk == "While":
            cond_str = str(getattr(node, "condition", "False"))
            out.append(
                {
                    "type": "while",
                    "condition": cond_str,
                    "condAst": compile_py_expr(cond_str),
                    "block": serialize_script_nodes(getattr(node, "block", [])),
                    "line": lineno,
                }
            )
        elif nk in ("Python", "EarlyPython"):
            src = pycode_source(getattr(node, "code", None)) or ""
            out.append(
                {
                    "type": "python",
                    "early": nk == "EarlyPython",
                    "code": src,
                    "pyAst": compile_py_block(src),
                    "line": lineno,
                }
            )
        elif nk == "Default":
            src = pycode_source(getattr(node, "code", None)) or ""
            out.append(
                {
                    "type": "default",
                    "store": str(getattr(node, "store", "store")),
                    "varname": str(getattr(node, "varname", "")),
                    "code": src,
                    "pyAst": compile_py_expr(src),
                    "line": lineno,
                }
            )
        elif nk == "Define":
            src = pycode_source(getattr(node, "code", None)) or ""
            out.append(
                {
                    "type": "define",
                    "store": str(getattr(node, "store", "store")),
                    "varname": str(getattr(node, "varname", "")),
                    "code": src,
                    "pyAst": compile_py_expr(src),
                    "line": lineno,
                }
            )
        elif nk == "UserStatement":
            out.append(_serialize_user_statement(node))
        elif nk == "Pass":
            out.append({"type": "pass", "line": lineno})
        elif nk == "ShowLayer":
            out.append(
                {
                    "type": "showLayer",
                    "layer": str(getattr(node, "layer", "master")),
                    "at": [str(a) for a in getattr(node, "at_list", ()) or ()],
                    "line": lineno,
                }
            )
        elif nk in ("Image", "Transform", "Screen", "Style", "Translate"):
            continue
        else:
            out.append({"type": f"unsupported:{nk}", "line": lineno})
    return out


def _collect_labels(
    stmts: list[dict[str, Any]], stem: str, label_map: dict[str, str]
) -> None:
    for s in stmts:
        if s.get("type") == "label":
            label_map[s["name"]] = stem
            _collect_labels(s.get("block", []), stem, label_map)
        elif s.get("type") in ("init", "while"):
            _collect_labels(s.get("block", []), stem, label_map)
        elif s.get("type") == "if":
            for b in s.get("branches", []):
                _collect_labels(b.get("block", []), stem, label_map)
        elif s.get("type") == "menu":
            for item in s.get("items", []):
                if item.get("block"):
                    _collect_labels(item["block"], stem, label_map)


def _parse_poemwords(path: Path) -> list[dict[str, Any]]:
    """Parse DDLC's poemwords.txt into [{word, sayori, natsuki, yuri}]."""
    if not path.is_file():
        return []
    words: list[dict[str, Any]] = []
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            try:
                words.append(
                    {
                        "word": parts[0],
                        "sayori": int(parts[1]),
                        "natsuki": int(parts[2]),
                        "yuri": int(parts[3]),
                    }
                )
            except ValueError:
                continue
    return words


def _extract_gui(rpyc_path: Path) -> dict[str, Any]:
    """Extract gui.* constants from gui.rpyc."""
    gui: dict[str, Any] = {}
    if not rpyc_path.is_file():
        return gui
    _meta, top = load_rpyc(rpyc_path)
    for node in flatten(top):
        if kind(node) != "Define":
            continue
        store = str(getattr(node, "store", ""))
        varname = str(getattr(node, "varname", ""))
        src = pycode_source(getattr(node, "code", None)) or ""
        key = f"{store}.{varname}" if store and store != "store" else varname
        if key.startswith("store."):
            key = key[len("store.") :]
        try:
            tree = ast.parse(src, mode="eval")
            val = _literal_value(tree.body)
            gui[key] = val if val is not None else {"expr": src.strip()}
        except SyntaxError:
            gui[key] = {"expr": src.strip()}
    return gui


def _extract_audio_and_characters(
    rpyc_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Extract audio tracks and Character definitions from definitions.rpyc."""
    audio: dict[str, Any] = {}
    characters: dict[str, Any] = {}
    if not rpyc_path.is_file():
        return audio, characters

    _meta, top = load_rpyc(rpyc_path)
    for node in flatten(top):
        if kind(node) != "Define":
            continue
        store = str(getattr(node, "store", ""))
        varname = str(getattr(node, "varname", ""))
        src = (pycode_source(getattr(node, "code", None)) or "").strip()

        if store == "audio" or store == "store.audio":
            try:
                val = _literal_value(ast.parse(src, mode="eval").body)
                if isinstance(val, str):
                    audio[varname] = parse_audio_spec(val)
            except SyntaxError:
                pass
            continue

        try:
            expr = ast.parse(src, mode="eval").body
        except SyntaxError:
            continue

        if isinstance(expr, ast.Call):
            cname = _call_name(expr)
            if cname in ("Character", "DynamicCharacter"):
                name_arg = _literal_value(expr.args[0]) if expr.args else None
                kwargs: dict[str, Any] = {}
                for kw in expr.keywords:
                    if not kw.arg:
                        continue
                    v = _literal_value(kw.value)
                    if v is not None:
                        kwargs[kw.arg] = v
                    else:
                        kwargs[kw.arg] = (
                            ast.unparse(kw.value) if hasattr(ast, "unparse") else ""
                        )
                characters[varname] = {
                    "id": varname,
                    "dynamic": cname == "DynamicCharacter",
                    "name": name_arg,
                    "kwargs": kwargs,
                }
    return audio, characters


def _extract_defaults(rpyc_paths: list[Path]) -> list[dict[str, Any]]:
    """Collect all `default` variable declarations in load order."""
    defaults: list[dict[str, Any]] = []
    for path in rpyc_paths:
        _meta, top = load_rpyc(path)
        for node in flatten(top):
            if kind(node) != "Default":
                continue
            store = str(getattr(node, "store", "store"))
            varname = str(getattr(node, "varname", ""))
            src = (pycode_source(getattr(node, "code", None)) or "").strip()
            defaults.append(
                {
                    "store": store,
                    "varname": varname,
                    "ast": compile_py_expr(src),
                }
            )
    return defaults


def _extract_poems(rpyc_path: Path) -> dict[str, Any]:
    """Extract all `Poem(...)` definitions from `poems.rpyc`."""
    poems: dict[str, Any] = {}
    if not rpyc_path.is_file():
        return poems
    _meta, top = load_rpyc(rpyc_path)
    for node in flatten(top):
        if kind(node) not in ("Python", "EarlyPython"):
            continue
        src = pycode_source(getattr(node, "code", None)) or ""
        try:
            tree = ast.parse(src.strip("\r\n"), mode="exec")
        except SyntaxError:
            continue
        for stmt in tree.body:
            if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
                continue
            tgt = stmt.targets[0]
            if not isinstance(tgt, ast.Name) or not isinstance(stmt.value, ast.Call):
                continue
            if _call_name(stmt.value) != "Poem":
                continue
            kw = {
                k.arg: _literal_value(k.value)
                for k in stmt.value.keywords
                if k.arg
            }
            poems[tgt.id] = {
                "id": tgt.id,
                "author": kw.get("author", ""),
                "title": kw.get("title", ""),
                "text": kw.get("text", ""),
                "yuri_2": bool(kw.get("yuri_2", False)),
                "yuri_3": bool(kw.get("yuri_3", False)),
            }
    return poems


def compile_all(
    rpyc_dir: Path,
    assets_dir: Path,
    out_dir: Path,
    source_sha256: str,
    game_files: list[str],
    character_files: list[str],
) -> None:
    """Compile all extracted .rpyc files into `src/generated/` JSON manifests."""
    out_dir.mkdir(parents=True, exist_ok=True)
    scripts_out = out_dir / "scripts"
    scripts_out.mkdir(parents=True, exist_ok=True)

    rpyc_paths = sorted(rpyc_dir.rglob("*.rpyc"))
    images: dict[str, Any] = {}
    transforms: dict[str, Any] = {}
    label_map: dict[str, str] = {}
    script_stems: list[str] = []

    print(f"  [compile] scanning {len(rpyc_paths)} .rpyc files...")
    for rpyc_path in rpyc_paths:
        stem = rpyc_path.stem
        _meta, top = load_rpyc(rpyc_path)

        for node in flatten(top):
            nk = kind(node)
            if nk == "Image":
                img_name = " ".join(str(p) for p in getattr(node, "imgname", ()))
                code_obj = getattr(node, "code", None)
                atl_obj = getattr(node, "atl", None)
                if code_obj is not None:
                    src = pycode_source(code_obj) or ""
                    try:
                        tree = ast.parse(src, mode="eval")
                        images[img_name] = parse_image_expr(tree.body, src)
                    except SyntaxError:
                        images[img_name] = {"kind": "expr", "raw": src.strip()}
                elif atl_obj is not None:
                    steps = serialize_atl_block(atl_obj)
                    preview = _extract_atl_first_image(steps)
                    images[img_name] = {
                        "kind": "atl",
                        "steps": steps,
                        "preview": preview,
                    }
            elif nk == "Transform":
                tname = str(getattr(node, "varname", ""))
                params = getattr(node, "parameters", None)
                param_list: list[dict[str, Any]] = []
                if params is not None:
                    for p in getattr(params, "parameters", ()) or ():
                        if isinstance(p, (tuple, list)) and len(p) >= 2:
                            default_val = str(p[1]) if p[1] is not None else None
                            param_list.append(
                                {
                                    "name": str(p[0]),
                                    "default": default_val,
                                }
                            )
                        else:
                            param_list.append({"name": str(p), "default": None})
                atl_obj = getattr(node, "atl", None)
                transforms[tname] = {
                    "name": tname,
                    "params": param_list,
                    "steps": serialize_atl_block(atl_obj) if atl_obj is not None else [],
                }

        if stem not in SCRIPT_EXCLUDE:
            stmts = serialize_script_nodes(top)
            _collect_labels(stmts, stem, label_map)
            script_stems.append(stem)
            (scripts_out / f"{stem}.json").write_text(
                json.dumps({"name": stem, "statements": stmts}, separators=(",", ":")),
                encoding="utf-8",
            )

    gui_data = _extract_gui(rpyc_dir / "gui.rpyc")
    audio_data, char_data = _extract_audio_and_characters(rpyc_dir / "definitions.rpyc")
    defaults_data = _extract_defaults(rpyc_paths)
    poems_data = _extract_poems(rpyc_dir / "poems.rpyc")

    fonts = []
    for gf in game_files:
        if gf.lower().endswith((".ttf", ".otf")):
            p = Path(gf)
            fonts.append({"file": gf, "family": p.stem})

    poem_words = _parse_poemwords(assets_dir / "game" / "poemwords.txt")

    (out_dir / "gui.json").write_text(json.dumps(gui_data, indent=2), encoding="utf-8")
    (out_dir / "audio.json").write_text(json.dumps(audio_data, indent=2), encoding="utf-8")
    (out_dir / "characters.json").write_text(
        json.dumps(char_data, indent=2), encoding="utf-8"
    )
    (out_dir / "defaults.json").write_text(
        json.dumps(defaults_data, separators=(",", ":")), encoding="utf-8"
    )
    (out_dir / "poems.json").write_text(
        json.dumps(poems_data, indent=2), encoding="utf-8"
    )
    (out_dir / "images.json").write_text(
        json.dumps(images, separators=(",", ":")), encoding="utf-8"
    )
    (out_dir / "transforms.json").write_text(
        json.dumps(transforms, separators=(",", ":")), encoding="utf-8"
    )
    (scripts_out / "index.json").write_text(
        json.dumps({"scripts": sorted(script_stems), "labels": label_map}, indent=2),
        encoding="utf-8",
    )

    manifest = {
        "pipelineVersion": PIPELINE_VERSION,
        "sourceSha256": source_sha256,
        "logicalWidth": 1280,
        "logicalHeight": 720,
        "gameFiles": game_files,
        "characterFiles": character_files,
        "fonts": fonts,
        "poemWords": poem_words,
        "scriptFiles": sorted(script_stems),
        "counts": {
            "images": len(images),
            "transforms": len(transforms),
            "audio": len(audio_data),
            "characters": len(char_data),
            "poems": len(poems_data),
            "labels": len(label_map),
            "scripts": len(script_stems),
            "gameFiles": len(game_files),
        },
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )

    loader_ts = """// AUTO-GENERATED by tools/compile_data.py — DO NOT COMMIT
import manifestData from "./manifest.json";
import guiData from "./gui.json";
import audioData from "./audio.json";
import charactersData from "./characters.json";
import defaultsData from "./defaults.json";
import poemsData from "./poems.json";
import imagesData from "./images.json";
import transformsData from "./transforms.json";
import scriptIndexData from "./scripts/index.json";
import type {
  AudioDef,
  CharacterDef,
  DefaultDef,
  GameManifest,
  GuiConfig,
  ImageDef,
  PoemDef,
  ScriptFile,
  ScriptIndex,
  TransformDef,
} from "../types/game-data";

export const manifest = manifestData as unknown as GameManifest;
export const guiConfig = guiData as unknown as GuiConfig;
export const audioDefs = audioData as unknown as Record<string, AudioDef>;
export const characterDefs = charactersData as unknown as Record<string, CharacterDef>;
export const defaultDefs = defaultsData as unknown as DefaultDef[];
export const poemDefs = poemsData as unknown as Record<string, PoemDef>;
export const imageDefs = imagesData as unknown as Record<string, ImageDef>;
export const transformDefs = transformsData as unknown as Record<string, TransformDef>;
export const scriptIndex = scriptIndexData as unknown as ScriptIndex;

const scriptModules = import.meta.glob([
  "./scripts/*.json",
  "!./scripts/index.json",
]);

export async function loadScriptModule(stem: string): Promise<ScriptFile> {
  const key = `./scripts/${stem}.json`;
  const loader = scriptModules[key];
  if (!loader) {
    throw new Error(`Compiled script module not found: ${stem}`);
  }
  const mod = (await loader()) as { default: ScriptFile };
  return mod.default;
}
"""
    (out_dir / "index.ts").write_text(loader_ts, encoding="utf-8")
    print(
        f"  [compile] done: {len(images)} images, {len(transforms)} transforms, "
        f"{len(audio_data)} audio tracks, {len(poems_data)} poems, "
        f"{len(label_map)} labels across {len(script_stems)} scripts"
    )
