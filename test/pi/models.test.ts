import { describe, expect, it } from "vitest";
import { CursorCatalog } from "../../packages/pi/src/models.js";

import { parameterizedCatalog } from "./catalog-fixture.js";

describe("Rust-enriched model catalog (metadata conversion only)", () => {
  it("always keeps auto, maps default to auto, and never advertises images by model-name inference", () => {
    for (const raw of [[{ id: "default" }], [{ id: "text-with-vision-name" }], [{ id: "unattested", supportsImages: true }]]) {
      const catalog = new CursorCatalog(), models = catalog.apply(JSON.stringify(raw), "account-a");
      expect(models.find(m => m.id === "auto")).toMatchObject({ input: ["text"] });
      expect(catalog.route("auto").modelId).toBe(raw[0]!.id === "default" ? "default" : "auto");
    }
    const catalog = new CursorCatalog();
    catalog.apply(JSON.stringify([{ id: "gpt-codex-max", reasoning: false }]), "a");
    expect(catalog.route("gpt-codex-max")).toMatchObject({ modelId: "gpt-codex-max" });
  });
  it("routes Pi thinking:off (undefined) to a real none sibling rather than the reasoning default", () => {
    const catalog = new CursorCatalog();
    catalog.apply(JSON.stringify([{ id: "chat", reasoning: true }, { id: "chat-none" }, { id: "chat-high", reasoning: true }]), "a");
    expect(catalog.route("chat")).toEqual(catalog.route("chat", "off"));
    expect(catalog.route("chat")).toMatchObject({ modelId: "chat-none", effort: "none" });
    expect(catalog.route("chat", "high")).toMatchObject({ modelId: "chat-high" });
    expect(() => catalog.route("chat", "max")).toThrow(/does not advertise/);
  });
  it("uses the advertised logical model name with exact context/fast/thinking sets, keeping reasoning:max and Max Mode distinct", () => {
    const catalog = new CursorCatalog(), definitions = catalog.apply(JSON.stringify(parameterizedCatalog), "a");
    const ids = definitions.map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining(["auto", "family", "family-none", "family-high", "family-max", "family-1m-max-mode-high-thinking-fast"]));
    expect(catalog.route("family", "high")).toEqual({ modelId: "family", maxMode: false, supportsImages: true, effort: "high",
      modelParameters: [{ id: "reasoning", value: "high" }, { id: "context", value: "200k" }] });
    expect(catalog.route("family", "max")).toMatchObject({ maxMode: false, effort: "max" });
    const extended = catalog.route("family-1m-max-mode-high-thinking-fast", "high");
    expect(extended).toMatchObject({ maxMode: true, modelParameters: parameterizedCatalog[0]!.parameterized!.variants[3]!.parameters });
    expect(definitions.find(m => m.id === "family-1m-max-mode-high-thinking-fast")).toMatchObject({ contextWindow: 1000000, input: ["text", "image"] });
    expect(() => catalog.route("family-1m-max-mode-high-thinking-fast", "low")).toThrow(/does not advertise/);
    expect(ids).not.toContain("family-low"); expect(ids).not.toContain("family-max-mode-high");
    expect(() => catalog.route("family-1m-high")).toThrow(/catalog/);
  });
  it("reserves the basic selection for the advertised default even when that default is in a later group", () => {
    const catalog = new CursorCatalog();
    const parameters = (context: string) => [{ id: "reasoning", value: "high" }, { id: "context", value: context }];
    catalog.apply(JSON.stringify([{ id: "family", parameterized: { name: "family", variants: [
      { parameters: parameters("200k"), isMaxMode: false },
      { parameters: parameters("1m"), isMaxMode: false, isDefaultNonMaxConfig: true },
    ] } }]), "a");
    expect(catalog.route("family")).toMatchObject({ modelParameters: parameters("1m"), maxMode: false });
    expect(catalog.route("family", "high")).toMatchObject({ modelParameters: parameters("1m") });
    expect(catalog.route("family-high")).toMatchObject({ modelParameters: parameters("200k") });
  });
  it("does not cross-product supportsMaxMode with non-Max variants or fabricate metadata-only direct routes", () => {
    const catalog = new CursorCatalog();
    const models = catalog.apply(JSON.stringify([{ id: "metadata", metadataOnly: true,
      parameterized: { name: "metadata", supportsMaxMode: true, variants: [{ parameters: [{ id: "effort", value: "low" }], isMaxMode: false }] } }]), "a");
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(["metadata", "metadata-low", "auto"]));
    expect(models.some(m => m.id.includes("max-mode"))).toBe(false);
    expect(catalog.route("metadata")).toMatchObject({ modelId: "metadata", maxMode: false, modelParameters: [{ id: "effort", value: "low" }] });
    expect(() => catalog.apply(JSON.stringify([{ id: "not-runnable", metadataOnly: true }]), "a")).toThrow(/no supported/);
  });
  it("preserves opaque parameters without delimiter-key aliasing or mutation", () => {
    const catalog = new CursorCatalog();
    const variants = ["x;y=z", "x"].map(value => ({ parameters: [{ id: "opaque", value }], isMaxMode: false }));
    const definitions = catalog.apply(JSON.stringify([{ id: "opaque", metadataOnly: true, parameterized: { name: "opaque", variants } }]), "a");
    const routes = definitions.filter(m => m.id.includes("-variant-")).map(m => catalog.route(m.id));
    expect(routes).toHaveLength(2); expect(routes.map(r => r.modelParameters)).toEqual(variants.map(v => v.parameters));
    routes[0]!.modelParameters![0]!.value = "mutated";
    expect(catalog.route(definitions.find(m => m.id.includes("-variant-"))!.id).modelParameters![0]!.value).toBe("x;y=z");
  });
  it("keeps empty, literal-empty and delimiter-looking efforts unique and reachable even beside a none sibling", () => {
    const values = ["", "empty", "none", "high-thinking", "opaque-0-"];
    const build = (ordered: string[]) => {
      const catalog = new CursorCatalog();
      const definitions = catalog.apply(JSON.stringify([{ id: "family", metadataOnly: true, parameterized: { name: "family", variants: ordered.map(value => ({
        parameters: [{ id: "reasoning", value }], isMaxMode: false, isDefaultNonMaxConfig: value === "empty",
      })) } }]), "a");
      const exact = definitions.filter(m => !["family", "auto"].includes(m.id));
      expect(exact).toHaveLength(values.length);
      const ids = new Set(exact.map(m => m.id)); expect(ids.size).toBe(values.length);
      const routes = Object.fromEntries(exact.map(m => [m.id, catalog.route(m.id).modelParameters![0]!.value]));
      expect(Object.values(routes).sort()).toEqual([...values].sort());
      expect(catalog.route("family").modelParameters![0]!.value).toBe("empty");
      return routes;
    };
    expect(build(values)).toEqual(build([...values].reverse()));
  });
  it("never overwrites a directly runnable ID with a differently routed parameter variant", () => {
    const catalog = new CursorCatalog();
    const definitions = catalog.apply(JSON.stringify([{ id: "family-high", reasoning: true }, { id: "family", parameterized: {
      name: "family", variants: [{ parameters: [{ id: "reasoning", value: "high" }], isMaxMode: false }],
    } }]), "a");
    expect(catalog.route("family-high")).toMatchObject({ modelId: "family-high" });
    expect(definitions.some(m => catalog.route(m.id).modelParameters?.some(p => p.id === "reasoning" && p.value === "high"))).toBe(true);
    expect(catalog.route("family", "high")).toMatchObject({ modelId: "family", modelParameters: [{ id: "reasoning", value: "high" }] });
  });
  it("restores only a matching account/endpoint snapshot supplied by Pi and ignores visible-model tampering", () => {
    const catalog = new CursorCatalog(); catalog.apply(JSON.stringify(parameterizedCatalog), "account-a");
    const stored = { models: catalog.persistedModels("https://fixture.invalid") };
    const restored = new CursorCatalog();
    expect(restored.restore(stored, "account-b", "https://fixture.invalid")).toBe(false);
    expect(restored.restore(stored, "account-a", "https://other.invalid")).toBe(false);
    stored.models.find(m => m.id === "family")!.input = ["text"];
    expect(restored.restore(stored, "account-a", "https://fixture.invalid")).toBe(true);
    expect(restored.route("family", "max")).toEqual(catalog.route("family", "max"));
    expect(restored.definitions().find(m => m.id === "family")!.input).toEqual(["text", "image"]);
  });
});
