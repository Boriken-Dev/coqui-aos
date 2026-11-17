import 'dart:typed_data';

import 'package:coqui_aos/src/catalog.dart';
import 'package:coqui_aos/src/error.dart';
import 'package:coqui_aos/src/limits.dart';
import 'package:coqui_aos/src/value.dart';
import 'package:test/test.dart';

import 'support/g2_support.dart';
import 'support/support.dart';

Map<String, Json> entryJson(CatalogEntry entry) {
  final out = <String, Json>{'source': sourceJson(entry.source)};
  if (entry.pin != null) out['pin'] = entry.pin;
  if (entry.description != null) out['description'] = entry.description;
  if (entry.about != null) out['about'] = entry.about;
  return out;
}

Map<String, Json> extensionJson(ExtensionEntry entry) {
  final out = <String, Json>{
    'source': sourceJson(entry.source),
    'provider': entry.provider,
  };
  if (entry.pin != null) out['pin'] = entry.pin;
  if (entry.sha256 != null) out['sha256'] = entry.sha256;
  if (entry.load != null) out['load'] = entry.load;
  final needs = entry.needs;
  if (needs.kind != null || needs.version != null || needs.platforms != null) {
    out['needs'] = {
      if (needs.kind != null) 'kind': needs.kind,
      if (needs.version != null) 'version': needs.version,
      if (needs.platforms != null) 'platforms': needs.platforms,
    };
  }
  if (entry.description != null) out['description'] = entry.description;
  if (entry.about != null) out['about'] = entry.about;
  return out;
}

Map<String, Json> extensionsJson(ExtensionSection section) => {
  'entries': {
    for (final e in section.entries.entries) e.key: extensionJson(e.value),
  },
  'refused': [
    for (final (name, why) in section.refused) [name, why],
  ],
};

void fitsCase(Case item) {
  final fits = obj(item['fits']);
  final given = fits['needs'];
  final needs = given is Map<String, Object?>
      ? ExtensionNeeds(
          kind: obj(given)['kind'] as String?,
          version: obj(given)['version'] as String?,
          platforms: obj(given)['platforms'] == null
              ? null
              : [for (final item in arr(obj(given)['platforms'])) str(item)],
        )
      : const ExtensionNeeds();
  final kinds = <String, List<String>>{
    for (final entry in obj(fits['offers']).entries)
      entry.key: [for (final version in arr(entry.value)) str(version)],
  };
  final platform = obj(fits['platform']);
  final reason = needs.unfit(kinds, str(platform['os']), str(platform['arch']));
  same(
    reason == null ? {'fits': true} : {'fits': false, 'reason': reason},
    obj(item['expect']),
  );
}

Map<String, Json> sectionJson(CatalogSection section) => {
  'entries': {
    for (final e in section.entries.entries) e.key: entryJson(e.value),
  },
  'refused': [
    for (final (name, why) in section.refused) [name, why],
  ],
};

Map<String, Json> catalogJson(Catalog catalog) {
  final out = <String, Json>{'form': catalog.form};
  for (final (key, value) in [
    ('name', catalog.name),
    ('description', catalog.description),
    ('homepage', catalog.homepage),
  ]) {
    if (value != null) out[key] = value;
  }
  final overlays = sectionJson(catalog.overlays);
  out['entries'] = overlays['entries'];
  out['refused'] = overlays['refused'];
  final skills = catalog.skills;
  if (skills != null) out['skills'] = sectionJson(skills);
  final extensions = catalog.extensions;
  if (extensions != null) out['extensions'] = extensionsJson(extensions);
  out['ignored'] = catalog.ignored;
  return out;
}

Catalog readItem(Case item, Settings settings) {
  final base = item['base'];
  return readCatalog(
    utf8Bytes(str(item['text'])),
    str(item['name']),
    base is String ? base : null,
    settings,
  );
}

void same(Json got, Json expectation) {
  if (!valuesEqual(got, expectation)) throw StateError('got ${show(got)}');
}

void catalogsCase(Case item) {
  final settings = Settings();
  final read = [
    for (final entry in arr(item['catalogs']))
      (str(obj(entry)['label']), readItem(obj(entry), settings)),
  ];
  final expectation = obj(item['expect']);
  Listing listing;
  try {
    listing = listCatalogs(read);
  } on AosError catch (error) {
    if (expectation['error'] == error.errorClass) return;
    rethrow;
  }
  final got = <String, Json>{
    'entries': [
      for (final entry in listing.entries)
        {
          'catalog': entry.catalog,
          'name': entry.name,
          'identity': entry.identity,
          'shown': entry.shown,
        },
    ],
    'collisions': listing.collisions,
  };
  final choose = item['choose'];
  if (choose is List<Object?> && choose.isNotEmpty) {
    final chosen = <String, Json>{};
    for (final request in choose) {
      try {
        final entry = chooseListed(listing, str(request));
        chosen[str(request)] = {'catalog': entry.catalog, 'name': entry.name};
      } on AosError catch (error) {
        chosen[str(request)] = {'error': error.errorClass};
      }
    }
    got['chosen'] = chosen;
  }
  same(got, expectation);
}

void iconCase(Case item) {
  final icon = obj(item['icon']);
  final limits = icon['limits'] is Map<String, Object?>
      ? obj(icon['limits'])
      : <String, Json>{};
  final changes = <String, Limit>{};
  final bytes = num_(limits['max_bytes']);
  if (bytes != null) changes['iconBytes'] = bytes;
  final width = num_(limits['max_width']);
  if (width != null) changes['iconWidth'] = width;
  final height = num_(limits['max_height']);
  if (height != null) changes['iconHeight'] = height;
  final expectation = obj(item['expect']);
  Icon read;
  try {
    read = readIcon(bytesOf(icon), str(icon['name']), Settings(changes));
  } on AosError catch (error) {
    if (expectation['error'] == error.errorClass) return;
    rethrow;
  }
  same({
    'format': read.format,
    'width': BigInt.from(read.width),
    'height': BigInt.from(read.height),
  }, expectation);
}

Matcher refusesWith(String errorClass) => throwsA(
  isA<AosError>().having((e) => e.errorClass, 'errorClass', errorClass),
);

void main() {
  runFile('catalog.json', (item) {
    if (item.containsKey('icon')) return iconCase(item);
    if (item.containsKey('catalogs')) return catalogsCase(item);
    if (item.containsKey('fits')) return fitsCase(item);
    final expectation = obj(item['expect']);
    Catalog catalog;
    try {
      catalog = readItem(obj(item['catalog']), Settings());
    } on AosError catch (error) {
      if (expectation['error'] == error.errorClass) return;
      rethrow;
    }
    same(catalogJson(catalog), expectation);
  });

  test('a catalog past catalog_bytes is too-large', () {
    final data = utf8Bytes('[overlays]\na = "../a"\n');
    expect(
      () => readCatalog(data, 'c.toml', null, Settings({'catalogBytes': 4})),
      refusesWith('too-large'),
    );
  });

  test('a skills table alone makes a catalog; neither table does not', () {
    final skills = readCatalog(
      utf8Bytes('[skills]\nreview = "https://example.org/r.git#review"\n'),
      'c.toml',
      null,
      Settings(),
    );
    expect(skills.skills?.entries.length, 1);
    expect(skills.overlays.entries.length, 0);
    expect(
      () => readCatalog(utf8Bytes('name = "x"\n'), 'c.toml', null, Settings()),
      refusesWith('not-a-catalog'),
    );
  });

  test(
    'an extension is pinned by its tree digest or its file sha256, never neither',
    () {
      final pin = 'sha256:${'ab' * 32}';
      final sha = 'cd' * 32;
      final catalog = readCatalog(
        utf8Bytes('''
[extensions.tree]
source = "../ext"
pin = "$pin"
load = "lib/x.dll"
provider = "p"

[extensions.file]
source = "https://example.org/x.so"
sha256 = "$sha"
provider = "q"

[extensions.none]
source = "../a"
provider = "p"

[extensions.crossed]
source = "https://example.org/x.so"
pin = "$pin"
provider = "p"

[extensions.short]
source = "https://example.org/x.so"
sha256 = "abcd"
provider = "p"

[extensions.twice]
source = "../a"
pin = "$pin"
provider = "p"
needs = { platforms = ["linux", "linux"] }
'''),
        'c.toml',
        '/srv/catalogs/c.toml',
        Settings(),
      );
      expect(catalog.form, 'full');
      final extensions = catalog.extensions!;
      expect(extensions.entries.keys.toList(), ['file', 'tree']);
      expect(extensions.entries['tree']!.pin, pin);
      expect(extensions.entries['tree']!.sha256, isNull);
      expect(extensions.entries['tree']!.load, 'lib/x.dll');
      expect(extensions.entries['file']!.sha256, sha);
      expect(extensions.refused, [
        ('crossed', 'invalid-entry'),
        ('none', 'unpinned'),
        ('short', 'invalid-pin'),
        ('twice', 'invalid-entry'),
      ]);
    },
  );

  test('an extension fits by kind, then version, then platform', () {
    const kinds = {
      'store_extension': ['1', '2'],
    };
    String? unfit(ExtensionNeeds needs) =>
        needs.unfit(kinds, 'windows', 'x86_64');
    expect(unfit(const ExtensionNeeds()), isNull);
    expect(
      unfit(
        const ExtensionNeeds(
          kind: 'store_extension',
          version: '2',
          platforms: ['windows'],
        ),
      ),
      isNull,
    );
    expect(unfit(const ExtensionNeeds(kind: 'other')), 'kind');
    expect(
      unfit(const ExtensionNeeds(kind: 'store_extension', version: '3')),
      'version',
    );
    expect(
      unfit(const ExtensionNeeds(platforms: ['windows-aarch64', 'linux'])),
      'platform',
    );
    expect(unfit(const ExtensionNeeds(platforms: ['windows-x86_64'])), isNull);
  });

  test("an icon's size is read from the header and held to the limits", () {
    final png = Uint8List(33)
      ..setAll(0, [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, //
        0x49, 0x48, 0x44, 0x52, 0, 0, 0, 9, 0, 0, 0, 4,
      ]);
    final icon = readIcon(png, 'a.png', Settings());
    expect((icon.format, icon.width, icon.height), ('png', 9, 4));
    expect(
      () => readIcon(png, 'a.png', Settings({'iconWidth': 8})),
      refusesWith('icon-dimensions'),
    );
    expect(
      () => readIcon(png, 'a.webp', Settings()),
      refusesWith('icon-mismatch'),
    );
  });
}
