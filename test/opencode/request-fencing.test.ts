import { expect, it, vi } from "vitest";
import { createNativeModel, REQUEST_KIND_HEADER, SESSION_HEADER } from "../../packages/opencode/src/model.js";
import type { RustEngine } from "@cursor-harness-provider/native";

it.each(["missing-finish", "trailing-event", "eof-rejection"])("retains tool-loop fencing and releases admission after %s", async failure => {
  const finish = JSON.stringify({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: {}, outputTokens: {} } });
  const nextEvent = vi.fn<() => Promise<string | null>>();
  if (failure === "missing-finish") nextEvent.mockResolvedValueOnce(null);
  else {
    nextEvent.mockResolvedValueOnce(finish);
    if (failure === "trailing-event") nextEvent.mockResolvedValueOnce(JSON.stringify({ type: "error", error: "late error" }));
    else nextEvent.mockRejectedValueOnce(new Error("EOF failed"));
  }
  const engine: RustEngine = {
    start: vi.fn(async () => ({ nextEvent, cancel: vi.fn(), setAccessToken: async () => {} })),
    remove: vi.fn(async () => {}), shutdown: vi.fn(), listModels: vi.fn(),
  };
  const model = createNativeModel({ engine, modelId: "auto", workspace: "/tmp/fence", getAccessToken: async () => "fixture-token" });
  const options = {
    headers: { [SESSION_HEADER]: "fixture-session:generate", [REQUEST_KIND_HEADER]: "generate" },
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }],
    tools: [{ type: "function" as const, name: "read", inputSchema: { type: "object" } }],
  };
  await expect(model.doGenerate(options)).rejects.toThrow(/terminal event|EOF failed/);
  expect(engine.remove).not.toHaveBeenCalled();
  // A rejected terminal sequence must not permanently lock out a fenced retry.
  nextEvent.mockResolvedValueOnce(finish).mockResolvedValueOnce(null);
  await model.doGenerate(options);
  expect(engine.start).toHaveBeenCalledTimes(2); expect(engine.remove).toHaveBeenCalledTimes(1);
});

it("does not delete uncertainty/action-ledger fencing on a failed or cancelled generate tool loop", async () => {
  const engine: RustEngine = {
    start: vi.fn(async () => ({ nextEvent: async () => JSON.stringify({ type: "error", error: "uncertain action" }), cancel: vi.fn(), setAccessToken: async () => {} })),
    remove: vi.fn(async () => {}), shutdown: vi.fn(), listModels: vi.fn(),
  };
  const model = createNativeModel({ engine, modelId: "auto", workspace: "/tmp/fence", getAccessToken: async () => "fixture-token" });
  const options = {
    headers: { [SESSION_HEADER]: "fixture-session:generate", [REQUEST_KIND_HEADER]: "generate" },
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "fixture" }] }],
    tools: [{ type: "function" as const, name: "read", inputSchema: { type: "object" } }],
  };
  await expect(model.doGenerate(options)).rejects.toThrow("uncertain action");
  const result = await model.doStream(options); await result.stream.cancel();
  expect(engine.remove).not.toHaveBeenCalled(); expect(engine.start).toHaveBeenCalledTimes(2);
});
