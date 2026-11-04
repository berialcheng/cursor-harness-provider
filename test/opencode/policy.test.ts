import { describe, expect, it, vi } from "vitest";
import { create, fromBinary } from "@bufbuild/protobuf";
import { dispatchNativeExec } from "../reference/pi-cursor/src/stream/exec-native.js";
import { loadClipboardImagesFromText } from "../reference/pi-cursor/src/stream/clipboard-images.js";
import { processServerMessage } from "../reference/pi-cursor/src/stream/server-messages.js";
import { AgentClientMessageSchema, AgentServerMessageSchema, InteractionQuerySchema, WebSearchRequestQuerySchema } from "../reference/pi-cursor/src/proto/agent_pb.js";
import type { StreamState } from "../reference/pi-cursor/src/stream/types.js";

describe("host-owned execution policy", () => {
  it("never performs a native HTTP fetch, including localhost/private services", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const result = dispatchNativeExec("fetchArgs", { url: "http://127.0.0.1/private" });
      expect(result?.kind).toBe("sync");
      expect(JSON.stringify(result)).toContain("bypass host permissions");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it("does not auto-read image paths from prompt text", () => {
    expect(loadClipboardImagesFromText("/tmp/pi-clipboard-11111111-1111-1111-1111-111111111111.png")).toEqual([]);
  });
  it("rejects hosted search permission queries instead of auto-approving them", () => {
    const frames: Uint8Array[] = [];
    const state: StreamState = { toolCallIndex: 0, pendingExecs: [], outputTokens: 0, totalTokens: 0, turnEnded: false };
    processServerMessage(create(AgentServerMessageSchema, { message: { case: "interactionQuery", value: create(InteractionQuerySchema, { id: 1,
      query: { case: "webSearchRequestQuery", value: create(WebSearchRequestQuerySchema, {}) } }) } }), new Map(), [], frame => frames.push(frame), state, () => {}, () => {});
    expect(frames).toHaveLength(1);
    const result = fromBinary(AgentClientMessageSchema, frames[0]!.subarray(5));
    expect(result.message.case).toBe("interactionResponse");
    if (result.message.case !== "interactionResponse") throw new Error("Missing interaction response");
    const reply = result.message.value.result;
    expect(reply.case).toBe("webSearchRequestResponse");
    if (reply.case === "webSearchRequestResponse") expect(reply.value.result.case).toBe("rejected");
  });
});
