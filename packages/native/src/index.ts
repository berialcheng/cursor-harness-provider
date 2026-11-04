/** Shared native boundary. No host SDK, credentials, protocol or CLI fallback. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export interface RustStream {
  nextEvent(): Promise<string | null | undefined>;
  cancel(): void;
  setAccessToken(token: string): Promise<void>;
}
export interface RustEngine {
  start(request: string, accessToken: string): Promise<RustStream>;
  listModels(accessToken: string, url?: string): Promise<string>;
  getUsage?(accessToken: string): Promise<string>;
  remove(scope: string): Promise<void>;
  shutdown(): void;
}
interface Binding { nativeVersion(): string; NativeEngine: new () => RustEngine }
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
let binding: Binding | undefined;
let bindingPath: string | undefined;
const engines = new Set<WeakRef<RustEngine>>();
export function nativePlatform(): string {
  if (process.platform !== "linux") return process.platform + "-" + process.arch;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const libc = process.env.CURSOR_NATIVE_LIBC ?? process.env.OPENCODE_CURSOR_LIBC ?? (report?.header?.glibcVersionRuntime ? "gnu" : "musl");
  if (!["gnu", "musl"].includes(libc)) throw new Error("CURSOR_NATIVE_LIBC must be gnu or musl");
  return "linux-" + process.arch + "-" + libc;
}
export function nativeBindingPath(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL("../native/manifest.json", import.meta.url), "utf8"));
    const entry = manifest.artifacts[nativePlatform()];
    if (manifest.version !== version || !entry || !/^cursor_native[.][a-z0-9-]+[.][a-f0-9]{16}[.]node$/.test(entry.file)) throw new Error("Invalid binding manifest");
    const path = fileURLToPath(new URL("../native/" + entry.file, import.meta.url));
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256) throw new Error("Binding checksum mismatch");
    return path;
  } catch { throw new Error("Rust Cursor binding unavailable for " + nativePlatform() + ". Build the repository using an existing Rust toolchain or install a matching prebuilt release. There is no CLI/JS inference fallback."); }
}
function load(): Binding {
  // The shared JS package is cached across host plugin activations. Revalidate
  // the manifest and select by hashed path, rather than pinning the first DSO.
  const path = nativeBindingPath();
  if (binding && bindingPath === path) return binding;
  let candidate: Binding;
  try { candidate = createRequire(import.meta.url)(path) as Binding; }
  catch { throw new Error("Rust Cursor binding cannot load; build or install a matching native artifact for this Bun/Node host"); }
  if (candidate.nativeVersion() !== version || typeof candidate.NativeEngine !== "function") throw new Error("Rust Cursor binding version mismatch; restart the host after a package-version upgrade");
  binding = candidate; bindingPath = path;
  return candidate;
}
export function nativeVersion(): string { return load().nativeVersion(); }
export function createRustEngine(): RustEngine {
  const engine = new (load().NativeEngine)();
  for (const ref of engines) if (!ref.deref()) engines.delete(ref);
  engines.add(new WeakRef(engine));
  return engine;
}
/** Explicit test/process teardown; production adapters own their engine. */
export function shutdownRustEngines(): void { for (const ref of engines) ref.deref()?.shutdown(); engines.clear(); }
