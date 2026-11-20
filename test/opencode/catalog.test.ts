import { describe, expect, it } from "vitest";
import { catalogModel, directCatalogModels } from "../../packages/opencode/src/plugin.js";

const basic = { id: "chat", name: "Chat", reasoning: true, contextWindow: 200000, maxTokens: 64000 };
describe("OpenCode basic catalog boundary", () => {
  it("keeps directly runnable entries with image metadata, but not parameter-only identities", () => {
    const direct = { ...basic, supportsImages: true, parameterized: { name: "chat", variants: [] } };
    const models = directCatalogModels([
      direct,
      { ...basic, id: "metadata", metadataOnly: true },
      { ...basic, id: "parameterized", parameters: [{ id: "effort", value: "high" }] },
      { ...basic, id: "max-route", requiresMaxMode: true },
    ]);
    expect(models).toEqual([direct]);
    expect(catalogModel(models[0]!).capabilities.input).toEqual(["text", "image"]);
  });
});
