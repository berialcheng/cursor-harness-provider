import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { createNativeModel, SESSION_HEADER, WORKSPACE_HEADER } from "../../packages/opencode/src/model.js";
import { cursorServer } from "./fixtures/cursor-server.js";
import { cleanupAllSessionState } from "../reference/pi-cursor/src/stream/native-core.js";
import { resetCursorAgentUrlCacheForTests } from "../reference/pi-cursor/src/config/index.js";
import { shutdownRustEngines } from "@cursor-native/native";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
afterEach(() => { shutdownRustEngines(); cleanupAllSessionState(); resetCursorAgentUrlCacheForTests(); delete process.env.OPENCODE_CURSOR_AGENT_URL; });
function model(url: string) {
  process.env.OPENCODE_CURSOR_AGENT_URL = url; resetCursorAgentUrlCacheForTests();
  return createNativeModel({ modelId: "auto", workspace: "/tmp/native-h2", getAccessToken: async () => "mock-cursor-token" });
}
const prompt = (text: string, session: string): LanguageModelV3CallOptions => ({ headers: { [SESSION_HEADER]: session, [WORKSPACE_HEADER]: encodeURIComponent("/tmp/native-h2") },
  prompt: [{ role: "user", content: [{ type: "text", text }] }] });
describe("real in-process HTTP/2 + Connect/protobuf", () => {
  it("streams Unicode/thinking and reuses a connection for subsequent turns", async () => {
    const server = await cursorServer();
    try {
      const native = model(server.url);
      const first = await native.doGenerate(prompt("hello", "h2-text"));
      expect(first.content).toEqual([{ type: "reasoning", text: "checking" }, { type: "text", text: "PONG 😀" }]);
      expect(first.finishReason.unified).toBe("stop");
      expect(first.usage.outputTokens.total).toBeUndefined();
      expect(first.providerMetadata?.cursorNative?.billingUsage).toBe("not-verified");
      const second = await native.doGenerate({ ...prompt("again", "h2-text"), prompt: [
        ...prompt("hello", "h2-text").prompt, { role: "assistant", content: [{ type: "text", text: "PONG 😀" }] }, { role: "user", content: [{ type: "text", text: "again" }] },
      ] });
      expect(second.finishReason.unified).toBe("stop");
      expect(server.runs).toHaveLength(2); expect(server.connections).toBe(1);
      expect(server.runs[0]?.conversationState?.previousWorkspaceUris).toEqual(["file:///tmp/native-h2"]);
    } finally { cleanupAllSessionState(); await server.close(); }
  });
  it("yields a tool call to the host and writes its result back to the SAME Run RPC", async () => {
    const server = await cursorServer();
    try {
      const native = model(server.url);
      const options = { ...prompt("TEST_USE_TOOL", "h2-tools"), tools: [{ type: "function" as const, name: "echo_test", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
      const first = await native.doGenerate(options);
      expect(first.finishReason.unified).toBe("tool-calls");
      expect(first.content).toEqual([{ type: "tool-call", toolCallId: "call-1", toolName: "echo_test", input: '{"value":"hello"}', providerExecuted: false }]);
      const second = await native.doGenerate({ ...options, prompt: [
        ...options.prompt, { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "echo_test", input: { value: "hello" } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "echo_test", output: { type: "text", value: "SAFE_TEST_RESULT" } }] },
      ] });
      expect(second.content).toEqual([{ type: "text", text: "TOOL_RESULT_RECEIVED" }]);
      expect(JSON.stringify(server.results)).toContain("SAFE_TEST_RESULT");
      expect(server.runs).toHaveLength(1); expect(server.connections).toBe(1);
    } finally { cleanupAllSessionState(); await server.close(); }
  });
  it("cancels an outstanding HTTP/2 stream", async () => {
    const server = await cursorServer();
    try {
      const native = model(server.url), abort = new AbortController();
      const ran = once(server.events, "run");
      const stream = await native.doStream({ ...prompt("WAIT_FOR_ABORT", "h2-abort"), abortSignal: abort.signal });
      const reader = stream.stream.getReader();
      await ran;
      abort.abort();
      await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow(/abort/i);
    } finally { cleanupAllSessionState(); await server.close(); }
  });
});
