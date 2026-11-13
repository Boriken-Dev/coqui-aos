import 'package:coqui_aos/coqui_aos.dart';

import 'support/env_support.dart';
import 'support/support.dart';

Map<String, Object?> script(ScriptRun s) => {
  'interpreter': s.interpreter,
  'path': s.path,
  'args': [...s.args],
  'timeout': BigInt.from(s.timeout),
};

void run(Case item) {
  final manifest = documentOf(item['manifest']);
  final raw = obj(item['facts']);
  final facts = factsOf(raw)..tree = treeOf(raw['files']);
  final expect = item['expect'];
  Object? got;
  try {
    final result = effective(manifest, facts);
    final setup = result.setup;
    final body = <String, Object?>{
      'ungranted': [...result.ungranted],
      'supported': result.supported,
      'env': envData(result.env),
      'env_scripts': [for (final s in result.envScripts) script(s)],
      'setup': setup == null
          ? null
          : {...script(setup), 'network': setup.network},
      'python': result.python,
      'node': result.node,
      'dependencies': [
        for (final d in result.dependencies)
          {
            'runtime': d.runtime,
            'file': d.file,
            'lock': d.lock,
            'environment': d.environment,
          },
      ],
      'needs': {
        'interpreters': [...result.needs.interpreters],
        'commands': [...result.needs.commands],
      },
      'non_defaults': [
        for (final w in result.nonDefaults) [w.id, w.subject],
      ],
      if (result.reports.isNotEmpty)
        'reports': [
          for (final (id, subject) in result.reports) [id, subject],
        ],
    };
    final change = raw['change'];
    if (change is String) {
      final record = raw['record'];
      final recorded = record is Map<String, Object?>
          ? SetupRecord(
              digest: str(record['digest']),
              phase: str(record['phase']),
            )
          : null;
      final digest = raw['digest'];
      final fails = raw['fails'];
      final prepared = preparation(
        change,
        recorded,
        digest is String ? digest : null,
        result.setup,
        result.dependencies,
        fails is String ? failStep.named(fails) : null,
      );
      final record2 = prepared.record;
      body['setup_phase'] = prepared.phase;
      body['setup_arguments'] = prepared.arguments == null
          ? null
          : [...prepared.arguments!];
      body['steps'] = [...prepared.steps];
      body['record'] = record2 == null
          ? null
          : {'digest': record2.digest, 'phase': record2.phase};
      body['activates'] = prepared.activates;
    }
    got = body;
  } on AosError catch (error) {
    got = {'error': error.errorClass, 'subject': error.subject};
  }
  if (!valuesEqual(got, expect)) {
    throw StateError('${show(got)}\nexpected ${show(expect)}');
  }
}

void main() {
  runFile('effective.json', run);
}
