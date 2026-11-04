import { createAssistantMessageEventStream, parseStreamingJson, type Api, type AssistantMessage,
  type AssistantMessageEventStream, type JsonObject, type Model, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import { CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import { isRecord, safeError } from "./security.js";

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
interface Block { index: number; kind: "text" | "reasoning" | "tool"; ended: boolean; json?: string; inputEnded?: boolean }
function required(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Malformed native stream event"); return value; }
function delta(value: unknown): string { if (typeof value !== "string") throw new Error("Malformed native content delta"); return value; }
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export class PiEventWriter {
  readonly stream: AssistantMessageEventStream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  private started = false;
  private terminal = false;
  private blocks = new Map<string, Block>();
  private toolNames: Set<string>;
  constructor(private model: Model<Api>, tools: readonly string[] = []) {
    this.toolNames = new Set(tools);
    this.message = { role: "assistant", api: CURSOR_NATIVE_API, provider: PROVIDER_ID, model: model.id,
      content: [], timestamp: Date.now(), stopReason: "pending", usage: emptyUsage() };
  }
  setTools(names: readonly string[]): void { this.toolNames = new Set(names); }
  diagnostic(type: string, details: JsonObject): void {
    (this.message.diagnostics ??= []).push({ type, timestamp: Date.now(), details });
  }
  start(): void {
    if (this.started || this.terminal) return;
    this.started = true; this.stream.push({ type: "start", partial: this.message });
  }
  private block(id: unknown, kind: Block["kind"]): Block {
    const b = this.blocks.get(required(id));
    if (!b || b.kind !== kind || b.ended) throw new Error("Native content event has no matching open block");
    return b;
  }
  private open(id: string, block: Block): void {
    if (this.blocks.has(id)) throw new Error("Duplicate native content block ID");
    this.blocks.set(id, block);
  }
  /** Earliest structured values from Rust, not fabricated HTTP frames or headers. */
  accept(event: Record<string, unknown>): boolean {
    if (this.terminal) throw new Error("Native stream event after terminal");
    switch (event.type) {
      case "stream-start": return false; // Rust versions may expose the V3 stream-start preamble.
      case "response-metadata":
        if (typeof event.id === "string") this.message.responseId = event.id;
        if (typeof event.modelId === "string") this.message.responseModel = event.modelId;
        return false;
      case "text-start": case "reasoning-start": {
        const kind = event.type === "text-start" ? "text" : "reasoning";
        const index = this.message.content.length;
        this.open(required(event.id), { index, kind, ended: false });
        this.message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: this.message });
        return false;
      }
      case "text-delta": case "reasoning-delta": {
        const kind = event.type === "text-delta" ? "text" : "reasoning";
        const b = this.block(event.id, kind), content = this.message.content[b.index]!;
        const text = delta(event.delta);
        if (content.type === "text") content.text += text;
        else if (content.type === "thinking") content.thinking += text;
        this.stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: b.index, delta: text, partial: this.message });
        return false;
      }
      case "text-end": case "reasoning-end": {
        this.close(this.block(event.id, event.type === "text-end" ? "text" : "reasoning")); return false;
      }
      case "tool-input-start": {
        if (event.providerExecuted) throw new Error("Provider-executed tools are forbidden; use Pi permissions");
        const id = required(event.id), name = required(event.toolName), index = this.message.content.length;
        if (!this.toolNames.has(name)) throw new Error("Cursor requested a tool not declared by Pi");
        this.open(id, { index, kind: "tool", ended: false, json: "" });
        this.message.content.push({ type: "toolCall", id, name, arguments: {} });
        this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.message });
        return false;
      }
      case "tool-input-delta": {
        const b = this.block(event.id, "tool");
        if (b.inputEnded) throw new Error("Native tool delta after input end");
        const text = delta(event.delta); b.json += text;
        const parsed: unknown = parseStreamingJson(b.json);
        const call = this.message.content[b.index] as ToolCall;
        if (isRecord(parsed)) call.arguments = parsed as JsonObject;
        this.stream.push({ type: "toolcall_delta", contentIndex: b.index, delta: text, partial: this.message });
        return false;
      }
      case "tool-input-end": {
        const b = this.block(event.id, "tool");
        if (b.inputEnded) throw new Error("Duplicate native tool-input-end");
        b.inputEnded = true; return false; // Pi ends only after authoritative, parsed tool-call.
      }
      case "tool-call": {
        if (event.providerExecuted) throw new Error("Provider-executed tools are forbidden; use Pi permissions");
        const b = this.block(event.toolCallId, "tool"), call = this.message.content[b.index] as ToolCall;
        if (!b.inputEnded || event.toolName !== call.name) throw new Error("Incomplete/mismatched native tool call");
        const input: unknown = typeof event.input === "string" ? JSON.parse(event.input) : event.input;
        if (!isRecord(input)) throw new Error("Native tool-call input must be a JSON object");
        // Validate the streamed arguments too; a mismatched final call must not execute.
        const streamed: unknown = JSON.parse(b.json || "{}");
        if (!isRecord(streamed) || JSON.stringify(streamed) !== JSON.stringify(input)) throw new Error("Native tool arguments changed after streaming");
        call.arguments = input as JsonObject; this.close(b); return false;
      }
      case "finish": {
        if ([...this.blocks.values()].some(b => !b.ended)) throw new Error("Native stream finished with incomplete content");
        if (!isRecord(event.finishReason)) throw new Error("Native stream has no finish reason");
        const reason = event.finishReason.unified;
        const hasTools = this.message.content.some(p => p.type === "toolCall");
        if ((reason === "tool-calls") !== hasTools || !["stop", "length", "tool-calls"].includes(String(reason))) throw new Error("Invalid native finish reason");
        this.message.rawStopReason = typeof event.finishReason.raw === "string" ? event.finishReason.raw : undefined;
        this.message.usage = this.usage(event.usage);
        this.message.stopReason = reason === "tool-calls" ? "toolUse" : reason as "stop" | "length";
        this.terminal = true;
        this.stream.push({ type: "done", reason: this.message.stopReason, message: this.message });
        this.stream.end(); return true;
      }
      case "error": throw new Error(typeof event.error === "string" ? event.error : "Rust Cursor request failed");
      default: throw new Error("Unsupported Rust Cursor stream event");
    }
  }
  private close(b: Block, incomplete = false): void {
    b.ended = true;
    const p = this.message.content[b.index]!;
    if (p.type === "text") this.stream.push({ type: "text_end", contentIndex: b.index, content: p.text, partial: this.message });
    else if (p.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: b.index, content: p.thinking, partial: this.message });
    else {
      if (incomplete) { p.arguments = {}; p.argumentsError = "Cursor tool arguments were incomplete; do not execute"; }
      this.stream.push({ type: "toolcall_end", contentIndex: b.index, toolCall: p, partial: this.message });
    }
  }
  fail(error: unknown, aborted: boolean, secrets: readonly string[]): void {
    if (this.terminal) return;
    for (const b of this.blocks.values()) if (!b.ended) this.close(b, true);
    let message = aborted ? "Cursor request aborted" : safeError(error, secrets);
    if (!aborted && /context_length_exceeded|maximum context length|prompt is too long|context window.{0,30}exceeded/i.test(message)) {
      message = "context_length_exceeded: " + message;
    }
    this.message.errorMessage = message;
    this.message.stopReason = aborted ? "aborted" : "error";
    this.terminal = true;
    this.stream.push({ type: "error", reason: this.message.stopReason, error: this.message }); this.stream.end();
  }
  private usage(raw: unknown): Usage {
    const value = isRecord(raw) ? raw : {}, input = isRecord(value.inputTokens) ? value.inputTokens : {},
      output = isRecord(value.outputTokens) ? value.outputTokens : {};
    const read = count(input.cacheRead) ?? 0, write = count(input.cacheWrite) ?? 0;
    const totalInput = count(input.total), noCache = count(input.noCache);
    const usage: Usage = { ...emptyUsage(), input: noCache ?? Math.max(0, (totalInput ?? 0) - read - write),
      cacheRead: read, cacheWrite: write, output: count(output.total) ?? 0 };
    const reasoning = count(output.reasoning);
    if (reasoning !== undefined) usage.reasoning = reasoning;
    usage.totalTokens = (totalInput ?? usage.input + read + write) + usage.output;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) usage.cost[key] = usage[key] * this.model.cost[key] / 1000000;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
    this.diagnostic("cursor_native_usage", { tokens: totalInput !== undefined || noCache !== undefined || count(output.total) !== undefined ? "reported" : "unreported",
      cache: count(input.cacheRead) !== undefined || count(input.cacheWrite) !== undefined ? "reported" : "unreported",
      cost: "model-rate estimate only; Cursor billing/quota unverified" });
    return usage;
  }
}
