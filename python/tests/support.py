"""What the vector tests share: the vector files, their comparison rules and their byte forms."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Dict, List

from coqui_aos import Settings

VECTORS = Path(__file__).resolve().parents[2] / "vectors"


def cases(file: str) -> "List[Dict[str, Any]]":
    """The cases of one vector file."""
    return json.loads((VECTORS / file).read_text(encoding="utf-8"))["cases"]


def ids(items: "List[Dict[str, Any]]") -> "List[str]":
    return [case["id"] for case in items]


def strict(value: Any) -> Any:
    """A value with its types made visible, so 30 and 30.0, or 1 and True, never compare equal."""
    if isinstance(value, dict):
        return {key: strict(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [strict(item) for item in value]
    return (type(value).__name__, value)


def decode(encoded: str) -> bytes:
    return base64.b64decode(encoded)


def repeated(parts: Any) -> bytes:
    """``[text, times]`` pairs (or bare text) concatenated as UTF-8."""
    out = b""
    for part in parts:
        text, times = (part[0], part[1]) if isinstance(part, list) else (part, 1)
        out += text.encode("utf-8") * times
    return out


def bytes_of(case: "Dict[str, Any]") -> bytes:
    """A case's document bytes: ``base64``, ``parts`` or ``text``."""
    if "base64" in case:
        return decode(case["base64"])
    if "parts" in case:
        return repeated(case["parts"])
    return case["text"].encode("utf-8")


def settings_of(case: "Dict[str, Any]") -> Settings:
    """The settings a case's ``limits`` write."""
    limits = case.get("limits", {})
    changes: "Dict[str, Any]" = {}
    if "max_bytes" in limits:
        changes["manifest_bytes"] = changes["catalog_bytes"] = limits["max_bytes"]
    if "max_depth" in limits:
        changes["manifest_depth"] = limits["max_depth"]
    if "max_context_bytes" in limits:
        changes["context_bytes"] = limits["max_context_bytes"]
    return Settings().replace(**changes)


def expected_errors(expect: "Dict[str, Any]") -> "List[str]":
    error = expect.get("error")
    return error if isinstance(error, list) else [error] if error else []
