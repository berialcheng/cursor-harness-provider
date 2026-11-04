import { createHash } from "node:crypto";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Partition hint only, never JWT verification or an authorization decision. */
export function accountPartition(token: string): string {
  let identity = token;
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (isRecord(claims) && typeof claims.sub === "string" && claims.sub) {
      identity = JSON.stringify([claims.iss ?? "cursor", claims.sub]);
    }
  } catch { /* Opaque credentials rotate into a new partition, conservatively. */ }
  return createHash("sha256").update(identity).digest("hex");
}

export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let value = error instanceof Error ? error.message : typeof error === "string" ? error : "Rust Cursor request failed";
  for (const secret of secrets) if (secret) value = value.split(secret).join("[REDACTED]");
  return value
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|authorization|cookie|verifier)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, 2000);
}

export function abortError(): Error { return new DOMException("Cursor request aborted", "AbortError"); }
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => {
      signal.removeEventListener("abort", onAbort); reject(error);
    });
    if (signal.aborted) onAbort();
  });
}
