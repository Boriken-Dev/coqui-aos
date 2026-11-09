import 'package:coqui_aos/coqui_aos.dart';

import 'support/support.dart';

void main() {
  runFile('names.json', (item) {
    final name = str(item['name']);
    final expect = obj(item['expect']);
    final valid = validOverlayName(name);
    if (expect['valid'] != valid) throw StateError('valid $valid');
    if (valid &&
        (expect['normalized'] != normalizeName(name) ||
            expect['variable'] != rootVariable(name))) {
      throw StateError('${normalizeName(name)} ${rootVariable(name)}');
    }
  });

  runFile('source.json', (item) {
    final expect = obj(item['expect']);
    final hasError = expect.containsKey('error');
    Source source;
    try {
      source = Source.parse(str(item['source']));
    } on AosError {
      if (hasError) return;
      rethrow;
    }
    if (hasError) throw StateError('parsed ${source.shown()}');
    final got = <String, Object?>{
      'kind': source.kind,
      'location': source.location,
      'ref': source.reference,
      'path': source.path,
    };
    if (!valuesEqual(got, expect)) {
      throw StateError('${show(got)} expected ${show(expect)}');
    }
  });
}
