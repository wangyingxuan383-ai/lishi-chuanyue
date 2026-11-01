//! Shared story rules. These functions do not access a database or a model.
//! Their JSON boundary is the same snapshot/record boundary used by the UI.
pub mod apply;
pub mod calendar;
pub mod money;
pub mod record;

pub use apply::apply_record;
pub use record::{normalize_record, parse_record};

use serde_json::Value;

pub(crate) fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}
pub(crate) fn num(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
pub(crate) fn values(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(crate) fn strings(value: &Value) -> Vec<String> {
    values(value)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}
pub(crate) fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(s) => {
            if s.trim().is_empty() {
                Some(0.0)
            } else {
                s.trim().parse::<f64>().ok().filter(|n| n.is_finite())
            }
        }
        Value::Array(a) if a.is_empty() => Some(0.0),
        Value::Array(a) if a.len() == 1 => js_number(&a[0]),
        _ => None,
    }
}
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        _ => value.to_string(),
    }
}
pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
pub(crate) fn utf16_prefix(s: &str, units: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(units).collect::<Vec<_>>())
}
pub(crate) fn safe_integer(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

#[cfg(test)]
mod tests;
