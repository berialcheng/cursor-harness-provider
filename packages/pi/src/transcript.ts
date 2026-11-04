import { collapseSystemMessages, getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { isRecord } from "./security.js";
import { normalizeMessagesForCursor } from "./context-normalize.js";

export type NativePart = Record<string, unknown>;
export interface NativeMessage { role: "system" | "user" | "assistant" | "tool"; content: string | NativePart[] }
export interface NativeTool { type: "function"; name: string; description?: string; inputSchema: Record<string, unknown> }
export interface NativeTranscript { prompt: NativeMessage[]; tools: NativeTool[] }

/** Only host-supplied inline bytes. Never resolve a path, URL, clipboard, or filesystem reference. */
export function inlineImage(data: unknown, mediaType: unknown): { data: string; mediaType: string } {
  if (typeof mediaType !== "string" || !/^image\/(png|jpeg|jpg|gif|webp)$/i.test(mediaType)) {
    throw new Error("Cursor Native supports inline PNG/JPEG/GIF/WebP images only");
  }
  if (typeof data !== "string" || !data || data.length > 7 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) {
    throw new Error("Invalid inline base64 image; paths and URLs are not read");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 ||
      bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) {
    throw new Error("Invalid or oversized inline image (maximum 5 MiB)");
  }
  return { data, mediaType };
}

/** Pi normalizes transcript state; fold infrastructure notices after V3 conversion. Rust owns replay. */
export function toNativeTranscript(context: TranscriptContext): NativeTranscript {
  const collapsed = collapseSystemMessages(context);
  const system = getCurrentSystemPrompt(collapsed.messages);
  const tools: NativeTool[] = getCurrentTools(collapsed.messages).map(tool => {
    if (tool.constrainedSampling && (tool.constrainedSampling.type === "grammar" || tool.constrainedSampling.strict === "require")) {
      throw new Error("Cursor Native cannot guarantee required constrained tool sampling");
    }
    // Pi sets constrainedSampling on built-ins as a preference for APIs that
    // support it, not a demand for server-side JSON grammar enforcement.
    // Preserve the full JSON Schema; Pi still validates every host tool call.
    return { type: "function", name: tool.name, description: tool.description,
      inputSchema: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown> };
  });
  const prompt: NativeMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const message of collapsed.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      prompt.push({ role: "user", content: typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.map(p => p.type === "text" ? { type: "text", text: p.text }
          : { type: "file", ...inlineImage(p.data, p.mimeType) }) });
    } else if (message.role === "assistant") {
      // Foreign provider signatures and signed thinking are not portable to Cursor.
      const content: NativePart[] = message.content.map(p => {
        if (p.type === "text") return { type: "text", text: p.text };
        if (p.type === "thinking") return { type: "reasoning", text: p.thinking };
        if (p.argumentsError) throw new Error("Cannot replay malformed tool-call arguments");
        return { type: "tool-call", toolCallId: p.id, toolName: p.name, input: p.arguments };
      });
      prompt.push({ role: "assistant", content });
    } else if (message.role === "toolResult") {
      // Details/nestedCalls/usage are host metadata, not model-facing tool output.
      const text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
      const output = message.isError
        ? { type: "error-text", value: text || "Pi denied or failed tool execution" }
        : message.content.some(p => p.type === "image")
          ? { type: "content", value: message.content.map(p => p.type === "text"
            ? { type: "text", text: p.text } : { type: "image-data", ...inlineImage(p.data, p.mimeType) }) }
          : { type: "text", value: text };
      // Error images have no V3 error+content variant: preserve them as separate inline user input.
      // Do not discard the error flag (Rust must never mistake denial for success).
      prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: message.toolCallId,
        toolName: message.toolName, output }] });
      if (message.isError) {
        const images = message.content.filter(p => p.type === "image");
        if (images.length) prompt.push({ role: "user", content: [
          { type: "text", text: `Images returned with failed Pi tool ${message.toolName}:` },
          ...images.map(p => ({ type: "file", ...inlineImage(p.data, p.mimeType) })),
        ] });
      }
    } else {
      throw new Error("Unsupported Pi transcript message role");
    }
  }
  return validateTranscript({ prompt: normalizeMessagesForCursor(prompt), tools });
}

function string(value: unknown): value is string { return typeof value === "string"; }
function object(value: unknown): void {
  if (!isRecord(value)) throw new Error("Tool arguments/schema must be a JSON object");
}
function checkOutput(output: unknown): void {
  if (!isRecord(output)) throw new Error("Invalid native tool output");
  if (["text", "error-text"].includes(String(output.type)) && string(output.value)) return;
  if (output.type === "execution-denied" && (output.reason === undefined || string(output.reason))) return;
  if (["json", "error-json"].includes(String(output.type)) && "value" in output) return;
  if (output.type === "content" && Array.isArray(output.value)) {
    for (const p of output.value) {
      if (!isRecord(p)) throw new Error("Invalid tool content");
      if (p.type === "text" && string(p.text)) continue;
      if (p.type === "image-data" || p.type === "file-data") { inlineImage(p.data, p.mediaType); continue; }
      throw new Error("Referenced tool media is unsupported; use inline image bytes");
    }
    return;
  }
  throw new Error("Invalid or unsupported native tool output");
}

/** Validate hook replacements too: no provider-executed tools, approvals, URLs, or executable values. */
export function validateTranscript(value: unknown): NativeTranscript {
  if (!isRecord(value) || !Array.isArray(value.prompt) || !Array.isArray(value.tools)) throw new Error("Invalid normalized Cursor payload");
  for (const tool of value.tools) {
    if (!isRecord(tool) || tool.type !== "function" || !string(tool.name) || !tool.name ||
        (tool.description !== undefined && !string(tool.description))) throw new Error("Only Pi host function tools are supported");
    object(tool.inputSchema);
  }
  for (const m of value.prompt) {
    if (!isRecord(m)) throw new Error("Invalid native message");
    if (m.role === "system" && string(m.content)) continue;
    if (!["user", "assistant", "tool"].includes(String(m.role)) || !Array.isArray(m.content)) throw new Error("Invalid native message role/content");
    for (const p of m.content) {
      if (!isRecord(p)) throw new Error("Invalid native message part");
      if ((m.role === "user" || m.role === "assistant") && p.type === "text" && string(p.text)) continue;
      if (m.role === "user" && p.type === "file") { inlineImage(p.data, p.mediaType); continue; }
      if (m.role === "assistant" && p.type === "reasoning" && string(p.text)) continue;
      if (m.role === "assistant" && p.type === "tool-call" && string(p.toolCallId) && string(p.toolName) && !p.providerExecuted) { object(p.input); continue; }
      if (m.role === "tool" && p.type === "tool-result" && string(p.toolCallId) && string(p.toolName)) { checkOutput(p.output); continue; }
      throw new Error("Unsupported native message part; all tool actions must run through Pi");
    }
  }
  return value as unknown as NativeTranscript;
}
