import 'g2_support.dart';
import 'support.dart';

/// [toJson], with the records of strings the hook and skill plans hold written as lists.
Json withRecords(Object? plain) {
  if (plain is (String, String)) return [plain.$1, plain.$2];
  if (plain is (String, String, String)) return [plain.$1, plain.$2, plain.$3];
  if (plain is (String, String, List<String>)) {
    return [plain.$1, plain.$2, toJson(plain.$3)];
  }
  if (plain is List) return [for (final item in plain) withRecords(item)];
  if (plain is Map) {
    return {
      for (final entry in plain.entries)
        entry.key as String: withRecords(entry.value),
    };
  }
  return toJson(plain);
}
