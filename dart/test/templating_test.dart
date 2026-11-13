import 'package:coqui_aos/coqui_aos.dart';
import 'package:test/test.dart';

import 'support/support.dart';

TemplateFacts factsOf(Case item) {
  final facts = obj(item['facts']);
  final options = facts['options'];
  return TemplateFacts(
    root: facts['root'] as String?,
    state: facts['state'] as String?,
    name: facts['name'] as String?,
    scope: facts['scope'] as String?,
    project: facts['project'] as String?,
    options: options == null ? const {} : typed(options) as Map<String, Object>,
  );
}

Document manifestOf(Object? plain) =>
    plain == null ? <String, Object>{} : typed(plain) as Document;

final Document sample = {
  'options': {
    'depth': {'type': 'string', 'default': 'normal'},
    'token': {'type': 'string', 'sensitive': true},
  },
};

void main() {
  runFile('templating.json', (item) {
    final expect = obj(item['expect']);
    final data = bytesOf(item);
    final settings = Settings();
    try {
      final values = templateValues(
        manifestOf(item['manifest']),
        factsOf(item),
      );
      final got = item['kind'] == 'context'
          ? contextText(data, values, settings)
          : skillText(data, values, settings);
      if (expect['error'] != null) {
        throw StateError('got $got, expected ${expect['error']}');
      }
      if (got != expect['text']) {
        throw StateError('text ${show(got)}, expected ${show(expect['text'])}');
      }
    } on AosError catch (error) {
      if (error.errorClass != expect['error']) rethrow;
    }
  });

  test('a sensitive option stays as written with a configured value', () {
    final values = templateValues(
      sample,
      TemplateFacts(
        root: '/o/team',
        options: {'token': 's3cret', 'depth': 'deep'},
      ),
    );
    expect(values.containsKey('token'), isFalse);
    expect(
      template(r'${token} ${depth} ${AOS_OVERLAY_ROOT}', values),
      r'${token} deep /o/team',
    );
  });

  test('a wrong typed value is refused', () {
    expect(
      () => templateValues(
        sample,
        TemplateFacts(options: {'depth': BigInt.from(3)}),
      ),
      throwsA(
        isA<AosError>()
            .having((e) => e.errorClass, 'class', 'invalid-option')
            .having((e) => e.subject, 'subject', 'depth'),
      ),
    );
  });

  test('context drops front matter and a skill keeps it', () {
    final values = templateValues(
      sample,
      TemplateFacts(root: '/o/team', name: 'team'),
    );
    final file = encodeUtf8(
      '---\nk: \${AOS_OVERLAY_NAME}\n---\nroot \${AOS_OVERLAY_ROOT}\n',
    );
    expect(contextText(file, values, Settings()), 'root /o/team\n');
    expect(
      skillText(file, values, Settings()),
      '---\nk: \${AOS_OVERLAY_NAME}\n---\nroot /o/team\n',
    );
  });
}
