import 'dart:typed_data';

import 'package:coqui_aos/coqui_aos.dart';

import 'support/env_support.dart';
import 'support/support.dart';

HookRun hookRunOf(Case value) {
  final Uint8List stdout;
  final encoded = value['stdout_base64'];
  final parts = value['stdout_parts'];
  if (encoded is String) {
    stdout = decode64(encoded);
  } else if (parts is List<Object?>) {
    stdout = partsBytes(parts);
  } else {
    stdout = utf8Bytes(value['stdout'] is String ? str(value['stdout']) : '');
  }
  int number(String key) {
    final found = value[key];
    return found is BigInt ? found.toInt() : 0;
  }

  return hookRun(value['source'] is String ? str(value['source']) : '', stdout)
    ..onFailure = value['on_failure'] == 'refuse' ? 'refuse' : 'report'
    ..seconds = number('seconds')
    ..notRun = value['not_run'] == true
    ..payloadSize = number('payload_size')
    ..timedOut = value['timed_out'] == true
    ..exit = number('exit')
    ..sets = strings(value['sets']);
}

Case objectOrEmpty(Json value) => value is Map<String, Object?> ? value : {};

List<Object?> pairsOf(List<(String, String)> items) => [
  for (final (a, b) in items) [a, b],
];

void run(Case item) {
  final overlays = <String, Document>{
    for (final entry in obj(item['overlays']).entries)
      entry.key: documentOf(entry.value),
  };
  final requested = strings(item['requested']);
  final trees = <String, OverlayTree>{
    for (final entry in objectOrEmpty(item['files']).entries)
      entry.key: treeOf(entry.value),
  };
  final expect = item['expect'];
  void check(Json got) {
    if (!valuesEqual(got, expect)) {
      throw StateError('${show(got)}\nexpected ${show(expect)}');
    }
  }

  Composition composition;
  try {
    composition = compose(overlays, requested, trees);
  } on Cycle catch (error) {
    check({
      'error': 'cycle',
      'chain': [...error.chain],
    });
    return;
  }
  final facts = item['facts'];
  if (facts is! Map<String, Object?>) {
    check({
      'install_order': [...composition.installOrder],
      'active': [...composition.active],
      'missing': pairsOf(composition.missing),
      'root_variables': {...composition.rootVariables},
      'routing': [...composition.routing],
      'rules': pairsOf(composition.rules),
      'context': pairsOf(composition.context),
      'skills': {...composition.skills},
      'skill_collisions': [...composition.skillCollisions],
    });
    return;
  }
  final os = str(facts['os']);
  final got = <String, Object?>{};
  Environments installed;
  try {
    installed = environments(
      overlays,
      composition.active,
      trees,
      os,
      strings(facts['removed']),
    );
  } on AosError catch (error) {
    got['active'] = [...composition.active];
    got['env'] = {'error': error.errorClass, 'subject': error.subject};
    check(got);
    return;
  }
  final active = [
    for (final identity in composition.active)
      if (!installed.blocked.contains(identity)) identity,
  ];
  got['active'] = active;
  void wanted(String key, Object? value) {
    if (obj(expect).containsKey(key)) got[key] = value;
  }

  wanted('environments', [
    for (final e in installed.environments)
      {
        'runtime': e.runtime,
        'environment': e.environment,
        'overlays': [...e.overlays],
        'files': pairsOf(e.files),
        'locked': e.locked,
      },
  ]);
  wanted('conflicts', [
    for (final c in installed.conflicts)
      {
        'runtime': c.runtime,
        'environment': c.environment,
        'package': c.package,
        'overlays': [...c.overlays],
      },
  ]);
  wanted('blocked', [...installed.blocked]);
  wanted('left', [
    for (final l in installed.left)
      {
        'overlay': l.overlay,
        'runtime': l.runtime,
        'environment': l.environment,
        'then': l.then,
      },
  ]);
  // Packages are given per overlay: each overlay's own go in with its facts.
  final shared = factsOf(facts);
  final roots = obj(facts['roots']);
  final packages = objectOrEmpty(facts['packages']);
  final per = <(Document, Facts)>[
    for (final identity in active)
      (
        overlays[identity]!,
        shared.copyWith(
          identity: identity,
          root: str(roots[identity]),
          tree: trees[identity] ?? OverlayTree.empty(),
          packages: stringMap(packages[identity]),
        ),
      ),
  ];
  final base = Environment([
    for (final e in stringMap(facts['base_env']).entries) (e.key, e.value),
  ], os == 'windows');
  final preEnv = <String, HookRun>{
    for (final entry in objectOrEmpty(facts['pre_env']).entries)
      entry.key: hookRunOf(obj(entry.value)),
  };
  final composed = composedEnvironment(per, base, preEnv, []);
  final composedEnv = composed.env;
  got['env'] = composedEnv != null
      ? envData(composedEnv)
      : {
          'error': composed.error!.errorClass,
          'subject': composed.error!.subject,
        };
  if (facts.containsKey('pre_env')) {
    got['hook_reports'] = [
      for (final report in composed.hookReports) [report.id, ...report.about],
    ];
    got['hook_non_defaults'] = pairsOf(composed.hookNonDefaults);
  }
  check(got);
}

void main() {
  runFile('compose.json', run);
}
