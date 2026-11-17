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
