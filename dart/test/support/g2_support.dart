/// Helpers the hook, skill and catalog tests share.
library;

import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';

import 'support.dart';

/// An overlay tree from a case's `files`: a list of paths, or a map of path to text.
OverlayTree treeOf(Json files) {
  if (files is List<Object?>) return OverlayTree.fromPaths(files.map(str));
  if (files is Map<String, Object?>) {
    return OverlayTree.fromTexts([
      for (final entry in files.entries) (entry.key, str(entry.value)),
    ]);
  }
  return OverlayTree.fromPaths([]);
}

/// The trees of a case's `files`, by identity.
Map<String, OverlayTree> treesOf(Case item) {
  final files = item['files'];
  return {
    if (files is Map<String, Object?>)
      for (final entry in files.entries) entry.key: treeOf(entry.value),
  };
}

/// A source as the vectors write it.
Map<String, Object?> sourceJson(Source source) => {
  'kind': source.kind,
  'location': source.location,
  'ref': source.reference,
  'path': source.path,
};

/// A hook run from a vector's `run`.
HookRun hookRunOf(Json value) {
  final item = obj(value);
  final Uint8List stdout;
  final encoded = item['stdout_base64'];
  final parts = item['stdout_parts'];
  if (encoded is String) {
    stdout = decode64(encoded);
  } else if (parts is List<Object?>) {
    stdout = partsBytes(parts);
  } else {
    stdout = utf8Bytes(item['stdout'] is String ? str(item['stdout']) : '');
  }
  num number(String key) {
    final found = item[key];
    return found is BigInt ? found.toInt() : 0;
  }

  return hookRun(item['source'] is String ? str(item['source']) : '', stdout)
    ..onFailure = item['on_failure'] == 'refuse' ? 'refuse' : 'report'
    ..seconds = number('seconds')
    ..notRun = item['not_run'] == true
    ..payloadSize = number('payload_size').toInt()
    ..timedOut = item['timed_out'] == true
    ..exit = number('exit').toInt()
    ..sets = strings(item['sets'])
    ..select = item['match'] == null ? null : strings(item['match']);
}

/// Plain Dart as the vectors' JSON: whole numbers become `BigInt`s, a map keeps its order.
Json toJson(Object? plain) {
  if (plain == null) return null;
  if (plain is List) return [for (final item in plain) toJson(item)];
  if (plain is Map) {
    return {
      for (final entry in plain.entries)
        entry.key as String: toJson(entry.value),
    };
  }
  if (plain is int) return BigInt.from(plain);
  return plain;
}
