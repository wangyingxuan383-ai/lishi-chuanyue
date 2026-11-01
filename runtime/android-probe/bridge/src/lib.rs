//! A probe-owned Rust gateway. No story DB, credentials, Engine or remote calls.
use jni::{objects::{JClass, JString}, sys::jstring, JNIEnv};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, ptr, sync::{Mutex, OnceLock}};

struct Fixture { directory: PathBuf, calls: Vec<Value>, draft: Option<String> }
static FIXTURE: OnceLock<Mutex<Fixture>> = OnceLock::new();

fn error(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message}})
}
fn snapshot(fixture: &Fixture) -> Value {
    json!({"fixtureOnly":true,"formalWorldTouched":false,"rustGateway":true,"calls":fixture.calls,"draft":fixture.draft})
}
fn invoke(request: Value) -> Value {
    let Some(fixture) = FIXTURE.get() else { return error("not_initialized", "独立Rust资料尚未初始化") };
    let Ok(mut fixture) = fixture.lock() else { return error("fixture_unavailable", "独立Rust资料暂不可用") };
    let name = request["name"].as_str().unwrap_or("");
    let result = match name {
        "read_resource" => json!({"ok":true,"summary":"已由Rust读取独立设定卡","data":{"text":"青石桥书铺旧设定","ref":{"kind":"fixture-card","id":"owned-card","version":1}}}),
        "stage_clock" => json!({"ok":false,"error":{"code":"invalid_year","path":"/year","expected":"positive integer","message":"日期设置失败：year须为正整数"}}),
        "stage_edit" => {
            if let Some(text) = request["args"]["text"].as_str().filter(|s| s.chars().count() <= 2000) {
                fixture.draft = Some(text.to_owned());
                json!({"ok":true,"summary":"Rust已保存独立草稿，尚未采用","data":{"staged":true,"text":text,"ref":{"kind":"fixture-draft","version":1}}})
            } else { error("invalid_text", "独立草稿文字无效") }
        },
        _ => error("tool_not_allowed", "此独立验证不提供该工具"),
    };
    fixture.calls.push(json!({"toolCallId":request["toolCallId"],"name":name,"ok":result["ok"]}));
    let file = fixture.directory.join("rust-fixture.json");
    if fs::write(&file, snapshot(&fixture).to_string()).is_err() { return error("fixture_write_failed", "独立草稿未能保存") }
    result
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_piprobe_ProbeGateway_initialize(mut env: JNIEnv, _: JClass, directory: JString) {
    let result = (|| -> Result<(), String> {
        let directory: String = env.get_string(&directory).map_err(|_| "Invalid fixture path")?.into();
        let path = PathBuf::from(directory);
        if !path.is_absolute() || path.file_name().and_then(|p| p.to_str()) != Some("rust-fixture") { return Err("Expected the owned probe fixture directory".into()) }
        fs::create_dir_all(&path).map_err(|_| "Cannot create the owned probe fixture")?;
        FIXTURE.set(Mutex::new(Fixture { directory: path, calls: vec![], draft: None })).map_err(|_| "Fixture already initialized")?;
        Ok(())
    })();
    if let Err(message) = result { let _ = env.throw_new("java/lang/IllegalStateException", message); }
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_piprobe_ProbeGateway_invoke(mut env: JNIEnv, _: JClass, input: JString) -> jstring {
    let output = env.get_string(&input).ok().and_then(|s| serde_json::from_str::<Value>(&String::from(s)).ok()).map(invoke).unwrap_or_else(|| error("invalid_json", "独立工具请求无法读取"));
    env.new_string(output.to_string()).map(|s| s.into_raw()).unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_piprobe_ProbeGateway_snapshot(env: JNIEnv, _: JClass) -> jstring {
    let output = FIXTURE.get().and_then(|f| f.lock().ok()).map(|f| snapshot(&f)).unwrap_or_else(|| error("not_initialized", "独立Rust资料尚未初始化"));
    env.new_string(output.to_string()).map(|s| s.into_raw()).unwrap_or(ptr::null_mut())
}
