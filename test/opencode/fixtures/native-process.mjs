// IPC-only native fault fixture. No credential discovery or host-tool execution.
import { createRustEngine } from "@cursor-harness-provider/native";

const engine = createRustEngine();
const streams = new Map();
const TOKEN = "fixture-native-process-token-not-a-credential";
const send = message => { if (process.connected) process.send(message); };
function category(error) {
  const message = String(error?.message ?? error);
  if (/already in use/i.test(message)) return "locked";
  if (/journal.*(?:corrupt|expired|binding)|recovery journal/i.test(message)) return "corrupt";
  if (/pending|blind|uncertain|provenance|matching results|recovery.*blocked|checkpoint/i.test(message)) return "unsafe";
  if (/cancel|abort/i.test(message)) return "cancelled";
  return "other"; // Never send native error text, tokens, arguments or tool results.
}
async function drain(id, stream) {
  try {
    for (let count = 0; count < 128; count++) {
      const raw = await stream.nextEvent();
      if (raw == null) { send({ kind: "end", id }); return; }
      const event = JSON.parse(raw);
      send({ kind: "event", id, type: event.type,
        ...(event.type === "error" ? { error: category(event.error ?? event.message ?? event.errorText) } : {}),
        ...(event.type === "finish" ? { finishReason: event.finishReason } : {}),
        ...(event.type === "tool-call" ? { toolCallId: event.toolCallId, toolName: event.toolName, providerExecuted: event.providerExecuted } : {}),
      });
    }
    stream.cancel();
    send({ kind: "end", id, error: "event-limit" });
  } catch (error) { send({ kind: "end", id, error: category(error) }); }
  finally { streams.delete(id); }
}
process.on("message", async message => {
  const { id, op } = message;
  try {
    if (op === "start") {
      const url = new URL(message.input.agentUrl);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Fixture requires localhost H2");
      const stream = await engine.start(JSON.stringify(message.input), TOKEN);
      streams.set(id, stream);
      send({ kind: "reply", id, ok: true });
      void drain(id, stream);
    } else if (op === "cancel") {
      streams.get(message.run)?.cancel();
      send({ kind: "reply", id, ok: true });
    } else if (op === "remove") {
      await engine.remove(message.scope);
      send({ kind: "reply", id, ok: true });
    } else if (op === "shutdown") {
      for (const stream of streams.values()) stream.cancel();
      engine.shutdown();
      send({ kind: "reply", id, ok: true });
    } else throw new Error("Unknown fixture command");
  } catch (error) { send({ kind: "reply", id, ok: false, error: category(error) }); }
});
process.on("disconnect", () => {
  for (const stream of streams.values()) stream.cancel();
  engine.shutdown();
  process.exit(0);
});
send({ kind: "ready" });
