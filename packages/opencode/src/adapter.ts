import type { LanguageModelV3CallOptions, LanguageModelV3FilePart, SharedV3Warning } from "@ai-sdk/provider";

interface ImageContent { type: "image"; data: string; mimeType: string }

export function inlineImage(part: Pick<LanguageModelV3FilePart, "mediaType" | "data">): ImageContent {
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(part.mediaType)) throw new Error("Cursor Native supports PNG/JPEG/GIF/WebP attachments only");
  let data: string;
  if (part.data instanceof Uint8Array) data = Buffer.from(part.data).toString("base64");
  else if (part.data instanceof URL) {
    if (part.data.protocol !== "data:") throw new Error("Cursor Native will not fetch attachment URLs or open file paths; attach inline image bytes");
    const match = part.data.href.match(/^data:([^;,]+);base64,(.*)$/s);
    if (!match || match[1] !== part.mediaType) throw new Error("Invalid image data URL");
    data = match[2]!;
  } else data = part.data;
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.from(data, "base64").length > 5 * 1024 * 1024) {
    throw new Error("Invalid or oversized inline image (maximum 5 MiB)");
  }
  return { type: "image", data, mimeType: part.mediaType };
}

export function validateOptions(options: LanguageModelV3CallOptions): SharedV3Warning[] {
  if (options.responseFormat?.type === "json") throw new Error("Cursor Native does not support enforced JSON/structured output");
  if (options.toolChoice && !["auto", "none"].includes(options.toolChoice.type)) throw new Error("Cursor Native supports auto/none tool choice only");
  const warnings: SharedV3Warning[] = [];
  for (const key of ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty", "maxOutputTokens", "stopSequences", "seed"] as const) {
    if (options[key] !== undefined) warnings.push({ type: "unsupported", feature: key, details: "Cursor's native agent protocol does not expose this generation control" });
  }
  return warnings;
}

export function requestHeader(options: LanguageModelV3CallOptions, name: string): string | undefined {
  return Object.entries(options.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}
export function nativeReasoning(options: LanguageModelV3CallOptions): string | undefined {
  for (const key of ["cursorNative", "cursor-native", "opencode-cursor-native"]) {
    const value = options.providerOptions?.[key]?.reasoningEffort;
    if (typeof value === "string") return value;
  }
  return undefined;
}
