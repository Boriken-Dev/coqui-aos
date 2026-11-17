//! A catalog's `extensions` table: what the vectors do not pin down about the types.

use coqui_aos::{
    CatalogForm, EntryRefusal, ExtensionDigest, ExtensionNeeds, Settings, SourceKind, Unfit,
    read_catalog,
};

const PIN: &str = "sha256:abababababababababababababababababababababababababababababababab";
const SHA: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

fn read(text: &str, base: Option<&str>) -> coqui_aos::Catalog {
    read_catalog(text.as_bytes(), "catalog.toml", base, &Settings::default()).expect("a catalog")
}

#[test]
fn a_tree_is_pinned_by_its_digest_and_a_file_by_its_sha256() {
    let catalog = read(
        &format!(
            "[extensions.tree]\nsource = \"../ext\"\npin = \"{PIN}\"\nload = \"lib/x.dll\"\nprovider = \"p\"\n\n\
             [extensions.file]\nsource = \"https://example.org/x.so\"\nsha256 = \"{SHA}\"\nprovider = \"q\"\n"
        ),
        Some("/srv/catalogs/catalog.toml"),
    );
    assert_eq!(catalog.form, CatalogForm::Full);
    let extensions = catalog.extensions.expect("an extensions table");
    assert!(extensions.refused.is_empty());
    let tree = &extensions.entries["tree"];
    assert_eq!(tree.digest, ExtensionDigest::Tree(PIN.to_owned()));
    assert_eq!(tree.load.as_deref(), Some("lib/x.dll"));
    assert_eq!(tree.source.kind, SourceKind::Directory);
    let file = &extensions.entries["file"];
    assert_eq!(file.digest, ExtensionDigest::File(SHA.to_owned()));
    assert_eq!(file.source.kind, SourceKind::Url);
    assert_eq!(file.needs, ExtensionNeeds::default());
}

#[test]
fn an_entry_without_the_digest_its_source_takes_is_refused_alone() {
    let catalog = read(
        &format!(
            "[extensions.none]\nsource = \"../a\"\nprovider = \"p\"\n\n\
             [extensions.crossed]\nsource = \"https://example.org/x.so\"\npin = \"{PIN}\"\nprovider = \"p\"\n\n\
             [extensions.short]\nsource = \"https://example.org/x.so\"\nsha256 = \"abcd\"\nprovider = \"p\"\n\n\
             [extensions.ok]\nsource = \"../ok\"\npin = \"{PIN}\"\nprovider = \"p\"\n"
        ),
        None,
    );
    let extensions = catalog.extensions.expect("an extensions table");
    assert_eq!(
        extensions.refused,
        [
            ("crossed".to_owned(), EntryRefusal::InvalidEntry),
            ("none".to_owned(), EntryRefusal::Unpinned),
            ("short".to_owned(), EntryRefusal::InvalidPin),
        ]
    );
    assert_eq!(
        extensions.entries.keys().collect::<Vec<_>>(),
        ["ok"],
        "the rest of the catalog is listed"
    );
}

#[test]
fn a_platform_is_listed_once_and_a_version_needs_its_kind() {
    let catalog = read(
        &format!(
            "[extensions.twice]\nsource = \"../a\"\npin = \"{PIN}\"\nprovider = \"p\"\n\
             needs = {{ platforms = [\"linux\", \"linux\"] }}\n\n\
             [extensions.lonely]\nsource = \"../b\"\npin = \"{PIN}\"\nprovider = \"p\"\n\
             needs = {{ version = \"1\" }}\n\n\
             [extensions.long]\nsource = \"../c\"\npin = \"{PIN}\"\nprovider = \"p\"\n\
             needs = {{ kind = \"k\", version = \"{}\" }}\n",
            "1".repeat(65)
        ),
        None,
    );
    let extensions = catalog.extensions.expect("an extensions table");
    assert!(extensions.entries.is_empty());
    assert_eq!(extensions.refused.len(), 3);
    assert!(
        extensions
            .refused
            .iter()
            .all(|(_, why)| *why == EntryRefusal::InvalidEntry)
    );
}

#[test]
fn a_catalog_of_extensions_alone_is_a_catalog_and_an_empty_table_is_not_full() {
    let empty = read("[extensions]\n", None);
    assert_eq!(empty.form, CatalogForm::Minimal);
    assert!(empty.extensions.expect("a table").entries.is_empty());
    assert!(empty.overlays.entries.is_empty());
    let neither = read_catalog(
        b"extensions = [1]\n",
        "catalog.toml",
        None,
        &Settings::default(),
    );
    assert!(
        neither.is_err(),
        "a table that is not a table makes no catalog"
    );
}

#[allow(
    clippy::field_reassign_with_default,
    reason = "the struct is non-exhaustive, so a test outside the crate sets its fields one by one"
)]
fn needs(kind: Option<&str>, version: Option<&str>, platforms: Option<&[&str]>) -> ExtensionNeeds {
    let mut needs = ExtensionNeeds::default();
    needs.kind = kind.map(str::to_owned);
    needs.version = version.map(str::to_owned);
    needs.platforms = platforms.map(|list| list.iter().map(|p| (*p).to_owned()).collect());
    needs
}

#[test]
fn an_extension_fits_by_kind_then_version_then_platform() {
    let kinds: &[(&str, &[&str])] = &[("store_extension", &["1", "2"])];
    let fits = |needs: &ExtensionNeeds| needs.fits(kinds, "windows", "x86_64");
    assert_eq!(fits(&needs(None, None, None)), Ok(()));
    assert_eq!(
        fits(&needs(
            Some("store_extension"),
            Some("2"),
            Some(&["windows"])
        )),
        Ok(())
    );
    assert_eq!(
        fits(&needs(Some("other"), None, Some(&["linux"]))),
        Err(Unfit::Kind)
    );
    assert_eq!(
        fits(&needs(Some("store_extension"), Some("3"), Some(&["linux"]))),
        Err(Unfit::Version)
    );
    assert_eq!(
        fits(&needs(None, None, Some(&["windows-aarch64", "linux"]))),
        Err(Unfit::Platform)
    );
    assert_eq!(fits(&needs(None, None, Some(&["windows-x86_64"]))), Ok(()));
}
