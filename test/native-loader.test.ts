import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const fake = vi.hoisted(() => ({ data: "generation-one", corrupt: false, loads: [] as string[] }));
vi.mock("node:fs", () => ({ readFileSync: (url: URL | string) => {
  const path = String(url);
  if (path.endsWith("/package.json")) return JSON.stringify({ version: "0.3.0" });
  const sha = createHash("sha256").update(fake.data).digest("hex");
  const platform = process.platform === "linux" ? "linux-" + process.arch + "-gnu" : process.platform + "-" + process.arch;
  if (path.endsWith("/manifest.json")) return JSON.stringify({ version: "0.3.0", artifacts: { [platform]: { file: "cursor_native." + platform + "." + sha.slice(0,16) + ".node", sha256: sha } } });
  return Buffer.from(fake.corrupt ? "tampered" : fake.data);
} }));
vi.mock("node:module", () => ({ createRequire: () => (path: string) => {
  fake.loads.push(path);
  return { nativeVersion: () => "0.3.0", NativeEngine: class { readonly generation = path; shutdown() {} } };
} }));
afterEach(() => { vi.resetModules(); fake.loads = []; fake.data = "generation-one"; fake.corrupt = false; });
describe("shared native loader generations", () => {
  it("retains one binding for an unchanged hash but loads a rebuilt hashed module across activations", async () => {
    const loader = await import("../packages/native/src/index.js");
    const first = loader.createRustEngine();
    const again = loader.createRustEngine();
    expect(fake.loads).toHaveLength(1);
    expect((first as unknown as { generation: string }).generation).toBe((again as unknown as { generation: string }).generation);
    fake.data = "generation-two";
    const second = loader.createRustEngine();
    expect(fake.loads).toHaveLength(2);
    expect((second as unknown as { generation: string }).generation).not.toBe((first as unknown as { generation: string }).generation);
    loader.shutdownRustEngines();
  });
  it("does not reuse a cached binding when the on-disk native module no longer matches its manifest", async () => {
    const loader = await import("../packages/native/src/index.js");
    loader.createRustEngine(); fake.corrupt = true;
    expect(() => loader.createRustEngine()).toThrow(/binding unavailable/);
    expect(fake.loads).toHaveLength(1);
  });
});
