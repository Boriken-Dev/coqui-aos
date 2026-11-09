import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

final settings = Settings();

Document read(String text, [Settings? given]) =>
    readDocument(encodeUtf8(text), given ?? settings);

String classOf(String text) {
  try {
    read(text);
  } on AosError catch (error) {
    return error.errorClass;
  }
  return 'accepted';
}

String refusal(void Function() run) {
  try {
    run();
  } on AosError catch (error) {
    return error.errorClass;
  }
  throw StateError('not refused');
}

void main() {
  test('an integer is a BigInt and a float a double, in every format', () {
    for (final text in [
      'x = 30\ny = 30.0\n',
      '#!json\n{"x": 30, "y": 30.0}',
      '#!yaml\nx: 30\ny: 30.0\n',
    ]) {
      final document = read(text);
      expect(document['x'], BigInt.from(30), reason: text);
      expect(document['y'], isA<double>(), reason: text);
      expect(document['y'], 30.0, reason: text);
      expect(valuesEqual(document['x'], document['y']), isFalse, reason: text);
    }
  });

  test('a key named __proto__ is data', () {
    for (final text in [
      '"__proto__" = 1\n',
      '#!json\n{"__proto__": 1}',
      '#!yaml\n__proto__: 1\n',
    ]) {
      final document = read(text);
      expect(document['__proto__'], BigInt.one, reason: text);
      expect(document.length, 1, reason: text);
    }
  });

  test(
    'JSON nested a million deep is refused, with the default and with no bound',
    () {
      final deep = '${'[' * 1000000}${']' * 1000000}';
      expect(
        refusal(
          () => read(
            '#!json\n{"a": $deep}',
            settings.copyWith({'manifestBytes': null}),
          ),
        ),
        'too-deep',
      );
      expect(refusal(() => read('#!json\n{"a": $deep}')), 'too-large');
      final unbounded = settings.copyWith({
        'manifestDepth': null,
        'manifestBytes': null,
      });
      final value = read(
        '#!json\n{"a": ${'[' * 100000}${']' * 100000}}',
        unbounded,
      );
      expect(isDocument(value), isTrue);
    },
  );

  test(
    'YAML and TOML nested far past the bound are refused, not a stack overflow',
    () {
      final yaml = '#!yaml\na: ${'[' * 100000}${']' * 100000}\n';
      expect(refusal(() => read(yaml)), 'too-deep');
      final block =
          '#!yaml\n${List.generate(1000, (level) => '${' ' * level}a:').join('\n')} 1\n';
      expect(refusal(() => read(block)), 'too-deep');
      final toml = 'a = ${'[' * 100000}${']' * 100000}\n';
      expect(refusal(() => read(toml)), 'too-deep');
    },
  );

  test('a billion-laughs document is refused before anything is expanded', () {
    var text = '#!yaml\na: &a [x, x, x, x, x, x, x, x, x]\n';
    const names = [
      ('b', 'a'),
      ('c', 'b'),
      ('d', 'c'),
      ('e', 'd'),
      ('f', 'e'),
      ('g', 'f'),
      ('h', 'g'),
      ('i', 'h'),
    ];
    for (final (name, previous) in names) {
      final refs = List.generate(9, (_) => '*$previous').join(', ');
      text += '$name: &$name [$refs]\n';
    }
    final watch = Stopwatch()..start();
    expect(refusal(() => read(text)), 'yaml-anchor');
    expect(watch.elapsedMilliseconds, lessThan(2000));
  });

  test(
    'a tag, an anchor, an alias, a merge key and a directive each have their class',
    () {
      const cases = [
        ('#!yaml\na: !!str b\n', 'yaml-tag'),
        ('#!yaml\na: &x b\n', 'yaml-anchor'),
        ('#!yaml\na: &x b\nc: *x\n', 'yaml-anchor'),
        ('#!yaml\na: *x\n', 'yaml-anchor'),
        ('#!yaml\nbase: {x: 1}\n<<: {y: 2}\n', 'yaml-merge-key'),
        ('#!yaml\n%YAML 1.2\n---\na: b\n', 'yaml-directive'),
        ('#!yaml\n%TAG ! tag:x,2000:\n---\na: b\n', 'yaml-directive'),
        ('#!yaml\na: 1\n---\nb: 2\n', 'parse-error'),
        ('#!yaml\n? [a]\n: b\n', 'non-string-key'),
        ('#!yaml\n1: b\n', 'non-string-key'),
        ('#!yaml\na: ~\n', 'null-value'),
        ('#!yaml\na: .inf\n', 'non-finite-float'),
        ('#!yaml\na: 9223372036854775808\n', 'integer-range'),
        ('#!yaml\na: 1\na: 2\n', 'duplicate-key'),
      ];
      for (final (text, expected) in cases) {
        expect(refusal(() => read(text)), expected, reason: text);
      }
    },
  );

  test(
    'YAML 1.2 core typing: yes is text, 0x and 0o are integers, an exponent is a float',
    () {
      final document = read(
        "#!yaml\na: yes\nb: 0x1F\nc: 0o17\nd: 1e3\ne: -7\nf: 'null'\ng: true\n",
      );
      expect(document.entries.map((e) => e.key).toList(), [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
      ]);
      expect(document['a'], 'yes');
      expect(document['b'], BigInt.from(31));
      expect(document['c'], BigInt.from(15));
      expect(document['d'], 1000.0);
      expect(document['e'], BigInt.from(-7));
      expect(document['f'], 'null');
      expect(document['g'], true);
    },
  );

  test('a TOML date, infinity and an integer past 64 bits are refused', () {
    expect(refusal(() => read('a = 1979-05-27\n')), 'datetime-value');
    expect(refusal(() => read('a = inf\n')), 'non-finite-float');
    expect(refusal(() => read('a = nan\n')), 'non-finite-float');
    expect(refusal(() => read('a = 9223372036854775808\n')), 'integer-range');
    expect(read('a = -9223372036854775808\n')['a'], -(BigInt.one << 63));
  });

  test(
    'JSON refuses a lone surrogate, a duplicate key, NaN, a comment and a trailing comma',
    () {
      const cases = [
        (r'{"a": "\ud800"}', 'invalid-unicode'),
        (r'{"a": "\udc00"}', 'invalid-unicode'),
        ('{"a": 1, "a": 2}', 'duplicate-key'),
        ('{"a": NaN}', 'parse-error'),
        ('{"a": 1} // x', 'parse-error'),
        ('{"a": 1,}', 'parse-error'),
        ('{"a": 1e999}', 'non-finite-float'),
        ('{"a": null}', 'null-value'),
        ('[1]', 'not-a-mapping'),
      ];
      for (final (text, expected) in cases) {
        expect(refusal(() => read('#!json\n$text')), expected, reason: text);
      }
      expect(
        read(
          r'#!json'
          '\n'
          r'{"a": "\ud83d\ude00"}',
        )['a'],
        '\u{1f600}',
      );
    },
  );

  test('a top-level empty JSON object is an empty mapping', () {
    expect(read('#!json\n{}'), isEmpty);
  });

  test(
    'a byte-order mark where a document starts is refused, and one before the format line is not',
    () {
      expect(read('\uFEFFa = 1\n')['a'], BigInt.one);
      expect(refusal(() => read('#!json\n\uFEFF{}')), 'parse-error');
      expect(refusal(() => read('\uFEFF\uFEFFa = 1\n')), 'parse-error');
    },
  );

  test('a document that is not UTF-8 is refused', () {
    expect(
      refusal(
        () => readDocument(
          Uint8List.fromList([0x61, 0x20, 0x3d, 0x20, 0xff]),
          settings,
        ),
      ),
      'invalid-utf8',
    );
  });

  test('a document past manifestBytes is too large, before it is read', () {
    expect(
      refusal(() => read('a = 1\n', settings.copyWith({'manifestBytes': 3}))),
      'too-large',
    );
  });

  test('a lone surrogate escape is refused in every format', () {
    expect(
      classOf(
        r'#!json'
        '\n'
        r'{"a": "\ud800"}',
      ),
      'invalid-unicode',
    );
    expect(classOf('#!yaml\na: "\\ud800"\n'), 'invalid-unicode');
    expect(classOf('#!yaml\n"\\udc00": 1\n'), 'invalid-unicode');
    expect(classOf('a = "\\ud800"\n'), 'invalid-unicode');
    expect(classOf('"\\ud800" = 1\n'), 'invalid-unicode');
    expect(classOf('#!yaml\na: "\\ud83d\\ude00"\n'), 'accepted');
  });

  test('a duplicate key has one class in every format', () {
    expect(classOf('a = 1\na = 2\n'), 'duplicate-key');
    expect(classOf('[a]\n[a]\n'), 'duplicate-key');
    expect(classOf('a.b = 1\na = 2\n'), 'duplicate-key');
    expect(classOf('#!json\n{"a": 1, "a": 2}'), 'duplicate-key');
    expect(classOf('#!yaml\na: 1\na: 2\n'), 'duplicate-key');
  });

  test('YAML refusals keep their classes with a directive first', () {
    expect(classOf('#!yaml\n%YAML 1.2\n---\na: b\n'), 'yaml-directive');
    expect(classOf('#!yaml\n%FOO bar\n---\na: b\n'), 'yaml-directive');
    expect(classOf('#!yaml\na: !!str b\n'), 'yaml-tag');
    expect(classOf('#!yaml\na: &x b\nc: *x\n'), 'yaml-anchor');
    expect(classOf('#!yaml\na: 1\n---\nb: 2\n'), 'parse-error');
  });

  test('YAML nested 100k deep is refused within a second or two', () {
    final watch = Stopwatch()..start();
    expect(classOf('#!yaml\na: ${'[' * 100000}${']' * 100000}\n'), 'too-deep');
    expect(watch.elapsedMilliseconds, lessThan(3000));
  });
}
