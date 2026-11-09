import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';

/// A tree held in memory, so a link, a device and a name that is not UTF-8 can be had anywhere.
class MemoryFs implements FileSystem {
  final Map<String, (FileKind, Uint8List)> entries = {};

  /// Adds an entry.
  MemoryFs add(String path, FileKind kind, [String text = '']) {
    entries[path] = (kind, encodeUtf8(text));
    return this;
  }

  @override
  Metadata metadata(String path) {
    if (path == '/o') return const Metadata(FileKind.directory, 0);
    final found = entries[path];
    if (found == null) throw StateError('not found');
    return Metadata(found.$1, found.$2.length);
  }

  @override
  Uint8List read(String path, int max) {
    final found = entries[path];
    if (found == null) throw StateError('not found');
    final bytes = found.$2;
    return Uint8List.sublistView(
      bytes,
      0,
      bytes.length < max ? bytes.length : max,
    );
  }

  @override
  List<Object> list(String path) => [
    for (final candidate in entries.keys)
      if (candidate.substring(0, candidate.lastIndexOf('/')) == path)
        candidate.substring(path.length + 1),
  ];
}

/// A tree whose every directory lists the same names, so it is as deep as the walk goes.
class EndlessFs implements FileSystem {
  EndlessFs(this.names);

  final List<Object> names;

  @override
  Metadata metadata(String path) => const Metadata(FileKind.directory, 0);

  @override
  Uint8List read(String path, int max) => Uint8List(0);

  @override
  List<Object> list(String path) => names;
}
