use std::collections::HashSet;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_MODEL_PARAMETERS: usize = 64;
const MAX_MODEL_PARAMETER_ID_BYTES: usize = 128;
const MAX_MODEL_PARAMETER_VALUE_BYTES: usize = 4096;
const MAX_MODEL_PARAMETER_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelParameter {
    pub id: String,
    pub value: String,
}

/// Validate caller-supplied and discovered parameter sets identically. Values
/// remain opaque strings: only advertised combinations may be routed by hosts.
pub fn validate_model_parameters(parameters: &[ModelParameter]) -> Result<()> {
    ensure!(
        parameters.len() <= MAX_MODEL_PARAMETERS,
        "Too many Cursor model parameters"
    );
    let mut ids = HashSet::new();
    let mut bytes = 0;
    for parameter in parameters {
        ensure!(
            !parameter.id.is_empty()
                && parameter.id.trim() == parameter.id
                && parameter.id.len() <= MAX_MODEL_PARAMETER_ID_BYTES
                && !parameter.id.chars().any(char::is_control),
            "Invalid Cursor model parameter id"
        );
        ensure!(
            parameter.value.len() <= MAX_MODEL_PARAMETER_VALUE_BYTES
                && !parameter.value.chars().any(char::is_control),
            "Invalid Cursor model parameter value"
        );
        ensure!(
            ids.insert(&parameter.id),
            "Duplicate Cursor model parameter id"
        );
        bytes += parameter.id.len() + parameter.value.len();
    }
    ensure!(
        bytes <= MAX_MODEL_PARAMETER_BYTES,
        "Cursor model parameters are too large"
    );
    Ok(())
}

fn deserialize_model_parameters<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<ModelParameter>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let parameters = Vec::<ModelParameter>::deserialize(deserializer)?;
    validate_model_parameters(&parameters).map_err(serde::de::Error::custom)?;
    Ok(parameters)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub scope: String,
    pub model_id: String,
    #[serde(default, deserialize_with = "deserialize_model_parameters")]
    pub model_parameters: Vec<ModelParameter>,
    #[serde(default)]
    pub max_mode: bool,
    pub workspace: String,
    pub prompt: Vec<Value>,
    #[serde(default)]
    pub tools: Vec<Value>,
    #[serde(default = "default_tool_choice")]
    pub tool_choice: String,
    pub reasoning: Option<String>,
    #[serde(default)]
    pub stateless: bool,
    pub agent_url: Option<String>,
    pub cache_dir: Option<String>,
    pub idle_timeout_ms: Option<u64>,
    pub connect_timeout_ms: Option<u64>,
    pub max_retries: Option<u32>,
}
fn default_tool_choice() -> String {
    "auto".to_owned()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    pub exec_id: String,
    pub exec_message_id: u32,
    pub tool_call_id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Clone, Default)]
pub struct WireContext {
    pub blobs: std::collections::HashMap<String, Vec<u8>>,
    pub tools: Vec<Value>,
    pub workspace: String,
    /// Advances whenever `blobs` gains or replaces content: the only durable state a
    /// server message can change. Reads and rejected execs leave it untouched.
    pub blob_generation: u64,
}

#[derive(Debug)]
pub enum ServerAction {
    Text(String),
    Reasoning(String),
    Tokens(u64),
    Reply(Vec<u8>),
    Tool(PendingTool),
    Checkpoint(Vec<u8>),
    Finished,
    RejectedLocal,
    Liveness,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_input_defaults_and_structured_parameters_are_bounded() -> Result<()> {
        let legacy = json!({"scope":"test", "modelId":"auto", "workspace":"/tmp", "prompt":[]});
        let input: StartInput = serde_json::from_value(legacy.clone())?;
        assert!(input.model_parameters.is_empty() && !input.max_mode);
        let mut explicit = legacy.clone();
        explicit["maxMode"] = json!(true);
        explicit["modelParameters"] = json!([{"id":"reasoning", "value":"extra-high"}]);
        let input: StartInput = serde_json::from_value(explicit.clone())?;
        assert!(input.max_mode);
        assert_eq!(
            input.model_parameters,
            vec![ModelParameter {
                id: "reasoning".into(),
                value: "extra-high".into()
            }]
        );
        assert_eq!(
            serde_json::to_value(&input.model_parameters)?,
            explicit["modelParameters"]
        );
        for parameters in [
            json!([{"id":"reasoning", "value":"low"}, {"id":"reasoning", "value":"high"}]),
            json!([{"id":"reasoning", "value":true}]),
            json!([{"id":"", "value":"high"}]),
            json!([{"id":" reasoning", "value":"high"}]),
            json!([{"id":"reasoning", "value":"x".repeat(MAX_MODEL_PARAMETER_VALUE_BYTES + 1)}]),
            json!([{"id":"x".repeat(MAX_MODEL_PARAMETER_ID_BYTES + 1), "value":"high"}]),
            json!([{"id":"reasoning", "value":"high\n"}]),
            json!((0..=MAX_MODEL_PARAMETERS)
                .map(|n| ModelParameter {
                    id: n.to_string(),
                    value: "a".into()
                })
                .collect::<Vec<_>>()),
            json!((0..5)
                .map(|n| ModelParameter {
                    id: n.to_string(),
                    value: "x".repeat(MAX_MODEL_PARAMETER_VALUE_BYTES)
                })
                .collect::<Vec<_>>()),
        ] {
            let mut invalid = legacy.clone();
            invalid["modelParameters"] = parameters;
            assert!(serde_json::from_value::<StartInput>(invalid).is_err());
        }
        Ok(())
    }
}
