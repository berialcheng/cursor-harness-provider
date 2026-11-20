import { createHash } from "node:crypto";
import type { Model, Api, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { AGENT_URL, CURSOR_NATIVE_API, PROVIDER_ID } from "./constants.js";
import { isRecord } from "./security.js";

const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export interface ModelParameter { id: string; value: string }
export interface CursorRoute { modelId: string; modelParameters?: ModelParameter[]; maxMode?: boolean; effort?: string; supportsImages: boolean }
interface Entry { model: Model<Api>; routes: Partial<Record<ModelThinkingLevel, CursorRoute>>; defaultRoute: CursorRoute; group: string; exactOnly?: boolean }
interface Variant { parameters: ModelParameter[]; isMaxMode: boolean; isDefaultMaxConfig?: boolean; isDefaultNonMaxConfig?: boolean; displayName?: string }
interface Metadata { name: string; clientDisplayName?: string; serverModelName?: string; supportsMaxMode?: boolean; supportsNonMaxMode?: boolean;
  supportsImages?: boolean; contextTokenLimit?: number; contextTokenLimitForMaxMode?: number; variants: Variant[] }
interface Row { id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; supportsImages: boolean; metadataOnly?: boolean; parameterized?: Metadata }
interface Snapshot { schema: 1; account: string; endpoint: string; rows: Row[] }
const label = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function positive(value: unknown, fallback: number): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function effort(value: string | undefined): ModelThinkingLevel | undefined {
  if (value === "none" || value === "off") return "off";
  if (value === "extra-high") return "xhigh";
  return levels.includes(value as ModelThinkingLevel) ? value as ModelThinkingLevel : undefined;
}
function metadata(value: unknown): Metadata | undefined {
  if (!isRecord(value) || !label(value.name) || !Array.isArray(value.variants) || value.variants.length > 2048) return undefined;
  const variants: Variant[] = [];
  for (const v of value.variants) {
    if (!isRecord(v) || typeof v.isMaxMode !== "boolean" || !Array.isArray(v.parameters) || v.parameters.length > 64 ||
        (v.isMaxMode ? value.supportsMaxMode === false : value.supportsNonMaxMode === false)) continue;
    const parameters: ModelParameter[] = [], ids = new Set<string>();
    for (const p of v.parameters) {
      if (!isRecord(p) || !label(p.id) || typeof p.value !== "string" || p.value.length > 4096 || /[\x00-\x1f\x7f]/.test(p.value) || ids.has(p.id)) break;
      ids.add(p.id); parameters.push({ id: p.id, value: p.value });
    }
    if (parameters.length !== v.parameters.length) continue;
    variants.push({ parameters, isMaxMode: v.isMaxMode, isDefaultMaxConfig: v.isDefaultMaxConfig === true,
      isDefaultNonMaxConfig: v.isDefaultNonMaxConfig === true, ...(label(v.displayName) ? { displayName: v.displayName } : {}) });
  }
  return { name: value.name, ...(label(value.clientDisplayName) ? { clientDisplayName: value.clientDisplayName } : {}),
    ...(label(value.serverModelName) ? { serverModelName: value.serverModelName } : {}),
    ...(typeof value.supportsImages === "boolean" ? { supportsImages: value.supportsImages } : {}),
    ...(typeof value.supportsMaxMode === "boolean" ? { supportsMaxMode: value.supportsMaxMode } : {}),
    ...(typeof value.supportsNonMaxMode === "boolean" ? { supportsNonMaxMode: value.supportsNonMaxMode } : {}),
    contextTokenLimit: positive(value.contextTokenLimit, 200000), contextTokenLimitForMaxMode: positive(value.contextTokenLimitForMaxMode, positive(value.contextTokenLimit, 200000)), variants };
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("Rust model discovery returned an invalid catalog");
  return value.flatMap(item => {
    if (!isRecord(item) || !label(item.id)) return [];
    const parameterized = metadata(item.parameterized);
    return [{ id: item.id, name: label(item.name) ? item.name : item.id, reasoning: item.reasoning === true,
      contextWindow: positive(item.contextWindow, 200000), maxTokens: positive(item.maxTokens, 64000),
      // GetUsableModels alone does not attest images. Require the enriched
      // AvailableModels metadata, even if an old/untrusted direct row says true.
      supportsImages: parameterized?.supportsImages === true,
      ...(item.metadataOnly === true ? { metadataOnly: true } : {}), ...(parameterized ? { parameterized } : {}) }];
  });
}
function model(row: Row, id = row.id, name = row.name): Model<Api> {
  return { id, name, api: CURSOR_NATIVE_API, provider: PROVIDER_ID, baseUrl: AGENT_URL,
    input: row.supportsImages ? ["text", "image"] : ["text"], reasoning: row.reasoning,
    cost: zeroCost(), contextWindow: row.contextWindow, maxTokens: row.maxTokens };
}
const canonical = (parameters: ModelParameter[]) => JSON.stringify([...parameters].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const routeIdentity = (route: CursorRoute) => JSON.stringify([route.modelId, route.maxMode ?? false, canonical(route.modelParameters ?? [])]);
function effortId(value: string): string {
  // Keep the familiar levels readable. Opaque values use a length-delimited byte
  // encoding: empty, literal "empty", and delimiter-looking values cannot alias.
  return effort(value) ? encodeURIComponent(value) : `opaque-${Buffer.byteLength(value, "utf8")}-${Buffer.from(value, "utf8").toString("hex")}`;
}
function parseEffort(id: string): { base: string; level?: ModelThinkingLevel } {
  // Direct IDs remain directly runnable; only observed sibling IDs are linked.
  const match = /^(.*?)-(none|minimal|low|medium|high|xhigh|extra-high)(-thinking)?(-fast)?$/.exec(id);
  return match ? { base: match[1]! + (match[3] ?? "") + (match[4] ?? ""), level: effort(match[2]) } : { base: id };
}

/** Pure catalog conversion. Rust alone fetches/decodes metadata and runs the wire protocol. */
export class CursorCatalog {
  private entries = new Map<string, Entry>();
  private account: string | undefined;
  private sourceRows: Row[] = [];
  constructor() { this.reset(); }
  reset(account?: string): void {
    this.account = account; this.sourceRows = [];
    const fallback = model({ id: "auto", name: "Cursor Auto (unverified catalog)", reasoning: false, supportsImages: false, contextWindow: 200000, maxTokens: 64000 });
    const route = { modelId: "auto", supportsImages: false };
    this.entries = new Map([["auto", { model: fallback, defaultRoute: route, routes: { off: route }, group: "auto" }]]);
  }
  isFor(account: string): boolean { return this.account === account; }
  ensureAccount(account: string): void { if (!this.isFor(account)) this.reset(account); }
  definitions(endpoint = AGENT_URL): ProviderModelConfig[] { return [...this.entries.values()].map(({ model }) => ({ ...structuredClone(model), baseUrl: endpoint })); }
  size(): number { return this.entries.size; }
  /** Persist only public catalog metadata, via Pi's generation-checked models store, never auth storage. */
  persistedModels(endpoint: string): Model<Api>[] {
    const definitions = this.definitions(endpoint) as Model<Api>[];
    if (this.account && this.sourceRows.length) Object.assign(definitions.find(m => m.id === "auto")!, {
      cursorNativeCatalog: { schema: 1, account: this.account, endpoint, rows: structuredClone(this.sourceRows) } satisfies Snapshot,
    });
    return definitions;
  }
  restore(stored: unknown, account: string, endpoint: string): boolean {
    if (!isRecord(stored) || !Array.isArray(stored.models)) return false;
    const auto = stored.models.find(m => isRecord(m) && m.id === "auto" && m.api === CURSOR_NATIVE_API && m.provider === PROVIDER_ID);
    const snapshot = isRecord(auto) ? auto.cursorNativeCatalog : undefined;
    if (!isRecord(snapshot) || snapshot.schema !== 1 || snapshot.account !== account || snapshot.endpoint !== endpoint) return false;
    try { this.apply(JSON.stringify(snapshot.rows), account); return true; } catch { return false; }
  }
  apply(raw: string, account: string): ProviderModelConfig[] {
    if (raw.length > 8 * 1024 * 1024) throw new Error("Rust model catalog is too large");
    const sourceRows = rows(JSON.parse(raw));
    const entries = new Map<string, Entry>();
    const reserved = new Set(sourceRows.map(row => row.id === "default" ? "auto" : row.id));
    for (const row of sourceRows) {
      if (row.metadataOnly) continue;
      const id = row.id === "default" ? "auto" : row.id;
      const parsed = parseEffort(id);
      const route: CursorRoute = { modelId: row.id, supportsImages: row.supportsImages,
        ...(parsed.level ? { effort: parsed.level === "off" ? "none" : parsed.level } : {}) };
      entries.set(id, { model: model(row, id), defaultRoute: route, routes: { [parsed.level ?? (row.reasoning ? "medium" : "off")]: route }, group: id });
    }
    // Auto is a provider selection, not an ordinary discovered ID. Discovery must never remove it.
    if (!entries.has("auto")) entries.set("auto", new CursorCatalog().entries.get("auto")!);
    const siblings = new Map<string, Entry["routes"]>();
    for (const entry of entries.values()) {
      const parsed = parseEffort(entry.model.id);
      if (!parsed.level) continue;
      const routes = siblings.get(parsed.base) ?? {};
      routes[parsed.level] = { ...entry.defaultRoute, effort: parsed.level === "off" ? "none" : parsed.level };
      siblings.set(parsed.base, routes);
    }
    for (const entry of entries.values()) Object.assign(entry.routes, siblings.get(entry.model.id));
    const seenMetadata = new Set<string>();
    for (const row of sourceRows) {
      const meta = row.parameterized;
      if (!meta || seenMetadata.has(meta.name)) continue;
      seenMetadata.add(meta.name);
      const groups = new Map<string, { alias: string; entries: Entry[]; variants: Variant[] }>();
      const variantEntries = new Map<Variant, Entry>();
      for (const variant of meta.variants) {
        const values = new Map(variant.parameters.map(p => [p.id, p.value]));
        const parameterId = values.has("reasoning") ? "reasoning" : values.has("effort") ? "effort" : undefined;
        const requestedEffort = parameterId ? values.get(parameterId) : undefined;
        const level = effort(requestedEffort);
        const rest = variant.parameters.filter(p => p.id !== parameterId);
        const group = JSON.stringify([meta.name, variant.isMaxMode, canonical(rest), parameterId]);
        const context = values.get("context");
        const contextSuffix = context && !["200k", "272k", "300k"].includes(context.toLowerCase()) ? "-" + encodeURIComponent(context.toLowerCase()) : "";
        const modeSuffix = variant.isMaxMode ? "-max-mode" : "";
        const identitySuffix = (values.get("thinking") === "true" ? "-thinking" : "") + (values.get("fast") === "true" ? "-fast" : "");
        // Unknown parameters still get exact routes; never discard them or cross-product combinations.
        const other = rest.filter(p => !["context", "thinking", "fast"].includes(p.id) ||
          (["thinking", "fast"].includes(p.id) && !["true", "false"].includes(p.value)));
        const extra = other.length ? "-variant-" + digest(canonical(other)) : "";
        const base = encodeURIComponent(meta.name) + contextSuffix + modeSuffix;
        const alias = base + identitySuffix + extra;
        // AvailableModels.name is the logical RequestedModel identity used with
        // parameters. serverModelName is matching/display metadata, not a variant selector.
        const route: CursorRoute = { modelId: meta.name, modelParameters: structuredClone(variant.parameters),
          maxMode: variant.isMaxMode, supportsImages: meta.supportsImages === true, ...(requestedEffort ? { effort: requestedEffort } : {}) };
        const identity = routeIdentity(route), basicId = row.id === "default" ? "auto" : row.id;
        const candidate = base + (requestedEffort !== undefined ? "-" + effortId(requestedEffort) : "") + identitySuffix + extra;
        let id = candidate.length > 256 ? candidate.slice(0, 200) + "-variant-" + digest(identity) : candidate;
        let collision = 0;
        while ((entries.has(id) && routeIdentity(entries.get(id)!.defaultRoute) !== identity) || (reserved.has(id) && id !== basicId)) {
          // Group identity deliberately excludes effort, so it cannot establish
          // equality of exact routes. Never overwrite a direct ID or another variant.
          id = candidate.slice(0, 200) + "-variant-" + digest(JSON.stringify([identity, collision++]));
          if (collision > entries.size + reserved.size + 1) throw new Error("Cursor model route identity collision");
        }
        const window = variant.isMaxMode ? meta.contextTokenLimitForMaxMode : meta.contextTokenLimit;
        const contextMatch = /^(\d+)(k|m)$/i.exec(context ?? "");
        const contextWindow = contextMatch ? positive(Number(contextMatch[1]) * (contextMatch[2]!.toLowerCase() === "m" ? 1000000 : 1000), positive(window, row.contextWindow)) : positive(window, row.contextWindow);
        const entry: Entry = { model: model({ ...row, supportsImages: route.supportsImages, contextWindow }, id,
          variant.displayName ?? [meta.clientDisplayName ?? row.name, contextSuffix ? context?.toUpperCase() : "", variant.isMaxMode ? "Max Mode" : "", requestedEffort, values.get("thinking") === "true" ? "Thinking" : "", values.get("fast") === "true" ? "Fast" : ""].filter(Boolean).join(" ")),
          defaultRoute: route, routes: {}, group, exactOnly: !!parameterId && !level };
        if (level) entry.routes[level] = route;
        else if (!parameterId) entry.routes[values.get("thinking") === "true" ? "medium" : "off"] = route;
        entries.set(id, entry); variantEntries.set(variant, entry);
        const g = groups.get(group) ?? { alias, entries: [], variants: [] };
        g.entries.push(entry); g.variants.push(variant); groups.set(group, g);
      }
      for (const g of groups.values()) {
        const routes = Object.assign({}, ...g.entries.map(e => e.routes)) as Entry["routes"];
        // Opaque effort values are exact selections, not Pi thinking levels.
        // Do not let a known none/off sibling replace their default wire parameters.
        for (const e of g.entries) e.routes = e.exactOnly ? {} : { ...routes };
        const preferred = g.entries.find((_e, i) => g.variants[i]!.isMaxMode ? g.variants[i]!.isDefaultMaxConfig : g.variants[i]!.isDefaultNonMaxConfig) ?? g.entries[0]!;
        if (!entries.has(g.alias)) entries.set(g.alias, { ...preferred, model: { ...preferred.model, id: g.alias } });
      }
      // The advertised non-Max default, not an invented parameter set, backs a basic selection.
      const preferred = meta.variants.find(v => !v.isMaxMode && v.isDefaultNonMaxConfig) ?? meta.variants.find(v => !v.isMaxMode) ?? meta.variants[0];
      if (preferred) {
        const selection = variantEntries.get(preferred);
        const basicId = row.id === "default" ? "auto" : row.id;
        if (selection) entries.set(basicId, { ...selection, model: { ...selection.model, id: basicId, name: row.name } });
      }
    }
    if (entries.size === 1 && !sourceRows.some(r => r.id === "auto" || r.id === "default")) throw new Error("Rust returned no supported Cursor models");
    for (const entry of entries.values()) {
      entry.model.thinkingLevelMap = Object.fromEntries(levels.map(level => [level, entry.routes[level] ? level === "off" ? "none" : level : null])) as ThinkingLevelMap;
      entry.model.reasoning = Object.keys(entry.routes).some(level => level !== "off");
    }
    this.account = account; this.sourceRows = sourceRows; this.entries = entries;
    return this.definitions();
  }
  route(id: string, reasoning?: string): CursorRoute {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Cursor model is not in this account's Rust-discovered catalog; run /cursor.models");
    // Pi represents thinking:off as reasoning:undefined. Prefer an advertised none sibling.
    const route = reasoning === undefined ? entry.routes.off ?? entry.defaultRoute : entry.routes[reasoning as ModelThinkingLevel];
    if (!route) throw new Error(`Cursor does not advertise reasoning level ${reasoning} for this model`);
    return structuredClone(route);
  }
}
