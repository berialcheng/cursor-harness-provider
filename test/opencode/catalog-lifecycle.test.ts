import { afterEach, expect, it, vi } from "vitest";
import plugin from "../../packages/opencode/src/plugin.js";

const native = vi.hoisted(() => ({ listModels: vi.fn(), shutdown: vi.fn() }));
vi.mock("@cursor-harness-provider/native", () => ({ createRustEngine: () => native, shutdownRustEngines: () => {} }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); native.listModels.mockReset(); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const catalog = (id: string) => JSON.stringify([{ id, name: id, reasoning: false, supportsImages: true, contextWindow: 100000, maxTokens: 1000 }]);
async function fixture(discovery = true) {
  vi.stubEnv("CURSOR_ACCESS_TOKEN", ""); vi.stubEnv("OPENCODE_CURSOR_OFFLINE", "0");
  let account: string | undefined = "A", inventory: any, transform: any, waiting: any;
  const queue: any[] = [], resolves: string[] = [];
  const publish = () => transform?.({ add: (value: any) => { inventory = value; } });
  const iterator = {
    next: () => queue.length ? Promise.resolve({ done: false, value: queue.shift() }) : new Promise(resolve => { waiting = resolve; }),
    return: async () => { waiting?.({ done: true }); waiting = undefined; return { done: true }; },
    [Symbol.asyncIterator]() { return this; },
  };
  const push = (type = "credential.switched") => { const value = { type, data: { integrationID: "cursor-native" } }; if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value }); } else queue.push(value); };
  const registration = async () => ({ dispose: async () => {} });
  const ctx: any = {
    options: { discovery }, location: { directory: "/tmp/catalog-fixture" },
    aisdk: { hook: registration },
    integration: { transform: async (fn: any) => { fn({ update: () => {}, method: { update: () => {} } }); return registration(); }, connection: {
      active: async () => account ? { type: "credential", id: account } : undefined,
      resolve: async (connection: any) => { resolves.push(connection.id); return { type: "oauth", access: "fixture-secret-" + connection.id }; },
    } },
    provider: { transform: async (fn: any) => { transform = fn; publish(); return registration(); }, reload: vi.fn(async () => publish()) },
    session: { hook: registration }, event: { subscribe: () => iterator },
  };
  const dispose = await plugin.setup(ctx); if (dispose) cleanups.push(dispose);
  return { get inventory() { return inventory; }, get ids() { return inventory.models.map((m: any) => m.id); }, resolves, reload: ctx.provider.reload, push, switch(value?: string) { account = value; push(); }, dispose };
}
it("resets A model IDs/images on B discovery 503, logout, and same-account failure without credential leakage", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  native.listModels.mockResolvedValueOnce(catalog("A_ONLY")).mockRejectedValueOnce(new Error("503 fixture-secret-B"));
  const f = await fixture(); await vi.waitFor(() => expect(f.ids).toContain("A_ONLY"));
  f.switch("B"); await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(2));
  expect(f.ids).toEqual(["auto"]); expect(f.inventory.models[0].capabilities.input).toEqual(["text"]);
  expect(f.resolves).toEqual(["A", "B"]); // no fallback harvesting A after B rejection
  native.listModels.mockResolvedValueOnce(catalog("B_ONLY")); f.push("credential.updated");
  await vi.waitFor(() => expect(f.ids).toContain("B_ONLY"));
  native.listModels.mockRejectedValueOnce(new Error("fixture-secret-B")); f.push("credential.updated");
  await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(4)); expect(f.ids).toEqual(["auto"]);
  native.listModels.mockResolvedValueOnce(catalog("B_ONLY")); f.push("credential.updated");
  await vi.waitFor(() => expect(f.ids).toContain("B_ONLY"));
  f.switch(undefined); await vi.waitFor(() => expect(f.ids).toEqual(["auto"]));
  expect(native.listModels).toHaveBeenCalledTimes(5); expect(JSON.stringify(f.inventory)).not.toContain("fixture-secret"); expect(log).not.toHaveBeenCalled();
});
it("rejects late A success after B failure, and a late A failure cannot erase B success", async () => {
  const a = deferred<string>(); native.listModels.mockReturnValueOnce(a.promise).mockRejectedValueOnce(new Error("503"));
  const f = await fixture(); await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(1));
  f.switch("B"); await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(2)); a.resolve(catalog("A_ONLY"));
  await new Promise(resolve => setTimeout(resolve, 0)); expect(f.ids).toEqual(["auto"]);
  const late = deferred<string>(); native.listModels.mockReturnValueOnce(late.promise).mockResolvedValueOnce(catalog("B_ONLY"));
  f.switch("A"); await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(3));
  f.switch("B"); await vi.waitFor(() => expect(f.ids).toContain("B_ONLY")); late.reject(new Error("A rejected"));
  await new Promise(resolve => setTimeout(resolve, 0)); expect(f.ids).toEqual(["auto", "B_ONLY"]);
});
it("does not publish late discovery after disposal and keeps discovery optional", async () => {
  const pending = deferred<string>(); native.listModels.mockReturnValueOnce(pending.promise);
  const f = await fixture(); await vi.waitFor(() => expect(native.listModels).toHaveBeenCalledTimes(1));
  await f.dispose?.(); const before = f.reload.mock.calls.length; pending.resolve(catalog("LATE"));
  await new Promise(resolve => setTimeout(resolve, 0)); expect(f.reload).toHaveBeenCalledTimes(before); expect(f.ids).toEqual(["auto"]);
  await fixture(false); expect(native.listModels).toHaveBeenCalledTimes(1);
});
