import 'package:web/web.dart';

/// The text of one of the specification's vector files, staged under `test/vectors/` by
/// `dart run tool/stage_vectors.dart` before a browser run.
String readVector(String name) {
  final request = XMLHttpRequest()
    ..open('GET', Uri.base.resolve('vectors/$name').toString(), false)
    ..send();
  if (request.status != 200) {
    throw StateError('vector $name: HTTP ${request.status}');
  }
  return request.responseText;
}
