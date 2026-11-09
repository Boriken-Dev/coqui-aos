import 'dart:convert';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';

import 'support/support.dart';

Uint8List fileBytes(Object? value) {
  if (value is Map<String, Object?> && value['base64'] is String) {
    return decode64(str(value['base64']));
  }
  return utf8Bytes(str(value));
}

bool _same(Uint8List a, Uint8List b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i += 1) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

void checkBytes(
  Uint8List got,
  Case expect,
  String key,
  String base64Key,
  String sizeKey,
) {
  final text = expect[key];
  if (text is String && !_same(got, utf8Bytes(text))) {
    throw StateError(
      '$key ${jsonEncode(utf8.decode(got, allowMalformed: true))}',
    );
  }
  final encoded = expect[base64Key];
  if (encoded is String && !_same(got, decode64(encoded))) {
    throw StateError('$base64Key differs');
  }
  final size = num_(expect[sizeKey]);
  if (size != null && got.length != size) {
    throw StateError('$sizeKey ${got.length}');
  }
}

void need(Object? got, Object? want, String what) {
  if (got != want) throw StateError('$what $got, expected $want');
}

void documentCase(Case item) {
  final data = bytesOf(item);
  final settings = settingsOf(item);
  final expect = obj(item['expect']);
  final read = readFrontMatter(data, settings);
  final split = splitFrontMatter(data, settings);
  need(read.frontMatterCase, expect['case'], 'case');
  for (final (key, got) in [
    ('body_offset', split.bodyOffset),
    ('body_line', split.bodyLine),
    ('metadata_offset', split.metadataOffset),
    ('metadata_line', split.metadataLine),
  ]) {
    final want = num_(expect[key]);
    if (want != null) need(got, want, key);
  }
  checkBytes(
    split.metadata ?? Uint8List(0),
    expect,
    'metadata',
    'metadata_base64',
    'metadata_size',
  );
  checkBytes(split.body(data), expect, 'body', 'body_base64', 'body_size');
  final format = expect['format'];
  if (format is String) need(read.format, format, 'format');
  if (expect.containsKey('data')) {
    if (read.data == null || !valuesEqual(read.data, expect['data'])) {
      throw StateError('data ${show(read.data)}');
    }
  }
  final classes = expectedErrors(expect);
  if (classes.isNotEmpty) {
    final error = read.error;
    if (error == null || !classes.contains(error.errorClass)) {
      throw StateError('error ${error?.message}, expected $classes');
    }
    final line = num_(expect['line']);
    if (line != null) need(error.line, line, 'line');
  } else if (read.error != null) {
    throw StateError('error ${read.error?.message}');
  }
}

void filesCase(Case item) {
  final files = obj(item['files']);
  var tree = OverlayTree.empty();
  for (final entry in files.entries) {
    tree = tree.withBytes(entry.key, fileBytes(entry.value));
  }
  final settings = settingsOf(item);
  final expect = obj(item['expect']);
  final OverlayRead read;
  try {
    read = readOverlay(tree, settings);
  } on AosError catch (error) {
    if (expect['error'] is! String) rethrow;
    need(error.errorClass, expect['error'], error.message);
    final line = num_(expect['line']);
    if (line != null) need(error.line, line, 'line');
    return;
  }
  if (expect.containsKey('error')) throw StateError('read, expected an error');
  Object? got(String key) {
    switch (key) {
      case 'manifest_file':
        return read.manifestFile;
      case 'manifest':
        return read.manifest;
      case 'context':
        return read.context;
      case 'context_ignored':
        return read.contextIgnored;
      case 'issues':
        return read.issues;
      case 'harness_context':
        return read.harnessContext;
      case 'applies':
        return applies(validate(read.manifest, tree));
      case 'digest':
        return digestEntries([
          for (final entry in files.entries)
            (entry.key.split('/'), FileEntry(fileBytes(entry.value))),
        ]).digest.toString();
      default:
        throw StateError('unknown key $key');
    }
  }

  for (final entry in expect.entries) {
    final value = got(entry.key);
    if (!valuesEqual(value, entry.value)) {
      throw StateError(
        '${entry.key} ${show(value)}, expected ${show(entry.value)}',
      );
    }
  }
}

void main() {
  runFile('front_matter.json', (item) {
    final contextFile = item['context_file'];
    if (contextFile is String) {
      final expect = obj(item['expect']);
      try {
        final text = utf8.decode(
          contextFileText(utf8Bytes(contextFile), settingsOf(item)),
        );
        need(text, expect['text'], 'text');
      } on AosError catch (error) {
        need(error.errorClass, expect['error'], error.message);
      }
      return;
    }
    if (item.containsKey('files')) {
      filesCase(item);
    } else {
      documentCase(item);
    }
  });
}
