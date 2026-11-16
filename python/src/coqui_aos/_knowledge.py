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
from ._errors import Error
from ._front_matter import Case, ManifestFile, read_front_matter, split_front_matter
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
    "knowledge_call",
    "knowledge_lines",
    "knowledge_plan",
    "knowledge_result",
    "knowledge_set",
    "knowledge_tools",
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
    """A served file: its text as stored, its template engine (``None`` for a plain file), its size
    in bytes and its bytes."""

    text: str
    engine: Optional[str]
    size: int
    raw: bytes


class KnowledgeSet(NamedTuple):
    """An overlay's knowledge: ``files`` by path and ``skipped`` as ``(path, reason)`` pairs, both in
    the order of the paths as UTF-8 bytes."""

    files: "Dict[str, KnowledgeFile]"
    skipped: "List[Tuple[str, str]]"


def knowledge_set(overlay: KnowledgeOverlay, settings: "Optional[KnowledgeSettings]" = None) -> KnowledgeSet:
    """What is served of ``overlay`` and what is skipped, with the reason (``name``, ``too-large``,
    ``not-text`` or ``template``)."""
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
            engine = None
            found = read_front_matter(data)
            if found.case is Case.MAPPING and found.data is not None and "template" in found.data:
                value = found.data["template"]
                if not isinstance(value, str) or value not in KNOWLEDGE_ENGINES:
                    skipped.append((path, "template"))
                    continue
                engine = value
            files[path] = KnowledgeFile(text, engine, len(data), data)
    return KnowledgeSet(files, skipped)


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
) -> "Dict[str, Any]":
    """What a server answers a call of ``kb_list`` or ``kb_read``: ``{"result": ...}`` or
    ``{"error": {"class", "message"}}``. ``overlays`` are the session's active overlays in
    composition order; ``kb_search`` is the consumer's own (``search_check`` checks its answer)."""
    modes = list(modes)
    try:
        args = knowledge_arguments(tool, arguments, modes, settings)
        if tool == "kb_list":
            return {"result": _list(overlays, args, modes, settings)}
        if tool == "kb_read":
            return {"result": _read(overlays, args, settings, caller or CallerFacts())}
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
    settings: "Optional[KnowledgeSettings]" = None,
) -> "Dict[str, Any]":
    """``kb_list`` as an MCP result: each active overlay's served files and what is skipped."""
    arguments = {} if overlay is None else {"overlay": overlay}
    return knowledge_result(knowledge_call("kb_list", overlays, arguments, modes, settings))


def kb_read(
    overlays: "Sequence[KnowledgeOverlay]",
    path: str,
    *,
    from_line: Optional[int] = None,
    to_line: Optional[int] = None,
    overlay: Optional[str] = None,
    context: "Optional[Dict[str, Any]]" = None,
    caller: "Optional[CallerFacts]" = None,
    settings: "Optional[KnowledgeSettings]" = None,
) -> "Dict[str, Any]":
    """``kb_read`` as an MCP result. A file whose front matter names a template engine is rendered
    for this call from ``caller`` (role, profile, the allowed environment) and ``context``, so a
    consumer never applies ``envsubst`` or Mustache itself; any other file is served as it is."""
    arguments: "Dict[str, Any]" = {"path": path}
    for key, value in (("from", from_line), ("to", to_line), ("overlay", overlay), ("context", context)):
        if value is not None:
            arguments[key] = value
    return knowledge_result(knowledge_call("kb_read", overlays, arguments, (), settings, caller))


def _list(
    overlays: "Sequence[KnowledgeOverlay]",
    args: "Dict[str, Any]",
    modes: "List[str]",
    settings: "Optional[KnowledgeSettings]",
) -> "Dict[str, Any]":
    listed = []
    for overlay in _choose(overlays, args.get("overlay")):
        found = knowledge_set(overlay, settings)
        files: "List[Dict[str, Any]]" = []
        for path, item in found.files.items():
            if item.engine:
                files.append({"path": path, "template": item.engine})
            else:
                files.append({"path": path, "lines": len(knowledge_lines(item.text)), "bytes": item.size})
        listed.append(
            {
                "overlay": overlay.identity,
                "served": bool(overlay.served),
                "files": files,
                "skipped": [{"path": inert(path), "reason": reason} for path, reason in found.skipped],
            }
        )
    result: "Dict[str, Any]" = {"overlays": listed}
    if modes:
        result["search"] = {"modes": [mode for mode in KNOWLEDGE_MODES if mode in set(modes)]}
    return result


_SKIP_CLASS = {
    "name": "invalid-path",
    "too-large": "too-large",
    "not-text": "not-text",
    "template": "unknown-template",
}
_PRIORITY = ("link", "not-text", "too-large", "unknown-template", "not-found")


def _read(
    overlays: "Sequence[KnowledgeOverlay]",
    args: "Dict[str, Any]",
    settings: "Optional[KnowledgeSettings]",
    caller: CallerFacts,
) -> "Dict[str, Any]":
    limit = _mapping(settings)
    path = args["path"]
    if not valid_relative_path(path) or _hidden_name(path):
        raise KnowledgeError("invalid-path", inert(path))
    found_in: "List[Tuple[KnowledgeOverlay, KnowledgeFile]]" = []
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
            found_in.append((overlay, held.files[path]))
        else:
            reason = dict(held.skipped).get(path)
            problems.append(_SKIP_CLASS[reason] if reason else "not-found")
    if len(found_in) > 1:
        raise KnowledgeError("ambiguous", "more than one overlay has that path")
    if not found_in:
        raise KnowledgeError(min(problems, key=_PRIORITY.index), inert(path))
    overlay, item = found_in[0]
    text = item.text
    if item.engine:
        text = _render(overlay, item, args.get("context", {}), caller, limit)
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
        "overlay": overlay.identity,
        "path": path,
        "from_line": start,
        "to_line": start - 1 + len(chosen),
        "total_lines": total,
        "truncated": truncated,
        "text": inert("\n".join(chosen)),
    }
    if item.engine:
        result["template"] = item.engine
    return result


def _facts(overlay: KnowledgeOverlay) -> TemplateFacts:
    if overlay.facts.name is not None:
        return overlay.facts
    return dataclasses.replace(overlay.facts, name=normalize_name(overlay.identity))


def _render(
    overlay: KnowledgeOverlay,
    item: KnowledgeFile,
    context: "Dict[str, Any]",
    call: CallerFacts,
    limit: KnowledgeSettings,
) -> str:
    facts = _facts(overlay)
    split = split_front_matter(item.raw)
    body = item.raw[split.body_offset or 0 :].decode("utf-8")
    caller = call.caller()
    env = call.allowed_env()
    try:
        values = template_values(overlay.manifest, facts)
    except Error as error:
        raise KnowledgeError("invalid-option", error.subject) from None
    if item.engine == "envsubst":
        for key, name in (("role", "AOS_CALLER_ROLE"), ("profile", "AOS_CALLER_PROFILE")):
            if key in caller:
                values[name] = caller[key]
        for name, value in env.items():
            values["AOS_ENV_" + name] = value
        for key, value in context.items():
            if isinstance(value, bool):
                values["AOS_ARG_" + key] = "true" if value else "false"
            elif isinstance(value, (int, str)):
                values["AOS_ARG_" + key] = str(value)
        out = template(body, values)
    else:
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
        data: "Dict[str, Any]" = {
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
            "caller": caller,
            "env": env,
            "options": options,
            "context": context,
        }
        out = mustache(body, data, limit)
    if not _within(limit.max_rendered_bytes, len(out.encode("utf-8", "surrogatepass"))):
        raise KnowledgeError("too-large", "the rendered text")
    return out


def _option_fits(kind: Any, value: Any) -> bool:
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    return False


_NEEDS_EXTRA = "a mustache template needs the 'templates' extra: pip install coqui-aos[templates]"


def mustache(text: str, data: "Dict[str, Any]", settings: "Optional[KnowledgeSettings]" = None) -> str:
    """The Mustache subset of the knowledge section, over ``data``, rendered by ``tplx`` in its
    sandbox (the ``templates`` extra, imported only here). Raises ``KnowledgeError`` of class
    ``template-error`` for a tag the subset does not define, or when ``tplx`` is not installed, and
    ``too-large`` past ``max_rendered_bytes``."""
    limit = _mapping(settings)
    try:
        import tplx
        from tplx.engines import MustacheTemplate
    except ImportError:
        raise KnowledgeError("template-error", _NEEDS_EXTRA) from None
    limits = {}
    if limit.max_template_depth is not None:
        limits["max_depth"] = limit.max_template_depth
    if limit.max_rendered_bytes is not None:
        limits["max_output"] = limit.max_rendered_bytes
    try:
        loader = tplx.Loader(sandbox=tplx.SandboxLimits(**limits), engines=(MustacheTemplate,))
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
) -> "List[str]":
    """The rules a ``kb_search`` answer breaks, as sorted ids (``overlays``, ``mode``, ``top``,
    ``path-limit``, ``not-knowledge``, ``range``, ``text``, ``inert``, ``shape``, ``order``); empty
    when it conforms. The ranking itself is not checked, only the shape and the order the scores imply.
    Raises ``KnowledgeError`` for arguments that are not a search's."""
    modes = list(modes)
    limit = _mapping(settings)
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
        held = knowledge_set(overlay, limit).files
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
            item = held.get(path)
            if item is None or item.engine:
                broken.add("not-knowledge")
                continue
            lines = knowledge_lines(item.text)
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
