// Bufbuild/JS is a server-side test oracle only. The client under test is NativeEngine.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, constants, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema, AgentServerMessageSchema, type AgentClientMessage, type AgentRunRequest,
  type ExecServerMessage,
} from "../../reference/pi-cursor/src/proto/agent_pb.js";
import { createConnectFrameParser, frameConnectMessage } from "../../reference/pi-cursor/src/client/bridge.js";

export interface RustCursorRun {
  stream: ServerHttp2Stream;
  request: AgentRunRequest;
  path: string;
  authorizationHash: string;
  closed: Promise<void>;
}

export function sendRustMessage(stream: ServerHttp2Stream, message: MessageInitShape<typeof AgentServerMessageSchema>): void {
  const frame = frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)));
  // Split even the Connect header, independently of Rust's encoder/decoder.
  stream.write(frame.subarray(0, 2));
  stream.write(frame.subarray(2));
}
export function sendRustText(stream: ServerHttp2Stream, text: string, kind: "textDelta" | "thinkingDelta" = "textDelta"): void {
  sendRustMessage(stream, { message: { case: "interactionUpdate", value: { message: { case: kind, value: { text } } } } });
}
export function sendRustExec(stream: ServerHttp2Stream, id: number, message: ExecServerMessage["message"], execId = "exec-" + id): void {
  sendRustMessage(stream, { message: { case: "execServerMessage", value: { id, execId, message } } });
}
export function finishRustTurn(stream: ServerHttp2Stream): void {
  sendRustMessage(stream, { message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } } });
  stream.end(frameConnectMessage(Buffer.from("{}"), 2));
}

/** Every timeout is cleared; callers own close() and the native engine's shutdown. */
export async function bounded<T>(pending: PromiseLike<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out: " + label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function rustCursorServer(options: {
  onRun?: (run: RustCursorRun) => void;
  onMessage?: (message: AgentClientMessage, stream: ServerHttp2Stream) => void;
} = {}) {
  const server = createServer(), sessions = new Set<ServerHttp2Session>(), streams = new Set<ServerHttp2Stream>();
  const events = new EventEmitter();
  const runs: RustCursorRun[] = [], messages: AgentClientMessage[] = [], clientFrames: Buffer[] = [], errors: Error[] = [];
  let connections = 0, closing: Promise<void> | undefined;
  server.on("session", session => {
    connections++; sessions.add(session);
    session.on("error", () => {});
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    streams.add(stream);
    const closed = new Promise<void>(resolve => stream.once("close", () => { streams.delete(stream); resolve(); }));
    stream.on("error", () => {}); // RST_STREAM is expected during cancellation.
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const parse = createConnectFrameParser(bytes => {
      clientFrames.push(Buffer.from(bytes));
      const message = fromBinary(AgentClientMessageSchema, bytes);
      messages.push(message);
      if (message.message.case === "runRequest") {
        const run: RustCursorRun = { stream, closed, request: message.message.value, path: String(headers[":path"]),
          authorizationHash: createHash("sha256").update(String(headers.authorization ?? "")).digest("hex") };
        runs.push(run);
        options.onRun?.(run);
      } else { options.onMessage?.(message, stream); }
      events.emit("change");
    }, () => {});
    stream.on("data", chunk => {
      try { parse(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        stream.close(constants.NGHTTP2_INTERNAL_ERROR);
        events.emit("change");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      server.once("listening", resolve); server.once("error", reject);
    }).finally(() => { server.removeAllListeners("listening"); server.removeAllListeners("error"); }), "fixture listen");
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: "http://127.0.0.1:" + address.port, runs, messages, clientFrames, errors,
    get connections() { return connections; },
    get activeStreams() { return streams.size; },
    async waitForRuns(count: number) {
      const changed = () => { if (errors.length || runs.length >= count) resolve(); };
      let resolve!: () => void;
      const pending = new Promise<void>(r => { resolve = r; });
      events.on("change", changed); changed();
      try { await bounded(pending, "fixture run count " + count); }
      finally { events.off("change", changed); }
      if (errors.length) throw errors[0];
      return runs;
    },
    close(): Promise<void> {
      return closing ??= bounded(new Promise<void>((resolve, reject) => {
        for (const stream of streams) stream.destroy();
        for (const session of sessions) session.destroy();
        server.close(error => error ? reject(error) : resolve());
      }), "fixture close");
    },
  };
}
