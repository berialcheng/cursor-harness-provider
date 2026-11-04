import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { EventEmitter, once } from "node:events";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { AgentClientMessageSchema, AgentServerMessageSchema, InteractionUpdateSchema, TextDeltaUpdateSchema, ThinkingDeltaUpdateSchema, TokenDeltaUpdateSchema, TurnEndedUpdateSchema, ExecServerMessageSchema, McpArgsSchema, type AgentRunRequest } from "../../reference/pi-cursor/src/proto/agent_pb.js";
import { createConnectFrameParser, frameConnectMessage } from "../../reference/pi-cursor/src/client/bridge.js";
import { encodeMcpArgsMap } from "../../reference/pi-cursor/src/stream/request-build.js";

export async function cursorServer(options: { toolName?: string; toolArgs?: Record<string, unknown> } = {}) {
  const server = createServer(), sessions = new Set<ServerHttp2Session>();
  const events = new EventEmitter();
  const runs: AgentRunRequest[] = [];
  const results: unknown[] = [];
  let connections = 0;
  const send = (stream: ServerHttp2Stream, message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]) => {
    const framed = frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)));
    // Exercise partial frame headers, not only protobuf self-round-trips.
    stream.write(framed.subarray(0, 2)); stream.write(framed.subarray(2));
  };
  const text = (stream: ServerHttp2Stream, value: string) => send(stream, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: value }) } }) } });
  const done = (stream: ServerHttp2Stream) => {
    send(stream, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }) } });
    stream.end(frameConnectMessage(Buffer.from("{}"), 2));
  };
  server.on("session", session => { connections++; sessions.add(session); session.on("close", () => sessions.delete(session)); });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const parse = createConnectFrameParser(bytes => {
      const message = fromBinary(AgentClientMessageSchema, bytes);
      if (message.message.case === "runRequest") {
        const request = message.message.value;
        runs.push(request);
        events.emit("run", request);
        if (headers.authorization !== "Bearer mock-cursor-token") throw new Error("Unexpected mock credential");
        if (request.requestedModel?.modelId !== "default") throw new Error("Unexpected model: " + request.requestedModel?.modelId);
        const userText = request.action?.action.case === "userMessageAction" ? request.action.action.value.userMessage?.text ?? "" : "";
        if (userText.startsWith("WAIT_FOR_ABORT")) return;
        if (userText.includes("TEST_USE_TOOL")) {
          send(stream, { message: { case: "execServerMessage", value: create(ExecServerMessageSchema, {
            id: 7, execId: "exec-1", message: { case: "mcpArgs", value: create(McpArgsSchema, {
              name: "mcp_pi_" + (options.toolName ?? "echo_test"), toolName: options.toolName ?? "echo_test", providerIdentifier: "pi", toolCallId: "call-1",
              args: encodeMcpArgsMap(options.toolArgs ?? { value: "hello" }),
            }) },
          }) } });
        } else {
          send(stream, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text: "checking" }) } }) } });
          text(stream, "PONG 😀");
          send(stream, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 3 }) } }) } });
          done(stream);
        }
      } else if (message.message.case === "execClientMessage") {
        const exec = message.message.value;
        if (exec.message.case === "mcpResult") {
          const result = exec.message.value;
          results.push(toJson(AgentClientMessageSchema, message));
          text(stream, "TOOL_RESULT_RECEIVED");
          done(stream);
        }
      }
    }, () => {});
    stream.on("data", chunk => {
      try { parse(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch (error) {
        stream.end(frameConnectMessage(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: error instanceof Error ? error.message : String(error) } })), 2));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return { url: "http://127.0.0.1:" + address.port, runs, results, events, get connections() { return connections; },
    async close() { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
