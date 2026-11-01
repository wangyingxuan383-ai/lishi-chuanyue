use crate::{android::JavaBridge, credentials::Credentials};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use story_core::{pi_service::ModelResolver, Error, Store};

#[path = "../../pi-model-reference.rs"]
mod model_reference;

fn invalid() -> Error {
    Error::Invalid("模型配置或凭据绑定不可用，请检查所选服务".into())
}

/// Resolve only native saved profiles and native bindings. Caller URLs, headers
/// and keys are ignored. Every task obtains a fresh bindings snapshot.
pub fn model_resolver(store: Store, data_root: PathBuf, bridge: Arc<JavaBridge>) -> ModelResolver {
    Arc::new(move |reference: &Value| {
        model_reference::resolve(&store, &data_root, reference, |slot, bound| {
            let authorizer =
                Credentials::open(data_root.clone(), bridge.clone()).map_err(|_| invalid())?;
            let secret = authorizer.authorize(slot, bound).map_err(|_| invalid())?;
            Ok(secret.expose_secret().to_owned())
        })
    })
}
