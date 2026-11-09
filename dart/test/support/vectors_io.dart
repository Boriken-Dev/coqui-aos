import 'dart:io';

/// The text of one of the specification's vector files, `../vectors/<name>` from the package.
String readVector(String name) {
  final dir = Platform.environment['AOS_VECTORS'] ?? '../vectors';
  return File('$dir/$name').readAsStringSync();
}
