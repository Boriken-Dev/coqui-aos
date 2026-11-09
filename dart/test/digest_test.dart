import 'dart:convert';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/support.dart';

void same(Object? got, Object? want, [String? reason]) {
  if (got != want) throw StateError('$got, expected $want ${reason ?? ''}');
}

void main() {
  runFile('digest.json', (item) {
    final entries = <(List<Object>, TreeEntry)>[];
    for (final entry in arr(item['tree'])) {
      final row = obj(entry);
      final encoded = row['path_base64'];
      final path = encoded is String
          ? decode64(encoded)
          : utf8Bytes(str(row['path']));
      final type = row['type'] is String ? str(row['type']) : 'file';
      final parts = <Object>[];
      var from = 0;
      for (var at = 0; at <= path.length; at += 1) {
        if (at == path.length || path[at] == 0x2f) {
          parts.add(Uint8List.sublistView(path, from, at));
          from = at + 1;
        }
      }
      final TreeEntry kind = switch (type) {
        'dir' => const DirectoryEntry(),
        'symlink' => const SymlinkEntry(),
        'special' => const SpecialEntry(),
        _ => FileEntry(bytesOf(row)),
      };
      entries.add((parts, kind));
    }
    final expect = obj(item['expect']);
    try {
      final tree = digestEntries(entries);
      final lines = tree
          .lines()
          .map((line) => utf8.decode(line, allowMalformed: true))
          .toList();
      same(
        show({'digest': tree.digest.toString(), 'lines': lines}),
        show({'digest': expect['digest'], 'lines': expect['lines']}),
        'digest',
      );
    } on AosError catch (error) {
      same(error.errorClass, expect['error'], error.message);
    }
  });

  test('a digest read back is the same whatever its case', () {
    final digest = Digest.of(encodeUtf8('x'));
    final upper = 'sha256:${digest.toString().substring(7).toUpperCase()}';
    expect(Digest.parse(upper), equals(digest));
    expect(() => Digest.parse('sha256:zz'), throwsA(isA<AosError>()));
  });

  test('a member listed twice is refused', () {
    expect(
      () => digestEntries([
        (['a'], FileEntry(encodeUtf8('x'))),
        (['a'], FileEntry(encodeUtf8('y'))),
      ]),
      throwsA(
        isA<AosError>().having(
          (e) => e.errorClass,
          'class',
          'duplicate-member',
        ),
      ),
    );
  });
}
