/** Local-only wire oracle. Production Pi code never imports a JS protocol client. */
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { once } from "node:events";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, AgentServerMessageSchema, GetUsableModelsResponseSchema,
  type AgentRunRequest } from "../reference/pi-cursor/src/proto/agent_pb.js";
import { createConnectFrameParser, frameConnectMessage } from "../reference/pi-cursor/src/client/bridge.js";
import { encodeMcpArgsMap } from "../reference/pi-cursor/src/stream/request-build.js";

// An actual 1x1 PNG attachment, generated fixture bytes, never a real user resource.
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const varint = (value: number): Buffer => { const b: number[] = []; do { let n = value & 127; value = Math.floor(value / 128); if (value) n |= 128; b.push(n); } while (value); return Buffer.from(b); };
const field = (n: number, bytes: Buffer) => Buffer.concat([varint(n * 8 + 2), varint(bytes.length), bytes]);
const str = (n: number, value: string) => field(n, Buffer.from(value));
const integer = (n: number, value: number) => Buffer.concat([varint(n * 8), varint(value)]);
function variant(parameters: Record<string, string>, maxMode: boolean, defaultMode = false): Buffer {
  return Buffer.concat([...Object.entries(parameters).map(([id, value]) => field(1, Buffer.concat([str(1, id), str(2, value)]))),
    integer(3, maxMode ? 1 : 0), ...(defaultMode ? [integer(maxMode ? 4 : 5, 1)] : [])]);
}
export const availableModels = Buffer.concat([field(2, Buffer.concat([
  str(1, "family"), integer(10, 1), integer(14, 1), integer(15, 200000), integer(16, 1000000), str(17, "Fixture Family"), str(18, "server-family"), integer(19, 1),
  field(30, variant({ reasoning: "none", context: "200k" }, false, true)),
  field(30, variant({ reasoning: "high", context: "200k" }, false)),
  field(30, variant({ reasoning: "max", context: "200k" }, false)),
  field(30, variant({ reasoning: "high", context: "1m", thinking: "true", fast: "true" }, true, true)),
]))]);

export async function piCursorServer(options: { toolName?: string; toolArgs?: Record<string, unknown>; checkpoint?: boolean } = {}) {
  const server = createServer(), sessions = new Set<ServerHttp2Session>();
  const runs: AgentRunRequest[] = [], results: unknown[] = [], roots: string[][] = [], errors: string[] = [];
  let discoveryCalls = 0, metadataCalls = 0;
  const send = (stream: ServerHttp2Stream, value: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) => {
    stream.write(frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, value))));
  };
  const complete = (stream: ServerHttp2Stream, text: string) => {
    send(stream, { message: { case: "interactionUpdate", value: { message: { case: "textDelta", value: { text } } } } });
    if (options.checkpoint) send(stream, { message: { case: "conversationCheckpointUpdate", value: { summary: Buffer.from("STALE_CHECKPOINT_SUMMARY"), clientName: "pi" } } });
    send(stream, { message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } } });
    stream.end(frameConnectMessage(Buffer.from("{}"), 2));
  };
  server.on("session", session => { sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    if (headers.authorization !== "Bearer mock-cursor-token") { errors.push("Unexpected fixture credential"); stream.respond({ ":status": 401 }); stream.end(); return; }
    const path = headers[":path"];
    if (path === "/agent.v1.AgentService/GetUsableModels" || path === "/aiserver.v1.AiService/AvailableModels") {
      stream.on("data", () => {});
      stream.on("end", () => {
        stream.respond({ ":status": 200, "content-type": "application/proto" });
        if (path.endsWith("GetUsableModels")) {
          discoveryCalls++; stream.end(toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, { models: [
            { modelId: "default", displayName: "Auto" }, { modelId: "family", displayName: "Fixture Family" },
          ] })));
        } else { metadataCalls++; stream.end(availableModels); }
      });
      return;
    }
    if (path !== "/agent.v1.AgentService/Run") { errors.push("Unexpected local RPC: " + path); stream.respond({ ":status": 404 }); stream.end(); return; }
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    let run: AgentRunRequest | undefined, rootIndex = -1, pending = new Set<number>();
    const respond = () => {
      if (!run) return;
      const text = run.action?.action.case === "userMessageAction" ? run.action.action.value.userMessage?.text ?? "" : "";
      if (text.includes("TEST_USE_TOOL")) {
        send(stream, { message: { case: "execServerMessage", value: { id: 7, execId: "fixture-exec", message: { case: "mcpArgs", value: {
          name: "mcp_pi_" + (options.toolName ?? "attach_fixture"), toolName: options.toolName ?? "attach_fixture", providerIdentifier: "pi", toolCallId: "1",
          args: encodeMcpArgsMap(options.toolArgs ?? { value: "fixture" }),
        } } } } });
      } else complete(stream, "PONG fixture");
    };
    const parse = createConnectFrameParser(bytes => {
      const message = fromBinary(AgentClientMessageSchema, bytes);
      if (message.message.case === "runRequest") {
        run = message.message.value; runs.push(run); rootIndex = roots.push([]) - 1;
        // Ask the actual native engine for every retained root: history assertions
        // exercise real KV, not merely a JS DTO or a nonempty reference count.
        const ids = run.conversationState?.rootPromptMessagesJson ?? [];
        pending = new Set(ids.map((_id, i) => i + 1));
        ids.forEach((id, i) => send(stream, { message: { case: "kvServerMessage", value: { id: i + 1, message: { case: "getBlobArgs", value: { blobId: id } } } } }));
        if (!pending.size) respond();
      } else if (message.message.case === "kvClientMessage") {
        const kv = message.message.value;
        if (kv.message.case !== "getBlobResult" || !kv.message.value.blobData) throw new Error("Missing fixture history blob");
        roots[rootIndex]!.push(Buffer.from(kv.message.value.blobData).toString("utf8")); pending.delete(kv.id);
        if (!pending.size) respond();
      } else if (message.message.case === "execClientMessage") {
        results.push(toJson(AgentClientMessageSchema, message)); complete(stream, "TOOL_RESULT_RECEIVED");
      }
    }, () => {});
    stream.on("data", data => {
      try { parse(Buffer.from(data)); } catch (error) {
        const text = error instanceof Error ? error.message : String(error); errors.push(text);
        stream.end(frameConnectMessage(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: text } })), 2));
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local fixture address");
  return { url: "http://127.0.0.1:" + address.port, runs, roots, results, errors,
    get discoveryCalls() { return discoveryCalls; }, get metadataCalls() { return metadataCalls; },
    async close() { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
