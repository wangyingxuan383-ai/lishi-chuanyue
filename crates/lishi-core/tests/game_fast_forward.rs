use lishi_core::{
    game_fast_forward::*, game_protocol::WorldSetup, game_protocol_v2::initial_state_v2,
    game_store::GameStoreError,
};
fn job() -> (FastForwardJob, lishi_core::game_protocol_v2::WorldStateV2) {
    let setup = WorldSetup {
        world_id: "fast-forward-pure-world".into(),
        title: "快进纯验证".into(),
        country: "唐".into(),
        era_year: 618,
        location_name: "长安".into(),
        protagonist_name: "行旅者".into(),
        narrative_style: "中文".into(),
    };
    let state = initial_state_v2(&setup).unwrap();
    (
        FastForwardJob {
            job_id: "fast-forward-pure-job".into(),
            world_id: setup.world_id,
            branch_id: "main".into(),
            start_head_turn_id: None,
            head_turn_id: None,
            start_elapsed_seconds: 0,
            elapsed_seconds: 0,
            target_elapsed_seconds: 100,
            max_segment_seconds: 10,
            focus: "关键决策".into(),
            status: FastForwardStatus::Running,
            revision: 1,
            segments_committed: 0,
            model_requests_reserved: 0,
            active_operation_id: Some("fast-forward-pure-segment".into()),
            decision: None,
            last_error: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        },
        state,
    )
}
#[test]
fn explicit_decision_wrapper_has_choices_but_no_selected_outcome() {
    let (job, state) = job();
    let segment =
        demo_fast_forward_segment(&job, &state, job.active_operation_id.as_deref().unwrap())
            .unwrap();
    assert_eq!(segment.stop_reason, FastForwardStopReason::Decision);
    assert_eq!(segment.output.time_advance.elapsed_seconds, 10);
    assert_eq!(
        validate_fast_forward_segment(
            &job,
            job.active_operation_id.as_deref().unwrap(),
            &state,
            &segment
        )
        .unwrap(),
        FastForwardStatus::PausedDecision
    );
    assert!(segment.output.state_changes.iter().all(|change| matches!(
        change,
        lishi_core::game_protocol_v2::StateChangeV2::ObserveFact { .. }
    )));
    let mut raw = serde_json::to_value(&segment).unwrap();
    raw["decision"]["selectedChoiceId"] = serde_json::json!("ff-inspect");
    assert_eq!(
        parse_fast_forward_segment(&raw.to_string()),
        Err(GameStoreError::InvalidOutput)
    );
}
#[test]
fn mismatched_choices_missing_nullable_or_hidden_follow_up_are_rejected() {
    let (job, state) = job();
    let id = job.active_operation_id.as_deref().unwrap();
    let segment = demo_fast_forward_segment(&job, &state, id).unwrap();
    let mut bad = segment.clone();
    bad.decision.as_mut().unwrap().choice_ids.reverse();
    assert_eq!(
        validate_fast_forward_segment(&job, id, &state, &bad),
        Err(GameStoreError::InvalidOutput)
    );
    let mut bad = segment.clone();
    bad.output.time_advance.elapsed_seconds = 11;
    assert_eq!(
        validate_fast_forward_segment(&job, id, &state, &bad),
        Err(GameStoreError::InvalidOutput)
    );
    let mut raw = serde_json::to_value(&segment).unwrap();
    raw.as_object_mut().unwrap().remove("decision");
    assert_eq!(
        parse_fast_forward_segment(&raw.to_string()),
        Err(GameStoreError::InvalidOutput)
    );
    raw["decision"] = serde_json::Value::Null;
    assert_eq!(
        validate_fast_forward_segment(
            &job,
            id,
            &state,
            &parse_fast_forward_segment(&raw.to_string()).unwrap()
        ),
        Err(GameStoreError::InvalidOutput)
    );
}
#[test]
fn segment_limit_and_target_require_progress_and_exact_boundary() {
    let (mut job, state) = job();
    job.focus.clear();
    let id = job.active_operation_id.clone().unwrap();
    let limit = demo_fast_forward_segment(&job, &state, &id).unwrap();
    assert_eq!(limit.stop_reason, FastForwardStopReason::SegmentLimit);
    assert!(limit.output.choices.is_empty());
    let mut wrong = limit.clone();
    wrong.stop_reason = FastForwardStopReason::TargetReached;
    assert_eq!(
        validate_fast_forward_segment(&job, &id, &state, &wrong),
        Err(GameStoreError::InvalidOutput)
    );
    job.max_segment_seconds = 100;
    let end = demo_fast_forward_segment(&job, &state, &id).unwrap();
    assert_eq!(end.stop_reason, FastForwardStopReason::TargetReached);
    assert_eq!(
        validate_fast_forward_segment(&job, &id, &state, &end).unwrap(),
        FastForwardStatus::Completed
    );
    let mut zero = limit;
    zero.output.time_advance.elapsed_seconds = 0;
    assert_eq!(
        validate_fast_forward_segment(&job, &id, &state, &zero),
        Err(GameStoreError::InvalidOutput)
    );
}
