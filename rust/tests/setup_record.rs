//! A setup record as a consumer keeps it: `{"digest": ..., "phase": ...}`.

use coqui_aos::serde_json::{self, json};
use coqui_aos::{Phase, SetupRecord};

#[test]
fn a_phase_is_read_from_its_name() {
    assert_eq!(Phase::named("install"), Some(Phase::Install));
    assert_eq!(Phase::named("sync"), Some(Phase::Sync));
    assert_eq!(Phase::named("remove"), Some(Phase::Remove));
    assert_eq!(Phase::named("Install"), None);
    assert_eq!(Phase::named(""), None);
    for phase in [Phase::Install, Phase::Sync, Phase::Remove] {
        assert_eq!(Phase::named(phase.name()), Some(phase));
    }
}

#[test]
fn a_record_is_written_as_digest_and_phase() {
    let record = SetupRecord::new("sha256:ab", Phase::Sync);
    assert_eq!(
        serde_json::to_value(&record).expect("written"),
        json!({"digest": "sha256:ab", "phase": "sync"})
    );
    assert_eq!(
        serde_json::to_string(&Phase::Remove).expect("written"),
        "\"remove\""
    );
}

#[test]
fn a_record_is_read_back() {
    let record = SetupRecord::new("sha256:ab", Phase::Install);
    let text = serde_json::to_string(&record).expect("written");
    assert_eq!(
        serde_json::from_str::<SetupRecord>(&text).expect("read"),
        record
    );
    assert_eq!(
        serde_json::from_value::<SetupRecord>(json!({"digest": "sha256:cd", "phase": "remove"}))
            .expect("read"),
        SetupRecord::new("sha256:cd", Phase::Remove)
    );
}

#[test]
fn a_record_that_does_not_read_is_refused() {
    for bad in [
        json!({"digest": "sha256:ab", "phase": "later"}),
        json!({"digest": "sha256:ab", "phase": "Sync"}),
        json!({"digest": "sha256:ab"}),
        json!({"phase": "sync"}),
        json!({"digest": 1, "phase": "sync"}),
        json!("sync"),
    ] {
        assert!(
            serde_json::from_value::<SetupRecord>(bad.clone()).is_err(),
            "{bad}"
        );
    }
}
