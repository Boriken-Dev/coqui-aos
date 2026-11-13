/// Shapes the compose, effective and dotenv vectors read and write.
library;

import 'package:coqui_aos/coqui_aos.dart';

import 'support.dart';

/// The text entries of a mapping; anything else is left out.
Map<String, String> stringMap(Json value) => {
  if (value is Map<String, Object?>)
    for (final entry in value.entries)
      if (entry.value is String) entry.key: entry.value as String,
};

/// The consumer's facts a case writes.
Facts factsOf(Case raw) {
  String? text(String key) {
    final value = raw[key];
    return value is String ? value : null;
  }

  final facts = Facts(text('os') ?? '')
    ..root = text('root') ?? ''
    ..identity = text('identity') ?? ''
    ..state = text('state')
    ..pinned = raw['pinned'] == true
    ..baseEnv = stringMap(raw['base_env'])
    ..hostEnv = stringMap(raw['host_env']);
  final grants = raw['grants'];
  if (grants is Map<String, Object?>) {
    for (final entry in grants.entries) {
      facts.grants[entry.key] = strings(entry.value);
    }
  }
  facts.secrets = stringMap(raw['secrets']);
  final files = raw['secret_files'];
  facts.secretFiles = files is Map<String, Object?> ? stringMap(files) : null;
  final providers = raw['providers'];
  facts.providers = providers is List<Object?> ? strings(providers) : null;
  final values = raw['provider_values'];
  if (values is Map<String, Object?>) {
    for (final entry in values.entries) {
      facts.providerValues[entry.key] = stringMap(entry.value);
    }
  }
  final network = raw['enforces_network'];
  facts.enforcesNetwork = network is bool ? network : null;
  final scripts = raw['env_scripts_enabled'];
  facts.envScriptsEnabled = scripts is bool ? scripts : null;
  facts.gateEnvScripts = raw.containsKey('allowed');
  facts.digest = text('digest');
  facts.allowed = text('allowed');
  final interpreters = raw['interpreters'];
  facts.interpreters = interpreters is List<Object?>
      ? strings(interpreters)
      : null;
  facts.packages = stringMap(raw['packages']);
  return facts;
}

/// A tree from a case's `files`: a list of paths, or a mapping of path to text.
OverlayTree treeOf(Json files) {
  if (files is List<Object?>) return OverlayTree.fromPaths(files.map(str));
  if (files is Map<String, Object?>) {
    return OverlayTree.fromTexts([
      for (final entry in files.entries) (entry.key, str(entry.value)),
    ]);
  }
  return OverlayTree.empty();
}

/// An environment's variables as a mapping.
Map<String, Object?> envData(Environment env) => {
  for (final (name, value) in env.values()) name: value,
};
