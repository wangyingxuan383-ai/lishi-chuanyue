//! Explicit one-segment transport. No automatic loops, retries or choice taking.
use super::{
    blocking, profile_work, saved_credential, GameCommandError, GameService, StoreRoute, TurnLease,
};
use lishi_core::{
    game_context::ContextRules,
    game_fast_forward::{
        self, ContinueFastForwardRequest, DecisionResumeRequest, FastForwardCommit, FastForwardJob,
        FastForwardUsage, StartFastForwardRequest,
    },
    game_provider::{self, ProviderKind},
    game_store::GameOperationStatus,
    model_probe::{CredentialMode, ModelContextPolicy, ModelProbeRequest, SavedEndpointPolicy},
    StreamStatus,
};
use std::sync::Arc;
fn v2(route: &StoreRoute) -> Result<&lishi_core::game_store_v2::GameStoreV2, GameCommandError> {
    match route {
        StoreRoute::V2(s) => Ok(s),
        _ => Err(GameCommandError::new("game_upgrade_required")),
    }
}
#[tauri::command]
pub async fn get_game_calendar(
    world_id: String,
    branch_id: String,
    expected_head_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<serde_json::Value, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move||{
  let route=s.store(&world_id,false)?;let view=v2(&route)?.selected_view(&branch_id)?;
  if view.head_turn_id!=expected_head_turn_id{return Err(GameCommandError::new("game_stale_head"));}
  let range=lishi_core::game_calendar::calendar_range(view.state.time.era_year,view.state.time.elapsed_seconds).map_err(|e|GameCommandError::new(e.to_string()))?;
  let history=v2(&route)?.selected_history(&branch_id)?;
  let actor=&view.state.protagonist_id;
  let grants=lishi_core::game_knowledge::initial_visible_grants(&history,actor)?;
  let visibility=lishi_core::game_knowledge::SourceVisibilityIndex::from_recorded_observations(&history,grants)?;
  let facts=lishi_core::game_knowledge::observed_facts_for_actor(&history,&visibility,actor)?;
  let birth=facts.iter().find_map(|fact|match &fact.fact_key{
   lishi_core::game_protocol_v2::FactKey::EntityAttribute{entity_id,key} if entity_id==actor&&key=="birth_date_range"=>
    fact.value.as_str().and_then(|v|serde_json::from_str::<lishi_core::game_calendar::BirthDateRange>(v).ok()),
   _=>None
  });
  let age=lishi_core::game_calendar::age_range(&range,birth.as_ref()).ok().flatten();
  Ok(serde_json::json!({"worldId":world_id,"branchId":branch_id,"headTurnId":view.head_turn_id,"calendarRange":range,"birthdayKnown":age.is_some(),"age":age}))
 }).await
}
#[tauri::command]
pub async fn start_game_fast_forward(
    request: StartFastForwardRequest,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<FastForwardJob, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&request.world_id, false)?;
        let store = v2(&route)?;
        store.ensure_fast_forward_backend()?;
        Ok(store.start_fast_forward(&request)?)
    })
    .await
}
#[tauri::command]
pub async fn list_game_fast_forward(
    world_id: String,
    branch_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Vec<FastForwardJob>, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let route = s.store(&world_id, false)?;
        let store = v2(&route)?;
        if !store.branches_enabled()? {
            return Ok(vec![]);
        }
        Ok(store.list_fast_forward_jobs(&branch_id)?)
    })
    .await
}
#[tauri::command]
pub async fn resume_game_fast_forward_decision(
    request: DecisionResumeRequest,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<FastForwardJob, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&request.world_id, false)?;
        Ok(v2(&route)?.resume_fast_forward_after_decision(&request)?)
    })
    .await
}
#[tauri::command]
pub async fn cancel_game_fast_forward(
    world_id: String,
    branch_id: String,
    job_id: String,
    expected_job_revision: u64,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<FastForwardJob, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&world_id, false)?;
        let store = v2(&route)?;
        let job = store.get_fast_forward_job(&job_id)?;
        if job.world_id != world_id || job.branch_id != branch_id {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        Ok(store.cancel_fast_forward_job(&job_id, expected_job_revision)?)
    })
    .await
}
pub(super) async fn run_segment(
    mut lease: TurnLease,
    request: ContinueFastForwardRequest,
    provider: ProviderKind,
) -> Result<FastForwardCommit, GameCommandError> {
    let route = Arc::clone(&lease.store);
    let r = request.clone();
    let prepared = blocking(move || Ok(v2(&route)?.begin_fast_forward_segment(&r)?)).await?;
    let route = Arc::clone(&lease.store);
    let branch = request.branch_id.clone();
    let view = blocking(move || Ok(v2(&route)?.view_branch(&branch)?)).await?;
    let generation:Result<game_fast_forward::FastForwardSegment,GameCommandError>=async{
  if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"));}
  let route=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{route.mark_generating(&id)?;Ok(())}).await?;
  let segment=match provider {
   ProviderKind::Demo=>{
    tokio::select!{biased;_ = lease.cancel.cancelled()=>return Err(GameCommandError::new("game_cancelled")),
      _=tokio::time::sleep(std::time::Duration::from_millis(180))=>{}}
    game_fast_forward::demo_fast_forward_segment(&prepared.job,&view.state,&request.operation_id)?
   }
   ProviderKind::Compatible=>{
    #[cfg(target_os="android")]
    if !crate::android_tls::is_ready(){return Err(GameCommandError::new("model_tls_unavailable"));}
    let research_hint=super::research_commands::preflight(Arc::clone(&lease.service),Arc::clone(&lease.store),&prepared.request,lease.cancel.clone()).await?;
    let configs=Arc::clone(&lease.service.providers);
    let frozen=blocking(move||configs.stored()?.ok_or_else(||GameCommandError::new("game_provider_missing"))).await?;
    let budget=frozen.config.context_budget;let s=Arc::clone(&lease.service);let route=Arc::clone(&lease.store);let input=prepared.request.clone();let current=view.clone();
    let (prompt,memory)=blocking(move||{
     let store=v2(&route)?;let memory=s.memory(&current.setup.world_id)?;
     let rules=format!("{}\n\n本操作是快进段。上方v2约定仅用于包裹内output字段；最终最外层必须服从以下快进协议：\n{}",lishi_core::game_provider_v2::GAME_OUTPUT_RULES_V2,game_fast_forward::FAST_FORWARD_OUTPUT_RULES);
     let history=store.selected_history(&current.branch_id)?;
     let mut evidence=super::research_commands::fragments(&s,store,&current,&history)?;evidence.extend(research_hint);
     store.allow_research_sources(&input.operation_id,&super::research_commands::allowed_sources(&s,store,&current,&history)?)?;
     let compiled=memory.compile_with_evidence(store,&current,&input,budget,ContextRules{prompt_version:21_001,output_rules:&rules},&evidence)?;
     Ok((compiled.prompt,memory))
    }).await?;
    let (profile,key)=profile_work(Arc::clone(&lease.service),|s|saved_credential(&s)).await?;
    if profile.config.revision!=frozen.config.revision{return Err(GameCommandError::new("game_provider_stale"));}
    let route=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{v2(&route)?.reserve_fast_forward_model_request(&id)?;Ok(())}).await?;
    let endpoint_policy=if profile.config.allow_insecure_http{SavedEndpointPolicy::ExplicitHttp}else{SavedEndpointPolicy::HttpsOnly};
    let result=lishi_core::model_probe::run_model_probe_with_context_policy(ModelProbeRequest{operation_id:request.operation_id.clone(),endpoint:profile.config.endpoint,model:profile.config.model,prompt,include_usage:false,credential_mode:CredentialMode::Saved},Some(key),lease.cancel.clone(),game_provider::production_stream_options(),endpoint_policy,
     ModelContextPolicy{max_prompt_bytes:budget.effective_input_limit_bytes().map_err(|e|GameCommandError::new(e.to_string()))?,output_reserve_tokens:Some(budget.output_reserve_tokens.try_into().map_err(|_|GameCommandError::new("game_provider_invalid"))?)},|_|true).await;
    let usage=result.diagnostics.usage.as_ref().map(|u|FastForwardUsage{input_tokens:Some(u.prompt_tokens),output_tokens:Some(u.completion_tokens),total_tokens:Some(u.total_tokens)}).unwrap_or_default();
    let actual=usage.input_tokens.and_then(|u|usize::try_from(u).ok());
    let route=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{v2(&route)?.record_fast_forward_usage(&id,usage)?;memory.record_actual_usage(&id,actual)?;Ok(())}).await?;
    if result.stream.status==StreamStatus::Cancelled{return Err(GameCommandError::new("game_cancelled"));}
    if result.stream.status!=StreamStatus::Completed{return Err(GameCommandError::new("game_provider_failed"));}
    game_fast_forward::parse_fast_forward_segment(&result.stream.text)?
   }
  };
  if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"));}
  let route=Arc::clone(&lease.store);let id=lease.id.clone();let stage=segment.clone();
  blocking(move||{v2(&route)?.stage_fast_forward_segment(&id,&stage)?;Ok(())}).await?;
  Ok(segment)
 }.await;
    match generation {
        Ok(segment) => {
            let route = Arc::clone(&lease.store);
            let id = lease.id.clone();
            let cancel = lease.cancel.clone();
            let committed = blocking(move || {
                Ok(
                    v2(&route)?.commit_fast_forward_segment_with_hook(&id, &segment, || {
                        if cancel.is_cancelled() {
                            Err(lishi_core::game_store::GameStoreError::Cancelled)
                        } else {
                            Ok(())
                        }
                    })?,
                )
            })
            .await;
            match committed {
                Ok(result) => {
                    lease.done = true;
                    Ok(result)
                }
                Err(problem) => {
                    let route = Arc::clone(&lease.store);
                    let id = lease.id.clone();
                    let status = if lease.cancel.is_cancelled() {
                        GameOperationStatus::Cancelled
                    } else {
                        GameOperationStatus::Failed
                    };
                    blocking(move || {
                        v2(&route)?.finish_fast_forward_segment(
                            &id,
                            status,
                            Some("game_invalid_output"),
                        )?;
                        Ok(())
                    })
                    .await?;
                    lease.done = true;
                    Err(problem)
                }
            }
        }
        Err(problem) => {
            let route = Arc::clone(&lease.store);
            let id = lease.id.clone();
            let cancelled = lease.cancel.is_cancelled() || problem.code == "game_cancelled";
            blocking(move || {
                v2(&route)?.finish_fast_forward_segment(
                    &id,
                    if cancelled {
                        GameOperationStatus::Cancelled
                    } else {
                        GameOperationStatus::Failed
                    },
                    Some(if cancelled {
                        "game_cancelled"
                    } else {
                        "game_provider_failed"
                    }),
                )?;
                Ok(())
            })
            .await?;
            lease.done = true;
            Err(problem)
        }
    }
}
#[tauri::command]
pub async fn continue_game_fast_forward(
    request: ContinueFastForwardRequest,
    provider_kind: ProviderKind,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<FastForwardCommit, GameCommandError> {
    let s = Arc::clone(service.inner());
    let owner = Arc::clone(&s);
    let id = request.world_id.clone();
    let route = blocking(move || owner.store(&id, false)).await?;
    let lease = s.turn_lease(route, &request.operation_id)?;
    tauri::async_runtime::spawn(run_segment(lease, request, provider_kind))
        .await
        .map_err(|_| GameCommandError::new("game_worker_failed"))?
}
