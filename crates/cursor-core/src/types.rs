use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub scope: String,
    pub model_id: String,
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
