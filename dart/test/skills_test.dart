import 'dart:typed_data';

import 'package:coqui_aos/src/catalog.dart';
import 'package:coqui_aos/src/error.dart';
import 'package:coqui_aos/src/limits.dart';
import 'package:coqui_aos/src/skills.dart';
import 'package:coqui_aos/src/source.dart';
import 'package:coqui_aos/src/tree.dart';
import 'package:coqui_aos/src/value.dart';
import 'package:test/test.dart';

import 'support/g2_support.dart';
import 'support/records.dart';
import 'support/support.dart';

void resolveCase(Case item) {
  final settings = Settings();
  final overlays = {
    for (final e in obj(item['overlays']).entries)
      e.key: fromPlain(obj(e.value)) as Document,
  };
  final catalogs = [
    for (final entry in arr(item['catalogs'] ?? <Object?>[]))
      (
        str(obj(entry)['label']),
        readCatalog(
          utf8Bytes(str(obj(entry)['text'])),
          str(obj(entry)['name']),
          obj(entry)['base'] is String ? obj(entry)['base'] as String : null,
          settings,
        ),
      ),
  ];
  final fetches = item['fetches'];
  final plan = resolveSkills(
    overlays,
    strings(item['requested']),
    treesOf(item),
    catalogs,
    strings(item['order']),
    fetches is bool ? fetches : true,
    settings,
  );
  final skills = [
    for (final skill in plan.skills)
      {
        'name': skill.name,
        'origin': skill.origin,
        'overlay': skill.overlay,
        if (skill.source != null) 'source': skill.source,
        if (skill.pin != null) 'pin': skill.pin,
        if (skill.catalog != null) 'catalog': skill.catalog,
        if (skill.catalogs != null) 'catalogs': skill.catalogs,
      },
  ];
  final got = withRecords({
    'skills': skills,
    'missing': plan.missing,
    'ambiguous': plan.ambiguous,
    'unpinned': plan.unpinned,
    'non_defaults': plan.nonDefaults,
    'not_fetched': plan.notFetched,
    'name_mismatch': plan.nameMismatch,
    'shadowing': plan.shadowing,
    'delivered': plan.delivered,
    'collisions': plan.collisions,
  });
  if (!valuesEqual(got, item['expect'])) throw StateError('got ${show(got)}');
}

void fetchedCase(Case item) {
  final files = [
    for (final e in obj(item['fetched']).entries)
      (
        e.key,
        e.value is Map<String, Object?> &&
                (e.value as Map<String, Object?>)['base64'] is String
            ? decode64((e.value as Map<String, Object?>)['base64'] as String)
            : utf8Bytes(str(e.value)),
      ),
  ];
  final pin = item['pin'];
  final expectation = obj(item['expect']);
  FetchedSkill read;
  try {
    read = readFetchedSkill(
      str(item['name']),
      files,
      pin is String ? pin : null,
      settingsOf(item),
    );
  } on AosError catch (error) {
    if (expectedErrors(expectation).contains(error.errorClass)) return;
    rethrow;
  }
  final got = withRecords({
    'digest': read.digest.toString(),
    'reported': read.reported,
    'files': read.files,
  });
  if (!valuesEqual(got, expectation)) throw StateError('got ${show(got)}');
}

Map<String, Document> manifests(Object? plain) => {
  'a': fromPlain(plain) as Document,
};

class _Served implements SkillSource {
  _Served(this.served, this.asked);
  final Map<String, List<(String, Uint8List)>> served;
  final List<String> asked;

  @override
  Future<List<(String, Uint8List)>> fetch(Source source) async {
    asked.add(source.shown());
    final files = served[source.shown()];
    if (files == null) throw AosError('io', 'no such source');
    return files;
  }
}

class _Sync implements SkillSource {
  _Sync(this.files);
  final List<(String, Uint8List)> files;

  @override
  List<(String, Uint8List)> fetch(Source source) => files;
}

void main() {
  runFile('skills.json', (item) {
    if (item.containsKey('fetched')) return fetchedCase(item);
    resolveCase(item);
  });

  test('a plan is fetched through the caller source and checked against its '
      'pins', () async {
    final skill = utf8Bytes(
      '---\nname: review\ndescription: Reviews.\n---\nBody.\n',
    );
    final digest = readFetchedSkill(
      'review',
      [('SKILL.md', skill)],
      null,
      Settings(),
    ).digest.toString();
    final plan = resolveSkills(
      manifests({
        'skills': [
          {
            'name': 'review',
            'source': 'https://example.org/skills.git#review',
            'pin': digest,
          },
          {
            'name': 'lint',
            'source': 'https://example.org/skills.git#lint',
            'pin': digest,
          },
          {'name': 'gone', 'source': 'https://example.org/skills.git#gone'},
        ],
      }),
      ['a'],
      <String, OverlayTree>{},
      [],
      [],
      true,
      Settings(),
    );
    expect(plan.toFetch.length, 3);
    final served = {
      'https://example.org/skills.git#review': [('SKILL.md', skill)],
      'https://example.org/skills.git#lint': [
        ('SKILL.md', utf8Bytes('---\nname: lint\n---\n')),
      ],
    };
    final asked = <String>[];
    final got = await fetchPlanned(plan, _Served(served, asked), Settings());
    String outcome(String name) {
      final found = got.firstWhere((entry) => entry.name == name);
      return found.ok ? 'ok' : found.error!.errorClass;
    }

    expect(outcome('review'), 'ok');
    expect(outcome('lint'), 'pin-mismatch');
    expect(outcome('gone'), 'io');
    expect(asked.length, 3);
  });

  test('a synchronous source works too', () async {
    final skill = utf8Bytes('---\nname: x\n---\n');
    final plan = resolveSkills(
      manifests({
        'skills': [
          {'name': 'x', 'source': 'https://example.org/x.git'},
        ],
      }),
      ['a'],
      <String, OverlayTree>{},
      [],
      [],
      true,
      Settings(),
    );
    final got = await fetchPlanned(
      plan,
      _Sync([('SKILL.md', skill)]),
      Settings(),
    );
    expect(got.first.ok, isTrue);
  });

  test('a consumer that does not fetch is asked for nothing', () {
    final plan = resolveSkills(
      manifests({
        'skills': [
          {'name': 'x', 'source': 'https://example.org/x.git'},
        ],
      }),
      ['a'],
      <String, OverlayTree>{},
      [],
      [],
      false,
      Settings(),
    );
    expect(plan.toFetch.length, 0);
    expect(plan.notFetched.length, 1);
  });

  test('a cycle among the requested overlays is refused as cycle', () {
    final overlays = <String, Document>{
      'a':
          fromPlain({
                'requires': ['b'],
              })
              as Document,
      'b':
          fromPlain({
                'requires': ['a'],
              })
              as Document,
    };
    expect(
      () => resolveSkills(
        overlays,
        ['a'],
        <String, OverlayTree>{},
        [],
        [],
        true,
        Settings(),
      ),
      throwsA(
        isA<AosError>().having((e) => e.errorClass, 'errorClass', 'cycle'),
      ),
    );
  });
}
