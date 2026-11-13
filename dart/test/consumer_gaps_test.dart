// What a host builds on: the setup record's JSON spelling, `hooksDeclared`, and the setting a
// limit's refusal names.
import 'dart:convert';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/memory_fs.dart';

Uint8List bytes(String text) => Uint8List.fromList(utf8.encode(text));

void refused(void Function() body, String errorClass, String setting) {
  try {
    body();
  } on AosError catch (error) {
    expect(error.errorClass, errorClass, reason: '$error');
    expect(error.setting, setting, reason: '$error');
    return;
  }
  fail('not refused');
}

OverlayTree tree(List<String> paths) => OverlayTree.fromPaths(paths);

void main() {
  group('the setup record', () {
    test('a phase is read from its name', () {
      expect(phaseWords.named('install'), 'install');
      expect(phaseWords.named('Install'), isNull);
      expect(phaseWords.named(''), isNull);
    });

    test('a record is written as digest and phase', () {
      const record = SetupRecord(digest: 'sha256:ab', phase: 'sync');
      expect(record.toJson(), {'digest': 'sha256:ab', 'phase': 'sync'});
    });

    test('a record is read back', () {
      const record = SetupRecord(digest: 'sha256:ab', phase: 'install');
      final back = SetupRecord.fromJson(record.toJson());
      expect(back.digest, 'sha256:ab');
      expect(back.phase, 'install');
      expect(
        SetupRecord.fromJson({'digest': 'sha256:cd', 'phase': 'remove'}).phase,
        'remove',
      );
      expect(
        SetupRecord.fromJson(
          jsonDecode('{"digest":"d","phase":"sync"}'),
        ).digest,
        'd',
      );
    });

    test('a record that does not read is refused', () {
      for (final bad in <Object?>[
        {'digest': 'sha256:ab', 'phase': 'later'},
        {'digest': 'sha256:ab', 'phase': 'Sync'},
        {'digest': 'sha256:ab'},
        {'phase': 'sync'},
        {'digest': 1, 'phase': 'sync'},
        'sync',
        null,
      ]) {
        expect(
          () => SetupRecord.fromJson(bad),
          throwsFormatException,
          reason: '$bad',
        );
      }
    });
  });

  group('hooksDeclared', () {
    test('an overlay with no hooks declares none', () {
      expect(hooksDeclared({}, tree(['SKILL.md'])), isFalse);
      expect(hooksDeclared({'hooks': <String, Object?>{}}, tree([])), isFalse);
      final off = {for (final event in hookEvent.all) event: false};
      expect(hooksDeclared({'hooks': off}, tree(['hook.sh'])), isFalse);
      expect(
        hooksDeclared({
          'defaults': {'hooks': false},
        }, tree(['hook.py'])),
        isFalse,
      );
    });

    test('a default script declares a hook whatever its os', () {
      for (final script in [
        'hook.sh',
        'hook.bash',
        'hook.ps1',
        'hook.py',
        'hook.js',
      ]) {
        expect(hooksDeclared({}, tree([script])), isTrue, reason: script);
      }
    });

    test('a table entry declares a hook', () {
      expect(
        hooksDeclared({
          'hooks': {
            'pre-tool': {'run': 'guard.py'},
          },
        }, tree(['guard.py'])),
        isTrue,
      );
      expect(
        hooksDeclared({
          'hooks': {'prompt': 'guard.ps1'},
        }, tree(['guard.ps1'])),
        isTrue,
      );
    });

    test('it agrees with hooksOf on every os', () {
      final cases = <(Document, List<String>)>[
        ({}, ['hook.ps1']),
        (
          {
            'hooks': {
              'cd': {'run': 'x.sh'},
            },
          },
          [],
        ),
        (
          {
            'hooks': {'cd': false},
          },
          ['hook.sh'],
        ),
      ];
      for (final (manifest, paths) in cases) {
        final overlay = tree(paths);
        var anywhere = false;
        for (final os in ['windows', 'linux', 'macos']) {
          final found = hooksOf(manifest, overlay, os, interpreters);
          anywhere =
              anywhere || found.hooks.isNotEmpty || found.notRun.isNotEmpty;
        }
        expect(hooksDeclared(manifest, overlay), anywhere, reason: '$manifest');
      }
    });
  });

  group('the setting a limit names', () {
    test('a manifest past its bytes', () {
      refused(
        () => readDocument(
          bytes('name = "longer than eight"\n'),
          Settings({'manifestBytes': 8}),
        ),
        'too-large',
        'manifest_bytes',
      );
    });

    test('a manifest past its depth in every format', () {
      for (final text in [
        'a = [[[1]]]\n',
        '#!json\n{"a": {"b": {"c": 1}}}\n',
        '#!yaml\na: [[[1]]]\n',
      ]) {
        refused(
          () => readDocument(bytes(text), Settings({'manifestDepth': 2})),
          'too-deep',
          'manifest_depth',
        );
      }
    });

    test('a catalog past its bytes', () {
      for (final name in ['catalog.json', 'CATALOG.aos']) {
        refused(
          () => readCatalogDocument(
            bytes(' ' * 64),
            name,
            Settings({'catalogBytes': 8}),
          ),
          'too-large',
          'catalog_bytes',
        );
      }
    });

    test('a context body past its bytes', () {
      final overlay = OverlayTree.fromTexts([
        ('OVERLAY.md', '---\nname: x\n---\n${'Body.\n' * 10}'),
      ]);
      refused(
        () => readOverlay(overlay, Settings({'contextBytes': 16})),
        'too-large',
        'context_bytes',
      );
    });

    test('an icon past its bytes or size', () {
      final data = Uint8List.fromList([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, //
        0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, //
        0, 0, 0, 16, 0, 0, 0, 16,
      ]);
      refused(
        () => readIcon(data, 'a.png', Settings({'iconBytes': 8})),
        'icon-too-large',
        'icon_bytes',
      );
      refused(
        () => readIcon(data, 'a.png', Settings({'iconWidth': 8})),
        'icon-dimensions',
        'icon_width',
      );
      refused(
        () => readIcon(data, 'a.png', Settings({'iconHeight': 8})),
        'icon-dimensions',
        'icon_height',
      );
    });

    test('a substitution past its limits', () {
      String? nothing(String name) => null;
      refused(
        () => substituteWith(
          '\${U:-\${V:-\${W:-x}}}',
          nothing,
          Settings({'substitutionDepth': 1}),
        ),
        'too-deep',
        'substitution_depth',
      );
      refused(
        () => substituteWith(
          '\${U:-xxxxxxxxxxxx}',
          nothing,
          Settings({'substitutionBytes': 4}),
        ),
        'too-large',
        'substitution_bytes',
      );
      refused(
        () => substituteWith(
          '\${A//*z/}',
          (name) => 'a' * 2000,
          Settings({'substitutionSteps': 100}),
        ),
        'too-complex',
        'substitution_steps',
      );
    });

    test('a tree past its limits', () async {
      final files = MemoryFs()
        ..add('/o/a', FileKind.directory)
        ..add('/o/a/b', FileKind.directory)
        ..add('/o/a/b/c.md', FileKind.file, 'twelve bytes')
        ..add('/o/d.md', FileKind.file, 'twelve bytes');
      for (final (field, key, bound) in [
        ('treeFiles', 'tree_files', 2),
        ('treeDepth', 'tree_depth', 1),
        ('fileBytes', 'file_bytes', 4),
        ('treeBytes', 'tree_bytes', 13),
      ]) {
        try {
          await treeDigest(files, '/o', Settings({field: bound}));
          fail('not refused');
        } on AosError catch (error) {
          expect(error.errorClass, 'too-large');
          expect(error.setting, key, reason: '$error');
        }
      }
    });

    test('a refusal that is no limit names none', () {
      try {
        readDocument(bytes('a = = 1\n'), Settings());
        fail('not refused');
      } on AosError catch (error) {
        expect(error.setting, isNull);
      }
    });
  });

  test('a host weakening keeps its own id', () {
    const mine = NonDefaultSetting('read-only-not-enforced', 'workspace');
    expect(mine.id, 'read-only-not-enforced');
    expect(mine.subject, 'workspace');
  });
}
