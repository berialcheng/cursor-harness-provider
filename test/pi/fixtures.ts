import { vi } from "vitest";
import { normalizeContext, type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type Model, type OAuthCredentials } from "@earendil-works/pi-ai";
import type { RustEngine, RustStream } from "@cursor-harness-provider/native";
import { CursorAuth, type AuthDependencies } from "../../packages/pi/src/auth/index.js";
import { PiRustRuntime, type RuntimeDependencies } from "../../packages/pi/src/runtime.js";
import { CURSOR_NATIVE_API } from "../../packages/pi/src/constants.js";

export function jwt(sub = "fixture-a", suffix = "one"): string {
  return "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({ iss: "fixture-issuer", sub, exp: 4102444800 })).toString("base64url") + "." + suffix;
}
export const token = jwt();
export const infrastructureNotices = {
  hierarchy: "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute.\nRead/edit files → ctx_execute_file.",
  lens: "[pi-lens automated context — not a user request] A fixture file changed; this is context, not a new task.",
  context: "<context_notice>Fixture status: previous checks passed. This is not a user request.</context_notice>",
  resume: "<session_resume><active_memory>Prior decision: preserve fixture permissions.</active_memory></session_resume>",
  compaction: '<session_state source="compaction"><session_mode>implement</session_mode><summary>Prior work: fixture auth is pending review.</summary></session_state>',
};
export const env = { PI_CURSOR_SYSTEM_CREDENTIALS: "0", PI_CURSOR_CACHE_DIR: "/tmp/pi-cursor-fixture", PI_CURSOR_AGENT_URL: "http://127.0.0.1:9" };
export const finish = (reason = "stop", usage: unknown = { inputTokens: {}, outputTokens: {} }) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
export const textEvents = (text = "hello") => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }, finish()];
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export class FakeStream implements RustStream {
  constructor(readonly events: unknown[] = textEvents()) {}
  nextEvent = vi.fn(async (): Promise<string | null> => this.events.length ? JSON.stringify(this.events.shift()) : null);
  cancel = vi.fn();
  setAccessToken = vi.fn(async (_token: string) => {});
}
export class FakeEngine implements RustEngine {
  readonly streams: RustStream[] = [];
  readonly catalog = [{ id: "chat", name: "Fixture Chat", reasoning: true, supportsImages: true, contextWindow: 123000, maxTokens: 4000 },
    { id: "chat-high", reasoning: true, supportsImages: true }, { id: "other", reasoning: false }];
  start = vi.fn(async (_request: string, _token: string): Promise<RustStream> => this.streams.shift() ?? new FakeStream());
  listModels = vi.fn(async (_token: string, _url?: string) => JSON.stringify(this.catalog));
  remove = vi.fn(async (_scope: string) => {});
  shutdown = vi.fn();
}
export function fakeAuth(deps: Pick<AuthDependencies, "resolveAuth"> = {}) {
  const oauth = { login: vi.fn(async () => ({ access: token, refresh: "fixture-refresh", expires: 4102444800000 })),
    refresh: vi.fn(async (_refresh: string, _signal: AbortSignal): Promise<OAuthCredentials> => ({ access: jwt("fixture-a", "two"), refresh: "fixture-rotated", expires: 4102444800000 })) };
  const system = vi.fn(async () => undefined);
  const auth = new CursorAuth({ oauth, system, ...deps });
  return { auth, oauth, system };
}
export function model(id = "auto", images = false): Model<Api> {
  return { id, name: "Fixture", api: CURSOR_NATIVE_API, provider: "cursor", baseUrl: "http://127.0.0.1:9", reasoning: false,
    input: images ? ["text", "image"] : ["text"], contextWindow: 200000, maxTokens: 64000,
    cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } };
}
export const context = (value: Context = { systemPrompt: "fixture instructions", messages: [{ role: "user", content: "hello", timestamp: 1 }] }) => normalizeContext(value);
export function setup(events?: unknown[], deps: Pick<RuntimeDependencies, "resolveAuth" | "env"> = {}) {
  const engine = new FakeEngine(), auth = fakeAuth();
  if (events) engine.streams.push(new FakeStream(events));
  const createEngine = vi.fn(() => engine);
  const runtime = new PiRustRuntime({ createEngine, auth: auth.auth, version: () => "fixture-native-version", env: () => env, ...deps });
  runtime.setSession({ sessionId: "session-a", workspace: "/tmp/pi-workspace" });
  return { engine, createEngine, runtime, ...auth };
}
export async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(structuredClone(event));
  return events;
}
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));
