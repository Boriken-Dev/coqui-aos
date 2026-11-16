"""Knowledge served through MCP (``spec/v0/knowledge.md``): what an overlay's knowledge is, the
arguments of ``kb_list``, ``kb_read`` and ``kb_search``, what the first two answer, the templates
a file may be, and the checks of a search answer.

Nothing here reads a file, opens a connection or runs code: an overlay is handed over as a tree
of entries (``KnowledgeOverlay``, built by hand or from a ``FileSystem``), and a call is a request
in and a result out, so any consumer serves it over its own MCP.
"""

from __future__ import annotations

import dataclasses
import json
import re
import sys
from pathlib import PurePath
from typing import Any, Dict, Iterable, List, Mapping, NamedTuple, Optional, Sequence, Tuple

from ._data import Document
from ._defaults import context_of, declared, named, rules_of
from ._digest import EntryKind, TreeEntry
from ._document import split_format_line
from ._errors import Error
from ._front_matter import ManifestFile, SplitCase, split_front_matter
from ._fs import FileKind, FileSystem
from ._names import EXCLUDED_COMPONENTS, is_sensitive_variable, normalize_name, valid_relative_path
from ._settings import NonDefault, Settings
from ._template import TemplateFacts, template, template_values
from ._tree import OverlayTree

__all__ = [
    "CallerFacts",
    "KNOWLEDGE_DIRS",
    "KNOWLEDGE_ENGINES",
    "KNOWLEDGE_MODES",
    "KnowledgeError",
    "KnowledgeFile",
    "KnowledgeOverlay",
    "KnowledgePlan",
    "KnowledgeSet",
    "KnowledgeSettings",
    "inert",
    "kb_list",
    "kb_read",
    "knowledge_arguments",
    "knowledge_engines",
    "knowledge_call",
    "knowledge_lines",
    "knowledge_plan",
    "knowledge_result",
    "knowledge_set",
    "knowledge_tools",
    "envsubst",
    "mustache",
    "search_check",
    "search_order",
]

#: The folders whose files are knowledge, besides the root ``CONTEXT.md`` and the files a manifest names.
KNOWLEDGE_DIRS = ("kb", "flows", "references", "rules", "context")
#: The search modes, in the order ``kb_list`` declares them.
KNOWLEDGE_MODES = ("words", "meaning", "llm")
#: The template engines this edition defines.
KNOWLEDGE_ENGINES = ("envsubst", "mustache")

_MAX_INTEGER = 9007199254740991
_DEFAULT_TOP = 5
_KIB, _MIB = 1024, 1024 * 1024


def _show(limit: "Optional[int]") -> str:
    return "none" if limit is None else str(limit)


@dataclasses.dataclass(frozen=True)
class KnowledgeSettings:
    """The limits of the knowledge tools. Every one has a default and no floor; ``None`` lifts it."""

    max_file_bytes: Optional[int] = _MIB
    max_read_bytes: Optional[int] = 64 * _KIB
    max_rendered_bytes: Optional[int] = _MIB
    max_query_characters: Optional[int] = 1000
    max_top: Optional[int] = 100
    max_context_bytes: Optional[int] = 16 * _KIB
    max_context_depth: Optional[int] = 8
    max_template_depth: Optional[int] = 32
    max_include_depth: Optional[int] = 5

    def replace(self, **limits: "Optional[int]") -> "KnowledgeSettings":
        """A copy with the named limits changed; an unknown name is a ``TypeError``."""
        return dataclasses.replace(self, **limits)

    def non_defaults(self) -> "List[NonDefault]":
        """Every setting that differs from its default, in field order."""
        default = KnowledgeSettings()
        return [
            NonDefault(field.name, _show(getattr(self, field.name)), _show(getattr(default, field.name)))
            for field in dataclasses.fields(self)
            if getattr(self, field.name) != getattr(default, field.name)
        ]


def _within(limit: "Optional[int]", n: int) -> bool:
    return limit is None or n <= limit


class KnowledgeError(Exception):
    """A refused call. ``code`` is the error class the specification names; ``message`` is text for
    a person, never to be parsed."""

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__("%s: %s" % (code, message) if message else code)
        self.code = code
        self.message = message or code


@dataclasses.dataclass(frozen=True)
class CallerFacts:
    """What the consumer tells a template about the call: the role and profile it has the agent in
    (as its own labels), the environment it holds and the names the user allowed templates to read."""

    role: Optional[str] = None
    profile: Optional[str] = None
    env: Mapping[str, str] = dataclasses.field(default_factory=dict)
    env_allow: Sequence[str] = ()

    def caller(self) -> "Dict[str, str]":
        """The ``caller`` root: ``role`` and ``profile``, those that have a value."""
        return {
            key: value
            for key, value in (("role", self.role), ("profile", self.profile))
            if isinstance(value, str)
        }

    def allowed_env(self) -> "Dict[str, str]":
        """The allowed variables that are set, are text and are not sensitive."""
        return {
            name: self.env[name]
            for name in self.env_allow
            if name in self.env and not is_sensitive_variable(name) and isinstance(self.env[name], str)
        }


@dataclasses.dataclass(frozen=True)
class KnowledgeOverlay:
    """An active overlay as the knowledge tools see it.

    ``identity`` is the name the consumer holds it under, ``manifest`` its read manifest, ``tree`` its
    entries by relative path (``TreeEntry``: a file with its bytes, a directory, a link or a special
    file), ``served`` whether the consumer leaves its rules and context out of the context because
    they are served, and ``facts`` what its templates read.
    """

    identity: str
    manifest: Document
    tree: Mapping[str, TreeEntry]
    served: bool = False
    facts: TemplateFacts = dataclasses.field(default_factory=TemplateFacts)

    @classmethod
    def from_filesystem(
        cls,
        fs: FileSystem,
        root: PurePath,
        identity: str,
        manifest: Document,
        *,
        served: bool = False,
        facts: "Optional[TemplateFacts]" = None,
        settings: "Optional[KnowledgeSettings]" = None,
    ) -> "KnowledgeOverlay":
        """The overlay at ``root``, walked without following a link. Only the files that are knowledge
        are read, each up to one byte past ``max_file_bytes``; any other file is recorded with no bytes.

        Raises ``OSError`` when ``fs`` cannot serve a path.
        """
        limit = (settings or KnowledgeSettings()).max_file_bytes
        most = sys.maxsize if limit is None else limit + 1
        tree: "Dict[str, TreeEntry]" = {}

        def walk(path: PurePath, prefix: str) -> None:
            for name in sorted(fs.list(path)):
                relative = prefix + name
                if name.lower() in EXCLUDED_COMPONENTS:
                    continue
                found = fs.metadata(path / name)
                if found.kind is FileKind.DIRECTORY:
                    tree[relative] = TreeEntry.directory()
                    walk(path / name, relative + "/")
                elif found.kind is FileKind.SYMLINK:
                    tree[relative] = TreeEntry.symlink()
                elif found.kind is FileKind.FILE:
                    chosen = _selected(relative, manifest)
                    tree[relative] = TreeEntry.file(fs.read(path / name, most) if chosen else b"")
                else:
                    tree[relative] = TreeEntry.special()

        walk(root, "")
        return cls(identity, manifest, tree, served, facts or TemplateFacts())


def inert(text: str) -> str:
    """Text as an agent may receive it: each control character but tab and line feed, and each
    character that hides or reorders text, is written ``<U+XXXX>``."""
    out = []
    for char in text:
        code = ord(char)
        if char in "\n\t":
            out.append(char)
        elif code < 0x20 or 0x7F <= code <= 0x9F or _hides(code):
            out.append("<U+%04X>" % code)
        else:
            out.append(char)
    return "".join(out)


def _hides(code: int) -> bool:
    return (
        0x202A <= code <= 0x202E
        or 0x2066 <= code <= 0x206F
        or 0x200B <= code <= 0x200F
        or 0x2060 <= code <= 0x2064
        or code in (0x2028, 0x2029, 0x061C, 0xFEFF, 0x00AD, 0x180E)
        or 0xFE00 <= code <= 0xFE0F
        or 0xE0000 <= code <= 0xE007F
        or 0xE0100 <= code <= 0xE01EF
        or code in (0x115F, 0x1160, 0x3164, 0xFFA0, 0x034F)
        or 0x17B4 <= code <= 0x17B5
        or 0x1D173 <= code <= 0x1D17A
        or 0xFFF9 <= code <= 0xFFFB
    )


def knowledge_lines(text: str) -> "List[str]":
    """A file's lines: split at line feed, a carriage return before the line feed dropped, no line
    after a final line feed, and no line at all in an empty text."""
    parts = text.split("\n")
    last = parts.pop()
    lines = [part[:-1] if part.endswith("\r") else part for part in parts]
    if last != "":
        lines.append(last)
    return lines


def _bytes_key(path: str) -> bytes:
    return path.encode("utf-8", "surrogatepass")


def _mapping(settings: "Optional[KnowledgeSettings]") -> KnowledgeSettings:
    return settings if settings is not None else KnowledgeSettings()


def knowledge_tools(
    modes: "Iterable[str]", settings: "Optional[KnowledgeSettings]" = None
) -> "List[Dict[str, Any]]":
    """The tools ``tools/list`` names, with their input schemas and no descriptions. ``kb_search`` is
    there only when at least one mode is declared."""
    limit = _mapping(settings)
    declared_modes = [mode for mode in KNOWLEDGE_MODES if mode in set(modes)]
    line = {"type": "integer", "minimum": 1, "maximum": _MAX_INTEGER}
    tools: "List[Dict[str, Any]]" = [
        {
            "name": "kb_list",
            "inputSchema": {
                "type": "object",
                "properties": {"overlay": {"type": "string"}},
                "additionalProperties": False,
            },
        },
        {
            "name": "kb_read",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "from": dict(line),
                    "to": dict(line),
                    "overlay": {"type": "string"},
                    "context": {"type": "object"},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    ]
    if declared_modes:
        query: "Dict[str, Any]" = {"type": "string", "minLength": 1}
        if limit.max_query_characters is not None:
            query["maxLength"] = limit.max_query_characters
        top: "Dict[str, Any]" = {"type": "integer", "minimum": 1}
        if limit.max_top is not None:
            top["maximum"] = limit.max_top
        top["default"] = _DEFAULT_TOP
        tools.append(
            {
                "name": "kb_search",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": query,
                        "top": top,
                        "overlay": {"type": "string"},
                        "mode": {"type": "string", "enum": ["auto"] + declared_modes, "default": "auto"},
                        "path": {"type": "string"},
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            }
        )
    return tools


_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def _context_ok(value: Any, depth: int, budget: "List[int]", limit: KnowledgeSettings) -> bool:
    if limit.max_context_depth is not None and depth > limit.max_context_depth:
        return False
    if isinstance(value, bool):
        return True
    if isinstance(value, int):
        return abs(value) <= _MAX_INTEGER
    if isinstance(value, str):
        budget[0] += len(value.encode("utf-8", "surrogatepass"))
        return _within(limit.max_context_bytes, budget[0])
    if isinstance(value, list):
        return all(_context_ok(item, depth + 1, budget, limit) for item in value)
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or not _IDENT.match(key):
                return False
            budget[0] += len(key.encode("utf-8"))
            if not _within(limit.max_context_bytes, budget[0]):
                return False
            if not _context_ok(item, depth + 1, budget, limit):
                return False
        return True
    return False


def knowledge_arguments(
    tool: str,
    arguments: Any,
    modes: "Iterable[str]",
    settings: "Optional[KnowledgeSettings]" = None,
) -> "Dict[str, Any]":
    """A call's arguments with the defaults applied. A ``null`` is the argument absent.

    Raises ``KnowledgeError`` of class ``invalid-arguments``.
    """
    limit = _mapping(settings)
    schemas = {item["name"]: item["inputSchema"] for item in knowledge_tools(modes, limit)}
    if tool not in schemas:
        raise KnowledgeError("invalid-arguments", "no tool is named " + tool)
    schema = schemas[tool]
    if not isinstance(arguments, dict):
        raise KnowledgeError("invalid-arguments", "the arguments are an object")
    out: "Dict[str, Any]" = {}
    for key, value in arguments.items():
        if key not in schema["properties"]:
            raise KnowledgeError("invalid-arguments", "no argument is named " + str(key))
        if value is None:
            continue
        spec = schema["properties"][key]
        if spec["type"] == "string":
            if not isinstance(value, str):
                raise KnowledgeError("invalid-arguments", key + " is text")
            if "enum" in spec and value not in spec["enum"]:
                raise KnowledgeError("invalid-arguments", key + " is not one of its values")
            if key == "query":
                if not _within(limit.max_query_characters, len(value)) or not value.strip(" \t\n\v\f\r"):
                    raise KnowledgeError("invalid-arguments", "the query is empty or too long")
        elif spec["type"] == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise KnowledgeError("invalid-arguments", key + " is a whole number")
            if value < spec["minimum"] or ("maximum" in spec and value > spec["maximum"]):
                raise KnowledgeError("invalid-arguments", key + " is out of range")
        else:
            if not isinstance(value, dict) or not _context_ok(value, 1, [0], limit):
                raise KnowledgeError("invalid-arguments", key + " is not a usable context")
        out[key] = value
    for key in schema.get("required", ()):
        if key not in out:
            raise KnowledgeError("invalid-arguments", key + " is required")
    if tool == "kb_search":
        out.setdefault("top", _DEFAULT_TOP)
        out.setdefault("mode", "auto")
    return out


def _selected(path: str, manifest: Document) -> bool:
    if path in (ManifestFile.OVERLAY_MD.value, ManifestFile.OVERLAY_CFG.value) or not valid_relative_path(
        path
    ):
        return False
    parts = path.split("/")
    names = {named(entry) for field in ("rules", "context") for entry in declared(manifest, field)}
    return (len(parts) > 1 and parts[0] in KNOWLEDGE_DIRS) or path == "CONTEXT.md" or path in names


def _hidden_name(path: str) -> bool:
    return any(_hides(ord(char)) for char in path)


class KnowledgeFile(NamedTuple):
    """A file of the knowledge: its text as stored, the engine its first line names (``None`` for a
    file that names none, or names a format AOS defines), its size in bytes, whether it is served
    as written (a raw or markdown file, or one that is not markdown) and its text after the first
    line that names a format."""

    text: str
    engine: Optional[str]
    size: int
    as_written: bool
    rest: str


class KnowledgeSet(NamedTuple):
    """An overlay's knowledge: ``files`` by path and ``skipped`` as ``(path, reason)`` pairs, both in
    the order of the paths as UTF-8 bytes."""

    files: "Dict[str, KnowledgeFile]"
    skipped: "List[Tuple[str, str]]"


def _ascii_lower(text: str) -> str:
    return "".join(char.lower() if "A" <= char <= "Z" else char for char in text)


def _format_name(data: bytes) -> Optional[str]:
    """The name a first line gives a file's format, or ``None`` when it gives none."""
    if not data.startswith(b"#!"):
        return None
    try:
        return split_format_line(data, "")[0]
    except Error:
        return None


def _after_first_line(text: str) -> str:
    end = text.find("\n")
    return "" if end < 0 else text[end + 1 :]


def knowledge_set(overlay: KnowledgeOverlay, settings: "Optional[KnowledgeSettings]" = None) -> KnowledgeSet:
    """What is served of ``overlay`` and what is skipped, with the reason (``name``, ``too-large`` or
    ``not-text``). Only a markdown file (``.md`` or ``.markdown``) names its format on its first line."""
    limit = _mapping(settings)
    files: "Dict[str, KnowledgeFile]" = {}
    skipped: "List[Tuple[str, str]]" = []
    for path in sorted(overlay.tree, key=_bytes_key):
        entry = overlay.tree[path]
        if entry.kind is not EntryKind.FILE or not _selected(path, overlay.manifest):
            continue
        data = entry.data
        if _hidden_name(path):
            skipped.append((path, "name"))
        elif not _within(limit.max_file_bytes, len(data)):
            skipped.append((path, "too-large"))
        else:
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                skipped.append((path, "not-text"))
                continue
            markdown = _ascii_lower(path).endswith(_MARKDOWN_SUFFIXES)
            name = _format_name(data) if markdown else None
            engine = None if name in (None,) + _AS_WRITTEN + _EXPANDED else name
            files[path] = KnowledgeFile(
                text,
                engine,
                len(data),
                not markdown or name in _AS_WRITTEN,
                _after_first_line(text) if name else text,
            )
    return KnowledgeSet(files, skipped)


_MARKDOWN_SUFFIXES = (".md", ".markdown")
_EXPANDED = ("aos", "agentic")
_AS_WRITTEN = ("raw", "markdown", "md")


def knowledge_engines() -> "List[str]":
    """The template engines this installation renders with: ``envsubst``, and ``mustache`` when the
    optional ``templates`` extra (``tplx``) is installed."""
    found = ["envsubst"]
    try:
        import tplx  # noqa: F401
        from tplx.engines import MustacheTemplate  # noqa: F401
        import chevron  # noqa: F401
    except ImportError:
        return found
    return found + ["mustache"]


def _engines(engines: "Optional[Iterable[str]]") -> "List[str]":
    wanted = set(knowledge_engines() if engines is None else engines)
    return [engine for engine in KNOWLEDGE_ENGINES if engine in wanted]


def _choose(overlays: "Sequence[KnowledgeOverlay]", wanted: Optional[str]) -> "List[KnowledgeOverlay]":
    if wanted is None:
        return list(overlays)
    chosen = [o for o in overlays if normalize_name(o.identity) == normalize_name(wanted)]
    if not chosen:
        raise KnowledgeError("unknown-overlay", wanted)
    return chosen


def knowledge_call(
    tool: str,
    overlays: "Sequence[KnowledgeOverlay]",
    arguments: Any,
    modes: "Iterable[str]" = (),
    settings: "Optional[KnowledgeSettings]" = None,
    caller: "Optional[CallerFacts]" = None,
    engines: "Optional[Iterable[str]]" = None,
) -> "Dict[str, Any]":
    """What a server answers a call of ``kb_list`` or ``kb_read``: ``{"result": ...}`` or
    ``{"error": {"class", "message"}}``. ``overlays`` are the session's active overlays in
    composition order; ``engines`` the template engines this server renders with (by default those
    ``knowledge_engines()`` finds); ``kb_search`` is the consumer's own (``search_check`` checks its
    answer)."""
    modes = list(modes)
    names = _engines(engines)
    try:
        args = knowledge_arguments(tool, arguments, modes, settings)
        facts = caller or CallerFacts()
        if tool == "kb_list":
            return {"result": _list(overlays, args, modes, settings, names, facts)}
        if tool == "kb_read":
            return {"result": _read(overlays, args, settings, facts, names)}
        raise KnowledgeError("invalid-arguments", "no tool is named " + tool)
    except KnowledgeError as error:
        return {"error": {"class": error.code, "message": error.message}}


def knowledge_result(outcome: "Dict[str, Any]") -> "Dict[str, Any]":
    """A call's outcome as MCP's ``tools/call`` result: the same JSON as ``structuredContent`` and as
    one text block of ``content``, and ``isError``."""
    failed = "error" in outcome
    body = {"error": outcome["error"]} if failed else outcome["result"]
    return {
        "content": [{"type": "text", "text": json.dumps(body, ensure_ascii=False)}],
        "structuredContent": body,
        "isError": failed,
    }


def kb_list(
    overlays: "Sequence[KnowledgeOverlay]",
    *,
    overlay: Optional[str] = None,
    modes: "Iterable[str]" = (),
    caller: "Optional[CallerFacts]" = None,
    engines: "Optional[Iterable[str]]" = None,
    settings: "Optional[KnowledgeSettings]" = None,
) -> "Dict[str, Any]":
    """``kb_list`` as an MCP result: each active overlay's served files (their lines and bytes are
    those of the served text) and what is skipped, and the engines this server renders with."""
    arguments = {} if overlay is None else {"overlay": overlay}
    return knowledge_result(knowledge_call("kb_list", overlays, arguments, modes, settings, caller, engines))


def kb_read(
    overlays: "Sequence[KnowledgeOverlay]",
    path: str,
    *,
    from_line: Optional[int] = None,
    to_line: Optional[int] = None,
    overlay: Optional[str] = None,
    context: "Optional[Dict[str, Any]]" = None,
    caller: "Optional[CallerFacts]" = None,
    engines: "Optional[Iterable[str]]" = None,
    settings: "Optional[KnowledgeSettings]" = None,
) -> "Dict[str, Any]":
    """``kb_read`` as an MCP result. The file is served as its first line says: expanded (``${NAME}``
    and ``@path``) by default, as written for ``raw``, ``markdown`` and ``md``, rendered for an engine
    this server has (``envsubst``, ``mustache``), from ``caller`` (role, profile, the allowed
    environment) and ``context``; so a consumer never applies any of them itself."""
    arguments: "Dict[str, Any]" = {"path": path}
    for key, value in (("from", from_line), ("to", to_line), ("overlay", overlay), ("context", context)):
        if value is not None:
            arguments[key] = value
    return knowledge_result(knowledge_call("kb_read", overlays, arguments, (), settings, caller, engines))


class _Held(NamedTuple):
    overlay: KnowledgeOverlay
    found: KnowledgeSet


def _list(
    overlays: "Sequence[KnowledgeOverlay]",
    args: "Dict[str, Any]",
    modes: "List[str]",
    settings: "Optional[KnowledgeSettings]",
    engines: "List[str]",
    caller: CallerFacts,
) -> "Dict[str, Any]":
    limit = _mapping(settings)
    listed = []
    for overlay in _choose(overlays, args.get("overlay")):
        found = knowledge_set(overlay, limit)
        files: "List[Dict[str, Any]]" = []
        skipped = list(found.skipped)
        for path, item in found.files.items():
            try:
                text = _serve(_Held(overlay, found), path, {}, caller, limit, engines)
            except KnowledgeError:
                skipped.append((path, "render"))
                continue
            entry: "Dict[str, Any]" = {
                "path": path,
                "lines": len(knowledge_lines(text)),
                "bytes": len(text.encode("utf-8", "surrogatepass")),
            }
            if item.engine:
                entry["template"] = item.engine
                entry["rendered"] = item.engine in engines
            files.append(entry)
        skipped.sort(key=lambda pair: _bytes_key(pair[0]))
        listed.append(
            {
                "overlay": overlay.identity,
                "served": bool(overlay.served),
                "files": files,
                "skipped": [{"path": inert(path), "reason": reason} for path, reason in skipped],
            }
        )
    result: "Dict[str, Any]" = {"overlays": listed, "engines": engines}
    if modes:
        result["search"] = {"modes": [mode for mode in KNOWLEDGE_MODES if mode in set(modes)]}
    return result


_SKIP_CLASS = {"name": "invalid-path", "too-large": "too-large", "not-text": "not-text"}
_PRIORITY = ("link", "not-text", "too-large", "not-found")


def _read(
    overlays: "Sequence[KnowledgeOverlay]",
    args: "Dict[str, Any]",
    settings: "Optional[KnowledgeSettings]",
    caller: CallerFacts,
    engines: "List[str]",
) -> "Dict[str, Any]":
    limit = _mapping(settings)
    path = args["path"]
    if not valid_relative_path(path) or _hidden_name(path):
        raise KnowledgeError("invalid-path", inert(path))
    found_in: "List[_Held]" = []
    problems: "List[str]" = []
    for overlay in _choose(overlays, args.get("overlay")):
        held = knowledge_set(overlay, limit)
        parts = path.split("/")
        linked = any(
            ("/".join(parts[: n + 1]) in overlay.tree)
            and overlay.tree["/".join(parts[: n + 1])].kind is EntryKind.SYMLINK
            for n in range(len(parts))
        )
        if linked:
            problems.append("link")
        elif path in held.files:
            found_in.append(_Held(overlay, held))
        else:
            reason = dict(held.skipped).get(path)
            problems.append(_SKIP_CLASS[reason] if reason else "not-found")
    if len(found_in) > 1:
        raise KnowledgeError("ambiguous", "more than one overlay has that path")
    if not found_in:
        raise KnowledgeError(min(problems, key=_PRIORITY.index) if problems else "not-found", inert(path))
    held = found_in[0]
    engine = held.found.files[path].engine
    text = _serve(held, path, args.get("context", {}), caller, limit, engines)
    lines = knowledge_lines(text)
    total = len(lines)
    start = args.get("from", 1)
    stop = args.get("to")
    if (stop is not None and stop < start) or start > max(total, 1):
        raise KnowledgeError("line-range", "the file has %d lines" % total)
    last = total if stop is None else min(stop, total)
    chosen: "List[str]" = []
    size = 0
    truncated = False
    for line in lines[start - 1 : last]:
        add = len(line.encode("utf-8", "surrogatepass")) + (1 if chosen else 0)
        if chosen and not _within(limit.max_read_bytes, size + add):
            truncated = True
            break
        chosen.append(line)
        size += add
    result: "Dict[str, Any]" = {
        "overlay": held.overlay.identity,
        "path": path,
        "from_line": start,
        "to_line": start - 1 + len(chosen),
        "total_lines": total,
        "truncated": truncated,
        "text": inert("\n".join(chosen)),
    }
    if engine:
        result["template"] = engine
        result["rendered"] = engine in engines
    return result


def _facts(overlay: KnowledgeOverlay) -> TemplateFacts:
    if overlay.facts.name is not None:
        return overlay.facts
    return dataclasses.replace(overlay.facts, name=normalize_name(overlay.identity))


def _data(overlay: KnowledgeOverlay, context: "Dict[str, Any]", call: CallerFacts) -> "Dict[str, Any]":
    """What a template reads: the roots ``overlay``, ``project``, ``caller``, ``env``, ``options`` and
    ``context``, each only with what it holds. A sensitive option or variable is never in it."""
    facts = _facts(overlay)
    options: "Dict[str, Any]" = {}
    declared_options = overlay.manifest.get("options")
    for name, spec in (declared_options if isinstance(declared_options, dict) else {}).items():
        if not isinstance(spec, dict) or spec.get("sensitive") is True:
            continue
        if name in facts.options:
            options[name] = facts.options[name]
        elif "default" in spec:
            options[name] = spec["default"]
        else:
            continue
        if not _option_fits(spec.get("type"), options[name]):
            raise KnowledgeError("invalid-option", name)
    return {
        "overlay": {
            key: value
            for key, value in (
                ("root", facts.root),
                ("state", facts.state),
                ("name", facts.name),
                ("scope", facts.scope),
            )
            if value is not None
        },
        "project": {"root": facts.project} if facts.project is not None else {},
        "caller": call.caller(),
        "env": call.allowed_env(),
        "options": options,
        "context": context,
    }


def _envsubst_values(
    overlay: KnowledgeOverlay, data: "Dict[str, Any]", context: "Dict[str, Any]"
) -> "Dict[str, str]":
    try:
        values = template_values(overlay.manifest, _facts(overlay))
    except Error as error:
        raise KnowledgeError("invalid-option", error.subject) from None
    for key, name in (("role", "AOS_CALLER_ROLE"), ("profile", "AOS_CALLER_PROFILE")):
        if key in data["caller"]:
            values[name] = data["caller"][key]
    for name, value in data["env"].items():
        values["AOS_ENV_" + name] = value
    for key, value in context.items():
        if isinstance(value, bool):
            values["AOS_ARG_" + key] = "true" if value else "false"
        elif isinstance(value, (int, str)):
            values["AOS_ARG_" + key] = str(value)
    return values


def _option_fits(kind: Any, value: Any) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    return False


def _flow(value: Any) -> str:
    """A value as one line of flow YAML (JSON's shapes): keys in UTF-8 byte order, ``, `` and ``: ``
    between, and in a string only ``"``, ``\\`` and U+0000-U+001F escaped, those as ``\\u00xx``."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        out = []
        for char in value:
            if char in '"\\':
                out.append("\\" + char)
            elif ord(char) < 0x20:
                out.append("\\u%04x" % ord(char))
            else:
                out.append(char)
        return '"' + "".join(out) + '"'
    if isinstance(value, list):
        return "[" + ", ".join(_flow(item) for item in value) + "]"
    keys = sorted(value, key=_bytes_key)
    return "{" + ", ".join("%s: %s" % (_flow(key), _flow(value[key])) for key in keys) + "}"


def _context_block(engine: str, data: "Dict[str, Any]") -> str:
    """The front matter a file gets when its engine is not here: the engine's name and the roots,
    which are left out when empty."""
    parts = ['"engine": ' + _flow(engine)]
    for root_name in ("overlay", "project", "caller", "env", "options", "context"):
        if data[root_name]:
            parts.append('"%s": %s' % (root_name, _flow(data[root_name])))
    return "---\naos_template_context: {" + ", ".join(parts) + "}\n---\n"


def _render(
    held: _Held,
    item: KnowledgeFile,
    context: "Dict[str, Any]",
    call: CallerFacts,
    limit: KnowledgeSettings,
    here: bool,
) -> str:
    data = _data(held.overlay, context, call)
    engine = item.engine
    if not here:
        end = item.text.find("\n")
        first, rest = (item.text + "\n", "") if end < 0 else (item.text[: end + 1], item.text[end + 1 :])
        out = first + _context_block(engine or "", data) + rest
    elif engine == "envsubst":
        out = envsubst(item.rest, _envsubst_values(held.overlay, data, context))
    else:
        out = mustache(item.rest, data, limit)
    if not _within(limit.max_rendered_bytes, len(out.encode("utf-8", "surrogatepass"))):
        raise KnowledgeError("too-large", "the rendered text")
    return out


class _Expansion:
    """What expanding one file shares along its includes."""

    def __init__(
        self,
        held: _Held,
        context: "Dict[str, Any]",
        call: CallerFacts,
        limit: KnowledgeSettings,
        engines: "List[str]",
    ) -> None:
        self.held = held
        self.context = context
        self.call = call
        self.limit = limit
        self.engines = engines
        self.values: "Optional[Dict[str, str]]" = None
        self.added = 0

    def names(self) -> "Dict[str, str]":
        """The names ``${NAME}`` replaces, made the first time one is met."""
        if self.values is None:
            data = _data(self.held.overlay, self.context, self.call)
            self.values = _envsubst_values(self.held.overlay, data, self.context)
        return self.values


def _serve(
    held: _Held,
    path: str,
    context: "Dict[str, Any]",
    call: CallerFacts,
    limit: KnowledgeSettings,
    engines: "List[str]",
) -> str:
    """The text ``kb_read`` serves for a file of the knowledge, before it is cut into lines."""
    item = held.found.files[path]
    if item.as_written:
        return item.rest
    if item.engine:
        return _render(held, item, context, call, limit, item.engine in engines)
    out = _expand(item.rest, path, _Expansion(held, context, call, limit, engines), (path,))
    if not _within(limit.max_rendered_bytes, len(out.encode("utf-8", "surrogatepass"))):
        raise KnowledgeError("too-large", "the served text")
    return out


_FENCE = re.compile(r"( {0,3})(`{3,}|~{3,})")
_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
_INCLUDE_NAME = re.compile(r"[^ \t\r\n\f\v]+")
_DRIVE = re.compile(r"[A-Za-z]:")
_TRAILING = ".,;:!?)]}'\""


def _opens_fence(line: str) -> "Optional[Tuple[str, int]]":
    found = _FENCE.match(line)
    return (found.group(2)[0], len(found.group(2))) if found else None


def _closes_fence(line: str, fence: "Tuple[str, int]") -> bool:
    found = _FENCE.match(line)
    return bool(
        found
        and found.group(2)[0] == fence[0]
        and len(found.group(2)) >= fence[1]
        and line[found.end() :].strip(" \t\r\n") == ""
    )


def _code_mask(line: str) -> "List[bool]":
    """Which characters of a line are in a code span: a run of backticks, to the next run of as many
    on the same line; a run with none is itself."""
    mask = [False] * len(line)
    i = 0
    while i < len(line):
        if line[i] != "`":
            i += 1
            continue
        j = i
        while j < len(line) and line[j] == "`":
            j += 1
        k = j
        end = None
        while k < len(line):
            if line[k] == "`":
                m = k
                while m < len(line) and line[m] == "`":
                    m += 1
                if m - k == j - i:
                    end = m
                    break
                k = m
            else:
                k += 1
        if end is None:
            i = j
        else:
            for n in range(i, end):
                mask[n] = True
            i = end
    return mask


def _expand(text: str, path: str, state: _Expansion, chain: "Tuple[str, ...]") -> str:
    out = []
    fence: "Optional[Tuple[str, int]]" = None
    for line in re.findall(r"[^\n]*\n|[^\n]+", text):
        if fence is not None:
            out.append(_expand_line(line, [True] * len(line), path, state, chain))
            if _closes_fence(line, fence):
                fence = None
            continue
        fence = _opens_fence(line)
        if fence:
            out.append(_expand_line(line, [True] * len(line), path, state, chain))
        else:
            out.append(_expand_line(line, _code_mask(line), path, state, chain))
    return "".join(out)


def _expand_line(
    line: str, in_code: "List[bool]", path: str, state: _Expansion, chain: "Tuple[str, ...]"
) -> str:
    out = []
    i = 0
    while i < len(line):
        if not in_code[i] and line.startswith("$${", i):
            out.append("${")
            i += 3
            continue
        found = None if in_code[i] else _PLACEHOLDER.match(line, i)
        if found:
            values = state.names()
            if found.group(1) in values:
                out.append(values[found.group(1)])
                i = found.end()
                continue
        if line[i] == "@" and not in_code[i] and (i == 0 or line[i - 1] in " \t\r\f\v"):
            token = _INCLUDE_NAME.match(line, i + 1)
            name = token.group() if token else ""
            while name and name[-1] in _TRAILING:
                name = name[:-1]
            target = _resolve(path, name, state.held.found) if name else None
            included = _include(target, state, chain) if target else None
            if included is not None:
                out.append(included)
                i += 1 + len(name)
                continue
        out.append(line[i])
        i += 1
    return "".join(out)


def _resolve(path: str, name: str, found: KnowledgeSet) -> Optional[str]:
    """The file of the knowledge an include names, or ``None``: the name is resolved from the including
    file's folder, ``..`` may rise only to the root, and what is not a served file is not an include."""
    if name[0] in "/~" or "\\" in name or _DRIVE.match(name):
        return None
    parts = path.split("/")[:-1]
    for part in name.split("/"):
        if part == "":
            return None
        if part == ".":
            continue
        if part == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(part)
    target = "/".join(parts)
    return target if valid_relative_path(target) and target in found.files else None


def _include(target: str, state: _Expansion, chain: "Tuple[str, ...]") -> Optional[str]:
    item = state.held.found.files[target]
    limit = state.limit
    if item.as_written:
        text = item.rest
    elif item.engine:
        if item.engine not in state.engines:
            return None
        text = _render(state.held, item, state.context, state.call, limit, True)
    else:
        if target in chain:
            raise KnowledgeError("include-error", "an include comes back to " + target)
        if limit.max_include_depth is not None and len(chain) > limit.max_include_depth:
            raise KnowledgeError("include-error", "includes are nested too deep")
        body = item.rest
        data = body.encode("utf-8", "surrogatepass")
        split = split_front_matter(data)
        if split.case in (SplitCase.PRESENT, SplitCase.EMPTY):
            body = data[split.body_offset or 0 :].decode("utf-8")
        text = _expand(body, target, state, chain + (target,))
    state.added += len(text.encode("utf-8", "surrogatepass"))
    if not _within(limit.max_rendered_bytes, state.added):
        raise KnowledgeError("too-large", "the included text")
    if text.endswith("\r\n"):
        return text[:-2]
    return text[:-1] if text.endswith("\n") else text


def mustache(text: str, data: "Dict[str, Any]", settings: "Optional[KnowledgeSettings]" = None) -> str:
    """The text of a ``mustache`` file, rendered over ``data``: the one place Mustache is rendered,
    by ``tplx``'s Mustache engine (the ``templates`` extra, imported only here). Raises
    ``KnowledgeError`` of class ``template-error`` for a template the engine refuses, or when it is
    not installed, and ``too-large`` past ``max_rendered_bytes``."""
    limit = _mapping(settings)
    try:
        import tplx
        from tplx.engines import MustacheTemplate
    except ImportError:
        raise KnowledgeError("template-error", _NEEDS_EXTRA) from None
    bounds: "Dict[str, int]" = {}
    if limit.max_rendered_bytes is not None:
        bounds["max_output"] = limit.max_rendered_bytes
    try:
        loader = tplx.Loader(sandbox=tplx.SandboxLimits(**bounds), engines=(MustacheTemplate,))
        out = loader.compile(text, engine=MustacheTemplate).render(data)
    except tplx.exceptions.SandboxError:
        raise KnowledgeError("too-large", "the rendered text") from None
    except (tplx.exceptions.TplxError, RecursionError) as error:
        raise KnowledgeError("template-error", str(error)[:200]) from None
    if not isinstance(out, str) or not _within(
        limit.max_rendered_bytes, len(out.encode("utf-8", "surrogatepass"))
    ):
        raise KnowledgeError("too-large", "the rendered text")
    return out


def envsubst(text: str, values: "Dict[str, str]") -> str:
    """The text of an ``envsubst`` file with each ``${NAME}`` that has a value replaced: the one place
    envsubst is rendered. Anything else, an unknown name included, stays as written."""
    return template(text, values)


_NEEDS_EXTRA = "a mustache template needs the 'templates' extra: pip install coqui-aos[templates]"


def search_order(passages: "List[Dict[str, Any]]") -> "List[Dict[str, Any]]":
    """Passages by score, highest first, then path as UTF-8 bytes, then first line, then last line;
    ones equal in all four keep the order given."""
    return sorted(
        passages,
        key=lambda p: (-p["score"], _bytes_key(p["path"]), p["from_line"], p["to_line"]),
    )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


_PASSAGE_KEYS = {"path", "heading", "from_line", "to_line", "score", "text"}


def search_check(
    overlays: "Sequence[KnowledgeOverlay]",
    arguments: "Dict[str, Any]",
    response: Any,
    modes: "Iterable[str]",
    settings: "Optional[KnowledgeSettings]" = None,
    caller: "Optional[CallerFacts]" = None,
    engines: "Optional[Iterable[str]]" = None,
) -> "List[str]":
    """The rules a ``kb_search`` answer breaks, as sorted ids (``overlays``, ``mode``, ``top``,
    ``path-limit``, ``not-knowledge``, ``range``, ``text``, ``inert``, ``shape``, ``order``); empty
    when it conforms. The ranking itself is not checked, only the shape and the order the scores imply.
    Raises ``KnowledgeError`` for arguments that are not a search's."""
    modes = list(modes)
    limit = _mapping(settings)
    names = _engines(engines)
    args = knowledge_arguments("kb_search", arguments, modes, limit)
    broken: "set[str]" = set()
    if not isinstance(response, dict) or set(response) != {"results"}:
        return ["shape"]
    chosen = _choose(overlays, args.get("overlay"))
    results = response["results"]
    if not isinstance(results, list):
        return ["shape"]
    if [r.get("overlay") if isinstance(r, dict) else None for r in results] != [o.identity for o in chosen]:
        broken.add("overlays")
    prefix = args.get("path")
    for entry, overlay in zip(results, chosen):
        if not isinstance(entry, dict):
            broken.add("shape")
            continue
        if "error" in entry:
            error = entry["error"]
            if (
                set(entry) != {"overlay", "error"}
                or not isinstance(error, dict)
                or set(error) != {"class", "message"}
                or error["class"] not in ("unavailable", "mode-unavailable")
            ):
                broken.add("shape")
            elif error["class"] == "mode-unavailable" and args["mode"] == "auto":
                broken.add("mode")
            continue
        if not {"overlay", "mode", "passages"} <= set(entry) <= {"overlay", "mode", "passages", "note"}:
            broken.add("shape")
            continue
        if entry["mode"] not in modes or (args["mode"] != "auto" and entry["mode"] != args["mode"]):
            broken.add("mode")
        if "note" in entry and (not isinstance(entry["note"], str) or entry["note"] != inert(entry["note"])):
            broken.add("inert")
        passages = entry["passages"]
        if not isinstance(passages, list):
            broken.add("shape")
            continue
        if len(passages) > args["top"]:
            broken.add("top")
        held = _Held(overlay, knowledge_set(overlay, limit))
        for passage in passages:
            if not isinstance(passage, dict) or set(passage) != _PASSAGE_KEYS:
                broken.add("shape")
                continue
            score = passage["score"]
            if not _is_number(score) or score != score or score in (float("inf"), float("-inf")):
                broken.add("shape")
                continue
            path = passage["path"]
            if not isinstance(path, str):
                broken.add("shape")
                continue
            if prefix is not None and not (path == prefix or path.startswith(prefix + "/")):
                broken.add("path-limit")
            try:
                lines = knowledge_lines(_serve(held, path, {}, caller or CallerFacts(), limit, names))
            except (KeyError, KnowledgeError):
                broken.add("not-knowledge")
                continue
            first, last = passage["from_line"], passage["to_line"]
            if not (
                isinstance(first, int)
                and isinstance(last, int)
                and not isinstance(first, bool)
                and not isinstance(last, bool)
                and 1 <= first <= last <= len(lines)
            ):
                broken.add("range")
                continue
            span = inert("\n".join(lines[first - 1 : last]))
            if not isinstance(passage["text"], str) or passage["text"] == "" or passage["text"] not in span:
                broken.add("text")
            for field in ("heading", "text"):
                if not isinstance(passage[field], str) or passage[field] != inert(passage[field]):
                    broken.add("inert")
        keyed = [
            p
            for p in passages
            if isinstance(p, dict)
            and _is_number(p.get("score"))
            and isinstance(p.get("path"), str)
            and isinstance(p.get("from_line"), int)
            and isinstance(p.get("to_line"), int)
        ]
        if len(keyed) == len(passages) and search_order(passages) != passages:
            broken.add("order")
    return sorted(broken)


class KnowledgePlan(NamedTuple):
    """Whether an overlay's rules and context files are left out of the context because they are
    served, and which."""

    served: bool
    left_out: "List[str]"


def knowledge_plan(
    manifest: Document, files: "Mapping[str, str]", user: Optional[bool] = None
) -> KnowledgePlan:
    """The hint ``[knowledge] serve`` and the user's choice, which wins over it. ``files`` holds the
    overlay's files by path. The body of ``OVERLAY.md`` is never left out, since no tool serves it."""
    table = manifest.get("knowledge")
    hint = isinstance(table, dict) and table.get("serve") is True
    served = hint if user is None else user
    left: "List[str]" = []
    if served:
        tree = OverlayTree.from_texts(files)
        for path in rules_of(manifest, tree) + context_of(manifest, tree):
            if path != "OVERLAY.md" and path not in left:
                left.append(path)
    return KnowledgePlan(served, left)
