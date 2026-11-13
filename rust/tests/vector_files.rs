//! Every vector file has a runner: a new file in `vectors/` fails here until one is written.

use std::path::PathBuf;

use coqui_aos::vectors::Runner;

#[test]
fn every_vector_file_is_run_or_named_here() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../vectors");
    assert_eq!(
        Runner::new(dir).unrun(),
        Vec::<String>::new(),
        "a new vector file needs a runner or a named skip"
    );
}
