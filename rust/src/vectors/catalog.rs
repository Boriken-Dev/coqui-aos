//! `catalog.json`: catalogs in both forms, several catalogs listed and chosen from, and icons.

use std::collections::BTreeMap;

use super::support::bytes_of;
use super::{Report, Runner};
use crate::{
    Catalog, CatalogEntry, CatalogSection, ExtensionDigest, ExtensionEntry, ExtensionNeeds,
    ExtensionSection, list_catalogs, read_catalog, read_icon,
};
use serde_json::{Value, json};

fn entry_json(entry: &CatalogEntry) -> Value {
    let mut out = json!({"source": super::support::source(&entry.source)});
    if let Some(pin) = &entry.pin {
        out["pin"] = json!(pin);
    }
    if let Some(description) = &entry.description {
        out["description"] = json!(description);
    }
    if let Some(about) = &entry.about {
        out["about"] = Value::Object(about.clone());
    }
    out
}

fn needs_json(needs: &ExtensionNeeds) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(kind) = &needs.kind {
        out.insert("kind".into(), json!(kind));
    }
    if let Some(version) = &needs.version {
        out.insert("version".into(), json!(version));
    }
    if let Some(platforms) = &needs.platforms {
        out.insert("platforms".into(), json!(platforms));
    }
    Value::Object(out)
}

fn extension_json(entry: &ExtensionEntry) -> Value {
    let mut out =
        json!({"source": super::support::source(&entry.source), "provider": entry.provider});
    match &entry.digest {
        ExtensionDigest::Tree(pin) => out["pin"] = json!(pin),
        ExtensionDigest::File(sha256) => out["sha256"] = json!(sha256),
    }
    if let Some(load) = &entry.load {
        out["load"] = json!(load);
    }
    if entry.needs != ExtensionNeeds::default() {
        out["needs"] = needs_json(&entry.needs);
    }
    if let Some(description) = &entry.description {
        out["description"] = json!(description);
    }
    if let Some(about) = &entry.about {
        out["about"] = Value::Object(about.clone());
    }
    out
}

fn extensions_json(section: &ExtensionSection) -> Value {
    let entries: BTreeMap<&String, Value> = section
        .entries
        .iter()
        .map(|(name, entry)| (name, extension_json(entry)))
        .collect();
    let refused: Vec<Value> = section
        .refused
        .iter()
        .map(|(name, why)| json!([name, why.as_str()]))
        .collect();
    json!({"entries": entries, "refused": refused})
}

fn section_json(section: &CatalogSection) -> Value {
    let entries: BTreeMap<&String, Value> = section
        .entries
        .iter()
        .map(|(name, entry)| (name, entry_json(entry)))
        .collect();
    let refused: Vec<Value> = section
        .refused
        .iter()
        .map(|(name, why)| json!([name, why.as_str()]))
        .collect();
    json!({"entries": entries, "refused": refused})
}

fn catalog_json(catalog: &Catalog) -> Value {
    let mut out = serde_json::Map::new();
    out.insert(
        "form".into(),
        json!(match catalog.form {
            crate::CatalogForm::Minimal => "minimal",
            _ => "full",
        }),
    );
    for (key, value) in [
        ("name", &catalog.name),
        ("description", &catalog.description),
        ("homepage", &catalog.homepage),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    let overlays = section_json(&catalog.overlays);
    out.insert("entries".into(), overlays["entries"].clone());
    out.insert("refused".into(), overlays["refused"].clone());
    if let Some(skills) = &catalog.skills {
        out.insert("skills".into(), section_json(skills));
    }
    if let Some(extensions) = &catalog.extensions {
        out.insert("extensions".into(), extensions_json(extensions));
    }
    out.insert("ignored".into(), json!(catalog.ignored));
    Value::Object(out)
}

fn read(item: &Value, settings: &crate::Settings) -> Result<Catalog, crate::Error> {
    read_catalog(
        item["text"].as_str().expect("text").as_bytes(),
        item["name"].as_str().expect("name"),
        item["base"].as_str(),
        settings,
    )
}

fn catalogs_case(case: &Value) -> Result<(), String> {
    let settings = crate::Settings::default();
    let items = case["catalogs"].as_array().expect("catalogs");
    let read_all: Vec<(String, Catalog)> = items
        .iter()
        .map(|item| {
            (
                item["label"].as_str().expect("label").to_owned(),
                read(item, &settings).expect("a catalog"),
            )
        })
        .collect();
    let labelled: Vec<(&str, &Catalog)> = read_all
        .iter()
        .map(|(label, catalog)| (label.as_str(), catalog))
        .collect();
    let expect = &case["expect"];
    let listing = match list_catalogs(&labelled) {
        Ok(listing) => listing,
        Err(error) => {
            return (expect["error"] == error.class.as_str())
                .then_some(())
                .ok_or(format!("refused {error}, expected {expect}"));
        }
    };
    let entries: Vec<Value> = listing
        .entries
        .iter()
        .map(|entry| {
            json!({"catalog": entry.catalog, "name": entry.name,
                   "identity": entry.identity, "shown": entry.shown})
        })
        .collect();
    let mut got = json!({"entries": entries, "collisions": listing.collisions});
    if let Some(requests) = case["choose"].as_array().filter(|list| !list.is_empty()) {
        let mut chosen = serde_json::Map::new();
        for request in requests {
            let request = request.as_str().expect("a name");
            chosen.insert(
                request.to_owned(),
                match listing.choose(request) {
                    Ok(entry) => json!({"catalog": entry.catalog, "name": entry.name}),
                    Err(error) => json!({"error": error.class.as_str()}),
                },
            );
        }
        got["chosen"] = Value::Object(chosen);
    }
    (got == *expect).then_some(()).ok_or(format!("{got}"))
}

/// A `fits` case: whether a consumer with these kinds and this system can use an extension.
fn fits_case(case: &Value) -> Result<(), String> {
    let fits = &case["fits"];
    let needs = match fits["needs"].as_object() {
        Some(map) => {
            let strings = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
            ExtensionNeeds {
                kind: strings("kind"),
                version: strings("version"),
                platforms: map.get("platforms").and_then(Value::as_array).map(|list| {
                    list.iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect()
                }),
            }
        }
        None => ExtensionNeeds::default(),
    };
    let offered: Vec<(String, Vec<String>)> = fits["offers"]
        .as_object()
        .expect("offers")
        .iter()
        .map(|(kind, versions)| {
            let versions = versions.as_array().expect("versions");
            (
                kind.clone(),
                versions
                    .iter()
                    .map(|version| version.as_str().expect("a version").to_owned())
                    .collect(),
            )
        })
        .collect();
    let owned: Vec<(&str, Vec<&str>)> = offered
        .iter()
        .map(|(kind, versions)| (kind.as_str(), versions.iter().map(String::as_str).collect()))
        .collect();
    let kinds: Vec<(&str, &[&str])> = owned
        .iter()
        .map(|(kind, versions)| (*kind, versions.as_slice()))
        .collect();
    let platform = &fits["platform"];
    let got = match needs.fits(
        &kinds,
        platform["os"].as_str().expect("os"),
        platform["arch"].as_str().expect("arch"),
    ) {
        Ok(()) => json!({"fits": true}),
        Err(reason) => json!({"fits": false, "reason": reason.as_str()}),
    };
    (got == case["expect"])
        .then_some(())
        .ok_or(format!("{got}"))
}

fn icon_case(case: &Value) -> Result<(), String> {
    let icon = &case["icon"];
    let mut settings = crate::Settings::default();
    let limit = |key: &str| icon["limits"][key].as_u64().map(crate::Limit::at);
    if let Some(bytes) = limit("max_bytes") {
        settings = settings.icon_bytes(bytes);
    }
    if let Some(width) = limit("max_width") {
        settings = settings.icon_width(width);
    }
    if let Some(height) = limit("max_height") {
        settings = settings.icon_height(height);
    }
    let data = bytes_of(icon);
    let expect = &case["expect"];
    match read_icon(&data, icon["name"].as_str().expect("name"), &settings) {
        Ok(read) => {
            let got =
                json!({"format": read.format.as_str(), "width": read.width, "height": read.height});
            (got == *expect).then_some(()).ok_or(format!("{got}"))
        }
        Err(error) => (expect["error"] == error.class.as_str())
            .then_some(())
            .ok_or(format!("refused {error}, expected {expect}")),
    }
}

pub(super) fn catalogs_and_icons(runner: &Runner) -> Report {
    runner.each("catalog.json", |case| {
        if case.get("icon").is_some() {
            return icon_case(case);
        }
        if case.get("catalogs").is_some() {
            return catalogs_case(case);
        }
        if case.get("fits").is_some() {
            return fits_case(case);
        }
        let item = &case["catalog"];
        let expect = &case["expect"];
        match read(item, &crate::Settings::default()) {
            Ok(catalog) => {
                let got = catalog_json(&catalog);
                (got == *expect).then_some(()).ok_or(format!("{got}"))
            }
            Err(error) => (expect["error"] == error.class.as_str())
                .then_some(())
                .ok_or(format!("refused {error}, expected {expect}")),
        }
    })
}
