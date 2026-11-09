import 'dart:io';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';

/// A `dart:io` file system for the tests that walk a directory on disk.
class IoFs implements FileSystem {
  @override
  Metadata metadata(String path) {
    final stat = FileStat.statSync(path);
    final link = FileSystemEntity.typeSync(path, followLinks: false);
    final kind = switch (link) {
      FileSystemEntityType.link => FileKind.symlink,
      FileSystemEntityType.directory => FileKind.directory,
      FileSystemEntityType.file => FileKind.file,
      _ => FileKind.other,
    };
    return Metadata(kind, stat.size);
  }

  @override
  Uint8List read(String path, int max) {
    final file = File(path).openSync();
    try {
      return file.readSync(max);
    } finally {
      file.closeSync();
    }
  }

  @override
  List<Object> list(String path) => [
    for (final entry in Directory(path).listSync(followLinks: false))
      entry.uri.pathSegments.where((s) => s != '').last,
  ];
}
