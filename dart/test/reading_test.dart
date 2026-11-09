import 'package:coqui_aos/coqui_aos.dart';

import 'support/env_support.dart';
import 'support/support.dart';

void main() {
  runFile('reading.json', (item) {
    final data = bytesOf(item);
    final settings = settingsOf(item);
    final format = str(item['format']);
    if (format == 'aos') {
      compare(() => readDocument(data, settings), item['expect']);
    } else if (format == 'env-script') {
      compare(
        () => {
          for (final (name, value) in readEnvScriptOutput(data, settings))
            name: value,
        },
        item['expect'],
      );
    } else if (format == 'dotenv') {
      final env = Environment(
        stringMap(item['env']).entries.map((e) => (e.key, e.value)),
        item['os'] == 'windows',
      );
      for (final name in strings(item['secret_variables'])) {
        env.set(name, env.get(name) ?? '', true);
      }
      compare(
        () => {for (final (name, value) in readDotenv(data, env)) name: value},
        item['expect'],
      );
    } else if (format == 'catalog') {
      compare(
        () => readCatalogDocument(data, str(item['name']), settings),
        item['expect'],
      );
    } else {
      throw StateError('format $format');
    }
  });
}
