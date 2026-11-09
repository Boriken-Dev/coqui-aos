import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/support.dart';

Document manifest(Object? plain) => fromPlain(plain) as Document;

void main() {
  runFile('validation.json', (item) {
    final document = typed(item['document']) as Document;
    final files = item['files'];
    final tree = files is List<Object?>
        ? OverlayTree.fromPaths(strings(files))
        : null;
    final issues = validate(document, tree);
    final expect = obj(item['expect']);
    final flags = expect['flags'];
    if (flags != null && tree != null) {
      final got = skillFlags(document, tree);
      if (show(got) != show(arr(flags))) {
        throw StateError('flags $got, expected $flags');
      }
    }
    final wanted = expect['applies'];
    if (wanted is bool && applies(issues) != wanted) {
      throw StateError('applies ${applies(issues)}, issues $issues');
    }
    if (expect['valid'] == true) {
      if (issues.isNotEmpty) throw StateError('$issues');
      return;
    }
    final at = str(expect['at']);
    final cls = expect['class'];
    if (cls is String &&
        !issues.any((issue) => issue.at == at && issue.code == cls)) {
      throw StateError('no $cls at $at: $issues');
    }
    final near = issues.any(
      (issue) =>
          issue.at == at ||
          issue.at.startsWith('$at/') ||
          (issue.at != '' && at.startsWith('${issue.at}/')),
    );
    if (!near) throw StateError('nothing at $at: $issues');
  });

  test('a pointer names a key with a slash by the escaped token', () {
    final at = validate(
      manifest({
        'env': {'a/b': 'x'},
      }),
    ).map((issue) => issue.at).toList();
    expect(at, contains('/env/a~1b'));
    expect(at, isNot(contains('/env/a/b')));
  });

  test('a float where an integer is required is integer-required', () {
    final floaty = <String, Object>{'priority': 3.0};
    final issues = validate(floaty);
    expect(issues.map((i) => '${i.at} ${i.code}'), [
      '/priority integer-required',
    ]);
    expect(validate(manifest({'priority': 3})), isEmpty);
  });

  test('only a problem under /about leaves a manifest applying', () {
    expect(
      applies(
        validate(
          manifest({
            'about': {'summary': ''},
          }),
        ),
      ),
      isTrue,
    );
    expect(applies(validate(manifest({'name': 1}))), isFalse);
    expect(applies([]), isTrue);
  });

  test('issues are sorted and without repeats', () {
    final issues = validate(
      manifest({
        'skills': ['a b', 'a b'],
        'name': 1,
      }),
    );
    final keys = issues.map((issue) => '${issue.at} ${issue.code}').toList();
    expect(keys, [...keys.toSet()]..sort());
  });

  test('license expressions nest to 128 parentheses and no further', () {
    String nested(int depth) => '${'(' * depth}MIT${')' * depth}';
    expect(validLicense(nested(128)), isTrue);
    expect(validLicense(nested(129)), isFalse);
    expect(validLicense('MIT OR (Apache-2.0 WITH LLVM-exception)'), isTrue);
    expect(validLicense('MIT or Apache-2.0'), isFalse);
    expect(validLicense(''), isFalse);
  });

  test('a hostile license of a million parentheses is refused', () {
    expect(validLicense('(' * 1000000), isFalse);
  });

  test('named files are listed with their pointers', () {
    final doc = manifest({
      'rules': ['r.md'],
      'hooks': {
        'cd': {'run': 'h.py'},
      },
      'about': {'icon': 'i.png'},
    });
    expect(namedFiles(doc), [
      ('/rules/0', 'r.md'),
      ('/hooks/cd/run', 'h.py'),
      ('/about/icon', 'i.png'),
    ]);
  });
}
