/// What the vector tests share: the vector files, their comparison rules and the JSON shapes the
/// vectors write results in.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';
import 'package:coqui_aos/src/json.dart' show readJson;
import 'package:test/test.dart';

import 'vectors.dart';

/// A vector's JSON: mappings are `Map<String, Object?>`, integers `BigInt`s, floats `double`s,
/// and null is null.
typedef Json = Object?;

/// A vector case.
typedef Case = Map<String, Object?>;

/// Parses a vector's JSON.
Json parseVectorJson(String text) => readJson(text, null, true);

/// The cases of one vector file.
List<Case> cases(String file) {
  final document = parseVectorJson(readVector(file)) as Map<String, Object?>;
  return (document['cases'] as List<Object?>).cast<Case>();
}

/// Base64 as bytes.
Uint8List decode64(String encoded) => base64.decode(encoded);

/// Text as UTF-8 bytes.
Uint8List utf8Bytes(String text) => encodeUtf8(text);

/// [value] as a string.
String str(Json value) {
  if (value is! String) throw StateError('a string, not $value');
  return value;
}

/// [value] as a mapping.
Case obj(Json value) {
  if (value is! Map<String, Object?>) throw StateError('an object, not $value');
  return value;
}

/// [value] as a list.
List<Object?> arr(Json value) {
  if (value is! List<Object?>) throw StateError('an array, not $value');
  return value;
}

/// [value] as a list of strings; null is empty.
List<String> strings(Json value) =>
    value == null ? [] : arr(value).map(str).toList();

/// [value] as a number, if it is an integer.
int? num_(Json value) => value is BigInt ? value.toInt() : null;

/// A case's document bytes: `base64`, `text`, or `parts` concatenated.
Uint8List bytesOf(Case item) {
  final encoded = item['base64'];
  if (encoded is String) return decode64(encoded);
  final parts = item['parts'];
  if (parts is List<Object?>) return partsBytes(parts);
  return utf8Bytes(str(item['text']));
}

/// Parts: text, or `[text, times]`, concatenated.
Uint8List partsBytes(List<Object?> parts) {
  final out = BytesBuilder();
  for (final part in parts) {
    final String text;
    final int times;
    if (part is List<Object?>) {
      text = str(part[0]);
      times = (part[1] as BigInt).toInt();
    } else {
      text = str(part);
      times = 1;
    }
    final bytes = utf8Bytes(text);
    for (var at = 0; at < times; at += 1) {
      out.add(bytes);
    }
  }
  return out.takeBytes();
}

/// The settings a case's `limits` write.
Settings settingsOf(Case item) {
  final limits = item['limits'];
  if (limits is! Map<String, Object?>) return Settings();
  final changes = <String, Limit>{};
  final bytes = num_(limits['max_bytes']);
  if (bytes != null) {
    changes['manifestBytes'] = bytes;
    changes['catalogBytes'] = bytes;
  }
  final depth = num_(limits['max_depth']);
  if (depth != null) changes['manifestDepth'] = depth;
  final context = num_(limits['max_context_bytes']);
  if (context != null) changes['contextBytes'] = context;
  return Settings(changes);
}

/// Runs [check] on every case of a file, collecting failures; [skip] names a case left out,
/// with the reason. Fails when any case fails.
void runFile(
  String file,
  void Function(Case item) check, {
  String? Function(Case item)? skip,
}) {
  test(file, () {
    var passed = 0;
    var skipped = 0;
    final failed = <String>[];
    for (final item in cases(file)) {
      final id = str(item['id']);
      final reason = skip?.call(item);
      if (reason != null) {
        skipped += 1;
        print('$file: skipped $id: $reason');
        continue;
      }
      try {
        check(item);
        passed += 1;
      } on Object catch (error, stack) {
        failed.add(
          '$id: ${error is AosError ? 'unexpected ${error.message}' : error}'
          '${error is AosError || error is StateError ? '' : '\n$stack'}',
        );
      }
    }
    print('$file: $passed passed, $skipped skipped, ${failed.length} failed');
    expect(failed, isEmpty, reason: '$file:\n${failed.join('\n')}');
  });
}

/// The error classes a case's `expect` names.
List<String> expectedErrors(Case expect) {
  final error = expect['error'];
  if (error is String) return [error];
  if (error is List<Object?>) return error.map(str).toList();
  return [];
}

/// [value] as JSON text for a failure message.
String show(Object? value) => jsonEncode(
  value,
  toEncodable: (item) => item is BigInt ? '${item}n' : item.toString(),
);

/// Compares a result with a case's `expect`: its `data`, or one of its error classes.
void compare(Object? Function() got, Json expect) {
  final want = obj(expect);
  final errors = expectedErrors(want);
  Object? data;
  try {
    data = got();
  } on AosError catch (error) {
    if (errors.contains(error.errorClass)) return;
    throw StateError('refused ${error.message}, expected ${show(want)}');
  }
  if (!want.containsKey('data')) {
    throw StateError(
      'read ${show(data)}, expected an error ${errors.join(',')}',
    );
  }
  if (!valuesEqual(data, want['data'])) {
    throw StateError('read ${show(data)}, expected ${show(want['data'])}');
  }
}

/// A vector's JSON as the data model: typed mappings and lists, null refused. Vector JSON is
/// read with nulls allowed, so its containers are not the `Map<String, Object>` the library
/// reads.
Object valueOf(Json value) {
  if (value is Map<String, Object?>) {
    return <String, Object>{
      for (final entry in value.entries) entry.key: valueOf(entry.value),
    };
  }
  if (value is List<Object?>) {
    return <Object>[for (final item in value) valueOf(item)];
  }
  if (value == null) throw StateError('a null is not a value');
  return value;
}

/// [value] as a document of the data model.
Document documentOf(Json value) => valueOf(value) as Document;

/// A vector value with typed containers (`Document`, `List<Object>`), so the library's type
/// tests accept it; a null is an error.
Object typed(Json value) {
  if (value is Map<String, Object?>) {
    return <String, Object>{
      for (final entry in value.entries) entry.key: typed(entry.value),
    };
  }
  if (value is List<Object?>) {
    return <Object>[for (final item in value) typed(item)];
  }
  if (value == null) throw StateError('a null is not a value');
  return value;
}
