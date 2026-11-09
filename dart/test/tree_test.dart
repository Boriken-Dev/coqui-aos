@TestOn('vm')
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/io_fs.dart';
import 'support/memory_fs.dart';

const engineering = <(String, String)>[
  (
    'overlay.cfg',
    'name = "engineering"\ndescription = "How work is planned and committed."\n',
  ),
  ('flows/PLAN.md', '# Plans\n\nOne file per plan.\n'),
  ('rules/commits.md', '- **Commits** are logical, one concern each.\n'),
];

const rust = <(String, String)>[
  ('overlay.cfg', 'requires = ["engineering"]\npriority = 600\n'),
  ('kb/RUST.md', '# Rust\n\nClippy with warnings denied.\n'),
  ('bin/check-all', '#!/bin/sh\ncargo clippy --all-targets\n'),
];

void write(String root, List<(String, String)> files) {
  for (final (path, text) in files) {
    final file = File('$root/$path');
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(text);
  }
}

Future<void> within(Future<void> Function(String root) run) async {
  final dir = Directory.systemTemp.createTempSync('aos-dart-');
  try {
    await run(dir.path.replaceAll(r'\', '/'));
  } finally {
    dir.deleteSync(recursive: true);
  }
}

Future<AosError> refusal(Future<Object?> Function() run) async {
  try {
    await run();
  } on AosError catch (error) {
    return error;
  }
  throw StateError('not refused');
}

void main() {
  final settings = Settings();

  test('a directory gives its tree digest without the excluded names', () {
    return within((root) async {
      write(root, engineering);
      write(root, [
        ('.git/HEAD', 'ref: refs/heads/main\n'),
        ('lib/__pycache__/x.pyc', 'x'),
      ]);
      final tree = await treeDigest(IoFs(), root, settings);
      expect(tree.files.keys.toList(), [
        'flows/PLAN.md',
        'overlay.cfg',
        'rules/commits.md',
      ]);
      final manifest = readDocument(
        File('$root/overlay.cfg').readAsBytesSync(),
        settings,
      );
      expect(rulesOf(manifest, OverlayTree.fromPaths(tree.files.keys)), [
        'rules/commits.md',
      ]);
    });
  });

  test('a directory with a bin folder adds it to the path', () {
    return within((root) async {
      write(root, rust);
      final tree = await treeDigest(IoFs(), root, settings);
      final manifest = readDocument(
        File('$root/overlay.cfg').readAsBytesSync(),
        settings,
      );
      expect(
        defaultPaths(
          manifest,
          OverlayTree.fromPaths(tree.files.keys),
        )[0]['variable'],
        'PATH',
      );
    });
  });

  test('a changed file changes the tree digest', () {
    return within((root) async {
      write(root, rust);
      Future<String> digest() async =>
          (await treeDigest(IoFs(), root, settings)).digest.toString();
      final before = await digest();
      write(root, [('kb/RUST.md', '# Rust\n\nClippy with warnings denied!\n')]);
      final edited = await digest();
      expect(edited, isNot(before));
      write(root, [('kb/NEW.md', 'new\n')]);
      final added = await digest();
      expect(added, isNot(edited));
      File('$root/kb/NEW.md').renameSync('$root/kb/OTHER.md');
      expect(await digest(), isNot(added));
      final now = await digest();
      Directory('$root/empty/inner').createSync(recursive: true);
      write(root, [('node_modules/x/index.js', 'x\n')]);
      expect(await digest(), now);
    });
  });

  test('a tree past a limit is refused naming the limit', () {
    return within((root) async {
      write(root, rust);
      var error = await refusal(
        () => treeDigest(IoFs(), root, settings.copyWith({'treeFiles': 2})),
      );
      expect(error.errorClass, 'too-large');
      expect(error.subject, contains('more than 2 files'));
      error = await refusal(
        () => treeDigest(IoFs(), root, settings.copyWith({'fileBytes': 4})),
      );
      expect(error.errorClass, 'too-large');
    });
  });

  test('a link in the tree is refused and never followed', () async {
    final files = MemoryFs()
        .add('/o/overlay.cfg', FileKind.file, 'name = "x"\n')
        .add('/o/shortcut', FileKind.symlink);
    final error = await refusal(() => treeDigest(files, '/o', settings));
    expect(error.errorClass, 'symlink');
    expect(error.subject, 'shortcut');
  });

  test('a device in the tree is refused', () async {
    final error = await refusal(
      () =>
          treeDigest(MemoryFs().add('/o/pipe', FileKind.other), '/o', settings),
    );
    expect(error.errorClass, 'special-file');
  });

  test('a tree held in memory has the digest of the same files on disk', () {
    return within((root) async {
      write(root, engineering);
      final onDisk = await treeDigest(IoFs(), root, settings);
      final files = MemoryFs();
      for (final (path, text) in engineering) {
        files.add('/o/$path', FileKind.file, text);
      }
      files
          .add('/o/flows', FileKind.directory)
          .add('/o/rules', FileKind.directory);
      expect(
        (await treeDigest(files, '/o', settings)).digest.toString(),
        onDisk.digest.toString(),
      );
    });
  });

  test('a directory read whole is a tree a manifest can be read from', () {
    return within((root) async {
      write(root, engineering);
      write(root, [('.git/HEAD', 'ref: refs/heads/main\n')]);
      final (:tree, :digest) = await readTree(IoFs(), root, settings);
      expect(
        digest.digest.toString(),
        (await treeDigest(IoFs(), root, settings)).digest.toString(),
      );
      expect(
        tree.contains('flows/PLAN.md') && !tree.contains('.git/HEAD'),
        isTrue,
      );
      expect(tree.text('rules/commits.md'), engineering[2].$2);
      final read = readOverlay(tree, settings);
      expect(read.manifestFile, 'overlay.cfg');
      expect(read.manifest['name'], 'engineering');
    });
  });

  test('directories nested past the depth setting are refused', () async {
    final error = await refusal(
      () => treeDigest(
        EndlessFs(['d']),
        '/o',
        settings.copyWith({'treeDepth': 5}),
      ),
    );
    expect(error.errorClass, 'too-large');
    expect(error.subject, contains('deeper than 5'));
  });

  test('a listed name that is not one path component is refused', () async {
    for (final name in ['..', '.', 'a/b', r'a\b', '']) {
      final error = await refusal(
        () => treeDigest(EndlessFs([name]), '/o', settings),
      );
      expect(error.errorClass, 'invalid-name', reason: name);
    }
  });

  test('a listed name that is not Unicode is refused', () async {
    final error = await refusal(
      () => treeDigest(
        EndlessFs([
          Uint8List.fromList([0xff, 0x61]),
        ]),
        '/o',
        settings,
      ),
    );
    expect(error.errorClass, 'non-utf8-name');
  });

  test('empty directories count against the entry limit', () async {
    final error = await refusal(
      () => treeDigest(
        EndlessFs(['a', 'b']),
        '/o',
        settings.copyWith({'treeFiles': 3}),
      ),
    );
    expect(error.errorClass, 'too-large');
  });
}
