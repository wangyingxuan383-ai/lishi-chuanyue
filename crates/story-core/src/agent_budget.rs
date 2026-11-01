//! Agent input allowances are tokens. UTF-16 JSON units are only a local
//! estimate, calibrated from this task's actual provider usage, never from a
//! different story model or a guessed model-name window.
use crate::{chat::Completion, Error, Result, RunPlan};
use serde::Serialize;
use serde_json::{json, Value};

pub const DEFAULT_INPUT_TOKENS: u64 = 475_000;
const ESTIMATOR_VERSION: &str = "agent-tokens-1";
const INITIAL_TOKENS_PER_UNIT: f64 = 1.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputBudget {
    pub requested_tokens: u64,
    pub effective_tokens: u64,
    pub estimated_chars: u64,
    pub calibrated: bool,
    pub estimated: bool,
    pub tokens_per_unit: f64,
    pub context_window_tokens: Option<u64>,
    pub output_reserve_tokens: u64,
    pub legacy: bool,
}

pub fn token_units(plan: &RunPlan) -> bool {
    plan.options["budgetUnit"] == "tokens"
}

pub fn new_options(request: &Value) -> Result<Value> {
    let tokens = match request.get("inputTokens").filter(|v| !v.is_null()) {
        None => DEFAULT_INPUT_TOKENS,
        Some(value) => value
            .as_u64()
            .filter(|n| (2000..=2_000_000).contains(n))
            .ok_or_else(|| Error::Invalid("输入预算应在2000至2000000 tokens之间".into()))?,
    };
    Ok(
        json!({"contextTokens":tokens,"budgetUnit":"tokens","tokenEstimate":{"version":ESTIMATOR_VERSION,"samples":0,"calibrated":false}}),
    )
}

pub fn set_input(plan: &mut RunPlan, tokens: u64) -> Result<()> {
    if !(2000..=2_000_000).contains(&tokens) {
        return Err(Error::Invalid(
            "输入预算应在2000至2000000 tokens之间".into(),
        ));
    }
    plan.options["contextTokens"] = tokens.into();
    plan.options["budgetUnit"] = "tokens".into();
    // This field was a legacy character estimate, not another token limit.
    plan.options.as_object_mut().unwrap().remove("budgetChars");
    Ok(())
}

pub fn input(plan: &RunPlan) -> InputBudget {
    let legacy = !token_units(plan);
    let requested_tokens = plan.options["contextTokens"].as_u64().unwrap_or(if legacy {
        12_000
    } else {
        DEFAULT_INPUT_TOKENS
    });
    let output_reserve_tokens = plan.model.max_output_tokens() as u64;
    let context_window_tokens = plan
        .model
        .extra
        .get("contextWindowTokens")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0);
    let effective_tokens = context_window_tokens
        .map(|window| {
            window
                .saturating_sub(output_reserve_tokens)
                .min(requested_tokens)
        })
        .unwrap_or(requested_tokens);
    let estimate = &plan.options["tokenEstimate"];
    let calibrated =
        estimate["version"] == ESTIMATOR_VERSION && estimate["samples"].as_u64().unwrap_or(0) > 0;
    let learned = estimate["safeTokensPerUnit"]
        .as_f64()
        .filter(|r| r.is_finite() && *r >= 0.05 && *r <= 8.0)
        .unwrap_or(INITIAL_TOKENS_PER_UNIT);
    let tokens_per_unit = if legacy {
        requested_tokens.max(1) as f64
            / plan.options["budgetChars"]
                .as_u64()
                .unwrap_or(requested_tokens)
                .max(1) as f64
    } else if calibrated {
        learned
    } else {
        INITIAL_TOKENS_PER_UNIT
    };
    let estimated_chars = (effective_tokens as f64 / tokens_per_unit)
        .floor()
        .max(0.0)
        .min(u64::MAX as f64) as u64;
    InputBudget {
        requested_tokens,
        effective_tokens,
        estimated_chars,
        calibrated: !legacy && calibrated,
        estimated: true,
        tokens_per_unit,
        context_window_tokens,
        output_reserve_tokens,
        legacy,
    }
}

pub fn request_units(request: &Value) -> u64 {
    // The same projection as the context fitter, including tool definitions.
    // Adaptation absorbs provider-specific serialization overhead; this is
    // deliberately not advertised as an exact tokenizer.
    json!({"messages":request.get("messages").unwrap_or(&Value::Null),"tools":request.get("tools").unwrap_or(&json!([]))}).to_string().encode_utf16().count() as u64
}

pub fn estimated_tokens(plan: &RunPlan, request: &Value) -> u64 {
    (request_units(request) as f64 * input(plan).tokens_per_unit)
        .ceil()
        .min(u64::MAX as f64) as u64
}

pub fn restore(plan: &mut RunPlan, draft: &Value) {
    if draft["tokenEstimate"]["version"] == ESTIMATOR_VERSION {
        plan.options["tokenEstimate"] = draft["tokenEstimate"].clone();
    }
}

/// The caller persists this value in the root task draft. Request step IDs
/// make replay/cached completions idempotent; all children share this state.
pub fn observe(previous: &Value, step: &str, request: &Value, reply: &Completion) -> Value {
    let mut next = if previous["version"] == ESTIMATOR_VERSION {
        previous.clone()
    } else {
        json!({"version":ESTIMATOR_VERSION,"samples":0,"unreportedResponses":0,"observedSteps":[]})
    };
    if next["observedSteps"]
        .as_array()
        .is_some_and(|steps| steps.iter().any(|s| s == step))
    {
        return next;
    }
    if !next["observedSteps"].is_array() {
        next["observedSteps"] = json!([]);
    }
    next["observedSteps"]
        .as_array_mut()
        .unwrap()
        .push(step.into());
    let units = request_units(request);
    let tokens = reply
        .usage
        .as_ref()
        .and_then(|u| u["prompt_tokens"].as_u64())
        .filter(|n| *n > 0);
    let observed = tokens
        .filter(|_| units > 0)
        .map(|tokens| tokens as f64 / units as f64)
        .filter(|r| r.is_finite() && *r >= 0.05 && *r <= 8.0);
    if let Some(observed) = observed {
        let mean = next["meanTokensPerUnit"]
            .as_f64()
            .filter(|r| r.is_finite())
            .map(|old| old * 0.7 + observed * 0.3)
            .unwrap_or(observed);
        // Respond immediately to a higher-cost request, and retain headroom
        // rather than claiming the provider's token count is exactly known.
        next["meanTokensPerUnit"] = mean.into();
        next["safeTokensPerUnit"] = (mean * 1.15).max(observed * 1.05).min(8.0).into();
        next["samples"] = (next["samples"].as_u64().unwrap_or(0) + 1).into();
        next["lastPromptTokens"] = tokens.unwrap().into();
        next["lastRequestUnits"] = units.into();
        next["lastUsageAvailable"] = true.into();
    } else {
        next["unreportedResponses"] =
            (next["unreportedResponses"].as_u64().unwrap_or(0) + 1).into();
        next["lastUsageAvailable"] = false.into();
    }
    next["calibrated"] = (next["samples"].as_u64().unwrap_or(0) > 0).into();
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(options: Value) -> RunPlan {
        serde_json::from_value(json!({"id":"budget-only","worldId":"w","lineId":"l","headId":"n","baseId":"n","kind":"agent_task","model":{"slot":"no-key","url":"https://fixture.invalid","model":"unknown-name","includeUsage":true,"maxTokens":8192},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":options,"action":{},"meta":{}})).unwrap()
    }

    #[test]
    fn agent_default_is_475k_tokens_and_only_a_configured_window_caps_it() {
        let mut p = plan(
            new_options(&json!({"model":{"contextTokens":12000},"budgetChars":12000})).unwrap(),
        );
        assert_eq!(input(&p).requested_tokens, 475_000);
        assert_eq!(input(&p).effective_tokens, 475_000);
        assert_eq!(input(&p).context_window_tokens, None);
        p.model
            .extra
            .insert("contextWindowTokens".into(), 262144.into());
        assert_eq!(input(&p).effective_tokens, 262144 - 8192);
    }

    #[test]
    fn usage_calibrates_task_units_without_treating_characters_as_tokens() {
        let mut p = plan(new_options(&json!({})).unwrap());
        let request = json!({"messages":[{"role":"user","content":"事实、要求和工具结果。".repeat(1000)}],"tools":[]});
        let reply = Completion {
            usage: Some(json!({"prompt_tokens":4000})),
            ..Default::default()
        };
        let estimate = observe(&Value::Null, "model:1", &request, &reply);
        restore(&mut p, &json!({"tokenEstimate":estimate}));
        let budget = input(&p);
        assert!(budget.calibrated);
        assert!(budget.estimated_chars > 475_000);
        assert!(estimated_tokens(&p, &request) >= 4000 && estimated_tokens(&p, &request) <= 4700);
        let replay = observe(&p.options["tokenEstimate"], "model:1", &request, &reply);
        assert_eq!(replay["samples"], 1);
        assert_eq!(replay, p.options["tokenEstimate"]);
    }

    #[test]
    fn missing_usage_stays_an_estimate_and_old_tasks_keep_their_character_budget() {
        let mut legacy = plan(json!({"contextTokens":12000,"budgetChars":14545}));
        let old = input(&legacy);
        assert_eq!(old.estimated_chars, 14545);
        assert!(old.legacy);
        let missing = observe(
            &Value::Null,
            "model:1",
            &json!({"messages":[],"tools":[]}),
            &Completion::default(),
        );
        assert_eq!(missing["calibrated"], false);
        restore(&mut legacy, &json!({"tokenEstimate":missing}));
        assert_eq!(input(&legacy).estimated_chars, 14545);
        set_input(&mut legacy, 475000).unwrap();
        assert_eq!(input(&legacy).effective_tokens, 475000);
        assert!(!input(&legacy).legacy);
    }
}
