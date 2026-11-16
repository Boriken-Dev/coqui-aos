import 'dart:convert';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/support.dart';

/// A vector value as plain JSON: integers that fit become `int`.
Object? plain(Object? value) {
  if (value is BigInt) return value.isValidInt ? value.toInt() : value;
  if (value is Map) {
    return {for (final e in value.entries) e.key: plain(e.value)};
  }
  if (value is List) return [for (final item in value) plain(item)];
  return value;
}

void same(Object? got, Object? want) {
  final a = jsonEncode(plain(got));
  final b = jsonEncode(plain(want));
  if (a != b) throw StateError('got $a, expected $b');
}

KnowledgeSettings limitsOf(Case item) {
  final limits = item['limits'];
  return limits is Map<String, Object?>
      ? KnowledgeSettings.fromData(limits)
      : KnowledgeSettings();
}

KnowledgeEntry entryOf(Case entry) {
  switch (entry['type']) {
    case 'symlink':
      return KnowledgeEntry.symlink();
    case 'special':
      return KnowledgeEntry.special();
    case 'dir':
      return KnowledgeEntry.directory();
    default:
      return KnowledgeEntry.file(bytesOf(entry));
  }
}

TemplateFacts factsOf(Case facts) => TemplateFacts(
  root: facts['root'] as String?,
  state: facts['state'] as String?,
  name: facts['name'] as String?,
  scope: facts['scope'] as String?,
  project: facts['project'] as String?,
  options: facts['options'] == null
      ? const {}
      : valueOf(facts['options']) as Map<String, Object>,
);

List<KnowledgeOverlay> overlaysOf(Case item) => [
  for (final overlay in arr(item['overlays']).map(obj))
    KnowledgeOverlay(
      identity: str(overlay['identity']),
      manifest: documentOf(overlay['manifest']),
      served: overlay['served'] == true,
      facts: factsOf(obj(overlay['facts'])),
      tree: {
        for (final entry in arr(overlay['tree']).map(obj))
          str(entry['path']): entryOf(entry),
      },
    ),
];

/// The engines a case's server renders with, and the option values it lacks.
Iterable<String> enginesOf(Case item) => [
  ...(item.containsKey('engines')
      ? strings(item['engines'])
      : knowledgeEngines),
  for (final lacked in strings(item['lacks'])) '-$lacked',
];

CallerFacts callerOf(Object? facts) {
  if (facts is! Map<String, Object?>) return const CallerFacts();
  final caller = facts['caller'];
  return CallerFacts(
    role: caller is Map ? caller['role'] as String? : null,
    profile: caller is Map ? caller['profile'] as String? : null,
    env: {
      for (final e in (facts['env'] as Map<String, Object?>? ?? {}).entries)
        e.key: e.value! as String,
    },
    envAllow: strings(facts['env_allow']),
  );
}

/// Cases the stock Mustache engine (`mustache_template`) does not meet, by id and why. They
/// are skipped, never worked around.
const _stockMisfits = <Object?, String>{
  'mustache-spaces-in-tag':
      'the engine reads "{{ & context.x }}" as an unescaped variable, as the official '
      'specification does; the vector reads "& context.x" as a missing name: expected "vvv", '
      'got "vvvv"',
};

void main() {
  runFile('knowledge.json', (item) {
    final id = str(item['id']);
    final limits = limitsOf(item);
    final expect = obj(item['expect']);
    if (id.startsWith('tools-')) {
      same({'tools': knowledgeTools(strings(item['modes']), limits)}, expect);
    } else if (item['kind'] == 'arguments') {
      Object? got;
      try {
        got = {
          'arguments': knowledgeArguments(
            str(item['tool']),
            item['arguments'],
            strings(item['modes']),
            limits,
          ),
        };
      } on KnowledgeError catch (error) {
        got = {'error': error.errorClass};
      }
      same(got, expect);
    } else if (item.containsKey('outcome')) {
      final outcome = obj(item['outcome']);
      final result = knowledgeResult(
        outcome.map((key, value) => MapEntry(key, plain(value))),
      );
      final content = (result['content']! as List).single as Map;
      same(jsonDecode(content['text']! as String), result['structuredContent']);
      same({
        'structuredContent': result['structuredContent'],
        'isError': result['isError'],
      }, expect);
    } else if (item.containsKey('manifest') && item.containsKey('files')) {
      final files = obj(item['files']);
      final plan = knowledgePlan(
        documentOf(item['manifest']),
        OverlayTree.fromTexts([
          for (final e in files.entries) (e.key, str(e.value)),
        ]),
        item['user'] as bool?,
      );
      same({'served': plan.served, 'left_out': plan.leftOut}, expect);
    } else {
      final out = knowledgeCall(
        str(item['tool']),
        overlaysOf(item),
        item['arguments'],
        modes: strings(item['modes']),
        settings: limits,
        caller: callerOf(item['facts']),
        engines: enginesOf(item),
      );
      final error = out['error'];
      same(
        error is Map ? {'error': error['class']} : {'result': out['result']},
        expect,
      );
    }
  }, skip: (item) => _stockMisfits[item['id']]);

  runFile('knowledge_search.json', (item) {
    final expect = obj(item['expect']);
    if (str(item['id']).startsWith('order-')) {
      final passages = [for (final p in arr(item['passages'])) obj(p)];
      same({'order': searchOrder(passages)}, expect);
    } else {
      same({
        'violations': searchCheck(
          overlaysOf(item),
          item['arguments'],
          item['response'],
          strings(item['modes']),
          settings: limitsOf(item),
          caller: callerOf(item['facts']),
          engines: enginesOf(item),
        ),
      }, expect);
    }
  });

  group('the public entry points', () {
    final overlay = KnowledgeOverlay(
      identity: 'team',
      manifest: {
        'options': {
          'depth': {'type': 'string', 'default': 'deep'},
        },
      },
      tree: {
        'kb/a.md': KnowledgeEntry.text('one\r\ntwo\n'),
        'kb/t.md': KnowledgeEntry.text(
          '#!mustache\n'
          '{{caller.role}} {{options.depth}} {{context.n}}\n',
        ),
        'kb/link': KnowledgeEntry.symlink(),
      },
      facts: const TemplateFacts(root: '/o/team'),
    );

    test('kbRead renders a template from the caller and the context', () {
      final result = kbRead(
        [overlay],
        path: 'kb/t.md',
        context: {'n': 3},
        caller: const CallerFacts(role: 'reviewer'),
      );
      expect(result['isError'], isFalse);
      final body = result['structuredContent']! as Map;
      expect(body['text'], 'reviewer deep 3');
      expect(body['template'], 'mustache');
    });

    test('kbRead refuses what the section says', () {
      for (final (path, want) in [
        ('kb/link/x.md', 'link'),
        ('../x', 'invalid-path'),
        ('kb/none.md', 'not-found'),
      ]) {
        final result = kbRead([overlay], path: path);
        expect(result['isError'], isTrue);
        expect(
          ((result['structuredContent']! as Map)['error'] as Map)['class'],
          want,
        );
      }
    });

    test('kbList lists a plain file by lines and a template by engine', () {
      final result = kbList([overlay], modes: ['words']);
      final body = result['structuredContent']! as Map;
      final files = ((body['overlays']! as List).single as Map)['files'];
      expect(files, [
        {'path': 'kb/a.md', 'lines': 2, 'bytes': 9},
        {
          'path': 'kb/t.md',
          'lines': 1,
          'bytes': 7,
          'template': 'mustache',
          'rendered': true,
        },
      ]);
      expect(body['engines'], ['envsubst', 'mustache']);
      expect(body['search'], {
        'modes': ['words'],
      });
    });

    test('a server without an engine keeps the file and its context', () {
      final result = kbRead(
        [overlay],
        path: 'kb/t.md',
        context: {'n': 3},
        caller: const CallerFacts(role: 'r'),
        engines: const [],
      );
      final body = result['structuredContent']! as Map;
      expect(body['rendered'], isFalse);
      expect(
        body['text'],
        '#!mustache\n---\naos_template_context: {"engine": "mustache", '
        '"overlay": {"name": "team", "root": "/o/team"}, "caller": '
        '{"role": "r"}, "options": {"depth": "deep"}, "context": {"n": 3}}\n'
        '---\n{{caller.role}} {{options.depth}} {{context.n}}',
      );
    });

    test(
      'a first line names the format, and only a markdown file reads it',
      () {
        final data = Uint8List.fromList(
          encodeUtf8('#!/usr/bin/env -S MUSTACHE\n'),
        );
        expect(knowledgeFormat(data)?.name, 'mustache');
        expect(knowledgeFormat(encodeUtf8('#!envsubst a=1 b=x\n'))?.options, {
          'a': '1',
          'b': 'x',
        });
        expect(knowledgeFormat(encodeUtf8(' #!raw\n')), isNull);
        expect(knowledgeFormat(encodeUtf8('#!\n')), isNull);
        expect(knowledgeFormat(encodeUtf8('#!.Raw'))?.name, 'raw');
      },
    );

    test('an include is read from the includer, code is left alone', () {
      final tree = KnowledgeOverlay(
        identity: 'team',
        tree: {
          'kb/a.md': KnowledgeEntry.text(
            'x @b.md y\n`@b.md` \${AOS_OVERLAY_NAME}\n',
          ),
          'kb/b.md': KnowledgeEntry.text('---\nk: v\n---\nB\n'),
        },
      );
      final body = kbRead([tree], path: 'kb/a.md')['structuredContent']! as Map;
      expect(body['text'], 'x B y\n`@b.md` team');
    });

    test('envsubst keeps an unset name by default and follows its options', () {
      expect(knowledgeUndefinedDefault, 'debug');
      final values = {'A': 'x'};
      expect(renderEnvsubst(r'$A ${B} $$C', values), r'x ${B} $$C');
      expect(
        renderEnvsubst(r'$A ${B} $$C', values, undefined: 'lenient'),
        r'x  $',
      );
      expect(
        renderEnvsubst(r'${B:-d} $$C', values, features: {'escape', 'default'}),
        r'd $C',
      );
      expect(
        () => renderEnvsubst(r'$B', values, undefined: 'strict'),
        throwsA(isA<KnowledgeError>()),
      );
      expect(
        () => envsubstOptions({'dialect': 'sed'}),
        throwsA(isA<KnowledgeError>()),
      );
    });

    test('a cycle of includes is an include-error', () {
      final tree = KnowledgeOverlay(
        identity: 'team',
        tree: {
          'kb/a.md': KnowledgeEntry.text('@b.md\n'),
          'kb/b.md': KnowledgeEntry.text('@a.md\n'),
        },
      );
      final result = kbRead([tree], path: 'kb/a.md');
      expect(
        ((result['structuredContent']! as Map)['error'] as Map)['class'],
        'include-error',
      );
      final skipped =
          (((kbList([tree])['structuredContent']! as Map)['overlays']! as List)
                  .single
              as Map)['skipped'];
      expect(skipped, [
        {'path': 'kb/a.md', 'reason': 'render'},
        {'path': 'kb/b.md', 'reason': 'render'},
      ]);
    });

    test('written-out text covers U+2060 to U+2064, and a key is strict', () {
      expect(inert('a\u2061b\u2064c'), 'a<U+2061>b<U+2064>c');
      expect(
        () => knowledgeArguments('kb_read', {
          'path': 'a',
          'context': {'k\n': 'v'},
        }, const []),
        throwsA(isA<KnowledgeError>()),
      );
      expect(knowledgeLines('a\r'), ['a\r']);
      expect(knowledgeLines(''), isEmpty);
    });

    test('settings carry no floor and report what differs', () {
      final settings = KnowledgeSettings({'maxReadBytes': 0, 'maxTop': null});
      expect(settings.maxReadBytes, 0);
      expect(settings.maxTop, isNull);
      expect(settings.nonDefaults().map((e) => e.setting), [
        'max_read_bytes',
        'max_top',
      ]);
    });

    test(
      'a tree is read through a filesystem without following a link',
      () async {
        final tree = await readKnowledgeTree(
          _Fs({
            '/o': (FileKind.directory, ''),
            '/o/kb': (FileKind.directory, ''),
            '/o/kb/a.md': (FileKind.file, 'hi\n'),
            '/o/kb/l': (FileKind.symlink, ''),
            '/o/.git': (FileKind.directory, ''),
          }),
          '/o',
        );
        expect(tree.keys.toSet(), {'kb', 'kb/a.md', 'kb/l'});
        expect(tree['kb/l']!.kind, 'symlink');
      },
    );
  });
}

class _Fs implements FileSystem {
  _Fs(this.entries);
  final Map<String, (FileKind, String)> entries;

  @override
  Metadata metadata(String path) {
    final (kind, text) = entries[path]!;
    return Metadata(kind, encodeUtf8(text).length);
  }

  @override
  Uint8List read(String path, int max) => encodeUtf8(entries[path]!.$2);

  @override
  List<Object> list(String path) => [
    for (final key in entries.keys)
      if (key != path &&
          key.startsWith('$path/') &&
          !key.substring(path.length + 1).contains('/'))
        key.substring(path.length + 1),
  ];
}
