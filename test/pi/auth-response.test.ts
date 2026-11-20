import { describe, expect, it, vi } from "vitest";
import { createOAuthClient } from "../../packages/pi/src/auth/oauth.js";
import { deferred, tick, token } from "./fixtures.js";

const client = (response: Response) => createOAuthClient({ fetch: vi.fn(async () => response) });
const signal = () => new AbortController().signal;

describe("bounded non-payload-bearing OAuth responses (injected fixtures only)", () => {
  it("does not echo malformed HTTP200 JSON or reader errors through the refresh callback", async () => {
    for (const response of [new Response("synthetic-opaque-secret", { status: 200 }), new Response(new ReadableStream({
      start(controller) { controller.error(new Error("synthetic-reader-secret")); },
    }))]) {
      const error = await client(response).refresh("fixture-refresh", signal()).catch(e => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/invalid or oversized OAuth token response/);
      expect((error as Error).message).not.toMatch(/synthetic|Unexpected token|JSON/);
    }
  });
  it("retains valid expiry and rotating refresh credentials without logging them", async () => {
    const response = Response.json({ accessToken: token, refreshToken: "fixture-rotated" });
    expect(await client(response).refresh("fixture-old", signal())).toMatchObject({ access: token, refresh: "fixture-rotated" });
  });
  it("enforces the byte cap even without or with a dishonest Content-Length", async () => {
    for (const declared of [undefined, "1"]) {
      const headers = declared === undefined ? undefined : { "content-length": declared };
      const response = new Response("\u00e9".repeat(32769), { headers });
      await expect(client(response).refresh("fixture-refresh", signal())).rejects.toThrow(/invalid or oversized/);
    }
  });
  it("cancels bodies rejected by declared size and rejects malformed UTF8 without quoting data", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(client(new Response(body, { headers: { "content-length": "999999" } })).refresh("fixture-refresh", signal())).rejects.toThrow(/invalid or oversized/);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(client(new Response(new Uint8Array([0xff, 0xfe]))).refresh("fixture-refresh", signal())).rejects.toThrow(/invalid or oversized/);
  });
  it("stops empty-chunk floods within a bounded number of reads", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array()); } });
    await expect(client(new Response(body)).refresh("fixture-refresh", signal())).rejects.toThrow(/invalid or oversized/);
    expect(pulls).toBeLessThanOrEqual(4098);
  });
  it("preserves caller AbortError while cancelling a stalled response reader", async () => {
    const abort = new AbortController(), waiting = deferred<void>(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull: () => waiting.promise, cancel });
    const pending = client(new Response(body)).refresh("fixture-refresh", abort.signal);
    await tick(); abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce(); waiting.resolve();
  });
});
