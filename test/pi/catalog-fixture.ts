export const parameterizedCatalog = [{ id: "family", name: "Fixture Family", reasoning: true, supportsImages: true, contextWindow: 200000, maxTokens: 8192,
  parameterized: { name: "family", clientDisplayName: "Fixture Family", serverModelName: "server-family", supportsImages: true,
    supportsMaxMode: true, supportsNonMaxMode: true, contextTokenLimit: 200000, contextTokenLimitForMaxMode: 1000000,
    variants: [
      { parameters: [{ id: "reasoning", value: "none" }, { id: "context", value: "200k" }], isMaxMode: false, isDefaultNonMaxConfig: true },
      { parameters: [{ id: "reasoning", value: "high" }, { id: "context", value: "200k" }], isMaxMode: false },
      { parameters: [{ id: "reasoning", value: "max" }, { id: "context", value: "200k" }], isMaxMode: false },
      { parameters: [{ id: "reasoning", value: "high" }, { id: "context", value: "1m" }, { id: "thinking", value: "true" }, { id: "fast", value: "true" }], isMaxMode: true, isDefaultMaxConfig: true },
    ] } }, { id: "default", name: "Auto", supportsImages: false }];
