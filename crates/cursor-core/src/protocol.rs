//! Cursor's unframed protobuf protocol. This module only transforms bytes and
//! JSON: host tools are returned to the caller, never executed here.

use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use prost::Message;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    pb,
    types::{PendingTool, ServerAction, StartInput, WireContext},
};

const MAX_BLOBS: usize = 512;
const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;
const MAX_STORE_BYTES: usize = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOOL_TEXT_BYTES: usize = 512 * 1024;
const MAX_TOOL_RESULT_BYTES: usize = 16 * 1024 * 1024;
const MCP_PREFIX: &str = "mcp_pi_";
const DENIED: &str = "Not available through the OpenCode Cursor provider. No operation was performed. Use the registered host MCP tools instead; follow their input schemas. Do not retry native Cursor tools.";

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}

fn blob_usage(blobs: &HashMap<String, Vec<u8>>) -> Result<usize> {
    ensure!(
        blobs.len() <= MAX_BLOBS,
        "Cursor blob store exceeds {MAX_BLOBS} entries"
    );
    let mut total = 0usize;
    for blob in blobs.values() {
        ensure!(
            blob.len() <= MAX_BLOB_BYTES,
            "Cursor blob exceeds {MAX_BLOB_BYTES} bytes"
        );
        total = total
            .checked_add(blob.len())
            .context("Cursor blob byte count overflow")?;
    }
    ensure!(
        total <= MAX_STORE_BYTES,
        "Cursor blob store exceeds {MAX_STORE_BYTES} bytes"
    );
    Ok(total)
}

fn check_blob_capacity(
    entries: usize,
    bytes: usize,
    old_size: Option<usize>,
    size: usize,
) -> Result<usize> {
    ensure!(
        size <= MAX_BLOB_BYTES,
        "Cursor blob exceeds the {MAX_BLOB_BYTES} byte per-blob limit"
    );
    ensure!(
        entries + usize::from(old_size.is_none()) <= MAX_BLOBS,
        "Cursor blob store would exceed {MAX_BLOBS} entries; retained history was not evicted"
    );
    let total = bytes
        .checked_sub(old_size.unwrap_or(0))
        .and_then(|n| n.checked_add(size))
        .context("Cursor blob byte count overflow")?;
    ensure!(
        total <= MAX_STORE_BYTES,
        "Cursor blob store would exceed {MAX_STORE_BYTES} bytes; retained history was not evicted"
    );
    Ok(total)
}

// Stage newly built blobs so an invalid prompt or a full store leaves the
// caller's checkpoint, tool registry and existing blobs entirely unchanged.
struct BlobBatch<'a> {
    existing: &'a HashMap<String, Vec<u8>>,
    added: HashMap<String, Vec<u8>>,
    bytes: usize,
}
impl<'a> BlobBatch<'a> {
    fn new(existing: &'a HashMap<String, Vec<u8>>) -> Result<Self> {
        Ok(Self {
            existing,
            added: HashMap::new(),
            bytes: blob_usage(existing)?,
        })
    }
    fn store(&mut self, data: Vec<u8>) -> Result<Vec<u8>> {
        let id = Sha256::digest(&data).to_vec();
        let key = hex(&id);
        if let Some(old) = self.added.get(&key).or_else(|| self.existing.get(&key)) {
            ensure!(
                *old == data,
                "Cursor blob hash collision or corrupt stored blob"
            );
            return Ok(id);
        }
        self.bytes = check_blob_capacity(
            self.existing.len() + self.added.len(),
            self.bytes,
            None,
            data.len(),
        )?;
        self.added.insert(key, data);
        Ok(id)
    }
}

fn json_to_prost(value: &Value) -> Result<prost_types::Value> {
    fn convert(value: &Value, depth: usize) -> Result<prost_types::Value> {
        use prost_types::value::Kind;
        ensure!(depth <= 64, "JSON value exceeds protobuf nesting limit");
        let kind = match value {
            Value::Null => Kind::NullValue(0),
            Value::Bool(value) => Kind::BoolValue(*value),
            Value::Number(value) => {
                Kind::NumberValue(value.as_f64().context("Invalid protobuf JSON number")?)
            }
            Value::String(value) => Kind::StringValue(value.clone()),
            Value::Array(values) => Kind::ListValue(prost_types::ListValue {
                values: values
                    .iter()
                    .map(|v| convert(v, depth + 1))
                    .collect::<Result<_>>()?,
            }),
            Value::Object(values) => Kind::StructValue(prost_types::Struct {
                fields: values
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), convert(v, depth + 1)?)))
                    .collect::<Result<_>>()?,
            }),
        };
        Ok(prost_types::Value { kind: Some(kind) })
    }
    convert(value, 0)
}

fn prost_to_json(value: prost_types::Value) -> Result<Value> {
    fn convert(value: prost_types::Value, depth: usize) -> Result<Value> {
        use prost_types::value::Kind;
        ensure!(depth <= 64, "Protobuf Value exceeds JSON nesting limit");
        Ok(
            match value
                .kind
                .context("MCP argument has no protobuf Value kind")?
            {
                Kind::NullValue(0) => Value::Null,
                Kind::NullValue(_) => bail!("Invalid protobuf null value"),
                Kind::BoolValue(v) => Value::Bool(v),
                Kind::NumberValue(v) => {
                    // protobuf Value uses doubles; serialize integral values as JSON
                    // integers just as protobuf-es does, without changing their value.
                    ensure!(v.is_finite(), "Non-finite MCP argument number");
                    if v.fract() == 0.0 && v >= i64::MIN as f64 && v < i64::MAX as f64 {
                        json!(v as i64)
                    } else {
                        json!(v)
                    }
                }
                Kind::StringValue(v) => Value::String(v),
                Kind::ListValue(v) => Value::Array(
                    v.values
                        .into_iter()
                        .map(|v| convert(v, depth + 1))
                        .collect::<Result<_>>()?,
                ),
                Kind::StructValue(v) => Value::Object(
                    v.fields
                        .into_iter()
                        .map(|(k, v)| Ok((k, convert(v, depth + 1)?)))
                        .collect::<Result<_>>()?,
                ),
            },
        )
    }
    convert(value, 0)
}

#[derive(Clone)]
struct ToolDefinition {
    name: String,
    description: String,
    schema: Value,
}

fn tool_definitions(tools: &[Value]) -> Result<Vec<ToolDefinition>> {
    let mut names = HashSet::new();
    tools
        .iter()
        .map(|tool| {
            let object = tool
                .as_object()
                .context("Host tool definition must be an object")?;
            if let Some(kind) = object.get("type") {
                ensure!(
                    kind.as_str() == Some("function"),
                    "Only host function tools are supported"
                );
            }
            let function = object.get("function").unwrap_or(tool);
            ensure!(
                function.is_object(),
                "Host function definition must be an object"
            );
            let name = required_str(function, "name")?.trim().to_owned();
            ensure!(!name.is_empty(), "Host tool name is empty");
            ensure!(
                names.insert(name.clone()),
                "Duplicate host tool name: {name}"
            );
            let schema = function
                .get("inputSchema")
                .or_else(|| function.get("parameters"))
                .cloned()
                .unwrap_or_else(|| json!({"type":"object","properties":{},"required":[]}));
            ensure!(
                schema.is_object(),
                "Tool inputSchema must be a JSON Schema object: {name}"
            );
            // Keep the entire executable contract (including descriptions, required,
            // additionalProperties, defaults, refs and extension keywords) in both fields.
            json_to_prost(&schema)?;
            Ok(ToolDefinition {
                name,
                schema,
                description: function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            })
        })
        .collect()
}

// A faithful port of cursorMcpToolNames: namespace exactly once without
// shadowing a host tool literally named, for example, `mcp_pi_bash`.
struct ToolNames {
    registered: Vec<String>,
    wire_by_name: HashMap<String, String>,
    name_by_wire: HashMap<String, String>,
}
impl ToolNames {
    fn new(tools: &[ToolDefinition]) -> Self {
        let registered: Vec<_> = tools.iter().map(|t| t.name.clone()).collect();
        let mut wire_by_name = HashMap::new();
        let mut name_by_wire = HashMap::new();
        for name in &registered {
            if !name.starts_with(MCP_PREFIX) {
                wire_by_name.insert(name.clone(), name.clone());
                name_by_wire.insert(name.clone(), name.clone());
            }
        }
        for name in &registered {
            if wire_by_name.contains_key(name) {
                continue;
            }
            let base = name.trim_start_matches(MCP_PREFIX);
            let base = if base.is_empty() { "tool" } else { base };
            let mut wire = base.to_owned();
            let mut n = 2;
            while name_by_wire.contains_key(&wire) {
                wire = format!("{base}_{n}");
                n += 1;
            }
            name_by_wire.insert(wire.clone(), name.clone());
            wire_by_name.insert(name.clone(), wire);
        }
        Self {
            registered,
            wire_by_name,
            name_by_wire,
        }
    }
    fn wire<'a>(&'a self, name: &'a str) -> &'a str {
        self.wire_by_name
            .get(name)
            .map(String::as_str)
            .unwrap_or(name)
    }
    fn advertised(&self, name: &str) -> String {
        if self.wire_by_name.contains_key(name) {
            format!("{MCP_PREFIX}{}", self.wire(name))
        } else if name.starts_with(MCP_PREFIX) {
            name.to_owned()
        } else {
            format!("{MCP_PREFIX}{name}")
        }
    }
    fn resolve(&self, name: &str) -> Option<String> {
        let name = name.trim();
        let unprefixed = name.strip_prefix(MCP_PREFIX);
        unprefixed
            .and_then(|n| self.name_by_wire.get(n))
            .or_else(|| self.name_by_wire.get(name))
            .or_else(|| self.registered.iter().find(|n| n.as_str() == name))
            .or_else(|| unprefixed.and_then(|n| self.registered.iter().find(|r| r.as_str() == n)))
            .or_else(|| {
                unprefixed
                    .and_then(|n| n.strip_prefix(MCP_PREFIX))
                    .and_then(|n| self.name_by_wire.get(n))
            })
            .cloned()
    }
}

fn wire_tools(
    tools: &[ToolDefinition],
    names: &ToolNames,
    advertised: bool,
) -> Result<Vec<pb::McpToolDefinition>> {
    tools
        .iter()
        .map(|tool| {
            Ok(pb::McpToolDefinition {
                name: names.wire(&tool.name).to_owned(),
                tool_name: if advertised {
                    names.advertised(&tool.name)
                } else {
                    names.wire(&tool.name).to_owned()
                },
                provider_identifier: "pi".to_owned(),
                description: tool.description.clone(),
                input_schema: Some(json_to_prost(&tool.schema)?),
                input_schema_json: Some(serde_json::to_string(&tool.schema)?),
            })
        })
        .collect()
}

fn local_policy(names: &ToolNames) -> String {
    let tools = names
        .registered
        .iter()
        .map(|name| names.advertised(name))
        .collect::<Vec<_>>()
        .join(", ");
    format!("Local file reads, searches, directory listings, writes, deletions and shell commands must use host MCP tools. Native Cursor local tools are disabled; do not call or retry them. Native network requests and hosted web approvals are also disabled. {}",
        if tools.is_empty() { "No host MCP tools are exposed for this request. Local operations are unavailable in this request.".to_owned() }
        else { format!("Registered host MCP tools: {tools}. Follow each tool's full input schema. If none supports an operation, report that limitation.") })
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Expected string field {key}"))
}
fn nonempty_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let text = required_str(value, key)?;
    ensure!(!text.trim().is_empty(), "Empty field {key}");
    Ok(text)
}

#[derive(Clone)]
struct Image {
    bytes: Vec<u8>,
    mime: String,
}
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if bytes.starts_with(b"GIF") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
fn normalize_mime(mime: &str) -> String {
    let mime = mime.trim().to_ascii_lowercase();
    if mime == "image/jpg" {
        "image/jpeg".to_owned()
    } else {
        mime
    }
}
fn inline_image(part: &Value) -> Result<Image> {
    let mime = part
        .get("mediaType")
        .or_else(|| part.get("mimeType"))
        .and_then(Value::as_str)
        .context("Inline image requires mediaType")?;
    let mime = normalize_mime(mime);
    ensure!(
        ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime.as_str()),
        "Only inline PNG/JPEG/GIF/WebP attachments are supported"
    );
    let data = part
        .get("data")
        .context("Image data is missing; URL/path attachments are not supported")?;
    let bytes = if let Some(text) = data.as_str() {
        ensure!(
            text.len() <= (MAX_IMAGE_BYTES * 4).div_ceil(3) + 1024,
            "Inline image exceeds 5 MiB encoded limit"
        );
        let base64 = if let Some(url) = text.strip_prefix("data:") {
            let (header, body) = url
                .split_once(',')
                .context("Invalid inline image data URL")?;
            let declared = header
                .strip_suffix(";base64")
                .context("Only base64 inline image data URLs are supported")?;
            ensure!(
                normalize_mime(declared) == mime,
                "Image data URL mediaType mismatch"
            );
            body
        } else {
            text
        };
        let compact;
        let base64 = if !base64.bytes().any(|c| c.is_ascii_whitespace()) {
            base64
        } else {
            compact = base64
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>();
            &compact
        };
        general_purpose::STANDARD
            .decode(base64)
            .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(base64))
            .context("Invalid inline image base64; URLs and file paths are never fetched or read")?
    } else {
        let array = data
            .as_array()
            .or_else(|| {
                if data.get("type").and_then(Value::as_str) == Some("Buffer") {
                    data.get("data").and_then(Value::as_array)
                } else {
                    None
                }
            })
            .context(
                "Image data must be inline base64 or a byte array, never a URL or file path",
            )?;
        ensure!(array.len() <= MAX_IMAGE_BYTES, "Inline image exceeds 5 MiB");
        array
            .iter()
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n <= 255)
                    .map(|n| n as u8)
                    .context("Invalid inline image byte")
            })
            .collect::<Result<Vec<_>>>()?
    };
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES,
        "Invalid or oversized inline image (maximum 5 MiB)"
    );
    let sniffed =
        image_mime(&bytes).context("Unsupported image bytes: expected PNG/JPEG/GIF/WebP")?;
    ensure!(sniffed == mime, "Image bytes do not match mediaType");
    Ok(Image { bytes, mime })
}

#[derive(Clone, Default)]
struct ParsedResult {
    text: String,
    images: Vec<Image>,
    error: bool,
    denied: bool,
}
fn bounded_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let suffix = format!("\n\n[OpenCode Cursor truncated this tool result from {} bytes. Use a narrower command, path, or line range.]", text.len());
    let mut end = max.saturating_sub(suffix.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}
fn parse_result(value: &Value) -> Result<ParsedResult> {
    // Accept either an AI SDK output or the enclosing V3 tool-result part.
    let value = if value.get("type").and_then(Value::as_str) == Some("tool-result") {
        value
            .get("output")
            .context("Tool result output is missing")?
    } else {
        value
    };
    let mut result = ParsedResult::default();
    match required_str(value, "type")? {
        "text" => result.text = required_str(value, "value")?.to_owned(),
        "json" => {
            result.text =
                serde_json::to_string(value.get("value").context("Missing JSON tool output")?)?
        }
        "error-text" => {
            result.error = true;
            result.text = required_str(value, "value")?.to_owned();
        }
        "error-json" => {
            result.error = true;
            result.text =
                serde_json::to_string(value.get("value").context("Missing JSON error output")?)?;
        }
        "execution-denied" => {
            result.error = true;
            result.denied = true;
            result.text = format!(
                "OpenCode denied tool execution: {}",
                value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("permission denied")
            );
        }
        "content" => {
            let parts = value
                .get("value")
                .and_then(Value::as_array)
                .context("Tool output content must be an array")?;
            let mut texts = Vec::new();
            for part in parts {
                match required_str(part, "type")? {
                    "text" => texts.push(required_str(part, "text")?.to_owned()),
                    "image-data" | "file-data" | "image" => result.images.push(inline_image(part)?),
                    kind => bail!("Unsupported referenced tool-result media: {kind}; attach inline image data"),
                }
            }
            result.text = texts.join("\n");
        }
        kind => bail!("Unsupported AI SDK tool output: {kind}"),
    }
    result.text = bounded_text(&result.text, MAX_TOOL_TEXT_BYTES);
    let image_bytes = result
        .images
        .iter()
        .try_fold(result.text.len(), |n, image| {
            n.checked_add(image.bytes.len() + image.mime.len())
                .context("Tool output size overflow")
        })?;
    ensure!(
        image_bytes <= MAX_TOOL_RESULT_BYTES,
        "Tool output exceeds {MAX_TOOL_RESULT_BYTES} bytes; reduce inline image output"
    );
    Ok(result)
}
fn result_content(result: &ParsedResult) -> Vec<pb::McpToolResultContentItem> {
    use pb::mcp_tool_result_content_item::Content;
    let mut content = Vec::new();
    if !result.text.is_empty() || result.images.is_empty() {
        content.push(pb::McpToolResultContentItem {
            content: Some(Content::Text(pb::McpTextContent {
                text: result.text.clone(),
                ..Default::default()
            })),
        });
    }
    content.extend(
        result
            .images
            .iter()
            .map(|image| pb::McpToolResultContentItem {
                content: Some(Content::Image(pb::McpImageContent {
                    data: image.bytes.clone(),
                    mime_type: image.mime.clone(),
                })),
            }),
    );
    content
}

/// Collect host-supplied V3 outputs, keyed by the original tool-call id. This
/// never treats an absent output, approval request, or unknown media as success.
pub fn parse_tool_results(input: &StartInput) -> Result<HashMap<String, Value>> {
    let mut results = HashMap::new();
    for message in &input.prompt {
        let role = required_str(message, "role")?;
        if role != "tool" && role != "assistant" {
            continue;
        }
        let parts = message
            .get("content")
            .and_then(Value::as_array)
            .context("Assistant/tool content must be an array")?;
        for part in parts {
            if part.get("type").and_then(Value::as_str) != Some("tool-result") {
                ensure!(
                    role != "tool",
                    "Unsupported tool approval/content; use host tools"
                );
                continue;
            }
            let id = nonempty_str(part, "toolCallId")?;
            let output = part.get("output").context("Tool result has no output")?;
            parse_result(output)?;
            if let Some(old) = results.insert(id.to_owned(), output.clone()) {
                ensure!(old == *output, "Conflicting tool results for call {id}");
            }
        }
    }
    Ok(results)
}

#[derive(Default)]
struct Turn {
    text: String,
    images: Vec<Image>,
    steps: Vec<Step>,
}
enum Step {
    Text(String),
    Thinking(String),
    Tool {
        id: String,
        name: String,
        input: Value,
        result: Option<ParsedResult>,
    },
}
struct Transcript {
    system: String,
    turns: Vec<Turn>,
    current: Option<Turn>,
}
fn parse_transcript(input: &StartInput) -> Result<Transcript> {
    let outputs = parse_tool_results(input)?;
    let mut system = Vec::new();
    let mut turns = Vec::<Turn>::new();
    let mut current: Option<Turn> = None;
    let mut call_ids = HashSet::new();
    let mut ended_with_user = false;
    for message in &input.prompt {
        match required_str(message, "role")? {
            "system" => {
                system.push(required_str(message, "content")?.to_owned());
                continue;
            }
            "user" => {
                if let Some(turn) = current.take() {
                    turns.push(turn);
                }
                let mut turn = Turn::default();
                let content = message.get("content").context("Missing user content")?;
                if let Some(text) = content.as_str() {
                    turn.text = text.to_owned();
                } else {
                    let mut texts = Vec::new();
                    for part in content
                        .as_array()
                        .context("User content must be text or an array")?
                    {
                        match required_str(part, "type")? {
                            "text" => texts.push(required_str(part, "text")?.to_owned()),
                            "file" | "image" => turn.images.push(inline_image(part)?),
                            kind => bail!("Unsupported user content: {kind}; only text and inline images are supported"),
                        }
                    }
                    turn.text = texts.join("\n");
                }
                current = Some(turn);
                ended_with_user = true;
            }
            "assistant" => {
                ended_with_user = false;
                let turn = current.get_or_insert_with(Turn::default);
                let parts = message
                    .get("content")
                    .and_then(Value::as_array)
                    .context("Assistant content must be an array")?;
                for part in parts {
                    match required_str(part, "type")? {
                        "text" => turn
                            .steps
                            .push(Step::Text(required_str(part, "text")?.to_owned())),
                        "reasoning" => turn
                            .steps
                            .push(Step::Thinking(required_str(part, "text")?.to_owned())),
                        "tool-call" => {
                            ensure!(
                                part.get("providerExecuted").and_then(Value::as_bool) != Some(true),
                                "Provider-executed tools cannot be replayed as host tools"
                            );
                            let id = nonempty_str(part, "toolCallId")?.to_owned();
                            ensure!(
                                call_ids.insert(id.clone()),
                                "Duplicate tool-call id in transcript: {id}"
                            );
                            let name = nonempty_str(part, "toolName")?.to_owned();
                            let args = part.get("input").context("Tool-call input is missing")?;
                            ensure!(args.is_object(), "Tool-call input must be a JSON object");
                            let result = outputs.get(&id).map(parse_result).transpose()?;
                            turn.steps.push(Step::Tool {
                                id,
                                name,
                                input: args.clone(),
                                result,
                            });
                        }
                        "tool-result" => {} // Already paired by id, not executed or fabricated.
                        kind => bail!("Unsupported assistant content: {kind}"),
                    }
                }
            }
            "tool" => {
                ended_with_user = false;
            }
            role => bail!("Unsupported prompt role: {role}"),
        }
    }
    // Orphan result-only messages may be supplied when continuing a journaled
    // exec. The journal handles them; rebuilding history cannot invent its args.
    for id in outputs.keys() {
        ensure!(
            call_ids.contains(id),
            "Cannot rebuild history for tool result {id} without its assistant tool call"
        );
    }
    let current = if ended_with_user {
        current
    } else {
        if let Some(turn) = current {
            turns.push(turn);
        }
        None
    };
    ensure!(
        current.is_some() || !turns.is_empty(),
        "Prompt has no conversation messages"
    );
    Ok(Transcript {
        system: if system.is_empty() {
            "You are a helpful assistant.".to_owned()
        } else {
            system.join("\n\n")
        },
        turns,
        current,
    })
}

// The selected-context *blob* is not SelectedContext. Cursor reads these two
// raw fields (references at #1 and client name at #22).
#[derive(Clone, PartialEq, Message)]
struct SelectedContextBlob {
    #[prost(bytes = "vec", repeated, tag = "1")]
    roots: Vec<Vec<u8>>,
    #[prost(string, tag = "22")]
    client_name: String,
}
// Domain-separated, length-prefixed content identities remain UUID-shaped
// without depending on randomness, clock time or a checkpoint's mutable state.
fn stable_id(domain: &str, parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in std::iter::once(domain.as_bytes()).chain(parts.iter().copied()) {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&hash.finalize()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // RFC 9562 UUIDv8 (custom SHA-256 identity).
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}
fn user_message(
    turn: &Turn,
    context_blob: &[u8],
    conversation_id: &str,
    turn_index: usize,
) -> pb::UserMessage {
    // Exclude assistant steps and selected-context roots: a current user turn
    // retains its identity when promoted to history or overlaid on a checkpoint.
    let index = (turn_index as u64).to_be_bytes();
    let mut identity = vec![
        conversation_id.as_bytes(),
        index.as_slice(),
        turn.text.as_bytes(),
    ];
    for image in &turn.images {
        identity.push(image.mime.as_bytes());
        identity.push(&image.bytes);
    }
    let id = stable_id("opencode-cursor/user-message/v1", &identity);
    pb::UserMessage {
        text: turn.text.clone(),
        message_id: id.clone(),
        correlation_id: id.clone(),
        mode: 1,
        selected_context_blob: context_blob.to_vec(),
        selected_context: Some(pb::SelectedContext {
            selected_images: turn
                .images
                .iter()
                .enumerate()
                .map(|(index, image)| pb::SelectedImage {
                    uuid: stable_id(
                        "opencode-cursor/selected-image/v1",
                        &[id.as_bytes(), &(index as u64).to_be_bytes()],
                    ),
                    mime_type: image.mime.clone(),
                    data_or_blob_id: Some(pb::selected_image::DataOrBlobId::Data(
                        image.bytes.clone(),
                    )),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }),
        ..Default::default()
    }
}
fn encode_step(step: &Step, names: &ToolNames) -> Result<Vec<u8>> {
    use pb::conversation_step::Message as StepMessage;
    let message = match step {
        Step::Text(text) => {
            StepMessage::AssistantMessage(pb::AssistantMessage { text: text.clone() })
        }
        Step::Thinking(text) => StepMessage::ThinkingMessage(pb::ThinkingMessage {
            text: text.clone(),
            ..Default::default()
        }),
        Step::Tool {
            id,
            name,
            input,
            result,
        } => {
            let mut arguments = input
                .as_object()
                .context("Tool-call input must be an object")?
                .iter()
                .collect::<Vec<_>>();
            arguments.sort_unstable_by_key(|(key, _)| *key);
            let mut args = pb::McpArgs {
                name: names.wire(name).to_owned(),
                tool_name: names.wire(name).to_owned(),
                provider_identifier: "pi".to_owned(),
                tool_call_id: id.clone(),
                ..Default::default()
            }
            .encode_to_vec();
            // prost's generated HashMap encodes in random iteration order.
            // Emit map entries deterministically or unchanged tool history
            // still produces fresh step/turn blobs on every rebuild.
            for (key, value) in arguments {
                let mut entry = Vec::new();
                bytes_field(&mut entry, 1, key.as_bytes());
                bytes_field(&mut entry, 2, &json_to_prost(value)?.encode_to_vec());
                bytes_field(&mut args, 2, &entry);
            }
            let result = result.as_ref().map(|result| pb::McpToolResult {
                result: Some(if result.denied {
                    pb::mcp_tool_result::Result::Rejected(pb::McpRejected {
                        reason: result.text.clone(),
                        is_readonly: false,
                    })
                } else if result.error {
                    pb::mcp_tool_result::Result::Error(pb::McpToolError {
                        error: result.text.clone(),
                    })
                } else {
                    pb::mcp_tool_result::Result::Success(pb::McpSuccess {
                        content: result_content(result),
                        is_error: false,
                    })
                }),
            });
            let mut call = pb::McpToolCall { args: None, result }.encode_to_vec();
            bytes_field(&mut call, 1, &args);
            let mut tool = Vec::new();
            bytes_field(&mut tool, 15, &call); // ToolCall.mcp_tool_call.
            let mut step = Vec::new();
            bytes_field(&mut step, 2, &tool); // ConversationStep.tool_call.
            return Ok(step);
        }
    };
    Ok(pb::ConversationStep {
        message: Some(message),
    }
    .encode_to_vec())
}
fn root_messages(turn: &Turn, names: &ToolNames) -> Vec<Value> {
    let mut messages = Vec::new();
    let image_note = if turn.images.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n[{} image attachment(s) from this earlier turn are not replayed.]",
            turn.images.len()
        )
    };
    if !turn.text.trim().is_empty() || !image_note.is_empty() {
        messages.push(json!({"role":"user","content":[{"type":"text","text":format!("<user_query>\n{}{}\n</user_query>", turn.text.trim(), image_note)}]}));
    }
    let mut assistant = Vec::<Value>::new();
    let mut results = Vec::<Value>::new();
    fn flush(messages: &mut Vec<Value>, assistant: &mut Vec<Value>, results: &mut Vec<Value>) {
        if !assistant.is_empty() {
            messages.push(json!({"role":"assistant","content":std::mem::take(assistant)}));
        }
        if !results.is_empty() {
            messages.push(json!({"role":"tool","content":std::mem::take(results)}));
        }
    }
    for step in &turn.steps {
        match step {
            Step::Thinking(_) => {} // Provider-signed reasoning is not portable.
            Step::Text(text) => {
                if text.is_empty() {
                    continue;
                }
                if !results.is_empty() {
                    flush(&mut messages, &mut assistant, &mut results);
                }
                assistant.push(json!({"type":"text","text":text}));
            }
            Step::Tool {
                id,
                name,
                input,
                result,
            } => {
                let name = names.advertised(name);
                assistant
                    .push(json!({"type":"tool-call","toolCallId":id,"toolName":name,"args":input}));
                if let Some(result) = result {
                    let mut text = result.text.clone();
                    if !result.images.is_empty() {
                        text.push_str(&format!(
                            "\n\n[{} image(s) in this earlier tool result are not replayed.]",
                            result.images.len()
                        ));
                    }
                    let mut text: String = text.chars().take(20_000).collect();
                    if result.text.chars().count() > 20_000 {
                        text.push_str("\n\n[OpenCode Cursor truncated this replayed tool result.]");
                    }
                    let mut part =
                        json!({"type":"tool-result","toolCallId":id,"toolName":name,"result":text});
                    if result.error {
                        part["isError"] = json!(true);
                    }
                    results.push(part);
                }
            }
        }
    }
    flush(&mut messages, &mut assistant, &mut results);
    messages
}
fn workspace_uri(workspace: &str) -> Result<String> {
    url::Url::from_file_path(workspace)
        .map(String::from)
        .map_err(|_| {
            anyhow!("Workspace must be an absolute path (no filesystem access is performed)")
        })
}
fn requested_model(input: &StartInput) -> Result<String> {
    let model = input.model_id.trim();
    ensure!(!model.is_empty(), "Model id is empty");
    let model = if model.eq_ignore_ascii_case("auto") {
        "default"
    } else {
        model
    };
    if let Some(effort) = input.reasoning.as_deref().filter(|s| !s.is_empty()) {
        ensure!(
            ["none", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&effort),
            "Unsupported reasoning effort"
        );
        let (base, suffix) = model
            .strip_suffix("-fast")
            .map(|m| (m, "-fast"))
            .or_else(|| model.strip_suffix("-thinking").map(|m| (m, "-thinking")))
            .unwrap_or((model, ""));
        return Ok(format!("{base}-{effort}{suffix}"));
    }
    Ok(model.to_owned())
}

/// Build AgentClientMessage.run_request. All blob references are SHA-256
/// addressed. A checkpoint never overrides the authoritative host transcript.
pub fn build_request(
    input: &StartInput,
    conversation_id: &str,
    checkpoint: Option<&[u8]>,
    context: &mut WireContext,
) -> Result<Vec<u8>> {
    ensure!(
        !conversation_id.trim().is_empty(),
        "Conversation id is empty"
    );
    ensure!(
        ["auto", "none"].contains(&input.tool_choice.as_str()),
        "Only auto/none tool choice is supported"
    );
    let tools_json = if input.tool_choice == "none" {
        Vec::new()
    } else {
        input.tools.clone()
    };
    let tools = tool_definitions(&tools_json)?;
    let names = ToolNames::new(&tools);
    let transcript = parse_transcript(input)?;
    let uri = workspace_uri(&input.workspace)?;
    let mut blobs = BlobBatch::new(&context.blobs)?;
    let system_blob = blobs.store(serde_json::to_vec(
        &json!({"role":"system","content":transcript.system}),
    )?)?;
    let selected = blobs.store(
        SelectedContextBlob {
            roots: vec![system_blob.clone()],
            client_name: "pi".to_owned(),
        }
        .encode_to_vec(),
    )?;
    let mut root_ids = vec![system_blob];
    let rules = format!(
        "<rules>\n{}\n\n{}\n</rules>",
        transcript.system,
        local_policy(&names)
    );
    root_ids.push(blobs.store(serde_json::to_vec(
        &json!({"role":"user","content":[{"type":"text","text":rules}]}),
    )?)?);
    let mut turn_ids = Vec::new();
    for (index, turn) in transcript.turns.iter().enumerate() {
        let message = user_message(turn, &selected, conversation_id, index);
        let request_id = stable_id(
            "opencode-cursor/request/v1",
            &[message.message_id.as_bytes()],
        );
        let user = blobs.store(message.encode_to_vec())?;
        let steps = turn
            .steps
            .iter()
            .map(|step| blobs.store(encode_step(step, &names)?))
            .collect::<Result<_>>()?;
        turn_ids.push(
            blobs.store(
                pb::ConversationTurnStructure {
                    turn: Some(
                        pb::conversation_turn_structure::Turn::AgentConversationTurn(
                            pb::AgentConversationTurnStructure {
                                user_message: user,
                                steps,
                                request_id: Some(request_id),
                            },
                        ),
                    ),
                }
                .encode_to_vec(),
            )?,
        );
        for message in root_messages(turn, &names) {
            root_ids.push(blobs.store(serde_json::to_vec(&message)?)?);
        }
    }
    let conversation_state = if let Some(checkpoint) = checkpoint {
        ensure!(
            checkpoint.len() <= MAX_BLOB_BYTES,
            "Checkpoint exceeds {MAX_BLOB_BYTES} bytes"
        );
        pb::ConversationStateStructure::decode(checkpoint).context("Invalid Cursor checkpoint")?;
        // Preserve unknown checkpoint fields too: prost ordinarily discards them.
        let mut state = Vec::new();
        for field in wire_fields(checkpoint)? {
            if field.number != 1 && field.number != 8 {
                state.extend_from_slice(field.raw);
            }
        }
        for id in &root_ids {
            bytes_field(&mut state, 1, id);
        }
        for id in &turn_ids {
            bytes_field(&mut state, 8, id);
        }
        state
    } else {
        pb::ConversationStateStructure {
            root_prompt_messages_json: root_ids,
            turns: turn_ids,
            previous_workspace_uris: vec![uri],
            mode: Some(1),
            client_name: "pi".to_owned(),
            ..Default::default()
        }
        .encode_to_vec()
    };
    let action = match transcript.current {
        Some(turn) => pb::conversation_action::Action::UserMessageAction(pb::UserMessageAction {
            user_message: Some(user_message(
                &turn,
                &selected,
                conversation_id,
                transcript.turns.len(),
            )),
            ..Default::default()
        }),
        // A result-ended transcript is a continuation, not another copy of the
        // original user question. Its complete history was overlaid above.
        None => pb::conversation_action::Action::ResumeAction(pb::ResumeAction {
            request_context: None,
        }),
    };
    let run = pb::AgentRunRequest {
        action: Some(pb::ConversationAction {
            action: Some(action),
        }),
        requested_model: Some(pb::RequestedModel {
            model_id: requested_model(input)?,
            ..Default::default()
        }),
        conversation_id: Some(conversation_id.to_owned()),
        mcp_tools: Some(pb::McpTools {
            mcp_tools: wire_tools(&tools, &names, false)?,
        }),
        ..Default::default()
    };
    let mut run_bytes = run.encode_to_vec();
    bytes_field(&mut run_bytes, 1, &conversation_state);
    let mut request = Vec::new();
    bytes_field(&mut request, 1, &run_bytes);
    context.blobs.extend(blobs.added);
    context.tools = tools_json;
    context.workspace = input.workspace.clone();
    Ok(request)
}

fn client(message: pb::agent_client_message::Message) -> Vec<u8> {
    pb::AgentClientMessage {
        message: Some(message),
    }
    .encode_to_vec()
}
fn exec_reply(exec: &pb::ExecServerMessage, message: pb::exec_client_message::Message) -> Vec<u8> {
    client(pb::agent_client_message::Message::ExecClientMessage(
        pb::ExecClientMessage {
            id: exec.id,
            exec_id: exec.exec_id.clone(),
            message: Some(message),
        },
    ))
}
fn exec_throw(exec: &pb::ExecServerMessage, error: &str) -> Vec<u8> {
    client(pb::agent_client_message::Message::ExecClientControlMessage(
        pb::ExecClientControlMessage {
            message: Some(pb::exec_client_control_message::Message::Throw(
                pb::ExecClientThrow {
                    id: exec.id,
                    error: error.to_owned(),
                    ..Default::default()
                },
            )),
        },
    ))
}

/// Convert a host's actual output into the result for its original exec. No
/// provider-side execution, fabricated completion, or remote image access.
pub fn tool_result(pending: &PendingTool, value: &Value) -> Result<Vec<u8>> {
    let parsed = parse_result(value)?;
    let result = if parsed.denied {
        pb::mcp_result::Result::Rejected(pb::McpRejected {
            reason: parsed.text,
            is_readonly: false,
        })
    } else if parsed.error {
        pb::mcp_result::Result::Error(pb::McpError { error: parsed.text })
    } else {
        pb::mcp_result::Result::Success(pb::McpSuccess {
            content: result_content(&parsed),
            is_error: false,
        })
    };
    Ok(client(
        pb::agent_client_message::Message::ExecClientMessage(pb::ExecClientMessage {
            id: pending.exec_message_id,
            exec_id: pending.exec_id.clone(),
            message: Some(pb::exec_client_message::Message::McpResult(pb::McpResult {
                result: Some(result),
            })),
        }),
    ))
}

pub fn cancel_message() -> Vec<u8> {
    client(pb::agent_client_message::Message::ConversationAction(
        pb::ConversationAction {
            action: Some(pb::conversation_action::Action::CancelAction(
                pb::CancelAction {},
            )),
        },
    ))
}

fn handle_exec(
    exec: pb::ExecServerMessage,
    raw: &[u8],
    context: &WireContext,
) -> Result<Vec<ServerAction>> {
    use pb::exec_client_message::Message as Out;
    use pb::exec_server_message::Message as In;
    // prost drops unknown oneof variants. Do not dispatch an earlier known
    // variant when a newer, unknown capability is also present on the wire.
    const KNOWN: &[u32] = &[
        1, 15, 19, 55, 2, 3, 4, 5, 7, 8, 9, 10, 11, 14, 16, 17, 18, 20, 21, 22, 23, 28, 32, 33, 34,
        35, 36,
    ];
    if wire_fields(raw)?.iter().any(|f| !KNOWN.contains(&f.number)) {
        return Ok(vec![
            ServerAction::Reply(exec_throw(
                &exec,
                &format!("Unsupported Cursor exec wire shape. {DENIED}"),
            )),
            ServerAction::RejectedLocal,
        ]);
    }
    let tools = tool_definitions(&context.tools)?;
    let names = ToolNames::new(&tools);
    let message = match exec.message.as_ref() {
        Some(message) => message,
        None => {
            return Ok(vec![
                ServerAction::Reply(exec_throw(&exec, &format!("Unknown Cursor exec. {DENIED}"))),
                ServerAction::RejectedLocal,
            ])
        }
    };
    let rejection = match message {
        In::RequestContextArgs(_) => {
            let request_context = pb::RequestContext {
                env: Some(pb::RequestContextEnv {
                    workspace_paths: vec![workspace_uri(&context.workspace)?],
                    ..Default::default()
                }),
                tools: wire_tools(&tools, &names, false)?,
                web_search_enabled: Some(false),
                ..Default::default()
            };
            return Ok(vec![ServerAction::Reply(exec_reply(
                &exec,
                Out::RequestContextResult(pb::RequestContextResult {
                    result: Some(pb::request_context_result::Result::Success(
                        pb::RequestContextSuccess {
                            request_context: Some(request_context),
                        },
                    )),
                }),
            ))]);
        }
        In::McpStateExecArgs(_) => {
            let servers = if tools.is_empty() {
                Vec::new()
            } else {
                vec![pb::McpStateServer {
                    server_name: "pi".to_owned(),
                    server_identifier: "pi".to_owned(),
                    tools: wire_tools(&tools, &names, true)?,
                    ..Default::default()
                }]
            };
            return Ok(vec![ServerAction::Reply(exec_reply(
                &exec,
                Out::McpStateExecResult(pb::McpStateExecResult {
                    result: Some(pb::mcp_state_exec_result::Result::Success(
                        pb::McpStateSuccess { servers },
                    )),
                }),
            ))]);
        }
        In::McpArgs(args) => {
            // These are upstream ledger identities, not locally assignable IDs.
            // An ID-less retry must never become a fresh executable host action.
            ensure!(
                !args.tool_call_id.trim().is_empty(),
                "Cursor MCP tool_call_id is empty; no host tool was exposed"
            );
            ensure!(
                !exec.exec_id.trim().is_empty(),
                "Cursor MCP exec_id is empty; no host tool was exposed"
            );
            let raw_name = if args.tool_name.is_empty() {
                &args.name
            } else {
                &args.tool_name
            };
            let name = if args.provider_identifier.is_empty() || args.provider_identifier == "pi" {
                names.resolve(raw_name)
            } else {
                None
            };
            let name = match name {
                Some(name) => name,
                None => {
                    return Ok(vec![ServerAction::Reply(exec_reply(
                        &exec,
                        Out::McpResult(pb::McpResult {
                            result: Some(pb::mcp_result::Result::ToolNotFound(
                                pb::McpToolNotFound {
                                    name: raw_name.clone(),
                                    available_tools: names.registered,
                                },
                            )),
                        }),
                    ))])
                }
            };
            let decoded: Result<Map<String, Value>> = args
                .args
                .iter()
                .map(|(key, bytes)| {
                    let value = prost_types::Value::decode(bytes.as_slice())
                        .with_context(|| format!("Invalid MCP argument Value: {key}"))?;
                    Ok((key.clone(), prost_to_json(value)?))
                })
                .collect();
            let input = match decoded {
                Ok(input) => Value::Object(input),
                Err(_) => {
                    return Ok(vec![ServerAction::Reply(exec_throw(
                        &exec,
                        "Invalid MCP argument protobuf Value; no host tool was executed",
                    ))])
                }
            };
            return Ok(vec![ServerAction::Tool(PendingTool {
                exec_id: exec.exec_id.clone(),
                exec_message_id: exec.id,
                tool_call_id: args.tool_call_id.clone(),
                name,
                input,
            })]);
        }
        In::ReadArgs(args) => Out::ReadResult(pb::ReadResult {
            result: Some(pb::read_result::Result::Rejected(pb::ReadRejected {
                path: args.path.clone(),
                reason: DENIED.to_owned(),
            })),
        }),
        In::LsArgs(args) => Out::LsResult(pb::LsResult {
            result: Some(pb::ls_result::Result::Rejected(pb::LsRejected {
                path: args.path.clone(),
                reason: DENIED.to_owned(),
            })),
        }),
        In::WriteArgs(args) => Out::WriteResult(pb::WriteResult {
            result: Some(pb::write_result::Result::Rejected(pb::WriteRejected {
                path: args.path.clone(),
                reason: DENIED.to_owned(),
            })),
        }),
        In::DeleteArgs(args) => Out::DeleteResult(pb::DeleteResult {
            result: Some(pb::delete_result::Result::Rejected(pb::DeleteRejected {
                path: args.path.clone(),
                reason: DENIED.to_owned(),
            })),
        }),
        In::GrepArgs(_) => Out::GrepResult(pb::GrepResult {
            result: Some(pb::grep_result::Result::Error(pb::GrepError {
                error: DENIED.to_owned(),
            })),
        }),
        In::WriteShellStdinArgs(_) => Out::WriteShellStdinResult(pb::WriteShellStdinResult {
            result: Some(pb::write_shell_stdin_result::Result::Error(
                pb::WriteShellStdinError {
                    error: DENIED.to_owned(),
                },
            )),
        }),
        In::ShellArgs(args) => Out::ShellResult(pb::ShellResult {
            result: Some(pb::shell_result::Result::Rejected(pb::ShellRejected {
                command: args.command.clone(),
                working_directory: args.working_directory.clone(),
                reason: DENIED.to_owned(),
                is_readonly: false,
            })),
            ..Default::default()
        }),
        In::ShellStreamArgs(args) => Out::ShellStream(pb::ShellStream {
            event: Some(pb::shell_stream::Event::Rejected(pb::ShellRejected {
                command: args.command.clone(),
                working_directory: args.working_directory.clone(),
                reason: DENIED.to_owned(),
                is_readonly: false,
            })),
        }),
        In::BackgroundShellSpawnArgs(args) => {
            Out::BackgroundShellSpawnResult(pb::BackgroundShellSpawnResult {
                result: Some(pb::background_shell_spawn_result::Result::Rejected(
                    pb::ShellRejected {
                        command: args.command.clone(),
                        working_directory: args.working_directory.clone(),
                        reason: DENIED.to_owned(),
                        is_readonly: false,
                    },
                )),
            })
        }
        In::FetchArgs(args) => Out::FetchResult(pb::FetchResult {
            result: Some(pb::fetch_result::Result::Error(pb::FetchError {
                url: args.url.clone(),
                error: DENIED.to_owned(),
            })),
        }),
        In::DiagnosticsArgs(args) => Out::DiagnosticsResult(pb::DiagnosticsResult {
            result: Some(pb::diagnostics_result::Result::Rejected(
                pb::DiagnosticsRejected {
                    path: args.path.clone(),
                    reason: DENIED.to_owned(),
                },
            )),
        }),
        In::ListMcpResourcesExecArgs(_) => {
            Out::ListMcpResourcesExecResult(pb::ListMcpResourcesExecResult {
                result: Some(pb::list_mcp_resources_exec_result::Result::Rejected(
                    pb::ListMcpResourcesRejected {
                        reason: DENIED.to_owned(),
                    },
                )),
            })
        }
        In::ReadMcpResourceExecArgs(args) => {
            Out::ReadMcpResourceExecResult(pb::ReadMcpResourceExecResult {
                result: Some(pb::read_mcp_resource_exec_result::Result::Rejected(
                    pb::ReadMcpResourceRejected {
                        uri: args.uri.clone(),
                        reason: DENIED.to_owned(),
                    },
                )),
            })
        }
        In::SubagentArgs(_) => Out::SubagentResult(pb::SubagentResult {
            result: Some(pb::subagent_result::Result::Error(pb::SubagentError {
                error: format!("No Cursor subagent was started. {DENIED}"),
                ..Default::default()
            })),
        }),
        In::RecordScreenArgs(_) => Out::RecordScreenResult(pb::RecordScreenResult {
            result: Some(pb::record_screen_result::Result::Failure(
                pb::RecordScreenFailure {
                    error: DENIED.to_owned(),
                },
            )),
        }),
        In::ComputerUseArgs(_) => Out::ComputerUseResult(pb::ComputerUseResult {
            result: Some(pb::computer_use_result::Result::Error(
                pb::ComputerUseError {
                    error: DENIED.to_owned(),
                    ..Default::default()
                },
            )),
        }),
        In::ReflectArgs(_) => Out::ReflectResult(pb::ReflectResult {
            result: Some(pb::reflect_result::Result::Error(pb::ReflectError {
                error: DENIED.to_owned(),
            })),
        }),
        In::TruncatedToolCallArgs(_) => Out::TruncatedToolCallResult(pb::TruncatedToolCallResult {
            result: Some(pb::truncated_tool_call_result::Result::Error(
                pb::TruncatedToolCallError {
                    error: DENIED.to_owned(),
                },
            )),
        }),
        In::StartGrindExecutionArgs(_) => {
            Out::StartGrindExecutionResult(pb::StartGrindExecutionResult {
                result: Some(pb::start_grind_execution_result::Result::Error(
                    pb::StartGrindExecutionError {
                        error: DENIED.to_owned(),
                    },
                )),
            })
        }
        // The schema provides only success here. A generic throw is the one
        // truthful response; acknowledging would falsely claim VM setup.
        In::SetupVmEnvironmentArgs(_) => {
            return Ok(vec![
                ServerAction::Reply(exec_throw(&exec, DENIED)),
                ServerAction::RejectedLocal,
            ])
        }
    };
    Ok(vec![
        ServerAction::Reply(exec_reply(&exec, rejection)),
        ServerAction::RejectedLocal,
    ])
}

fn handle_query(query: pb::InteractionQuery, raw: &[u8]) -> Result<Vec<ServerAction>> {
    use pb::interaction_query::Query as In;
    use pb::interaction_response::Result as Out;
    let fields = wire_fields(raw)?;
    ensure!(
        fields.iter().all(|f| (1..=9).contains(&f.number)),
        "Unsupported Cursor interaction query rejected"
    );
    if fields.iter().any(|f| f.number == 9) {
        ensure!(
            query.query.is_none(),
            "Ambiguous Cursor interaction query rejected"
        );
        // Current hosted web-fetch permission is not named in agent.proto.
        // Its response mirrors ExaFetch: #9 { rejected:#2 { reason:#1 } }.
        let mut reason = Vec::new();
        bytes_field(&mut reason, 1, DENIED.as_bytes());
        let mut rejected = Vec::new();
        bytes_field(&mut rejected, 2, &reason);
        let mut response = Vec::new();
        varint_field(&mut response, 1, u64::from(query.id));
        bytes_field(&mut response, 9, &rejected);
        let mut outer = Vec::new();
        bytes_field(&mut outer, 6, &response);
        return Ok(vec![
            ServerAction::Reply(outer),
            ServerAction::RejectedLocal,
        ]);
    }
    let result = match query.query.context("Unknown Cursor interaction query rejected")? {
        In::WebSearchRequestQuery(_) => Out::WebSearchRequestResponse(pb::WebSearchRequestResponse { result: Some(pb::web_search_request_response::Result::Rejected(pb::WebSearchRequestResponseRejected { reason: DENIED.to_owned() })) }),
        In::ExaSearchRequestQuery(_) => Out::ExaSearchRequestResponse(pb::ExaSearchRequestResponse { result: Some(pb::exa_search_request_response::Result::Rejected(pb::ExaSearchRequestResponseRejected { reason: DENIED.to_owned() })) }),
        In::ExaFetchRequestQuery(_) => Out::ExaFetchRequestResponse(pb::ExaFetchRequestResponse { result: Some(pb::exa_fetch_request_response::Result::Rejected(pb::ExaFetchRequestResponseRejected { reason: DENIED.to_owned() })) }),
        In::SwitchModeRequestQuery(_) => Out::SwitchModeRequestResponse(pb::SwitchModeRequestResponse { result: Some(pb::switch_mode_request_response::Result::Rejected(pb::SwitchModeRequestResponseRejected { reason: DENIED.to_owned() })) }),
        In::AskQuestionInteractionQuery(_) => Out::AskQuestionInteractionResponse(pb::AskQuestionInteractionResponse { result: Some(pb::AskQuestionResult { result: Some(pb::ask_question_result::Result::Rejected(pb::AskQuestionRejected { reason: "Interactive questions are unavailable; ask the user through host tools or chat.".to_owned() })) }) }),
        In::CreatePlanRequestQuery(_) => Out::CreatePlanRequestResponse(pb::CreatePlanRequestResponse { result: Some(pb::CreatePlanResult { result: Some(pb::create_plan_result::Result::Error(pb::CreatePlanError { error: DENIED.to_owned() })), ..Default::default() }) }),
        In::SetupVmEnvironmentArgs(_) => bail!("Cursor VM setup interaction rejected: no rejection shape is defined; refusing to claim success"),
    };
    Ok(vec![
        ServerAction::Reply(client(
            pb::agent_client_message::Message::InteractionResponse(pb::InteractionResponse {
                id: query.id,
                result: Some(result),
            }),
        )),
        ServerAction::RejectedLocal,
    ])
}

/// Numeric wire shapes only: safe diagnostics without upstream strings/args.
pub fn diagnostic_shape(bytes: &[u8]) -> Value {
    let Ok(fields) = wire_fields(bytes) else {
        return json!({"invalidWire":true});
    };
    let outer: Vec<_> = fields
        .iter()
        .take(32)
        .map(|f| (f.number, f.wire_type))
        .collect();
    let mut shape = json!({"outer":outer});
    if let Some(field) = fields.iter().find(|f| f.number == 1) {
        if let Ok(update) = wire_fields(field.data) {
            shape["update"] = json!(update
                .iter()
                .take(32)
                .map(|f| (f.number, f.wire_type))
                .collect::<Vec<_>>());
        }
    }
    if let Some(field) = fields.iter().find(|f| f.number == 2) {
        if let Ok(exec_fields) = wire_fields(field.data) {
            shape["exec"] = json!(exec_fields
                .iter()
                .take(32)
                .map(|f| (f.number, f.wire_type))
                .collect::<Vec<_>>());
        }
        if let Ok(exec) = pb::ExecServerMessage::decode(field.data) {
            shape["hasExecId"] = json!(!exec.exec_id.trim().is_empty());
            if let Some(pb::exec_server_message::Message::McpArgs(args)) = exec.message {
                shape["hasToolCallId"] = json!(!args.tool_call_id.trim().is_empty());
                shape["toolNameLength"] = json!(args.tool_name.len());
                shape["piProvider"] = json!(args.provider_identifier == "pi");
            }
        }
    }
    shape
}

/// Dispatch an unframed AgentServerMessage. Unknown requests either receive an
/// exec throw or return an error so the transport terminates, never silently parks.
pub fn handle_message(bytes: &[u8], context: &mut WireContext) -> Result<Vec<ServerAction>> {
    use pb::agent_server_message::Message as In;
    blob_usage(&context.blobs)?;
    let fields = wire_fields(bytes)?;
    // Inspect both oneof envelopes before prost can discard unknown variants or
    // select/merge a known case from an ambiguous message. Field 8 is explicitly
    // TTFT metadata in AgentServerMessage, not another action case.
    validate_message_oneof(
        &fields,
        &[1, 2, 3, 4, 5, 7],
        &[(8, 2)],
        "Cursor server message",
    )?;
    if let Some(update) = fields.iter().find(|f| f.number == 1) {
        validate_message_oneof(
            &wire_fields(update.data)?,
            // Field 27 is an observed newer observational update. It is not
            // an exec/query: ignore it without progress, execution or finish.
            // Mixed known+unknown cases remain ambiguous and are rejected.
            &[
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 27,
            ],
            &[(25, 0)], // message_started_at_ms, not an update case.
            "Cursor interaction update",
        )?;
    }
    let message =
        pb::AgentServerMessage::decode(bytes).context("Invalid Cursor server protobuf")?;
    let payload = |number| {
        fields
            .iter()
            .rev()
            .find(|f| f.number == number && f.wire_type == 2)
            .map(|f| f.data)
            .context("Cursor server message payload is missing")
    };
    match message.message {
        Some(In::InteractionUpdate(update)) => {
            use pb::interaction_update::Message as Update;
            Ok(match update.message {
                Some(Update::TextDelta(delta)) if !delta.text.is_empty() => {
                    vec![ServerAction::Text(delta.text)]
                }
                Some(Update::ThinkingDelta(delta)) if !delta.text.is_empty() => {
                    vec![ServerAction::Reasoning(delta.text)]
                }
                Some(Update::TokenDelta(delta)) => {
                    ensure!(delta.tokens >= 0, "Negative Cursor token delta");
                    vec![ServerAction::Tokens(delta.tokens as u64)]
                }
                Some(Update::TurnEnded(_)) => vec![ServerAction::Finished],
                Some(Update::Heartbeat(_)) => vec![ServerAction::Liveness],
                // These are notifications, not requests requiring a response.
                _ => Vec::new(),
            })
        }
        Some(In::ExecServerMessage(exec)) => handle_exec(exec, payload(2)?, context),
        Some(In::InteractionQuery(query)) => handle_query(query, payload(7)?),
        Some(In::ConversationCheckpointUpdate(_)) => {
            let checkpoint = payload(3)?;
            ensure!(
                checkpoint.len() <= MAX_BLOB_BYTES,
                "Checkpoint exceeds {MAX_BLOB_BYTES} bytes"
            );
            Ok(vec![ServerAction::Checkpoint(checkpoint.to_vec())])
        }
        Some(In::ExecServerControlMessage(_)) => Ok(vec![ServerAction::Liveness]),
        Some(In::KvServerMessage(kv)) => {
            ensure!(
                wire_fields(payload(4)?)?
                    .iter()
                    .all(|f| [1, 2, 3, 4].contains(&f.number)),
                "Unsupported Cursor KV request rejected"
            );
            let result = match kv.message.context("Unsupported Cursor KV request")? {
                pb::kv_server_message::Message::GetBlobArgs(args) => {
                    let key = hex(&args.blob_id);
                    let blob = context.blobs.get(&key).context("Cursor requested a missing blob; refusing to answer with silent holes in history")?;
                    pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult {
                        blob_data: Some(blob.clone()),
                    })
                }
                pb::kv_server_message::Message::SetBlobArgs(args) => {
                    ensure!(!args.blob_id.is_empty(), "Cursor sent an empty blob id");
                    let key = hex(&args.blob_id);
                    check_blob_capacity(
                        context.blobs.len(),
                        blob_usage(&context.blobs)?,
                        context.blobs.get(&key).map(Vec::len),
                        args.blob_data.len(),
                    )?;
                    context.blobs.insert(key, args.blob_data);
                    pb::kv_client_message::Message::SetBlobResult(pb::SetBlobResult::default())
                }
            };
            Ok(vec![ServerAction::Reply(client(
                pb::agent_client_message::Message::KvClientMessage(pb::KvClientMessage {
                    id: kv.id,
                    message: Some(result),
                }),
            ))])
        }
        None if fields.iter().all(|f| f.number == 8) && !fields.is_empty() => Ok(Vec::new()), // TTFT metadata only.
        None => bail!("Unsupported Cursor server message rejected"),
    }
}

/// GetUsableModels lists directly runnable model ids. In particular, it does
/// not synthesize AvailableModels variants that require unsupported parameters.
pub fn model_list_request() -> (String, Vec<u8>) {
    (
        "/agent.v1.AgentService/GetUsableModels".to_owned(),
        pb::GetUsableModelsRequest::default().encode_to_vec(),
    )
}
pub fn decode_model_list(bytes: &[u8]) -> Result<Value> {
    let response =
        pb::GetUsableModelsResponse::decode(bytes).context("Invalid Cursor model list")?;
    let mut models = std::collections::BTreeMap::new();
    for model in response.models {
        let id = model.model_id.trim();
        if id.is_empty() || model.max_mode == Some(true) {
            // StartInput cannot request Max Mode or parameterized variants.
            continue;
        }
        let name = [
            &model.display_name,
            &model.display_name_short,
            &model.display_model_id,
        ]
        .into_iter()
        .find(|s| !s.is_empty())
        .map(String::as_str)
        .unwrap_or(id);
        let text = format!("{id} {name}").to_ascii_lowercase();
        let context = if text.contains("gpt-5.6") {
            if id.split('-').any(|p| p == "1m") {
                500_000
            } else {
                272_000
            }
        } else if window_marker(&text, "1", "m") {
            1_000_000
        } else if window_marker(&text, "272", "k") {
            272_000
        } else if window_marker(&text, "256", "k")
            || text.contains("grok-4.5")
            || text.contains("grok-4.6")
        {
            256_000
        } else {
            200_000
        };
        let max_tokens = if text.contains("gpt-5")
            || text.contains("claude-4.6")
            || text.contains("sonnet 4.6")
            || text.contains("opus 4.6")
        {
            128_000
        } else {
            64_000
        };
        models.insert(
            id.to_owned(),
            json!({"id":id,"name":name,"reasoning":model.thinking_details.is_some(),
            "contextWindow":context,"maxTokens":max_tokens,
            // GetUsableModels does not attest image support. Be conservative,
            // rather than advertise fabricated multimodal capabilities.
            "supportsImages":false}),
        );
    }
    Ok(Value::Array(models.into_values().collect()))
}

fn window_marker(text: &str, number: &str, unit: &str) -> bool {
    let tokens: Vec<_> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let marker = format!("{number}{unit}");
    tokens.iter().any(|token| *token == marker)
        || tokens.windows(2).any(|pair| pair == [number, unit])
}

// Minimal lossless wire inspection is needed for unknown oneof rejection and
// checkpoint overlays. No Connect framing belongs in this module.
struct WireField<'a> {
    number: u32,
    wire_type: u8,
    data: &'a [u8],
    raw: &'a [u8],
}
fn validate_message_oneof(
    fields: &[WireField<'_>],
    cases: &[u32],
    metadata: &[(u32, u8)],
    label: &str,
) -> Result<()> {
    let mut count = 0;
    for field in fields {
        if cases.contains(&field.number) {
            ensure!(field.wire_type == 2, "Invalid {label} oneof wire type");
            count += 1;
        } else {
            ensure!(
                metadata.contains(&(field.number, field.wire_type)),
                "Unsupported {label} wire shape rejected"
            );
        }
    }
    ensure!(count <= 1, "Ambiguous {label} oneof rejected");
    Ok(())
}
fn read_varint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*offset).context("Truncated protobuf varint")?;
        *offset += 1;
        ensure!(shift < 63 || byte <= 1, "Protobuf varint overflow");
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    bail!("Protobuf varint too long")
}
fn wire_fields(bytes: &[u8]) -> Result<Vec<WireField<'_>>> {
    let mut offset = 0usize;
    let mut fields = Vec::new();
    while offset < bytes.len() {
        let start = offset;
        let tag = read_varint(bytes, &mut offset)?;
        let number = u32::try_from(tag >> 3).context("Invalid protobuf field number")?;
        ensure!(
            number > 0 && number < (1 << 29),
            "Invalid protobuf field number"
        );
        let wire_type = (tag & 7) as u8;
        let data_start;
        match wire_type {
            0 => {
                data_start = offset;
                read_varint(bytes, &mut offset)?;
            }
            1 | 5 => {
                data_start = offset;
                offset = offset
                    .checked_add(if wire_type == 1 { 8 } else { 4 })
                    .context("Protobuf size overflow")?;
            }
            2 => {
                let size = usize::try_from(read_varint(bytes, &mut offset)?)
                    .context("Protobuf size overflow")?;
                data_start = offset;
                offset = offset.checked_add(size).context("Protobuf size overflow")?;
            }
            _ => bail!("Unsupported protobuf wire type: {wire_type}"),
        }
        ensure!(offset <= bytes.len(), "Truncated protobuf field");
        fields.push(WireField {
            number,
            wire_type,
            data: &bytes[data_start..offset],
            raw: &bytes[start..offset],
        });
    }
    Ok(fields)
}
fn put_varint(bytes: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        bytes.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    bytes.push(value as u8);
}
fn varint_field(bytes: &mut Vec<u8>, number: u32, value: u64) {
    put_varint(bytes, u64::from(number) << 3);
    put_varint(bytes, value);
}
fn bytes_field(bytes: &mut Vec<u8>, number: u32, value: &[u8]) {
    put_varint(bytes, (u64::from(number) << 3) | 2);
    put_varint(bytes, value.len() as u64);
    bytes.extend_from_slice(value);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(prompt: Value, tools: Value) -> Result<StartInput> {
        Ok(serde_json::from_value(json!({
            "scope":"protocol-test", "modelId":"auto", "workspace":"/tmp/protocol 你好",
            "prompt":prompt, "tools":tools
        }))?)
    }
    fn basic_input() -> Result<StartInput> {
        input(
            json!([{"role":"user","content":[{"type":"text","text":"hello"}]}]),
            json!([]),
        )
    }
    fn run_request(bytes: &[u8]) -> Result<pb::AgentRunRequest> {
        match pb::AgentClientMessage::decode(bytes)?.message {
            Some(pb::agent_client_message::Message::RunRequest(run)) => Ok(run),
            _ => bail!("Expected RunRequest"),
        }
    }
    fn historical_turn(
        run: &pb::AgentRunRequest,
        context: &WireContext,
        index: usize,
    ) -> Result<(pb::AgentConversationTurnStructure, pb::UserMessage)> {
        let state = run.conversation_state.as_ref().context("No state")?;
        let turn = pb::ConversationTurnStructure::decode(
            context
                .blobs
                .get(&hex(&state.turns[index]))
                .context("No turn blob")?
                .as_slice(),
        )?;
        let turn = match turn.turn {
            Some(pb::conversation_turn_structure::Turn::AgentConversationTurn(turn)) => turn,
            _ => bail!("Not an agent turn"),
        };
        let user = pb::UserMessage::decode(
            context
                .blobs
                .get(&hex(&turn.user_message))
                .context("No user blob")?
                .as_slice(),
        )?;
        Ok((turn, user))
    }
    fn current_user(run: &pb::AgentRunRequest) -> Result<&pb::UserMessage> {
        match run.action.as_ref().and_then(|a| a.action.as_ref()) {
            Some(pb::conversation_action::Action::UserMessageAction(action)) => {
                action.user_message.as_ref().context("No user message")
            }
            _ => bail!("Not a user action"),
        }
    }
    fn roots(run: &pb::AgentRunRequest, context: &WireContext) -> Result<Vec<Value>> {
        run.conversation_state
            .as_ref()
            .context("No conversation state")?
            .root_prompt_messages_json
            .iter()
            .map(|id| {
                Ok(serde_json::from_slice(
                    context.blobs.get(&hex(id)).context("Missing root blob")?,
                )?)
            })
            .collect()
    }
    fn server(message: pb::agent_server_message::Message) -> Vec<u8> {
        pb::AgentServerMessage {
            message: Some(message),
            ..Default::default()
        }
        .encode_to_vec()
    }
    fn exec(message: pb::exec_server_message::Message) -> Vec<u8> {
        server(pb::agent_server_message::Message::ExecServerMessage(
            pb::ExecServerMessage {
                id: 7,
                exec_id: "exec-test".to_owned(),
                message: Some(message),
                ..Default::default()
            },
        ))
    }
    fn reply(actions: &[ServerAction]) -> Result<pb::AgentClientMessage> {
        for action in actions {
            if let ServerAction::Reply(bytes) = action {
                return Ok(pb::AgentClientMessage::decode(bytes.as_slice())?);
            }
        }
        bail!("No reply action")
    }
    fn exec_result(actions: &[ServerAction]) -> Result<pb::exec_client_message::Message> {
        match reply(actions)?.message {
            Some(pb::agent_client_message::Message::ExecClientMessage(message)) => {
                assert_eq!(message.id, 7);
                assert_eq!(message.exec_id, "exec-test");
                message.message.context("No exec result")
            }
            _ => bail!("Not an exec result"),
        }
    }
    fn pending() -> PendingTool {
        PendingTool {
            exec_id: "exec-test".to_owned(),
            exec_message_id: 7,
            tool_call_id: "call-test".to_owned(),
            name: "read".to_owned(),
            input: json!({}),
        }
    }
    fn mcp_result(value: Value) -> Result<pb::mcp_result::Result> {
        let bytes = tool_result(&pending(), &value)?;
        match exec_result(&[ServerAction::Reply(bytes)])? {
            pb::exec_client_message::Message::McpResult(result) => {
                result.result.context("No MCP result")
            }
            _ => bail!("Not MCP result"),
        }
    }

    #[test]
    fn protobuf_value_has_google_wire_compatibility() -> Result<()> {
        // google.protobuf.Value.string_value = 3; fixtures are protobuf-es's
        // bytes, not an encoding learned from this implementation's decoder.
        assert_eq!(
            json_to_prost(&json!("hello"))?.encode_to_vec(),
            b"\x1a\x05hello"
        );
        assert_eq!(
            prost_to_json(prost_types::Value::decode(&b"\x20\x01"[..])?)?,
            json!(true)
        );
        assert_eq!(
            prost_to_json(prost_types::Value::decode(&b"\x08\x00"[..])?)?,
            Value::Null
        );
        let structured =
            json!({"path":"你好/😀", "n":3, "fraction":1.25, "array":[true, null, {"x":"y"}]});
        assert_eq!(prost_to_json(json_to_prost(&structured)?)?, structured);
        assert!(prost_to_json(prost_types::Value::default()).is_err());
        assert!(prost_to_json(prost_types::Value {
            kind: Some(prost_types::value::Kind::NumberValue(f64::NAN))
        })
        .is_err());
        assert_eq!(cancel_message(), [0x22, 0x02, 0x1a, 0x00]);
        Ok(())
    }

    #[test]
    fn protobuf_es_mcp_fixture_decodes_and_result_bytes_match() -> Result<()> {
        // Captured with vendor agent_pb.ts and @bufbuild/protobuf 2.13.0,
        // independently of prost; exercises nested Value structs and lists.
        let server_hex = "127e08075a6f0a0e70692d6d63705f70695f7265616412410a0576616c756512382a360a130a076d65737361676512081a06e4bda0e5a5bd0a1f0a0676616c756573121532130a0208000a0220010a091100000000000008401a0963616c6c2d74657374220270692a0b6d63705f70695f726561647a09657865632d74657374";
        let bytes = (0..server_hex.len())
            .step_by(2)
            .map(|n| Ok(u8::from_str_radix(&server_hex[n..n + 2], 16)?))
            .collect::<Result<Vec<_>>>()?;
        let mut context = WireContext {
            tools: vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})],
            ..Default::default()
        };
        let actions = handle_message(&bytes, &mut context)?;
        let tool = match &actions[..] {
            [ServerAction::Tool(tool)] => tool,
            _ => bail!("No MCP tool in fixture"),
        };
        assert_eq!(
            tool.input,
            json!({"value":{"message":"你好","values":[null,true,3]}})
        );
        assert_eq!(
            hex(&tool_result(
                tool,
                &json!({"type":"text","value":"SAFE_TEST_RESULT"})
            )?),
            "122708075a180a160a140a120a10534146455f544553545f524553554c547a09657865632d74657374"
        );
        Ok(())
    }

    #[test]
    fn request_publishes_full_history_rules_schema_and_inline_images() -> Result<()> {
        let schema = json!({"type":"object", "properties":{"filePath":{"type":"string","description":"Keep this", "default":"notes"}},
            "required":["filePath"], "additionalProperties":false, "$defs":{"special":{"const":"literal"}}});
        let input = input(
            json!([
                {"role":"system","content":"HOST SYSTEM"},
                {"role":"user","content":[{"type":"text","text":"first question"}]},
                {"role":"assistant","content":[{"type":"reasoning","text":"PRIVATE OLD REASONING"},
                    {"type":"tool-call","toolCallId":"call-1","toolName":"read","input":{"filePath":"你好"}}]},
                {"role":"tool","content":[{"type":"tool-result","toolCallId":"call-1","toolName":"read","output":{"type":"json","value":{"answer":42}}}]},
                {"role":"assistant","content":[{"type":"text","text":"prior answer"}]},
                {"role":"user","content":[{"type":"text","text":"latest question"},{"type":"file","mediaType":"image/png","data":"iVBORw=="}]}
            ]),
            json!([{"type":"function", "name":"read", "description":"Exact description", "inputSchema":schema}]),
        )?;
        let mut context = WireContext::default();
        let bytes = build_request(&input, "stable-conversation", None, &mut context)?;
        let run = run_request(&bytes)?;
        assert_eq!(run.conversation_id.as_deref(), Some("stable-conversation"));
        assert_eq!(
            run.requested_model.as_ref().map(|m| m.model_id.as_str()),
            Some("default")
        );
        assert!(run.model_details.is_none() && run.custom_system_prompt.is_none());
        let tools = &run.mcp_tools.as_ref().context("No tools")?.mcp_tools;
        assert_eq!(tools.len(), 1);
        assert_eq!(
            (
                &tools[0].name[..],
                &tools[0].tool_name[..],
                &tools[0].provider_identifier[..]
            ),
            ("read", "read", "pi")
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                tools[0]
                    .input_schema_json
                    .as_deref()
                    .context("No schema JSON")?
            )?,
            schema
        );
        assert_eq!(
            prost_to_json(tools[0].input_schema.clone().context("No schema Value")?)?,
            schema
        );
        let roots = roots(&run, &context)?;
        assert_eq!(
            roots
                .iter()
                .map(|r| r["role"].as_str().unwrap_or(""))
                .collect::<Vec<_>>(),
            ["system", "user", "user", "assistant", "tool", "assistant"]
        );
        let rendered = serde_json::to_string(&roots)?;
        assert!(
            rendered.contains("HOST SYSTEM")
                && rendered.contains("<rules>")
                && rendered.contains("Native Cursor local tools are disabled")
        );
        assert!(
            rendered.contains("first question")
                && rendered.contains("prior answer")
                && rendered.contains("mcp_pi_read")
        );
        assert!(
            !rendered.contains("PRIVATE OLD REASONING") && !rendered.contains("latest question")
        );
        assert_eq!(roots[3]["content"][0]["args"], json!({"filePath":"你好"}));
        assert_eq!(roots[4]["content"][0]["result"], "{\"answer\":42}");
        let state = run.conversation_state.as_ref().context("No state")?;
        assert_eq!(
            state.previous_workspace_uris,
            ["file:///tmp/protocol%20%E4%BD%A0%E5%A5%BD"]
        );
        let turn = pb::ConversationTurnStructure::decode(
            context
                .blobs
                .get(&hex(&state.turns[0]))
                .context("No turn blob")?
                .as_slice(),
        )?;
        let turn = match turn.turn {
            Some(pb::conversation_turn_structure::Turn::AgentConversationTurn(turn)) => turn,
            _ => bail!("Not agent turn"),
        };
        assert_eq!(turn.steps.len(), 3);
        let user = match run.action.context("No action")?.action {
            Some(pb::conversation_action::Action::UserMessageAction(action)) => {
                action.user_message.context("No user message")?
            }
            _ => bail!("Not user action"),
        };
        assert_eq!(user.text, "latest question");
        assert_eq!(user.message_id, user.correlation_id);
        let image = &user
            .selected_context
            .as_ref()
            .context("No selected context")?
            .selected_images[0];
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(
            image.data_or_blob_id,
            Some(pb::selected_image::DataOrBlobId::Data(vec![
                137, 80, 78, 71
            ]))
        );
        let selected = context
            .blobs
            .get(&hex(&user.selected_context_blob))
            .context("No context blob")?;
        assert_eq!(&selected[..2], [0x0a, 0x20]);
        assert!(selected.ends_with(&[0xb2, 0x01, 0x02, b'p', b'i']));
        let selected = SelectedContextBlob::decode(selected.as_slice())?;
        assert_eq!(selected.roots[0], state.root_prompt_messages_json[0]);
        for (key, blob) in &context.blobs {
            assert_eq!(key, &hex(&Sha256::digest(blob)));
        }
        let retained = context.blobs.clone();
        let again = build_request(&input, "stable-conversation", None, &mut context)?;
        assert_eq!(
            again, bytes,
            "Retries must retain user and image identities"
        );
        assert_eq!(context.blobs, retained);
        Ok(())
    }

    #[test]
    fn fifty_turn_history_rebuilds_deduplicate_retained_blobs() -> Result<()> {
        let mut input = basic_input()?;
        input.prompt.clear();
        let mut context = WireContext::default();
        let mut previous_user = None;
        let mut previous_turn_ids = Vec::new();
        for index in 0..=50 {
            input
                .prompt
                .push(json!({"role":"user","content":format!("question {index}")}));
            let bytes = build_request(&input, "fifty-turns", None, &mut context)?;
            let run = run_request(&bytes)?;
            let state = run.conversation_state.as_ref().context("No state")?;
            assert_eq!(state.turns.len(), index);
            assert!(state.turns.starts_with(&previous_turn_ids));
            previous_turn_ids = state.turns.clone();
            if let Some(previous) = previous_user {
                assert_eq!(historical_turn(&run, &context, index - 1)?.1, previous);
            }
            previous_user = Some(current_user(&run)?.clone());
            // Three shared blobs, then one user, step, turn and two roots per
            // completed turn. Rebuilding old turns must not retain new copies.
            assert_eq!(context.blobs.len(), 3 + 5 * index);
            let retained = context.blobs.clone();
            assert_eq!(
                build_request(&input, "fifty-turns", None, &mut context)?,
                bytes
            );
            assert_eq!(context.blobs, retained);
            input.prompt.push(json!({"role":"assistant","content":[{"type":"text","text":format!("answer {index}")}]}));
        }
        assert_eq!(context.blobs.len(), 253);
        Ok(())
    }

    #[test]
    fn tool_history_rebuilds_have_deterministic_argument_maps() -> Result<()> {
        let arguments = json!({"alpha":1,"beta":true,"gamma":{"nested":["value",null]}});
        let input = input(
            json!([
                {"role":"user","content":"old question"},
                {"role":"assistant","content":[{"type":"tool-call","toolCallId":"old-call","toolName":"read",
                    "input":arguments}]},
                {"role":"tool","content":[{"type":"tool-result","toolCallId":"old-call","output":{"type":"text","value":"actual result"}}]},
                {"role":"user","content":"new question"}
            ]),
            json!([]),
        )?;
        let mut context = WireContext::default();
        let first = build_request(&input, "tool-history", None, &mut context)?;
        let (turn, _) = historical_turn(&run_request(&first)?, &context, 0)?;
        let step = pb::ConversationStep::decode(
            context
                .blobs
                .get(&hex(&turn.steps[0]))
                .context("No step blob")?
                .as_slice(),
        )?;
        let call = match step.message {
            Some(pb::conversation_step::Message::ToolCall(pb::ToolCall {
                tool: Some(pb::tool_call::Tool::McpToolCall(call)),
            })) => call,
            _ => bail!("Not an MCP tool call"),
        };
        assert!(call.result.is_some());
        let args = call.args.context("No MCP arguments")?;
        assert_eq!(args.tool_call_id, "old-call");
        let decoded = args
            .args
            .into_iter()
            .map(|(key, value)| {
                Ok((
                    key,
                    prost_to_json(prost_types::Value::decode(value.as_slice())?)?,
                ))
            })
            .collect::<Result<Map<String, Value>>>()?;
        assert_eq!(Value::Object(decoded), arguments);
        let retained = context.blobs.clone();
        for _ in 0..50 {
            assert_eq!(
                build_request(&input, "tool-history", None, &mut context)?,
                first
            );
            assert_eq!(context.blobs, retained);
        }
        Ok(())
    }

    #[test]
    fn user_turn_identity_includes_conversation_index_and_content() -> Result<()> {
        let content = json!([
            {"type":"text","text":"repeat"},
            {"type":"file","mediaType":"image/png","data":"iVBORw=="},
            {"type":"file","mediaType":"image/png","data":"iVBORw=="}
        ]);
        let mut input = input(
            json!([
                {"role":"user","content":content},
                {"role":"assistant","content":[{"type":"text","text":"answer"}]},
                {"role":"user","content":content},
                {"role":"assistant","content":[{"type":"text","text":"answer"}]},
                {"role":"user","content":content}
            ]),
            json!([]),
        )?;
        let mut context = WireContext::default();
        let bytes = build_request(&input, "repeat-conversation", None, &mut context)?;
        let run = run_request(&bytes)?;
        let (first_turn, first_user) = historical_turn(&run, &context, 0)?;
        let (second_turn, second_user) = historical_turn(&run, &context, 1)?;
        let current = current_user(&run)?.clone();
        let ids = [
            &first_user.message_id,
            &second_user.message_id,
            &current.message_id,
        ];
        assert_eq!(ids.into_iter().collect::<HashSet<_>>().len(), 3);
        assert_ne!(first_turn.request_id, second_turn.request_id);
        let images = &first_user
            .selected_context
            .as_ref()
            .context("No images")?
            .selected_images;
        assert_ne!(images[0].uuid, images[1].uuid);
        let retained = context.blobs.clone();
        assert_eq!(
            build_request(&input, "repeat-conversation", None, &mut context)?,
            bytes
        );
        assert_eq!(context.blobs, retained);

        let other = run_request(&build_request(
            &input,
            "other-conversation",
            None,
            &mut context,
        )?)?;
        assert_ne!(current_user(&other)?.message_id, current.message_id);
        assert_ne!(
            historical_turn(&other, &context, 0)?.1.message_id,
            first_user.message_id
        );
        input.prompt[4]["content"][0]["text"] = json!("changed text");
        let changed = run_request(&build_request(
            &input,
            "repeat-conversation",
            None,
            &mut context,
        )?)?;
        assert_ne!(current_user(&changed)?.message_id, current.message_id);
        input.prompt[4]["content"][0]["text"] = json!("repeat");
        input.prompt[4]["content"][1]["data"] = json!("iVBORwA=");
        let changed = run_request(&build_request(
            &input,
            "repeat-conversation",
            None,
            &mut context,
        )?)?;
        assert_ne!(current_user(&changed)?.message_id, current.message_id);
        Ok(())
    }

    #[test]
    fn checkpoint_overlay_retains_metadata_and_unknown_fields_not_stale_roots() -> Result<()> {
        let input = input(
            json!([
                {"role":"system","content":"UPDATED RULES"},
                {"role":"user","content":[{"type":"text","text":"old question"}]},
                {"role":"assistant","content":[{"type":"text","text":"old answer"}]},
                {"role":"user","content":[{"type":"text","text":"new question"}]}
            ]),
            json!([]),
        )?;
        let mut checkpoint = pb::ConversationStateStructure {
            root_prompt_messages_json: vec![vec![9; 32]],
            turns: vec![vec![8; 32]],
            client_name: "cli".to_owned(),
            extra_state: vec![1, 2, 3],
            self_summary_count: 7,
            summary: Some(vec![4; 32]),
            ..Default::default()
        }
        .encode_to_vec();
        bytes_field(&mut checkpoint, 100, b"future-state");
        let mut context = WireContext::default();
        let request = build_request(
            &input,
            "checkpoint-conversation",
            Some(&checkpoint),
            &mut context,
        )?;
        let run = run_request(&request)?;
        let state = run.conversation_state.as_ref().context("No state")?;
        assert_eq!(state.client_name, "cli");
        assert_eq!(state.extra_state, [1, 2, 3]);
        assert_eq!(state.self_summary_count, 7);
        assert_eq!(state.summary, Some(vec![4; 32]));
        assert!(!state.root_prompt_messages_json.contains(&vec![9; 32]));
        let rendered = serde_json::to_string(&roots(&run, &context)?)?;
        assert!(
            rendered.contains("old question")
                && rendered.contains("old answer")
                && rendered.contains("UPDATED RULES")
        );
        let fields = wire_fields(&request)?;
        let run_raw = fields
            .iter()
            .find(|f| f.number == 1)
            .context("No run")?
            .data;
        let fields = wire_fields(run_raw)?;
        let state_raw = fields
            .iter()
            .find(|f| f.number == 1)
            .context("No state")?
            .data;
        assert!(wire_fields(state_raw)?
            .iter()
            .any(|f| f.number == 100 && f.data == b"future-state"));
        let update = {
            let mut v = Vec::new();
            bytes_field(&mut v, 3, &checkpoint);
            v
        };
        let actions = handle_message(&update, &mut context)?;
        assert!(matches!(&actions[..], [ServerAction::Checkpoint(bytes)] if *bytes == checkpoint));
        Ok(())
    }

    #[test]
    fn mcp_names_discovery_and_context_use_one_exact_registry() -> Result<()> {
        let input = input(
            json!([{"role":"user","content":"hello"}]),
            json!([
                {"type":"function","name":"read","inputSchema":{"type":"object"}},
                {"type":"function","name":"mcp_pi_read","inputSchema":{"type":"object"}},
                {"type":"function","function":{"name":"functions.Read","parameters":{"type":"object","additionalProperties":false}}}
            ]),
        )?;
        let mut context = WireContext::default();
        let run = run_request(&build_request(&input, "tool-names", None, &mut context)?)?;
        let names = run
            .mcp_tools
            .context("No tools")?
            .mcp_tools
            .into_iter()
            .map(|t| t.name)
            .collect::<Vec<_>>();
        assert_eq!(names, ["read", "read_2", "functions.Read"]);
        let bytes = exec(pb::exec_server_message::Message::McpStateExecArgs(
            pb::McpStateExecArgs {
                server_identifiers: vec!["custom-user-tools".to_owned()],
                ..Default::default()
            },
        ));
        let actions = handle_message(&bytes, &mut context)?;
        let servers = match exec_result(&actions)? {
            pb::exec_client_message::Message::McpStateExecResult(pb::McpStateExecResult {
                result: Some(pb::mcp_state_exec_result::Result::Success(success)),
            }) => success.servers,
            _ => bail!("No MCP catalog"),
        };
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].server_identifier, "pi");
        assert_eq!(
            servers[0]
                .tools
                .iter()
                .map(|t| t.tool_name.as_str())
                .collect::<Vec<_>>(),
            ["mcp_pi_read", "mcp_pi_read_2", "mcp_pi_functions.Read"]
        );
        for (wire, original) in [
            ("mcp_pi_read", "read"),
            ("mcp_pi_read_2", "mcp_pi_read"),
            ("read_2", "mcp_pi_read"),
            ("mcp_pi_functions.Read", "functions.Read"),
        ] {
            let bytes = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
                tool_name: wire.to_owned(),
                provider_identifier: "pi".to_owned(),
                tool_call_id: "call-test".to_owned(),
                ..Default::default()
            }));
            let actions = handle_message(&bytes, &mut context)?;
            assert!(matches!(&actions[..], [ServerAction::Tool(tool)] if tool.name == original));
        }
        let bytes = exec(pb::exec_server_message::Message::RequestContextArgs(
            pb::RequestContextArgs::default(),
        ));
        let actions = handle_message(&bytes, &mut context)?;
        let request_context = match exec_result(&actions)? {
            pb::exec_client_message::Message::RequestContextResult(pb::RequestContextResult {
                result: Some(pb::request_context_result::Result::Success(success)),
            }) => success.request_context.context("No request context")?,
            _ => bail!("Not request context result"),
        };
        assert_eq!(
            request_context.env.context("No env")?.workspace_paths,
            ["file:///tmp/protocol%20%E4%BD%A0%E5%A5%BD"]
        );
        assert_eq!(request_context.tools[1].tool_name, "read_2");
        assert_eq!(request_context.web_search_enabled, Some(false));
        Ok(())
    }

    #[test]
    fn mcp_args_roundtrip_errors_and_unknown_tools_are_not_executed() -> Result<()> {
        let mut context = WireContext {
            tools: vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})],
            ..Default::default()
        };
        let values = json!({"unicode":"你好😀","nested":{"x":[null,true,3,1.25]}});
        let args = values
            .as_object()
            .context("Not object")?
            .iter()
            .map(|(k, v)| Ok((k.clone(), json_to_prost(v)?.encode_to_vec())))
            .collect::<Result<_>>()?;
        let bytes = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
            name: "pi-mcp_pi_read".to_owned(),
            tool_name: "mcp_pi_read".to_owned(),
            provider_identifier: "pi".to_owned(),
            tool_call_id: "call-test".to_owned(),
            args,
        }));
        let actions = handle_message(&bytes, &mut context)?;
        let tool = match &actions[..] {
            [ServerAction::Tool(tool)] => tool,
            _ => bail!("Not host tool"),
        };
        assert_eq!(tool.input, values);
        assert_eq!(tool.name, "read");
        assert_eq!(tool.exec_message_id, 7);
        assert_eq!(tool.exec_id, "exec-test");
        for (name, provider) in [("missing", "pi"), ("read", "other-provider")] {
            let bytes = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
                tool_name: name.to_owned(),
                provider_identifier: provider.to_owned(),
                tool_call_id: "call-test".to_owned(),
                ..Default::default()
            }));
            let actions = handle_message(&bytes, &mut context)?;
            assert!(matches!(
                exec_result(&actions)?,
                pb::exec_client_message::Message::McpResult(pb::McpResult {
                    result: Some(pb::mcp_result::Result::ToolNotFound(_))
                })
            ));
        }
        let bytes = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
            tool_name: "read".to_owned(),
            tool_call_id: "call-test".to_owned(),
            args: HashMap::from([("bad".to_owned(), vec![0xff])]),
            ..Default::default()
        }));
        let actions = handle_message(&bytes, &mut context)?;
        assert!(matches!(
            reply(&actions)?.message,
            Some(pb::agent_client_message::Message::ExecClientControlMessage(
                pb::ExecClientControlMessage {
                    message: Some(pb::exec_client_control_message::Message::Throw(_))
                }
            ))
        ));
        Ok(())
    }

    #[test]
    fn repeated_idless_mcp_execs_never_expose_a_host_action() -> Result<()> {
        let mut context = WireContext {
            tools: vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})],
            ..Default::default()
        };
        for (call_id, exec_id) in [
            (None, Some("exec-test")),
            (Some(""), Some("exec-test")),
            (Some(" \t"), Some("exec-test")),
            (Some("call-test"), None),
            (Some("call-test"), Some("")),
            (Some("call-test"), Some(" \t")),
        ] {
            let mut args = pb::McpArgs {
                tool_name: "read".to_owned(),
                provider_identifier: "pi".to_owned(),
                ..Default::default()
            }
            .encode_to_vec();
            if let Some(id) = call_id {
                // Include an explicit empty string as well as an absent field.
                bytes_field(&mut args, 3, id.as_bytes());
            }
            let mut raw_exec = Vec::new();
            varint_field(&mut raw_exec, 1, 7);
            if let Some(id) = exec_id {
                bytes_field(&mut raw_exec, 15, id.as_bytes());
            }
            bytes_field(&mut raw_exec, 11, &args);
            let mut bytes = Vec::new();
            bytes_field(&mut bytes, 2, &raw_exec);
            for _ in 0..3 {
                assert!(
                    handle_message(&bytes, &mut context).is_err(),
                    "Missing/blank upstream IDs must not be replaced on retry"
                );
                assert!(context.blobs.is_empty());
            }
        }
        Ok(())
    }

    #[test]
    fn host_result_formats_are_truthful_and_images_stay_inline() -> Result<()> {
        for (kind, value) in [
            ("text", json!("你好")),
            ("json", json!({"answer":[1,true]})),
        ] {
            match mcp_result(json!({"type":kind,"value":value}))? {
                pb::mcp_result::Result::Success(success) => {
                    assert!(!success.is_error);
                    let text = match success.content[0].content.as_ref() {
                        Some(pb::mcp_tool_result_content_item::Content::Text(t)) => &t.text,
                        _ => bail!("No text"),
                    };
                    assert_eq!(
                        text,
                        if kind == "text" {
                            "你好".to_owned()
                        } else {
                            serde_json::to_string(&value)?
                        }
                        .as_str()
                    );
                }
                _ => bail!("Not success"),
            }
        }
        assert!(
            matches!(mcp_result(json!({"type":"error-text","value":"actual failure"}))?, pb::mcp_result::Result::Error(pb::McpError { error }) if error == "actual failure")
        );
        assert!(
            matches!(mcp_result(json!({"type":"error-json","value":{"error":"bad"}}))?, pb::mcp_result::Result::Error(pb::McpError { error }) if error == "{\"error\":\"bad\"}")
        );
        assert!(
            matches!(mcp_result(json!({"type":"execution-denied","reason":"owner refused"}))?, pb::mcp_result::Result::Rejected(pb::McpRejected { reason, .. }) if reason.contains("owner refused"))
        );
        let result = mcp_result(
            json!({"type":"content","value":[{"type":"text","text":"screenshot"},{"type":"image-data","mediaType":"image/png","data":"iVBORw=="}]}),
        )?;
        match result {
            pb::mcp_result::Result::Success(success) => {
                assert_eq!(success.content.len(), 2);
                assert!(
                    matches!(&success.content[1].content, Some(pb::mcp_tool_result_content_item::Content::Image(image)) if image.data == [137,80,78,71] && image.mime_type == "image/png")
                );
            }
            _ => bail!("Not image success"),
        }
        assert!(tool_result(&pending(), &json!({"type":"unknown"})).is_err());
        assert!(tool_result(&pending(), &json!({"type":"content","value":[{"type":"image-url","url":"https://example.test/image"}]})).is_err());
        let long = "😀".repeat(MAX_TOOL_TEXT_BYTES / 2);
        let result = parse_result(&json!({"type":"text","value":long}))?;
        assert!(result.text.len() <= MAX_TOOL_TEXT_BYTES && result.text.contains("truncated"));
        Ok(())
    }

    #[test]
    fn parse_results_preserves_outputs_and_rejects_conflicting_or_invented_history() -> Result<()> {
        let output = json!({"type":"error-json","value":{"error":"not authorized"}});
        let input = input(
            json!([
                {"role":"user","content":"run check"},
                {"role":"assistant","content":[{"type":"tool-call","toolCallId":"call-test","toolName":"read","input":{}}]},
                {"role":"tool","content":[{"type":"tool-result","toolCallId":"call-test","toolName":"read","output":output}]}
            ]),
            json!([]),
        )?;
        assert_eq!(parse_tool_results(&input)?.get("call-test"), Some(&output));
        let mut context = WireContext::default();
        let run = run_request(&build_request(&input, "resume", None, &mut context)?)?;
        assert!(matches!(
            run.action.as_ref().and_then(|a| a.action.as_ref()),
            Some(pb::conversation_action::Action::ResumeAction(_))
        ));
        let rendered = serde_json::to_string(&roots(&run, &context)?)?;
        assert!(rendered.contains("not authorized") && rendered.contains("isError"));
        let mut conflict = input.clone();
        conflict.prompt.push(json!({"role":"tool","content":[{"type":"tool-result","toolCallId":"call-test","output":{"type":"text","value":"different"}}]}));
        assert!(parse_tool_results(&conflict).is_err());
        let mut orphan = input;
        orphan.prompt.remove(1);
        assert!(build_request(&orphan, "no-fabricated-call", None, &mut context).is_err());
        Ok(())
    }

    #[test]
    fn inline_images_reject_paths_urls_unsupported_bytes_and_oversize() -> Result<()> {
        for source in [
            "https://example.test/private.png",
            "file:///etc/passwd",
            "/tmp/private.png",
            "not-base64!",
        ] {
            assert!(inline_image(&json!({"mediaType":"image/png","data":source})).is_err());
        }
        assert!(inline_image(
            &json!({"mediaType":"image/png","data":{"href":"https://example.test/private.png"}})
        )
        .is_err());
        assert!(inline_image(&json!({"mediaType":"application/pdf","data":"iVBORw=="})).is_err());
        assert!(inline_image(&json!({"mediaType":"image/jpeg","data":"iVBORw=="})).is_err());
        assert_eq!(
            inline_image(
                &json!({"mediaType":"image/png","data":"data:image/png;base64,iVBORw=="})
            )?
            .bytes,
            [137, 80, 78, 71]
        );
        assert_eq!(
            inline_image(
                &json!({"mediaType":"image/png","data":{"type":"Buffer","data":[137,80,78,71]}})
            )?
            .mime,
            "image/png"
        );
        for (mime, bytes) in [
            ("image/jpeg", vec![255, 216, 255]),
            ("image/gif", b"GIF89a".to_vec()),
            ("image/webp", b"RIFF0000WEBP".to_vec()),
        ] {
            assert_eq!(
                inline_image(
                    &json!({"mediaType":mime,"data":general_purpose::STANDARD.encode(&bytes)})
                )?
                .bytes,
                bytes
            );
        }
        let mut bytes = vec![0; MAX_IMAGE_BYTES];
        bytes[..4].copy_from_slice(b"\x89PNG");
        assert_eq!(
            inline_image(
                &json!({"mediaType":"image/png","data":general_purpose::STANDARD.encode(&bytes)})
            )?
            .bytes
            .len(),
            MAX_IMAGE_BYTES
        );
        bytes.push(0);
        assert!(inline_image(
            &json!({"mediaType":"image/png","data":general_purpose::STANDARD.encode(bytes)})
        )
        .is_err());
        Ok(())
    }

    #[test]
    fn native_local_and_network_requests_always_receive_typed_rejections() -> Result<()> {
        use pb::exec_client_message::Message as Out;
        use pb::exec_server_message::Message as In;
        let requests = vec![
            In::ReadArgs(pb::ReadArgs {
                path: "/not-read".to_owned(),
                ..Default::default()
            }),
            In::LsArgs(pb::LsArgs::default()),
            In::WriteArgs(pb::WriteArgs::default()),
            In::DeleteArgs(pb::DeleteArgs::default()),
            In::GrepArgs(pb::GrepArgs::default()),
            In::ShellArgs(pb::ShellArgs::default()),
            In::ShellStreamArgs(pb::ShellArgs::default()),
            In::BackgroundShellSpawnArgs(pb::BackgroundShellSpawnArgs::default()),
            In::WriteShellStdinArgs(pb::WriteShellStdinArgs::default()),
            In::FetchArgs(pb::FetchArgs {
                url: "https://example.test/never-fetched".to_owned(),
                ..Default::default()
            }),
            In::DiagnosticsArgs(pb::DiagnosticsArgs::default()),
            In::ListMcpResourcesExecArgs(pb::ListMcpResourcesExecArgs::default()),
            In::ReadMcpResourceExecArgs(pb::ReadMcpResourceExecArgs::default()),
            In::SubagentArgs(pb::SubagentArgs::default()),
            In::ReflectArgs(pb::ReflectArgs::default()),
            In::TruncatedToolCallArgs(pb::TruncatedToolCallArgs::default()),
            In::StartGrindExecutionArgs(pb::StartGrindExecutionArgs::default()),
            In::RecordScreenArgs(pb::RecordScreenArgs::default()),
            In::ComputerUseArgs(pb::ComputerUseArgs::default()),
        ];
        for request in requests {
            let mut context = WireContext::default();
            let actions = handle_message(&exec(request), &mut context)?;
            assert!(matches!(actions.last(), Some(ServerAction::RejectedLocal)));
            assert!(context.blobs.is_empty());
            let typed = match exec_result(&actions)? {
                Out::ReadResult(r) => {
                    matches!(r.result, Some(pb::read_result::Result::Rejected(_)))
                }
                Out::LsResult(r) => matches!(r.result, Some(pb::ls_result::Result::Rejected(_))),
                Out::WriteResult(r) => {
                    matches!(r.result, Some(pb::write_result::Result::Rejected(_)))
                }
                Out::DeleteResult(r) => {
                    matches!(r.result, Some(pb::delete_result::Result::Rejected(_)))
                }
                Out::GrepResult(r) => matches!(r.result, Some(pb::grep_result::Result::Error(_))),
                Out::ShellResult(r) => {
                    matches!(r.result, Some(pb::shell_result::Result::Rejected(_)))
                }
                Out::ShellStream(r) => {
                    matches!(r.event, Some(pb::shell_stream::Event::Rejected(_)))
                }
                Out::BackgroundShellSpawnResult(r) => matches!(
                    r.result,
                    Some(pb::background_shell_spawn_result::Result::Rejected(_))
                ),
                Out::WriteShellStdinResult(r) => matches!(
                    r.result,
                    Some(pb::write_shell_stdin_result::Result::Error(_))
                ),
                Out::FetchResult(r) => matches!(r.result, Some(pb::fetch_result::Result::Error(_))),
                Out::DiagnosticsResult(r) => {
                    matches!(r.result, Some(pb::diagnostics_result::Result::Rejected(_)))
                }
                Out::ListMcpResourcesExecResult(r) => matches!(
                    r.result,
                    Some(pb::list_mcp_resources_exec_result::Result::Rejected(_))
                ),
                Out::ReadMcpResourceExecResult(r) => matches!(
                    r.result,
                    Some(pb::read_mcp_resource_exec_result::Result::Rejected(_))
                ),
                Out::SubagentResult(r) => {
                    matches!(r.result, Some(pb::subagent_result::Result::Error(_)))
                }
                Out::ReflectResult(r) => {
                    matches!(r.result, Some(pb::reflect_result::Result::Error(_)))
                }
                Out::TruncatedToolCallResult(r) => matches!(
                    r.result,
                    Some(pb::truncated_tool_call_result::Result::Error(_))
                ),
                Out::StartGrindExecutionResult(r) => matches!(
                    r.result,
                    Some(pb::start_grind_execution_result::Result::Error(_))
                ),
                Out::RecordScreenResult(r) => {
                    matches!(r.result, Some(pb::record_screen_result::Result::Failure(_)))
                }
                Out::ComputerUseResult(r) => {
                    matches!(r.result, Some(pb::computer_use_result::Result::Error(_)))
                }
                _ => false,
            };
            assert!(typed, "Native request was not truthfully rejected");
        }
        Ok(())
    }

    #[test]
    fn server_oneofs_reject_unknown_and_ambiguous_cases_before_dispatch() -> Result<()> {
        let mut context = WireContext {
            tools: vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})],
            ..Default::default()
        };
        let mcp = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
            tool_name: "read".to_owned(),
            tool_call_id: "call-test".to_owned(),
            ..Default::default()
        }));
        let mut ended = Vec::new();
        bytes_field(&mut ended, 14, b"");
        let mut finished = Vec::new();
        bytes_field(&mut finished, 1, &ended);
        for field in [6, 99] {
            let mut unknown = Vec::new();
            bytes_field(&mut unknown, field, b"");
            for bytes in [&mcp, &finished] {
                for combined in [
                    [bytes.as_slice(), unknown.as_slice()].concat(),
                    [unknown.as_slice(), bytes.as_slice()].concat(),
                ] {
                    assert!(handle_message(&combined, &mut context).is_err());
                }
            }
            assert!(handle_message(&unknown, &mut context).is_err());
        }
        for field in [18, 100] {
            let mut unknown = Vec::new();
            bytes_field(&mut unknown, field, b"");
            for update in [
                [ended.as_slice(), unknown.as_slice()].concat(),
                [unknown.as_slice(), ended.as_slice()].concat(),
                unknown,
            ] {
                let mut bytes = Vec::new();
                bytes_field(&mut bytes, 1, &update);
                assert!(handle_message(&bytes, &mut context).is_err());
            }
        }
        // Multiple known cases, including duplicate occurrences of one case,
        // are ambiguous too; do not let prost's last/merged case win.
        for bytes in [
            [mcp.as_slice(), finished.as_slice()].concat(),
            [finished.as_slice(), mcp.as_slice()].concat(),
            [mcp.as_slice(), mcp.as_slice()].concat(),
        ] {
            assert!(handle_message(&bytes, &mut context).is_err());
        }
        for field in [13, 14] {
            let mut update = ended.clone();
            bytes_field(&mut update, field, b"");
            let mut bytes = Vec::new();
            bytes_field(&mut bytes, 1, &update);
            assert!(handle_message(&bytes, &mut context).is_err());
        }
        assert!(context.blobs.is_empty());
        Ok(())
    }

    #[test]
    fn observed_update_27_never_executes_or_finishes_and_cannot_mask_turn_ended() -> Result<()> {
        let mut update = Vec::new();
        bytes_field(&mut update, 27, b"observational-data-not-a-tool");
        let mut outer = Vec::new();
        bytes_field(&mut outer, 1, &update);
        let mut context = WireContext::default();
        assert!(handle_message(&outer, &mut context)?.is_empty());
        bytes_field(&mut update, 14, b"");
        let mut mixed = Vec::new();
        bytes_field(&mut mixed, 1, &update);
        assert!(handle_message(&mixed, &mut context).is_err());
        Ok(())
    }

    #[test]
    fn server_and_update_metadata_are_not_oneof_cases() -> Result<()> {
        let mut context = WireContext::default();
        let mut metadata = Vec::new();
        bytes_field(
            &mut metadata,
            8,
            &pb::TtftBreakdown::default().encode_to_vec(),
        );
        assert!(handle_message(&metadata, &mut context)?.is_empty());
        let mut update = Vec::new();
        bytes_field(&mut update, 14, b"");
        varint_field(&mut update, 25, 123);
        let mut finished = Vec::new();
        bytes_field(&mut finished, 1, &update);
        for bytes in [
            [metadata.as_slice(), finished.as_slice()].concat(),
            [finished.as_slice(), metadata.as_slice()].concat(),
        ] {
            assert!(matches!(
                &handle_message(&bytes, &mut context)?[..],
                [ServerAction::Finished]
            ));
        }
        let mut context = WireContext {
            tools: vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})],
            ..Default::default()
        };
        let mcp = exec(pb::exec_server_message::Message::McpArgs(pb::McpArgs {
            tool_name: "read".to_owned(),
            tool_call_id: "call-test".to_owned(),
            ..Default::default()
        }));
        for bytes in [
            [metadata.as_slice(), mcp.as_slice()].concat(),
            [mcp.as_slice(), metadata.as_slice()].concat(),
        ] {
            assert!(
                matches!(&handle_message(&bytes, &mut context)?[..], [ServerAction::Tool(tool)] if tool.tool_call_id == "call-test")
            );
        }
        Ok(())
    }

    #[test]
    fn unsupported_exec_throws_and_unknown_queries_fail_closed() -> Result<()> {
        let mut context = WireContext::default();
        let mut raw_exec = Vec::new();
        varint_field(&mut raw_exec, 1, 7);
        bytes_field(&mut raw_exec, 99, b"unknown");
        let mut bytes = Vec::new();
        bytes_field(&mut bytes, 2, &raw_exec);
        let actions = handle_message(&bytes, &mut context)?;
        assert!(matches!(
            reply(&actions)?.message,
            Some(pb::agent_client_message::Message::ExecClientControlMessage(
                pb::ExecClientControlMessage {
                    message: Some(pb::exec_client_control_message::Message::Throw(
                        pb::ExecClientThrow { id: 7, .. }
                    ))
                }
            ))
        ));
        let bytes = exec(pb::exec_server_message::Message::SetupVmEnvironmentArgs(
            pb::SetupVmEnvironmentArgs::default(),
        ));
        assert!(matches!(
            reply(&handle_message(&bytes, &mut context)?)?.message,
            Some(pb::agent_client_message::Message::ExecClientControlMessage(
                _
            ))
        ));
        for field in [10, 100] {
            let mut query = Vec::new();
            varint_field(&mut query, 1, 17);
            bytes_field(&mut query, field, b"");
            let mut bytes = Vec::new();
            bytes_field(&mut bytes, 7, &query);
            assert!(handle_message(&bytes, &mut context).is_err());
        }
        let mut query = Vec::new();
        varint_field(&mut query, 1, 17);
        bytes_field(&mut query, 9, b"");
        let mut bytes = Vec::new();
        bytes_field(&mut bytes, 7, &query);
        let actions = handle_message(&bytes, &mut context)?;
        let bytes = match &actions[0] {
            ServerAction::Reply(bytes) => bytes,
            _ => bail!("No field-9 rejection"),
        };
        let outer = wire_fields(bytes)?;
        let response = wire_fields(outer[0].data)?;
        assert_eq!(response[0].data, [17]);
        assert_eq!(response[1].number, 9);
        let result = wire_fields(response[1].data)?;
        assert_eq!(result[0].number, 2); // rejected, never approved (#1).
        Ok(())
    }

    #[test]
    fn hosted_web_approvals_are_denied() -> Result<()> {
        use pb::interaction_query::Query as In;
        use pb::interaction_response::Result as Out;
        for query in [
            In::WebSearchRequestQuery(pb::WebSearchRequestQuery::default()),
            In::ExaFetchRequestQuery(pb::ExaFetchRequestQuery::default()),
            In::ExaSearchRequestQuery(pb::ExaSearchRequestQuery::default()),
            In::SwitchModeRequestQuery(pb::SwitchModeRequestQuery::default()),
        ] {
            let mut context = WireContext::default();
            let bytes = server(pb::agent_server_message::Message::InteractionQuery(
                pb::InteractionQuery {
                    id: 17,
                    query: Some(query),
                },
            ));
            let actions = handle_message(&bytes, &mut context)?;
            let result = match reply(&actions)?.message {
                Some(pb::agent_client_message::Message::InteractionResponse(response)) => {
                    assert_eq!(response.id, 17);
                    response.result.context("No query result")?
                }
                _ => bail!("Not query response"),
            };
            assert!(match result {
                Out::WebSearchRequestResponse(r) => matches!(
                    r.result,
                    Some(pb::web_search_request_response::Result::Rejected(_))
                ),
                Out::ExaFetchRequestResponse(r) => matches!(
                    r.result,
                    Some(pb::exa_fetch_request_response::Result::Rejected(_))
                ),
                Out::ExaSearchRequestResponse(r) => matches!(
                    r.result,
                    Some(pb::exa_search_request_response::Result::Rejected(_))
                ),
                Out::SwitchModeRequestResponse(r) => matches!(
                    r.result,
                    Some(pb::switch_mode_request_response::Result::Rejected(_))
                ),
                _ => false,
            });
        }
        let bytes = server(pb::agent_server_message::Message::InteractionQuery(
            pb::InteractionQuery {
                id: 17,
                query: Some(In::SetupVmEnvironmentArgs(
                    pb::SetupVmEnvironmentArgs::default(),
                )),
            },
        ));
        assert!(handle_message(&bytes, &mut WireContext::default()).is_err());
        Ok(())
    }

    #[test]
    fn kv_roundtrip_and_blob_limits_never_evict_history() -> Result<()> {
        let mut context = WireContext::default();
        let id = vec![7; 32];
        let set = server(pb::agent_server_message::Message::KvServerMessage(
            pb::KvServerMessage {
                id: 19,
                message: Some(pb::kv_server_message::Message::SetBlobArgs(
                    pb::SetBlobArgs {
                        blob_id: id.clone(),
                        blob_data: b"actual blob".to_vec(),
                    },
                )),
                ..Default::default()
            },
        ));
        let actions = handle_message(&set, &mut context)?;
        assert_eq!(
            context.blobs.get(&hex(&id)).map(Vec::as_slice),
            Some(&b"actual blob"[..])
        );
        assert!(matches!(
            reply(&actions)?.message,
            Some(pb::agent_client_message::Message::KvClientMessage(
                pb::KvClientMessage {
                    id: 19,
                    message: Some(pb::kv_client_message::Message::SetBlobResult(_))
                }
            ))
        ));
        let get = server(pb::agent_server_message::Message::KvServerMessage(
            pb::KvServerMessage {
                id: 20,
                message: Some(pb::kv_server_message::Message::GetBlobArgs(
                    pb::GetBlobArgs {
                        blob_id: id.clone(),
                    },
                )),
                ..Default::default()
            },
        ));
        assert!(
            matches!(reply(&handle_message(&get, &mut context)?)?.message, Some(pb::agent_client_message::Message::KvClientMessage(pb::KvClientMessage { id:20, message:Some(pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult { blob_data:Some(data) })) })) if data == b"actual blob")
        );
        context.blobs.remove(&hex(&id));
        assert!(handle_message(&get, &mut context).is_err());
        context.blobs = (0..MAX_BLOBS)
            .map(|n| (hex(&Sha256::digest(n.to_be_bytes())), vec![0]))
            .collect();
        let before = context.blobs.clone();
        assert!(handle_message(&set, &mut context).is_err());
        assert_eq!(context.blobs, before);
        assert!(build_request(&basic_input()?, "capacity", None, &mut context).is_err());
        assert_eq!(context.blobs, before);
        assert!(context.tools.is_empty());
        assert!(check_blob_capacity(1, 0, None, MAX_BLOB_BYTES + 1).is_err());
        assert!(check_blob_capacity(4, MAX_STORE_BYTES, None, 1).is_err());
        assert_eq!(
            check_blob_capacity(MAX_BLOBS, MAX_STORE_BYTES, Some(32), 16)?,
            MAX_STORE_BYTES - 16
        );
        assert!(check_blob_capacity(MAX_BLOBS, 0, None, 0).is_err());
        Ok(())
    }

    #[test]
    fn text_reasoning_tokens_finished_and_heartbeat_decode() -> Result<()> {
        use pb::interaction_update::Message as Update;
        let mut context = WireContext::default();
        for (update, expected) in [
            (
                Update::TextDelta(pb::TextDeltaUpdate {
                    text: "你好😀".to_owned(),
                }),
                "text",
            ),
            (
                Update::ThinkingDelta(pb::ThinkingDeltaUpdate {
                    text: "consider".to_owned(),
                }),
                "thinking",
            ),
            (
                Update::TokenDelta(pb::TokenDeltaUpdate { tokens: 3 }),
                "tokens",
            ),
            (Update::TurnEnded(pb::TurnEndedUpdate {}), "done"),
            (Update::Heartbeat(pb::HeartbeatUpdate {}), "heartbeat"),
        ] {
            let actions = handle_message(
                &server(pb::agent_server_message::Message::InteractionUpdate(
                    pb::InteractionUpdate {
                        message: Some(update),
                        ..Default::default()
                    },
                )),
                &mut context,
            )?;
            assert!(match (&actions[..], expected) {
                ([ServerAction::Text(text)], "text") => text == "你好😀",
                ([ServerAction::Reasoning(text)], "thinking") => text == "consider",
                ([ServerAction::Tokens(3)], "tokens")
                | ([ServerAction::Finished], "done")
                | ([ServerAction::Liveness], "heartbeat") => true,
                _ => false,
            });
        }
        let bytes = server(pb::agent_server_message::Message::InteractionUpdate(
            pb::InteractionUpdate {
                message: Some(Update::TokenDelta(pb::TokenDeltaUpdate { tokens: -1 })),
                ..Default::default()
            },
        ));
        assert!(handle_message(&bytes, &mut context).is_err());
        assert!(handle_message(&[0x80], &mut context).is_err());
        assert!(handle_message(&[], &mut context).is_err());
        Ok(())
    }

    #[test]
    fn validation_failures_are_atomic_and_none_hides_tools() -> Result<()> {
        let mut input = basic_input()?;
        input.tools =
            vec![json!({"type":"function","name":"read","inputSchema":{"type":"object"}})];
        input.tool_choice = "required".to_owned();
        let mut context = WireContext::default();
        assert!(build_request(&input, "invalid", None, &mut context).is_err());
        assert!(context.blobs.is_empty() && context.tools.is_empty());
        input.tool_choice = "none".to_owned();
        let run = run_request(&build_request(&input, "none", None, &mut context)?)?;
        assert!(
            run.mcp_tools
                .context("No MCP tools envelope")?
                .mcp_tools
                .is_empty()
                && context.tools.is_empty()
        );
        let before = context.blobs.clone();
        input.prompt[0]["content"] =
            json!([{"type":"file","mediaType":"image/png","data":"file:///etc/passwd"}]);
        assert!(build_request(&input, "invalid-image", None, &mut context).is_err());
        assert_eq!(context.blobs, before);
        assert!(build_request(&basic_input()?, "", None, &mut context).is_err());
        Ok(())
    }

    #[test]
    fn model_list_is_unframed_and_lists_only_directly_runnable_ids() -> Result<()> {
        assert_eq!(
            model_list_request(),
            ("/agent.v1.AgentService/GetUsableModels".to_owned(), vec![])
        );
        let response = pb::GetUsableModelsResponse {
            models: vec![
                pb::ModelDetails {
                    model_id: "gpt-5.6-luna-high".to_owned(),
                    display_name: "GPT-5.6 Luna 1M High".to_owned(),
                    thinking_details: Some(pb::ThinkingDetails {}),
                    ..Default::default()
                },
                pb::ModelDetails {
                    model_id: "claude-4.6-opus-1m".to_owned(),
                    display_name: "Opus 4.6 1M".to_owned(),
                    ..Default::default()
                },
                pb::ModelDetails {
                    model_id: "requires-max-mode".to_owned(),
                    max_mode: Some(true),
                    ..Default::default()
                },
                pb::ModelDetails::default(),
            ],
        };
        let models = decode_model_list(&response.encode_to_vec())?;
        assert_eq!(models.as_array().context("No model array")?.len(), 2);
        assert_eq!(models[0]["contextWindow"], 1_000_000);
        assert_eq!(models[1]["id"], "gpt-5.6-luna-high");
        assert_eq!(models[1]["contextWindow"], 272_000);
        assert_eq!(models[1]["maxTokens"], 128_000);
        assert_eq!(models[1]["reasoning"], true);
        assert_eq!(models[1]["supportsImages"], false);
        assert!(models[1].get("parameters").is_none());
        assert!(decode_model_list(&[0xff]).is_err());
        Ok(())
    }
}
