//! Node-API boundary. Futures own Rust values, never borrowed JS receivers.
//! napi2 async &self wrappers retain receiver refs on rejected futures; avoid
//! that codegen path by returning Env::spawn_future from synchronous methods.
#![deny(clippy::unwrap_used)]
use cursor_core::{Engine, RunningStream};
use napi::{Env, Error, JsObject, Result, Status};
use napi_derive::napi;
use std::sync::Arc;

fn error(message: &'static str) -> Error {
    Error::new(Status::GenericFailure, message)
}

#[napi]
pub fn native_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[napi(js_name = "NativeEngine")]
pub struct NativeEngine {
    core: Engine,
}

#[napi]
impl NativeEngine {
    #[napi(constructor)]
    pub fn new() -> Result<Self> {
        Ok(Self {
            core: Engine::new()
                .map_err(|_| error("Cannot initialize Rust Cursor engine or TLS trust roots"))?,
        })
    }
    #[napi]
    pub fn start(&self, env: Env, request: String, access_token: String) -> Result<JsObject> {
        let engine = self.core.clone();
        env.spawn_future(async move {
            if request.len() > 64 * 1024 * 1024 {
                return Err(error("Cursor host request exceeds 64 MiB"));
            }
            let input =
                serde_json::from_str(&request).map_err(|_| error("Invalid Cursor host request"))?;
            let core = engine
                .start(input, access_token)
                .await
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            Ok(NativeStream {
                core: Arc::new(core),
            })
        })
    }
    #[napi(js_name = "listModels")]
    pub fn list_models(
        &self,
        env: Env,
        access_token: String,
        url: Option<String>,
    ) -> Result<JsObject> {
        let engine = self.core.clone();
        env.spawn_future(async move {
            let models = engine
                .models(access_token, url)
                .await
                .map_err(|_| error("Rust Cursor model discovery failed"))?;
            serde_json::to_string(&models)
                .map_err(|_| error("Cannot encode Cursor model inventory"))
        })
    }
    /// JSON from the single read-only GetCurrentPeriodUsage endpoint.
    #[napi(js_name = "getUsage")]
    pub fn get_usage(&self, env: Env, access_token: String) -> Result<JsObject> {
        let engine = self.core.clone();
        env.spawn_future(async move {
            let usage = engine
                .get_usage(access_token)
                .await
                .map_err(|_| error("Rust Cursor usage lookup failed"))?;
            serde_json::to_string(&usage).map_err(|_| error("Cannot encode Cursor usage"))
        })
    }
    #[napi]
    pub fn remove(&self, env: Env, scope: String) -> Result<JsObject> {
        let engine = self.core.clone();
        env.spawn_future(async move {
            engine
                .remove(&scope)
                .await
                .map_err(|_| error("Cannot remove Rust Cursor scope safely"))
        })
    }
    #[napi]
    pub fn shutdown(&self) {
        self.core.shutdown();
    }
}

#[napi(js_name = "NativeStream")]
pub struct NativeStream {
    core: Arc<RunningStream>,
}

impl Drop for NativeStream {
    fn drop(&mut self) {
        self.core.cancel();
    }
}

#[napi]
impl NativeStream {
    #[napi(js_name = "nextEvent")]
    pub fn next_event(&self, env: Env) -> Result<JsObject> {
        let stream = self.core.clone();
        env.spawn_future(async move {
            stream
                .next()
                .await
                .map(|e| {
                    serde_json::to_string(&e).map_err(|_| error("Cannot encode Rust Cursor event"))
                })
                .transpose()
        })
    }
    #[napi]
    pub fn cancel(&self) {
        self.core.cancel();
    }
    #[napi(js_name = "setAccessToken")]
    pub fn set_access_token(&self, env: Env, token: String) -> Result<JsObject> {
        let stream = self.core.clone();
        env.spawn_future(async move {
            stream
                .set_access_token(token)
                .await
                .map_err(|_| error("Cursor token refresh is not pending"))
        })
    }
}
