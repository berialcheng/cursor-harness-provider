// Legacy JS transcript conversion: test oracle only, never a production import.
import type { LanguageModelV3CallOptions, LanguageModelV3ToolResultPart } from "@ai-sdk/provider";
import type { AssistantMessage, Context, ImageContent, Message, TextContent } from "../host/stream.js";
import { inlineImage } from "../../../packages/opencode/src/adapter.js";
export { validateOptions, requestHeader, nativeReasoning } from "../../../packages/opencode/src/adapter.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function toolResult(part: LanguageModelV3ToolResultPart): Extract<Message, { role: "toolResult" }> {
  const output = part.output;
  const content: Array<TextContent | ImageContent> = [];
  let isError = false;
  switch (output.type) {
    case "text": content.push({ type: "text", text: output.value }); break;
    case "json": content.push({ type: "text", text: JSON.stringify(output.value) }); break;
    case "error-text": isError = true; content.push({ type: "text", text: output.value }); break;
    case "error-json": isError = true; content.push({ type: "text", text: JSON.stringify(output.value) }); break;
    case "execution-denied":
      isError = true; content.push({ type: "text", text: "OpenCode denied tool execution: " + (output.reason ?? "permission denied") }); break;
    case "content":
      for (const item of output.value) {
        if (item.type === "text") content.push({ type: "text", text: item.text });
        else if (item.type === "image-data" || item.type === "file-data") content.push(inlineImage({ mediaType: item.mediaType, data: item.data }));
        else throw new Error("Cursor Native cannot represent referenced tool-result media: " + item.type);
      }
      break;
  }
  return { role: "toolResult", toolCallId: part.toolCallId, toolName: part.toolName, isError, content, timestamp: Date.now() };
}

export function toNativeContext(options: LanguageModelV3CallOptions): Context {
  const system: string[] = [];
  const messages: Message[] = [];
  for (const message of options.prompt) {
    if (message.role === "system") { system.push(message.content); continue; }
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((part) => part.type === "text" ? { type: "text" as const, text: part.text } : inlineImage(part)) });
      continue;
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      const results: LanguageModelV3ToolResultPart[] = [];
      for (const part of message.content) {
        if (part.type === "text") content.push({ type: "text", text: part.text });
        else if (part.type === "reasoning") content.push({ type: "thinking", thinking: part.text });
        else if (part.type === "tool-call") {
          if (part.providerExecuted) throw new Error("Provider-executed tools cannot be replayed as local tool calls");
          if (!record(part.input)) throw new Error("Tool-call input must be a JSON object");
          content.push({ type: "toolCall", id: part.toolCallId, name: part.toolName, arguments: part.input });
        } else if (part.type === "tool-result") results.push(part);
        else throw new Error("Unsupported assistant content: " + part.type);
      }
      messages.push({ role: "assistant", content, api: "cursor-native", provider: "cursor-native", model: "", stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      messages.push(...results.map(toolResult));
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") throw new Error("Provider tool-approval messages are unsupported; use OpenCode tools");
      messages.push(toolResult(part));
    }
  }
  const tools = (options.tools ?? []).map((tool) => {
    if (tool.type !== "function") throw new Error("Cursor Native supports host function tools only");
    return { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> };
  });
  return { systemPrompt: system.join("\n\n"), messages, tools };
}

