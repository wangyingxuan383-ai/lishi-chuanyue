//! Fixed current-price calculations and sidecar safety; no model/network calls.
use lishi_core::{
    game_call_log::{CallAttempt, CallState},
    game_cost::{
        estimate_attempts, estimate_cost, parse_price, ModelPrice, PriceError, PriceSettings,
        PriceStore, PriceUpdate, MAX_SAFE_INTEGER,
    },
    stream::TokenUsage,
};
use std::sync::{Arc, Barrier};

fn price(input: &str, output: &str) -> ModelPrice {
    ModelPrice {
        model: "fixture-model".into(),
        currency: "CNY".into(),
        input_per_million: input.into(),
        output_per_million: output.into(),
    }
}
fn update(revision: u64) -> PriceUpdate {
    PriceUpdate {
        model: "fixture-model".into(),
        currency: "CNY".into(),
        input_per_million: "1.2".into(),
        output_per_million: "3.000001".into(),
        expected_revision: revision,
    }
}
fn usage(input: u64, output: u64) -> TokenUsage {
    TokenUsage {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
    }
}
fn attempt(operation: &str, model: &str, usage: Option<TokenUsage>) -> CallAttempt {
    CallAttempt {
        operation_id: operation.into(),
        world_id: "fixture-world".into(),
        branch_id: "child".into(),
        model: model.into(),
        prompt_version: 8,
        sequence: 2,
        state: CallState::Failed,
        actual_http_attempts: Some(1),
        sent_unknown: false,
        http_status: Some(429),
        usage,
        elapsed_ms: Some(9),
        error_code: Some("http_status".into()),
        created_at_ms: 0,
        finished_at_ms: Some(9),
    }
}

#[test]
fn strict_decimal_boundaries_and_invalid_inputs_are_not_float_coerced() {
    for (input, value) in [
        ("0", 0),
        ("0.000001", 1),
        ("1.234567", 1_234_567),
        ("1000000", 1_000_000_000_000),
        ("1000000.000000", 1_000_000_000_000),
    ] {
        assert_eq!(parse_price(input), Ok(value), "{input}");
    }
    for invalid in [
        "",
        " ",
        " 1",
        "1 ",
        "-0",
        "-1",
        "+1",
        ".5",
        "1.",
        "00",
        "01.2",
        "0.0000001",
        "1000000.000001",
        "1000001",
        "1e3",
        "NaN",
        "Infinity",
        "1.0.0",
        "１２",
        "9999999999999999999999",
    ] {
        assert_eq!(parse_price(invalid), Err(PriceError::Invalid), "{invalid}");
    }
}
#[test]
fn estimate_rounds_the_combined_numerator_once_and_distinguishes_true_zero() {
    let small = price("0.000001", "0.000001");
    let below = estimate_cost(&small, &usage(1, 0)).unwrap();
    assert_eq!(below.total_amount, "0.000000");
    assert!(below.rounded_to_zero);
    let half = estimate_cost(&small, &usage(250_000, 250_000)).unwrap();
    assert_eq!(half.total_amount, "0.000001");
    assert!(!half.rounded_to_zero);
    let sum = estimate_cost(&small, &usage(300_000, 300_000)).unwrap();
    assert_eq!(sum.total_amount, "0.000001"); // independently rounded components would be zero
    let zero = estimate_cost(&price("0", "0"), &usage(99, 1)).unwrap();
    assert_eq!(zero.total_amount, "0.000000");
    assert!(!zero.rounded_to_zero);
    assert_eq!(
        estimate_cost(&price("1000000", "1000000"), &usage(MAX_SAFE_INTEGER, 0))
            .unwrap()
            .total_amount,
        "9007199254740991.000000"
    );
}
#[test]
fn invalid_usage_and_prices_never_become_known_or_silent_zero() {
    for invalid in [
        TokenUsage {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 3,
        },
        TokenUsage {
            prompt_tokens: MAX_SAFE_INTEGER + 1,
            completion_tokens: 0,
            total_tokens: MAX_SAFE_INTEGER + 1,
        },
        TokenUsage {
            prompt_tokens: u64::MAX,
            completion_tokens: 1,
            total_tokens: 0,
        },
    ] {
        assert_eq!(
            estimate_cost(&price("1", "2"), &invalid),
            Err(PriceError::Invalid)
        );
        assert_eq!(
            estimate_attempts(
                &PriceSettings {
                    revision: 0,
                    entries: vec![]
                },
                &[attempt("invalid-operation", "unknown", Some(invalid))]
            ),
            Err(PriceError::Invalid)
        );
    }
    for model in ["", "two words", "control\u{7f}"] {
        let mut p = price("1", "2");
        p.model = model.into();
        assert_eq!(estimate_cost(&p, &usage(1, 1)), Err(PriceError::Invalid));
    }
    let mut p = price("1", "2");
    p.currency = "EUR".into();
    assert_eq!(estimate_cost(&p, &usage(1, 1)), Err(PriceError::Invalid));
}
#[test]
fn attempts_bind_full_identity_preserve_failed_usage_and_do_not_cross_currencies() {
    let mut usd = price("2", "4");
    usd.model = "usd-model".into();
    usd.currency = "USD".into();
    let settings = PriceSettings {
        revision: 3,
        entries: vec![price("1", "2"), usd],
    };
    let calls = vec![
        attempt("failed-but-billed", "fixture-model", Some(usage(1000, 100))),
        attempt("no-usage", "fixture-model", None),
        attempt("unknown-price", "unknown", Some(usage(1000, 100))),
        attempt("usd-operation", "usd-model", Some(usage(1000, 100))),
    ];
    let before = calls.clone();
    let result = estimate_attempts(&settings, &calls).unwrap();
    assert_eq!(result.price_revision, 3);
    let first = &result.attempts[0];
    assert_eq!(
        (
            &first.world_id,
            &first.branch_id,
            &first.operation_id,
            first.sequence,
            &first.model
        ),
        (
            &calls[0].world_id,
            &calls[0].branch_id,
            &calls[0].operation_id,
            2,
            &calls[0].model
        )
    );
    assert_eq!(first.estimate.as_ref().unwrap().total_amount, "0.001200");
    assert!(result.attempts[1].estimate.is_none() && result.attempts[2].estimate.is_none());
    assert_eq!(
        result.attempts[3].estimate.as_ref().unwrap().currency,
        "USD"
    );
    assert_eq!(
        result.attempts[3].estimate.as_ref().unwrap().total_amount,
        "0.002400"
    );
    assert_eq!(calls, before);
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 2);
    assert_eq!(json["attempts"][0].as_object().unwrap().len(), 6);
    assert_eq!(
        json["attempts"][0]["estimate"].as_object().unwrap().len(),
        3
    );
    assert_eq!(
        estimate_attempts(&settings, &vec![calls[0].clone(); 101]),
        Err(PriceError::Invalid)
    );
}
#[test]
fn cas_canonical_prices_clear_and_reopen_preserve_exact_data() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("prices.sqlite");
    let store = PriceStore::open(&path).unwrap();
    assert_eq!(
        store.settings().unwrap(),
        PriceSettings {
            revision: 0,
            entries: vec![]
        }
    );
    let saved = store.set(&update(0)).unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.entries[0].input_per_million, "1.200000");
    assert_eq!(saved.entries[0].output_per_million, "3.000001");
    assert_eq!(store.set(&update(0)), Err(PriceError::Stale));
    assert_eq!(store.clear("fixture-model", 0), Err(PriceError::Stale));
    assert_eq!(PriceStore::open(&path).unwrap_err(), PriceError::Store);
    drop(store);
    let store = PriceStore::open(&path).unwrap();
    assert_eq!(store.settings().unwrap(), saved);
    let changed = PriceUpdate {
        input_per_million: "0".into(),
        expected_revision: 1,
        ..update(0)
    };
    assert_eq!(
        store.set(&changed).unwrap().entries[0].input_per_million,
        "0.000000"
    );
    let clear = store.clear("fixture-model", 2).unwrap();
    assert_eq!(
        clear,
        PriceSettings {
            revision: 3,
            entries: vec![]
        }
    );
    assert_eq!(store.clear("fixture-model", 3).unwrap(), clear);
}
#[test]
fn simultaneous_writers_accept_only_one_expected_revision() {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(PriceStore::open(temp.path().join("prices.sqlite")).unwrap());
    let barrier = Arc::new(Barrier::new(8));
    let threads = (0..8)
        .map(|_| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                store.set(&update(0))
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|t| t.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == Err(PriceError::Stale))
            .count(),
        7
    );
    assert_eq!(store.settings().unwrap().revision, 1);
}
#[test]
fn configured_model_limit_allows_updates_but_refuses_a_129th_entry() {
    let temp = tempfile::tempdir().unwrap();
    let store = PriceStore::open(temp.path().join("prices.sqlite")).unwrap();
    for revision in 0..128 {
        let mut input = update(revision);
        input.model = format!("model-{revision:03}");
        store.set(&input).unwrap();
    }
    assert_eq!(store.set(&update(128)), Err(PriceError::Invalid));
    let mut replacement = update(128);
    replacement.model = "model-000".into();
    replacement.currency = "USD".into();
    assert_eq!(store.set(&replacement).unwrap().revision, 129);
    assert_eq!(store.settings().unwrap().entries.len(), 128);
}
#[test]
fn corrupt_foreign_empty_future_and_altered_schema_files_are_refused_without_rewriting() {
    let temp = tempfile::tempdir().unwrap();
    for (name, bytes) in [
        ("corrupt", b"PRIVATE_BROKEN_DATABASE".as_slice()),
        ("empty", b"".as_slice()),
    ] {
        let path = temp.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(PriceStore::open(&path).unwrap_err(), PriceError::Store);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    for mode in [
        "foreign",
        "future",
        "extra",
        "wrong-shape",
        "missing-row",
        "bad-data",
        "zero-revision-entries",
    ] {
        let path = temp.path().join(format!("{mode}.sqlite"));
        if mode == "foreign" {
            let c = rusqlite::Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE foreign_data(secret TEXT); INSERT INTO foreign_data VALUES('PRIVATE_DATA');PRAGMA user_version=1;").unwrap();
        } else {
            let store = PriceStore::open(&path).unwrap();
            store.set(&update(0)).unwrap();
            drop(store);
            let c = rusqlite::Connection::open(&path).unwrap();
            match mode {
                "future" => c.execute_batch("PRAGMA user_version=2;").unwrap(),
                "extra" => c.execute_batch("CREATE TABLE extra(value TEXT);").unwrap(),
                "wrong-shape" => c
                    .execute_batch("ALTER TABLE model_prices ADD COLUMN extra TEXT;")
                    .unwrap(),
                "missing-row" => c.execute_batch("DELETE FROM price_meta;").unwrap(),
                "bad-data" => c
                    .execute_batch("UPDATE model_prices SET model='two words';")
                    .unwrap(),
                "zero-revision-entries" => c
                    .execute_batch("UPDATE price_meta SET revision=0;")
                    .unwrap(),
                _ => unreachable!(),
            }
        }
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            PriceStore::open(&path).unwrap_err(),
            PriceError::Store,
            "{mode}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before, "{mode}");
    }
}
#[test]
fn cached_store_revalidates_schema_and_revision_overflow_does_not_mutate() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("prices.sqlite");
    let store = PriceStore::open(&path).unwrap();
    store.set(&update(0)).unwrap();
    let external = rusqlite::Connection::open(&path).unwrap();
    external
        .execute(
            "UPDATE price_meta SET revision=?1",
            [MAX_SAFE_INTEGER as i64],
        )
        .unwrap();
    assert_eq!(
        store.set(&update(MAX_SAFE_INTEGER)),
        Err(PriceError::Invalid)
    );
    assert_eq!(
        store.clear("fixture-model", MAX_SAFE_INTEGER),
        Err(PriceError::Invalid)
    );
    assert_eq!(store.settings().unwrap().revision, MAX_SAFE_INTEGER);
    external
        .execute_batch("CREATE VIEW surprise AS SELECT 1;")
        .unwrap();
    assert_eq!(store.settings(), Err(PriceError::Store));
    assert_eq!(store.set(&update(MAX_SAFE_INTEGER)), Err(PriceError::Store));
}
#[test]
fn ipc_update_rejects_unknown_fields_and_estimates_reject_duplicate_identity() {
    let valid = serde_json::json!({"model":"fixture","currency":"CNY","inputPerMillion":"1","outputPerMillion":"2","expectedRevision":0});
    assert!(serde_json::from_value::<PriceUpdate>(valid.clone()).is_ok());
    let mut extra = valid;
    extra["apiKey"] = serde_json::json!("PRIVATE");
    assert!(serde_json::from_value::<PriceUpdate>(extra).is_err());
    assert_eq!(
        estimate_attempts(
            &PriceSettings {
                revision: 2,
                entries: vec![price("1", "2"), price("3", "4")]
            },
            &[]
        ),
        Err(PriceError::Invalid)
    );
    assert_eq!(
        estimate_attempts(
            &PriceSettings {
                revision: MAX_SAFE_INTEGER + 1,
                entries: vec![]
            },
            &[]
        ),
        Err(PriceError::Invalid)
    );
    let no_prices = PriceSettings {
        revision: 0,
        entries: vec![],
    };
    let call = attempt("duplicate-operation", "unknown", None);
    let mut impostor = call.clone();
    impostor.world_id = "different-world".into();
    impostor.model = "different-model".into();
    assert_eq!(
        estimate_attempts(&no_prices, &[call, impostor]),
        Err(PriceError::Invalid)
    );
    assert_eq!(
        estimate_attempts(
            &PriceSettings {
                revision: 0,
                entries: vec![price("1", "2")]
            },
            &[]
        ),
        Err(PriceError::Invalid)
    );
}
