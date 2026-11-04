import { describe, expect, it } from "vitest";
import { inlineImage, validateOptions } from "../../packages/opencode/src/adapter.js";
import { toNativeContext } from "../reference/opencode/adapter.js";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
const options = (prompt: LanguageModelV3CallOptions["prompt"]): LanguageModelV3CallOptions => ({ prompt });
describe("OpenCode transcript adapter", () => {
  it("preserves system, tool input, result errors and Unicode without executing anything", () => {
    const context = toNativeContext(options([
      { role: "system", content: "系统" },
      { role: "user", content: [{ type: "text", text: "read it" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "思考" }, { type: "tool-call", toolCallId: "call", toolName: "read", input: { filePath: "/tmp/你好" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "execution-denied", reason: "user denied" } }] },
    ]));
    expect(context.systemPrompt).toBe("系统");
    expect(context.messages[1]).toMatchObject({ content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", arguments: { filePath: "/tmp/你好" } }] });
    expect(context.messages[2]).toMatchObject({ role: "toolResult", isError: true, content: [{ text: "OpenCode denied tool execution: user denied" }] });
  });
  it("keeps all tool JSON Schema constraints", () => {
    const context = toNativeContext({ prompt: [], tools: [{ type: "function", name: "check", inputSchema: { type: "object", properties: { n: { type: "number", minimum: 1 } }, additionalProperties: false, required: ["n"] } }] });
    expect(context.tools?.[0]?.parameters).toMatchObject({ additionalProperties: false, required: ["n"] });
  });
  it("represents explicit inline images and never downloads remote/file URLs", () => {
    expect(inlineImage({ mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) }).data).toBe("iVBORw==");
    for (const url of ["https://example.test/image.png", "file:///etc/passwd"]) expect(() => inlineImage({ mediaType: "image/png", data: new URL(url) })).toThrow("will not fetch");
  });
  it("rejects unsupported media rather than silently dropping it", () => {
    expect(() => inlineImage({ mediaType: "application/pdf", data: "AA==" })).toThrow("attachments only");
    expect(() => inlineImage({ mediaType: "image/png", data: "not-base64!" })).toThrow("Invalid");
  });
  it("preserves structured error tool output", () => {
    const context = toNativeContext(options([{ role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "test", output: { type: "error-json", value: { error: "bad" } } }] }]));
    expect(context.messages[0]).toMatchObject({ isError: true, content: [{ text: '{"error":"bad"}' }] });
  });
  it("rejects provider-executed replay, forced tools and enforced JSON", () => {
    expect(() => toNativeContext(options([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "shell", input: {}, providerExecuted: true }] }]))).toThrow("Provider-executed");
    expect(() => validateOptions({ prompt: [], toolChoice: { type: "required" } })).toThrow("auto/none");
    expect(() => validateOptions({ prompt: [], responseFormat: { type: "json" } })).toThrow("structured output");
  });
  it("reports ignored generation controls explicitly", () => {
    expect(validateOptions({ prompt: [], temperature: 0.1, maxOutputTokens: 10 }).map(w => w.type)).toEqual(["unsupported", "unsupported"]);
  });
});
