/// The Mustache subset a knowledge file may be written in (`spec/v0/knowledge.md#mustache`):
/// variables, sections, inverted sections and comments over plain data. No partial, no change of
/// delimiters, no lambda and no escaping.
library;

import 'dart:convert';

import 'knowledge_core.dart';

final RegExp _name = RegExp(
  r'^(?:\.|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$',
);
final RegExp _standalone = RegExp(r'^[ \t]*\r?\n?$');

class _Item {
  const _Item(this.kind, this.text);
  final String kind;
  final String text;
}

class _Node {
  _Node(this.kind, this.text) : children = [];
  final String kind;
  final String text;
  final List<_Node> children;
}

String _stripBlank(String text) {
  var start = 0;
  var end = text.length;
  while (start < end && (text[start] == ' ' || text[start] == '\t')) {
    start += 1;
  }
  while (end > start && (text[end - 1] == ' ' || text[end - 1] == '\t')) {
    end -= 1;
  }
  return text.substring(start, end);
}

KnowledgeError _refused(String why) => KnowledgeError('template-error', why);

List<_Item> _line(String line) {
  final items = <_Item>[];
  var index = 0;
  while (index < line.length) {
    final found = line.indexOf('{{', index);
    if (found < 0) {
      items.add(_Item('text', line.substring(index)));
      break;
    }
    if (found > index) items.add(_Item('text', line.substring(index, found)));
    if (line.startsWith('{{{', found)) {
      final end = line.indexOf('}}}', found + 3);
      if (end < 0) throw _refused('a tag is not closed');
      items.add(_Item('var', _stripBlank(line.substring(found + 3, end))));
      index = end + 3;
    } else {
      final end = line.indexOf('}}', found + 2);
      if (end < 0) throw _refused('a tag is not closed');
      final inner = _stripBlank(line.substring(found + 2, end));
      index = end + 2;
      final sigil = inner.isEmpty ? '' : inner[0];
      if (sigil == '#' || sigil == '^' || sigil == '/' || sigil == '&') {
        final kind = const {
          '#': 'sec',
          '^': 'inv',
          '/': 'end',
          '&': 'var',
        }[sigil]!;
        items.add(_Item(kind, _stripBlank(inner.substring(1))));
      } else if (sigil == '!') {
        items.add(const _Item('comment', ''));
      } else if ('><={}\$%*'.contains(sigil) && sigil.isNotEmpty) {
        throw _refused('a tag of this kind is not defined');
      } else {
        items.add(_Item('var', inner));
      }
    }
    final last = items.last;
    if (last.kind != 'text' && last.kind != 'comment') {
      final section =
          last.kind == 'sec' || last.kind == 'inv' || last.kind == 'end';
      if (!_name.hasMatch(last.text) || (section && last.text == '.')) {
        throw _refused('a name is not usable');
      }
    }
  }
  final tags = [
    for (final item in items)
      if (item.kind != 'text') item,
  ];
  if (tags.length == 1 &&
      const {'sec', 'inv', 'end', 'comment'}.contains(tags[0].kind)) {
    final texts = [
      for (final item in items)
        if (item.kind == 'text') item.text,
    ];
    if (texts.every(_standalone.hasMatch) &&
        _standalone.hasMatch(texts.join())) {
      return tags;
    }
  }
  return items;
}

final RegExp _lines = RegExp(r'[^\n]*\n|[^\n]+');

_Node _parse(String text, KnowledgeSettings settings) {
  final root = _Node('root', '');
  final stack = <_Node>[root];
  for (final match in _lines.allMatches(text)) {
    for (final item in _line(match.group(0)!)) {
      final children = stack.last.children;
      switch (item.kind) {
        case 'text' || 'var':
          children.add(_Node(item.kind, item.text));
        case 'sec' || 'inv':
          final node = _Node(item.kind, item.text);
          children.add(node);
          stack.add(node);
          final most = settings.maxTemplateDepth;
          if (most != null && stack.length > most) {
            throw _refused('sections nest too deep');
          }
        case 'end':
          if (stack.length == 1 || stack.last.text != item.text) {
            throw _refused('a section is closed wrongly');
          }
          stack.removeLast();
        default:
      }
    }
  }
  if (stack.length != 1) throw _refused('a section is not closed');
  return root;
}

final Object _missing = Object();

Object? _lookup(String name, List<Object?> stack) {
  if (name == '.') return stack.last;
  final parts = name.split('.');
  Object? value = _missing;
  for (var at = stack.length - 1; at >= 0; at -= 1) {
    final context = stack[at];
    if (context is Map && context.containsKey(parts.first)) {
      value = context[parts.first];
      break;
    }
  }
  for (final key in parts.skip(1)) {
    if (identical(value, _missing)) break;
    value = value is Map && value.containsKey(key) ? value[key] : _missing;
  }
  return value;
}

bool _truthy(Object? value) =>
    !(identical(value, _missing) ||
        value == null ||
        value == false ||
        (value is List && value.isEmpty));

/// [text] rendered over [data]: the Mustache subset of the knowledge section.
///
/// A value is a `String`, an integer (`int` or `BigInt`), a `bool`, a list or a mapping; any
/// other value inserts nothing. Throws [KnowledgeError] `template-error` for what the subset
/// refuses and `too-large` for an output past `maxRenderedBytes`.
String mustache(
  String text,
  Map<String, Object?> data, [
  KnowledgeSettings? settings,
]) {
  final limit = settings ?? KnowledgeSettings();
  final tree = _parse(text, limit);
  final out = StringBuffer();
  var size = 0;

  void emit(String piece) {
    size += utf8.encode(piece).length;
    final most = limit.maxRenderedBytes;
    if (most != null && size > most) {
      throw KnowledgeError('too-large', 'the rendered text');
    }
    out.write(piece);
  }

  void walk(List<_Node> nodes, List<Object?> stack) {
    for (final node in nodes) {
      if (node.kind == 'text') {
        emit(node.text);
      } else if (node.kind == 'var') {
        final value = _lookup(node.text, stack);
        if (value is bool) {
          emit(value ? 'true' : 'false');
        } else if (value is int || value is BigInt || value is String) {
          emit('$value');
        }
      } else {
        final value = _lookup(node.text, stack);
        if (node.kind == 'inv') {
          if (!_truthy(value)) walk(node.children, stack);
        } else if (_truthy(value)) {
          for (final item in value is List ? value : [value]) {
            walk(node.children, [...stack, item]);
          }
        }
      }
    }
  }

  walk(tree.children, [data]);
  return out.toString();
}
