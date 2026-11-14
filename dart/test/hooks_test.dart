import 'dart:convert';

import 'package:coqui_aos/src/apply.dart';
import 'package:coqui_aos/src/compose.dart';
import 'package:coqui_aos/src/environment.dart';
import 'package:coqui_aos/src/hooks.dart';
import 'package:coqui_aos/src/limits.dart';
import 'package:coqui_aos/src/overlay.dart';
import 'package:coqui_aos/src/tree.dart';
import 'package:coqui_aos/src/validate.dart';
import 'package:coqui_aos/src/value.dart';
import 'package:test/test.dart';

import 'support/env_support.dart' show envData, factsOf, stringMap;
import 'support/g2_support.dart';
import 'support/records.dart';
import 'support/support.dart';

String eventOf(Case item) {
  final name = str(item['event']);
  expect(hookEvent.contains(name), isTrue, reason: 'an event: $name');
  return name;
}

Settings settingsFrom(Json limits) {
  if (limits is! Map<String, Object?>) return Settings();
  final changes = <String, Limit>{};
  for (final (key, field) in const [
    ('timeout', 'hookTimeout'),
    ('event_timeout', 'hookEventTimeout'),
    ('max_output', 'hookOutputBytes'),
    ('max_payload', 'hookPayloadBytes'),
    ('context_bytes', 'contextBytes'),
  ]) {
    final value = num_(limits[key]);
    if (value != null) changes[field] = value;
  }
  return Settings(changes);
}

Json hookJson(Hook hook) => toJson({
  'event': hook.event,
  'path': hook.path,
  'interpreter': hook.interpreter,
  'runs': hook.runs,
  'match': hook.select,
  'sets': hook.sets,
  'timeout': hook.timeout,
  'on_failure': hook.onFailure,
  'payload': hook.payload,
});

void same(Json got, Json expectation) {
  if (!valuesEqual(got, expectation)) throw StateError('got ${show(got)}');
}

List<String>? eventList(Case facts, String key) {
  final list = facts[key];
  if (list == null) return null;
  return strings(list).map((name) {
    expect(hookEvent.contains(name), isTrue);
    return name;
  }).toList();
}

void planCase(Case item) {
  final facts = obj(item['facts']);
  final tree = treeOf(facts['files']);
  final settings = settingsFrom(facts['limits']);
  final given = item['manifest'];
  final Document manifest = given is Map<String, Object?>
      ? fromPlain(given) as Document
      : readOverlay(tree, Settings()).manifest;
  final scope = facts['scope'];
  final files = facts['tree'];
  final interpreters = facts['interpreters'];
  final known = hookFacts(
    str(facts['os']),
    facts['identity'] is String ? str(facts['identity']) : '',
    interpreters: interpreters == null ? null : strings(interpreters),
    scope: scope == 'user' || scope == 'project' ? scope as String : 'overlay',
    digest: facts['digest'] is String ? str(facts['digest']) : null,
    allowed: facts['allowed'] is String ? str(facts['allowed']) : null,
    tree: files is Map<String, Object?>
        ? [for (final e in files.entries) (e.key, utf8Bytes(str(e.value)))]
        : null,
    fires: eventList(facts, 'fires'),
    partial: eventList(facts, 'partial') ?? [],
    timeout: num_(obj(facts['limits'] ?? <String, Object?>{})['timeout']),
  );
  final plan = hookPlan(manifest, tree, known, settings);
  final got = <String, Json>{
    'hooks': plan.hooks.map(hookJson).toList(),
    'on': plan.on,
    'activates': plan.activates,
    'needs': plan.needs,
    'reports': plan.reports.map(withRecords).toList(),
    'non_defaults': plan.nonDefaults.map(withRecords).toList(),
  };
  final expectation = obj(item['expect']);
  if (expectation.containsKey('issues')) {
    got['issues'] = validate(manifest, tree).map((issue) => issue.at).toList();
  }
  same(got, expectation);
}

Json envJson(List<(String, String?)> env) => {
  for (final (name, value) in env) name: value,
};

void outputCase(Case item) {
  final expectation = obj(item['expect']);
  HookOutput output;
  try {
    output = hookResult(
      eventOf(item),
      hookRunOf(item['run']),
      settingsFrom(item['limits']),
    );
  } on HookFailed catch (error) {
    if (expectation['failed'] == error.failure) return;
    rethrow;
  }
  final got = <String, Json>{};
  if (output.decision != null) got['decision'] = output.decision;
  if (output.reason != null) got['reason'] = output.reason;
  if (output.context != null) got['context'] = output.context;
  if (output.input != null) got['input'] = output.input;
  if (output.env != null) got['env'] = envJson(output.env!);
  same({'output': got}, expectation);
}

void eventCase(Case item) {
  final runs = arr(item['runs']).map(hookRunOf).toList();
  final applies = item['applies'];
  final fired = fireEvent(
    eventOf(item),
    runs,
    applies == null ? null : strings(applies),
    settingsFrom(item['limits']),
    item['os'] == 'windows',
    num_(item['context_used']) ?? 0,
    item['input'],
    item['kind'] as String?,
  );
  same({
    'ran': fired.ran,
    'decision': fired.decision,
    'by': fired.by,
    'reason': fired.reason,
    'context': fired.context.map(withRecords).toList(),
    'env': envJson(fired.env),
    'reports': [
      for (final report in fired.reports) [report.id, ...report.about],
    ],
    'non_defaults': fired.nonDefaults.map(withRecords).toList(),
    if (fired.seen != null) ...{
      'seen': [
        for (final (source, input) in fired.seen!) [source, input],
      ],
      'input': fired.input,
    },
  }, item['expect']);
}

void orderCase(Case item) {
  final overlays = <String, Document>{
    for (final entry in obj(item['overlays']).entries)
      entry.key: documentOf(entry.value),
  };
  final order = hookOrder(
    overlays,
    strings(item['requested']),
    strings(item['has']),
    strings(item['scopes']),
  );
  same({
    'order': [
      for (final (scope, source) in order) [scope, source],
    ],
  }, item['expect']);
}

void environmentCase(Case item) {
  final raw = obj(item['facts']);
  final overlays = <String, Document>{
    for (final entry in obj(item['overlays']).entries)
      entry.key: documentOf(entry.value),
  };
  final names = compositionOrder(
    overlays,
    resolve(overlays, strings(item['requested'])).installOrder,
  );
  final shared = factsOf(raw);
  final roots = obj(raw['roots']);
  final states = item['facts'] is Map<String, Object?> ? raw['states'] : null;
  final files = item['files'];
  final active = <(Document, Facts)>[
    for (final name in names)
      (
        overlays[name]!,
        shared.copyWith(
          identity: name,
          root: str(roots[name]),
          state: states is Map<String, Object?> && states[name] is String
              ? str(states[name])
              : null,
          tree: files is Map<String, Object?> && files[name] != null
              ? treeOf(files[name])
              : OverlayTree.empty(),
        ),
      ),
  ];
  final preEnv = <String, HookRun>{
    for (final entry in obj(raw['pre_env'] ?? <String, Object?>{}).entries)
      entry.key: hookRunOf(obj(entry.value)),
  };
  final base = Environment([
    for (final e in stringMap(raw['base_env']).entries) (e.key, e.value),
  ], raw['os'] == 'windows');
  final scope = item['scope'];
  final identity = scope == 'user' || scope == 'project'
      ? null
      : str(item['identity']);
  final process = item['process'];
  final earlier = <EnvSet>[
    for (final set in arr(raw['earlier'] ?? <Object?>[]))
      [for (final e in obj(set).entries) (e.key, e.value as String?)],
  ];
  final env = process == null
      ? hookEnvironment(eventOf(item), active, base, preEnv, identity, earlier)
      : processEnvironment(str(process), active, base, preEnv, identity!);
  same({'env': envData(env)}, item['expect']);
}

void main() {
  runFile('hooks.json', (item) {
    final id = str(item['id']);
    if (id.startsWith('plan-')) return planCase(item);
    if (id.startsWith('payload-')) {
      return same(
        hookPayload(eventOf(item), fromPlain(obj(item['known'])) as Document),
        item['expect'],
      );
    }
    if (id.startsWith('output-')) return outputCase(item);
    if (id.startsWith('event-')) return eventCase(item);
    if (id.startsWith('order-')) return orderCase(item);
    if (id.startsWith('environment-') || id.startsWith('process-')) {
      return environmentCase(item);
    }
    final select = item['match'];
    final got = hookMatches(
      eventOf(item),
      select is List<Object?> ? strings(select) : null,
      str(item['value']),
    );
    same(toJson({'runs': got}), item['expect']);
  });

  final secretRun = <String, Json>{
    'stdout': '{"context":"a secret context","env":{"TOKEN":"hunter2"}}',
    'sets': ['TOKEN'],
    'source': 'h',
  };

  test("a run's and an output's forms hide the text they carry", () {
    final run = hookRun('hook.py', utf8Bytes('a secret context'));
    expect(jsonEncode(run).contains('secret'), isFalse);
    expect(run.toString().contains('secret'), isFalse);
    run.sets = ['TOKEN'];
    final output = hookResult(
      'session-start',
      hookRunOf(secretRun),
      Settings(),
    );
    for (final text in [jsonEncode(output), output.toString()]) {
      expect(text.contains('hunter2'), isFalse);
      expect(text.contains('secret'), isFalse);
    }
    final fired = fireEvent(
      'session-start',
      [hookRunOf(secretRun)],
      null,
      Settings(),
      false,
    );
    expect(fired.context.length, 1);
    for (final text in [jsonEncode(fired), fired.toString()]) {
      expect(text.contains('hunter2'), isFalse);
      expect(text.contains('secret'), isFalse);
    }
  });

  test('an output reason longer than hook_reason_chars is refused, counting '
      'characters', () {
    HookRun run(String reason) => hookRunOf({
      'stdout': jsonEncode({'decision': 'block', 'reason': reason}),
    });
    const faces = '\u{1F600}\u{1F600}';
    expect(
      hookResult('prompt', run(faces), Settings({'hookReasonChars': 2})).reason,
      faces,
    );
    expect(
      () => hookResult('prompt', run('abc'), Settings({'hookReasonChars': 2})),
      throwsA(isA<HookFailed>().having((e) => e.failure, 'failure', 'output')),
    );
  });

  test("a plan's hook timeout is held to the consumer's bound", () {
    final tree = treeOf(['hook.py']);
    final manifest = <String, Object>{
      'hooks': <String, Object>{
        'cd': <String, Object>{'timeout': BigInt.from(500)},
      },
    };
    int timeout(HookPlan plan) =>
        plan.hooks.where((hook) => hook.event == 'cd').first.timeout;
    final facts = hookFacts('linux', 'a', scope: 'user');
    expect(timeout(hookPlan(manifest, tree, facts, Settings())), 60);
    expect(
      timeout(hookPlan(manifest, tree, facts, Settings({'hookTimeout': null}))),
      500,
    );
  });

  test('an allow carries a rewritten input and nothing else does', () {
    HookOutput read(String stdout, [String event = 'pre-tool']) => hookResult(
      event,
      hookRunOf(<String, Json>{'stdout': stdout}),
      Settings(),
    );
    final allowed = read('{"decision": "allow", "input": {"command": "true"}}');
    expect(allowed.decision, 'allow');
    expect(allowed.input, {'command': 'true'});
    for (final bad in [
      '{"decision": "ask", "input": {}}',
      '{"input": {}}',
      '{"decision": "allow", "input": []}',
      '{"decision": "approve"}',
    ]) {
      expect(
        () => read(bad),
        throwsA(
          isA<HookFailed>().having((e) => e.failure, 'failure', 'output'),
        ),
      );
    }
    expect(
      () => read('{"decision": "allow"}', 'prompt'),
      throwsA(isA<HookFailed>().having((e) => e.failure, 'failure', 'output')),
    );
  });
}
