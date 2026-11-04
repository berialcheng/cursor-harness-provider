import type { Model, Api, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AGENT_URL, CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import { isRecord } from "./security.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
interface Entry { model: Model<Api>; routes: Partial<Record<ModelThinkingLevel, string>> }

/** Exact discovered IDs only. No synthesized parameterized / Max-mode models. */
export class CursorCatalog {
  private entries = new Map<string, Entry>();
  private account: string | undefined;
  constructor() { this.reset(); }
  reset(account?: string): void {
    this.account = account;
    this.entries = new Map([["auto", { model: { id: "auto", name: "Cursor Auto (unverified catalog)",
      api: CURSOR_NATIVE_API, provider: PROVIDER_ID, baseUrl: AGENT_URL,
      input: ["text"], reasoning: false, cost: zeroCost(), contextWindow: 200000, maxTokens: 64000 }, routes: { off: "auto" } }]]);
  }
  isFor(account: string): boolean { return this.account === account; }
  ensureAccount(account: string): void { if (!this.isFor(account)) this.reset(account); }
  definitions(): ProviderModelConfig[] {
    return [...this.entries.values()].map(({ model }) => ({ ...model }));
  }
  size(): number { return this.entries.size; }
  apply(raw: string, account: string): ProviderModelConfig[] {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error("Rust model discovery returned an invalid catalog");
    const entries = new Map<string, Entry>();
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 256) continue;
      // Current Rust boundary has no Max flag / structured model-parameters route.
      if (item.requiresMaxMode || item.requestedMaxMode !== undefined || item.requestedModelId ||
          (Array.isArray(item.parameters) && item.parameters.length) || /(?:^|-)max(?:-|$)/i.test(item.id)) continue;
      const model: Model<Api> = {
        id: item.id, name: typeof item.name === "string" ? item.name : item.id,
        api: CURSOR_NATIVE_API, provider: PROVIDER_ID, baseUrl: AGENT_URL,
        input: item.supportsImages === true ? ["text", "image"] : ["text"],
        reasoning: item.reasoning === true, cost: zeroCost(),
        contextWindow: positive(item.contextWindow, 200000), maxTokens: positive(item.maxTokens, 64000),
      };
      entries.set(model.id, { model, routes: {} });
    }
    if (!entries.size) throw new Error("Rust returned no supported Cursor models (Max/parameterized routes are not supported)");
    for (const entry of entries.values()) {
      const parsed = parseEffort(entry.model.id);
      if (parsed.level) entry.routes[parsed.level] = entry.model.id;
      else if (entry.model.reasoning) entry.routes.medium = entry.model.id; // Cursor's native default, not a fabricated effort suffix.
      else entry.routes.off = entry.model.id;
      for (const candidate of entries.values()) {
        const sibling = parseEffort(candidate.model.id);
        if (sibling.level && sibling.base === entry.model.id) entry.routes[sibling.level] = candidate.model.id;
      }
      const map = Object.fromEntries(levels.map(level => [level, entry.routes[level] === undefined ? null : level === "off" ? "none" : level]));
      entry.model.thinkingLevelMap = map as ThinkingLevelMap;
      entry.model.reasoning = Object.keys(entry.routes).some(level => level !== "off");
    }
    this.account = account;
    this.entries = entries;
    return this.definitions();
  }
  route(id: string, reasoning?: string): { modelId: string; effort?: string } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Cursor model is not in this account's Rust-discovered catalog; run /cursor.models");
    if (reasoning === undefined) return { modelId: id };
    const route = entry.routes[reasoning as ModelThinkingLevel];
    if (!route) throw new Error(`Cursor does not advertise reasoning level ${reasoning} for this model`);
    return { modelId: route, effort: reasoning === "off" ? "none" : reasoning };
  }
}
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
// Parse the two observed thinking/effort orders, preserving fast/thinking identity.
function parseEffort(id: string): { base: string; level?: ModelThinkingLevel } {
  const match = /^(.*?)-(none|minimal|low|medium|high|xhigh|extra-high)(-thinking)?(-fast)?$/.exec(id);
  if (!match) return { base: id };
  const base = match[1]! + (match[3] ?? "") + (match[4] ?? "");
  return { base, level: match[2] === "none" ? "off" : match[2] === "extra-high" ? "xhigh" : match[2] as ModelThinkingLevel };
}
