import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
// @ts-expect-error Build tooling is intentionally JavaScript and Node-builtin-only.
import { fetchRegistryJson, parseVerifyPublishedArgs, PublishedVerificationError, verifyProvenance, verifyPublished, verifySignatureAudit } from "../scripts/verify-published.mjs";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const kinds = ["native", "pi", "opencode"] as const;
type Kind = typeof kinds[number];
type Data = Record<string, any>;
const repository = "https://github.com/berialcheng/cursor-harness-provider";
const registry = "https://registry.npmjs.org/";
const slsa = "https://slsa.dev/provenance/v1";
const legacySource = "fb6089e011b40f89c65bf66a4afcb43791040919";
const auditOutput = "audited 3 packages in 1s\n\n3 packages have verified registry signatures\n\n3 packages have verified attestations\n";
// Captured successful npm 11.21.0 stdout for the already-verified 0.3.0.
// Only the wording is real: archive/attestation/CLI fixtures stay synthetic.
const capturedAuditOutput = "audited 3 packages in 0s\n\n3 packages have verified registry signatures\n\n3 packages have verified attestations\n(use --json --include-attestations to view attestation details)\n";
const auditHint = "(use --json --include-attestations to view attestation details)";
const textAudit = (count: number) => count === 1
  ? "audited 1 package in 0s\n\n1 package has a verified registry signature\n\n1 package has a verified attestation\n"
  : `audited ${count} packages in 0s\n\n${count} packages have verified registry signatures\n\n${count} packages have verified attestations\n`;
const view404 = () => Object.assign(new Error("synthetic npm view failure"), { status: 1, signal: null,
  stdout: JSON.stringify({ error: { code: "E404", summary: "No match found", detail: "synthetic version not published" } }) });
const producerMap = () => Object.fromEntries(kinds.map(kind => [kind, { runId: "123", runAttempt: "2" }])) as Record<Kind, { runId: string; runAttempt: string }>;
const nameFor = (kind: Kind) => "@cursor-harness-provider/" + kind;
const digest = (bytes: Buffer, algorithm: string, encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const writeJson = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));

function fixture({ version = "0.3.1", source = "a".repeat(40), sourceRef = "refs/tags/v" + version }: { version?: string; source?: string; sourceRef?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "verify-published-test-")); temporary.push(directory);
  const projectRoot = join(directory, "checkout"), outputDirectory = join(directory, "verified"), npmCli = join(directory, "npm-cli.js");
  mkdirSync(projectRoot); writeFileSync(npmCli, "// synthetic; never executed\n");
  writeJson(join(projectRoot, "package.json"), { name: "cursor-harness-provider", version, private: true, license: "MIT" });
  const bytes = {} as Record<Kind, Buffer>, metadata = {} as Record<Kind, Data>, manifests = {} as Record<Kind, Data>;
  const statements = {} as Record<Kind, Data>, documents = {} as Record<Kind, Data>, expectedSha256 = {} as Record<Kind, string>;
  for (const kind of kinds) {
    // These are deliberately NOT real tarballs/signatures. Only injected CLI
    // and transport boundaries see them; no test contacts npm or Sigstore.
    bytes[kind] = Buffer.from("synthetic archive for " + kind);
    expectedSha256[kind] = digest(bytes[kind], "sha256");
    manifests[kind] = { name: nameFor(kind), version, license: "MIT", private: false,
      dependencies: kind === "native" ? {} : { [nameFor("native")]: version },
      repository: { url: "git+" + repository + ".git", directory: "packages/" + kind },
      publishConfig: { access: "public", registry } };
    const base = join(projectRoot, "packages", kind); mkdirSync(base, { recursive: true }); writeJson(join(base, "package.json"), manifests[kind]);
    metadata[kind] = { ...manifests[kind], dist: { shasum: digest(bytes[kind], "sha1"), integrity: "sha512-" + digest(bytes[kind], "sha512", "base64"),
      tarball: registry + "@cursor-harness-provider/" + kind + "/-/" + kind + "-" + version + ".tgz",
      attestations: { url: registry + "-/npm/v1/attestations/@cursor-harness-provider%2f" + kind + "@" + version } } };
    statements[kind] = { _type: "https://in-toto.io/Statement/v1", predicateType: slsa,
      subject: [{ name: "pkg:npm/%40cursor-harness-provider/" + kind + "@" + version, digest: { sha512: digest(bytes[kind], "sha512") } }],
      predicate: { buildDefinition: { buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository, path: ".github/workflows/publish.yml", ref: sourceRef } },
        internalParameters: { github: { event_name: "workflow_dispatch", repository_id: "1", repository_owner_id: "2" } },
        resolvedDependencies: [{ uri: "git+" + repository + "@" + sourceRef, digest: { gitCommit: source } }] },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: repository + "/actions/runs/123/attempts/2" } } } };
    documents[kind] = { attestations: [
      { predicateType: slsa, bundle: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1", verificationMaterial: {},
        dsseEnvelope: { payloadType: "application/vnd.in-toto+json", signatures: [{ sig: Buffer.from("synthetic signature").toString("base64") }], payload: "" } } },
      { predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {
        mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1", verificationMaterial: {},
        dsseEnvelope: { payloadType: "application/vnd.in-toto+json", signatures: [{ keyid: "synthetic-registry-key", sig: Buffer.from("synthetic publish signature").toString("base64") }],
          payload: Buffer.from(JSON.stringify({ _type: "https://in-toto.io/Statement/v1",
            predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", subject: statements[kind].subject, predicate: {} })).toString("base64") } } },
    ] };
  }
  const behavior: { versionOutput: string; auditOutput?: string; auditJsonOutput?: string; head: string; viewErrors: Partial<Record<Kind, unknown>>;
    onPack?: (kind: Kind, packed: Data[]) => void; onInstall?: (lock: Data, cwd: string) => void; onAudit?: () => void;
    onVerified?: (audit: Data) => void } = { versionOutput: "11.21.0\n", head: source + "\n", viewErrors: {} };
  let installedKinds: Kind[] = [];
  const options: Data = { projectRoot, outputDirectory, npmCli, version, source, expectedSha256, env: {} };
  const execute = vi.fn((_binary: string, args: string[], config: Data): string => {
    if (_binary === "git") return behavior.head;
    const command = args[1];
    if (command === "--version") return behavior.versionOutput;
    if (command === "view" || command === "pack") {
      const kind = kinds.find(kind => args[2] === nameFor(kind) + "@" + version);
      if (!kind) throw Error("Unexpected synthetic npm spec");
      if (command === "view") {
        if (Object.hasOwn(behavior.viewErrors, kind)) throw behavior.viewErrors[kind];
        return JSON.stringify(metadata[kind]);
      }
      const filename = "cursor-harness-provider-" + kind + "-" + version + ".tgz";
      writeFileSync(join(outputDirectory, "archives", filename), bytes[kind]);
      const packed = [{ name: nameFor(kind), version, filename, size: bytes[kind].length,
        shasum: metadata[kind].dist.shasum, integrity: metadata[kind].dist.integrity }];
      behavior.onPack?.(kind, packed);
      return JSON.stringify(packed);
    }
    if (command === "install") {
      installedKinds = kinds.filter(kind => args.includes(nameFor(kind) + "@" + version));
      const packages: Data = { "": { name: "public-registry-verification", version: "0.0.0", dependencies: Object.fromEntries(installedKinds.map(kind => [nameFor(kind), version])) } };
      for (const kind of installedKinds) {
        packages["node_modules/" + nameFor(kind)] = { version, license: "MIT", integrity: metadata[kind].dist.integrity,
          resolved: metadata[kind].dist.tarball, dependencies: manifests[kind].dependencies };
        const path = join(config.cwd, "node_modules", nameFor(kind)); mkdirSync(path, { recursive: true });
        writeJson(join(path, "package.json"), manifests[kind]);
      }
      const lock = { lockfileVersion: 3, packages };
      behavior.onInstall?.(lock, config.cwd); writeJson(join(config.cwd, "package-lock.json"), lock);
      return `added ${installedKinds.length} packages\n`;
    }
    if (command === "audit") {
      behavior.onAudit?.();
      if (!args.includes("--json")) return behavior.auditOutput ?? textAudit(installedKinds.length);
      // npm 11.21.0 --json --include-attestations exposes precisely these rows
      // AFTER pacote verifies every bundle. This injection is not real crypto.
      const audit = { invalid: [], missing: [], verified: installedKinds.map(kind => ({ name: nameFor(kind), version,
        location: "node_modules/" + nameFor(kind), registry, attestations: metadata[kind].dist.attestations,
        attestationBundles: structuredClone(documents[kind].attestations) })) };
      behavior.onVerified?.(audit);
      return behavior.auditJsonOutput ?? JSON.stringify(audit);
    }
    throw Error("Unexpected synthetic npm command");
  });
  const fetchJson = vi.fn(async (url: string) => {
    const kind = kinds.find(kind => url === metadata[kind].dist.attestations.url);
    if (!kind) throw Error("Unexpected synthetic attestation URL");
    documents[kind].attestations[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statements[kind])).toString("base64");
    return documents[kind];
  });
  const sourcePackage = (kind: Kind, update: (pkg: Data) => void) => {
    const pkg = structuredClone(manifests[kind]); update(pkg); writeJson(join(projectRoot, "packages", kind, "package.json"), pkg);
  };
  return { directory, options, execute, fetchJson, behavior, metadata, documents, statements, manifests, bytes, sourcePackage };
}
const commands = (f: ReturnType<typeof fixture>) => f.execute.mock.calls.filter(call => call[0] !== "git").map(call => call[1][1]);
const verify = (f: ReturnType<typeof fixture>) => verifyPublished(f.options, { execute: f.execute, fetchJson: f.fetchJson });
const missingPackages = (f: ReturnType<typeof fixture>, ...missing: Kind[]) => {
  f.options.allowPartial = true;
  for (const kind of missing) f.behavior.viewErrors[kind] = view404();
};
const changeVerifiedPayload = (audit: Data, kind: Kind, change: (statement: Data) => void, index = 0) => {
  const envelope = audit.verified.find((row: Data) => row.name === nameFor(kind)).attestationBundles[index].bundle.dsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  change(statement); envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
};
const setProducers = (f: ReturnType<typeof fixture>, producers: ReturnType<typeof producerMap>) => {
  f.options.producers = producers;
  for (const kind of kinds) f.statements[kind].predicate.runDetails.metadata.invocationId =
    repository + "/actions/runs/" + producers[kind].runId + "/attempts/" + producers[kind].runAttempt;
};

// Every integration test injects BOTH process execution and network. Test fixtures
// are outside the checkout and all release commands are prohibited by assertions.
describe("published registry verification", () => {
  it("binds public bytes/provenance to source and performs an exact isolated 3-package crypto audit", async () => {
    const f = fixture(); Object.assign(f.options, { sourceRun: "123", sourceAttempt: "2" });
    const result = await verify(f);
    expect(result).toMatchObject({ outcome: "verified", complete: true, missing: [], version: "0.3.1", source: f.options.source, sourceRef: "refs/tags/v0.3.1", npmVersion: "11.21.0",
      sourceRun: "123", sourceAttempt: "2", producers: producerMap(), signatureAudit: { registrySignatures: 3, attestations: 3 } });
    expect(commands(f)).toEqual(["--version", "view", "pack", "view", "pack", "view", "pack", "install", "audit", "audit"]);
    const audits = f.execute.mock.calls.filter(call => call[1][1] === "audit");
    expect(audits[0][1].slice(1, 3)).toEqual(["audit", "signatures"]);
    expect(audits[1][1].slice(1, 5)).toEqual(["audit", "signatures", "--json", "--include-attestations"]);
    for (const receipt of result.packages) expect(receipt).toMatchObject({ location: "node_modules/" + receipt.name, registry,
      attestationBundles: f.documents[receipt.kind as Kind].attestations });
    expect(f.execute.mock.calls[0].slice(0, 2)).toEqual(["git", ["rev-parse", "--verify", "HEAD"]]);
    expect(f.fetchJson).toHaveBeenCalledTimes(3);
    expect(readdirSync(result.archivesDirectory).sort()).toEqual(["native.tgz", "opencode.tgz", "pi.tgz"]);
    for (const kind of kinds) expect(readFileSync(join(result.archivesDirectory, kind + ".tgz"))).toEqual(f.bytes[kind]);
    expect(JSON.parse(readFileSync(join(f.options.outputDirectory, "verification.json"), "utf8"))).toEqual(result);
    const install = f.execute.mock.calls.find(call => call[1][1] === "install")!;
    expect(install[1]).toEqual(expect.arrayContaining(["--ignore-scripts", "--legacy-peer-deps", "--save-exact", "--no-audit", "--no-fund", ...kinds.map(kind => nameFor(kind) + "@0.3.1")]));
    expect(install[2].cwd).toBe(join(f.options.outputDirectory, "audit"));
    for (const call of f.execute.mock.calls.filter(call => call[1][1] === "pack")) expect(call[1]).toContain("--ignore-scripts");
  });

  it("uses bounded commands, private new empty configs and an allowlisted credential-free environment", async () => {
    const f = fixture();
    f.options.env = { HOME: "/never-read-this-home", PATH: "/never-use-this-path", GITHUB_TOKEN: "synthetic-secret", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc",
      NODE_OPTIONS: "--require=/never-load-this", HTTPS_PROXY: "https://never-use-this.invalid/", NODE_EXTRA_CA_CERTS: "/never-read-this" };
    await verify(f);
    expect(statSync(f.options.outputDirectory).mode & 0o777).toBe(0o700);
    for (const call of f.execute.mock.calls) {
      const config = call[2];
      expect(config).toMatchObject({ encoding: "utf8", killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
      expect(config.timeout).toBeGreaterThan(0); expect(config.timeout).toBeLessThanOrEqual(180000);
      expect(config.maxBuffer).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(JSON.stringify(config.env)).not.toMatch(/synthetic|never-|GITHUB_TOKEN|ACTIONS_ID_TOKEN|NODE_OPTIONS|PROXY|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_/i);
      expect(config.env.HOME).toBe(join(f.options.outputDirectory, "home"));
      if (call[0] === "git") continue;
      const args = call[1];
      expect(call[0]).toBe(process.execPath); expect(args[0]).toBe(f.options.npmCli);
      expect(args[args.indexOf("--registry") + 1]).toBe(registry);
      expect(args[args.indexOf("--fetch-retries") + 1]).toBe("0");
      expect(args[args.indexOf("--fetch-timeout") + 1]).toBe("60000");
      const user = args[args.indexOf("--userconfig") + 1], global = args[args.indexOf("--globalconfig") + 1];
      expect(user).not.toBe(global);
      for (const path of [user, global]) { expect(isAbsolute(path)).toBe(true); expect(readFileSync(path, "utf8")).toBe(""); expect(statSync(path).mode & 0o777).toBe(0o600); }
      expect(args).not.toEqual(expect.arrayContaining(["publish", "stage", "unpublish", "login", "token", "--global"]));
    }
  });

  it.each(["NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_AUTH_TOKEN", "npm_token", "npm_config_registry", "NPM_CONFIG_USERCONFIG"])("rejects even empty legacy env override %s before execution", async key => {
    const f = fixture(); f.options.env[key] = "";
    await expect(verify(f)).rejects.toThrow(/overrides/);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.fetchJson).not.toHaveBeenCalled(); expect(existsSync(f.options.outputDirectory)).toBe(false);
  });

  it.each(["0.3.1-beta", "v0.3.1", "00.3.1", "0.3.01", "0.3.1+build", "0.3.1\n", "9007199254740992.0.0"])("rejects noncanonical/nonstable version %s", async version => {
    const f = fixture(); f.options.version = version; await expect(verify(f)).rejects.toThrow(/stable/); expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects malformed source/path/run/hash selectors without touching npm", async () => {
    const changes = [{ source: "A".repeat(40) }, { source: "a".repeat(39) }, { npmCli: "npm" }, { outputDirectory: "relative" },
      { sourceRun: "123" }, { sourceAttempt: "2" }, { sourceRun: "0", sourceAttempt: "2" }, { sourceRun: "123", sourceAttempt: "02" },
      { expectedSha256: [] }, { expectedSha256: { native: "a".repeat(64), pi: "a".repeat(64) } },
      { expectedSha256: { native: "A".repeat(64), pi: "a".repeat(64), opencode: "a".repeat(64) } },
      ...[null, "true", "false", 0, 1, {}, []].map(allowPartial => ({ allowPartial }))];
    for (const change of changes) { const f = fixture(); Object.assign(f.options, change); await expect(verify(f)).rejects.toBeInstanceOf(PublishedVerificationError); expect(f.execute).not.toHaveBeenCalled(); }
  });

  it("rejects malformed explicit producer maps before creating output or running any command", async () => {
    const invalid: unknown[] = [null, [], {}, { ...producerMap(), extra: { runId: "123", runAttempt: "2" } },
      { native: producerMap().native, pi: producerMap().pi }];
    for (const value of [null, [], {}, { runId: "123" }, { runAttempt: "2" }, { runId: "123", runAttempt: "2", extra: "1" }]) {
      invalid.push({ ...producerMap(), pi: value });
    }
    for (const field of ["runId", "runAttempt"] as const) for (const value of [undefined, null, true, 123, "", "0", "01", "-1", "+1", "1.0", "1e2", " 1", "1\n", "１", "1".repeat(21)]) {
      invalid.push({ ...producerMap(), pi: { ...producerMap().pi, [field]: value } });
    }
    for (const producers of invalid) {
      const f = fixture(); f.options.producers = producers;
      await expect(verify(f)).rejects.toThrow(/producers/);
      expect(f.execute).not.toHaveBeenCalled(); expect(f.fetchJson).not.toHaveBeenCalled(); expect(existsSync(f.options.outputDirectory)).toBe(false);
    }
  });

  it("checks source root, source package identities and checkout HEAD before any network", async () => {
    for (const change of [(p: Data) => { p.name = "@other/native"; }, (p: Data) => { p.version = "0.3.2"; },
      (p: Data) => { p.dependencies.extra = "1.0.0"; }, (p: Data) => { p.license = "UNLICENSED"; }, (p: Data) => { p.publishConfig.registry = "https://example.invalid/"; }]) {
      const f = fixture(); f.sourcePackage("native", change); await expect(verify(f)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled(); expect(f.fetchJson).not.toHaveBeenCalled();
    }
    const root = fixture(); writeJson(join(root.options.projectRoot, "package.json"), { name: "cursor-harness-provider", version: "0.3.0", private: true, license: "MIT" });
    await expect(verify(root)).rejects.toThrow(/Source root/); expect(root.execute).not.toHaveBeenCalled();
    const head = fixture(); head.behavior.head = "b".repeat(40); await expect(verify(head)).rejects.toThrow(/HEAD/); expect(commands(head)).toEqual([]); expect(head.fetchJson).not.toHaveBeenCalled();
  });

  it("never reuses output or operates inside the checkout", async () => {
    const f = fixture(); mkdirSync(f.options.outputDirectory); writeFileSync(join(f.options.outputDirectory, "untouched"), "keep");
    await expect(verify(f)).rejects.toThrow(/existing/); expect(f.execute).not.toHaveBeenCalled(); expect(readFileSync(join(f.options.outputDirectory, "untouched"), "utf8")).toBe("keep");
    const inside = fixture(); inside.options.outputDirectory = join(inside.options.projectRoot, "verification"); await expect(verify(inside)).rejects.toThrow(/outside/); expect(inside.execute).not.toHaveBeenCalled();
  });
  it("requires npm 11.21.0 and sanitizes subprocess errors without retries", async () => {
    const f = fixture(); f.behavior.versionOutput = "11.20.0"; await expect(verify(f)).rejects.toThrow(/11.21.0/); expect(commands(f)).toEqual(["--version"]);
    const bad = fixture(), implementation = bad.execute.getMockImplementation()!;
    bad.execute.mockImplementation((binary, args, config) => { if (args[1] === "pack") throw Error("synthetic-secret raw npm stderr"); return implementation(binary, args, config); });
    await expect(verify(bad)).rejects.toThrow(/^npm pack failed; verification stopped without retry$/);
    expect(commands(bad)).toEqual(["--version", "view", "pack"]); expect(bad.fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    ["name", (m: Data) => { m.name = "@other/native"; }], ["version", (m: Data) => { m.version = "0.3.2"; }], ["license", (m: Data) => { m.license = "ISC"; }],
    ["native dependency", (m: Data) => { m.dependencies = { other: "1.0.0" }; }], ["optional dependency", (m: Data) => { m.optionalDependencies = { other: "1.0.0" }; }],
    ["null dependencies", (m: Data) => { m.dependencies = null; }], ["array optional deps", (m: Data) => { m.optionalDependencies = []; }],
    ["empty dependency key", (m: Data) => { m.dependencies = { "": "1.0.0" }; }], ["empty optional dependency key", (m: Data) => { m.optionalDependencies = { "": "1.0.0" }; }],
    ["SHA1 format", (m: Data) => { m.dist.shasum = "not a digest"; }], ["SRI format", (m: Data) => { m.dist.integrity = "sha256-AAAA"; }],
  ])("rejects invalid public metadata: %s", async (_label, change) => {
    const f = fixture(); change(f.metadata.native); await expect(verify(f)).rejects.toThrow(); expect(commands(f)).toEqual(["--version", "view"]); expect(f.fetchJson).not.toHaveBeenCalled();
  });
  it("requires exact native dependency versions on both adapters", async () => {
    for (const kind of ["pi", "opencode"] as const) for (const dependencies of [{ [nameFor("native")]: "^0.3.1" }, {}, { [nameFor("native")]: "0.3.1", extra: "1.0.0" }]) {
      const f = fixture(); f.metadata[kind].dependencies = dependencies; await expect(verify(f)).rejects.toThrow(/dependencies/); expect(commands(f)).not.toContain("install");
    }
  });

  it.each([
    "https://registry.example.invalid/-/npm/v1/attestations/name", "http://registry.npmjs.org/-/npm/v1/attestations/name",
    "https://user@registry.npmjs.org/-/npm/v1/attestations/name", "https://registry.npmjs.org/-/npm/v1/attestations/name?token=x",
    "https://registry.npmjs.org/-/npm/v1/attestations/name#fragment", "https://registry.npmjs.org/-/npm/v1/keys",
    "https://registry.npmjs.org/-/npm/v1/attestations/", "https://registry.npmjs.org/-/npm/v1/attestations/a/%2e%2e/keys",
    "https://registry.npmjs.org/-/npm/v1/attestations/a%2f..%2fkeys", "https://registry.npmjs.org/-/npm/v1/attestations/a%0ab",
  ])("rejects unsafe attestation URL %s before fetching/packing", async url => {
    const f = fixture(); f.metadata.native.dist.attestations.url = url; await expect(verify(f)).rejects.toThrow(); expect(f.fetchJson).not.toHaveBeenCalled(); expect(commands(f)).toEqual(["--version", "view"]);
  });
  it("rejects a nonregistry tarball URL before packing", async () => {
    const f = fixture(); f.metadata.native.dist.tarball = "https://example.invalid/native.tgz"; await expect(verify(f)).rejects.toThrow(/registry/); expect(commands(f)).toEqual(["--version", "view"]);
  });

  it.each(["../native.tgz", "/tmp/native.tgz", "native.tgz", "cursor-harness-provider-native-0.3.2.tgz"])("rejects unpredictable npm pack filename %s", async filename => {
    const f = fixture(); f.behavior.onPack = (_kind, packed) => { packed[0].filename = filename; };
    await expect(verify(f)).rejects.toThrow(/filename/); expect(f.fetchJson).not.toHaveBeenCalled();
  });
  it("rejects multiple pack results and a wrong packed name", async () => {
    for (const change of [(packed: Data[]) => { packed.push(packed[0]); }, (packed: Data[]) => { packed[0].name = "other"; }]) {
      const f = fixture(); f.behavior.onPack = (_kind, packed) => change(packed); await expect(verify(f)).rejects.toThrow(/inventory/); expect(f.fetchJson).not.toHaveBeenCalled();
    }
  });
  it.each(["sha256", "shasum", "integrity"])("compares archive %s to protected inputs/public metadata", async which => {
    const f = fixture();
    if (which === "sha256") f.options.expectedSha256.native = "b".repeat(64);
    if (which === "shasum") f.metadata.native.dist.shasum = "b".repeat(40);
    if (which === "integrity") f.metadata.native.dist.integrity = "sha512-" + Buffer.alloc(64).toString("base64");
    await expect(verify(f)).rejects.toThrow(/archive/); expect(f.fetchJson).not.toHaveBeenCalled(); expect(commands(f)).not.toContain("install");
  });
  it("refuses symlinked or oversized archives without reading arbitrary files", async () => {
    const f = fixture(); f.behavior.onPack = (_kind, packed) => { const path = join(f.options.outputDirectory, "archives", packed[0].filename); rmSync(path); symlinkSync(f.options.npmCli, path); };
    await expect(verify(f)).rejects.toBeInstanceOf(PublishedVerificationError); expect(f.fetchJson).not.toHaveBeenCalled();
    const large = fixture(); large.behavior.onPack = (_kind, packed) => truncateSync(join(large.options.outputDirectory, "archives", packed[0].filename), 128 * 1024 * 1024 + 1);
    await expect(verify(large)).rejects.toThrow(/oversized/); expect(large.fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    ["statement type", (s: Data) => { s._type = "https://in-toto.io/Statement/v0.1"; }],
    ["predicate type", (s: Data) => { s.predicateType = "https://slsa.dev/provenance/v0.2"; }],
    ["subject name", (s: Data) => { s.subject[0].name = "pkg:npm/%40other/native@0.3.1"; }],
    ["subject digest", (s: Data) => { s.subject[0].digest.sha512 = "b".repeat(128); }],
    ["multiple subjects", (s: Data) => { s.subject.push(s.subject[0]); }],
    ["repository", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repo"; }],
    ["workflow", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; }],
    ["source ref", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; }],
    ["build type", (s: Data) => { s.predicate.buildDefinition.buildType = "other"; }],
    ["source gitCommit", (s: Data) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); }],
    ["source URI", (s: Data) => { s.predicate.buildDefinition.resolvedDependencies[0].uri = "git+" + repository + "@refs/heads/main"; }],
    ["ambiguous inputs", (s: Data) => { s.predicate.buildDefinition.resolvedDependencies.push(s.predicate.buildDefinition.resolvedDependencies[0]); }],
    ["run repository", (s: Data) => { s.predicate.runDetails.metadata.invocationId = "https://github.com/other/repo/actions/runs/123/attempts/2"; }],
    ["run missing", (s: Data) => { delete s.predicate.runDetails; }],
    ["builder missing", (s: Data) => { delete s.predicate.runDetails.builder; }],
    ["builder ID missing", (s: Data) => { s.predicate.runDetails.builder = {}; }],
    ["self-hosted builder", (s: Data) => { s.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted"; }],
    ["builder origin", (s: Data) => { s.predicate.runDetails.builder.id = "https://example.invalid/actions/runner/github-hosted"; }],
    ["builder suffix", (s: Data) => { s.predicate.runDetails.builder.id += "/other"; }],
  ])("fails closed on provenance %s mismatch", async (_label, change) => {
    const f = fixture(); change(f.statements.native); await expect(verify(f)).rejects.toThrow(); expect(commands(f)).not.toContain("install");
  });
  it("requires matching producer run AND attempt when supplied, and rejects mixed producers by default", async () => {
    for (const change of [{ sourceRun: "124", sourceAttempt: "2" }, { sourceRun: "123", sourceAttempt: "3" }]) {
      const f = fixture(); Object.assign(f.options, change); await expect(verify(f)).rejects.toThrow(/producer run\/attempt mismatch/); expect(commands(f)).not.toContain("install");
    }
    for (const invocation of ["124/attempts/2", "123/attempts/3"]) {
      const mixed = fixture(); mixed.statements.pi.predicate.runDetails.metadata.invocationId = repository + "/actions/runs/" + invocation;
      await expect(verify(mixed)).rejects.toThrow(/mixed producer/); expect(commands(mixed)).not.toContain("install");
    }
  });
  it.each(["object", "JSON"])("accepts explicitly matched mixed %s producers and reports every package's actual producer", async encoding => {
    const f = fixture(), producers = producerMap();
    producers.pi = { runId: "124", runAttempt: "1" }; producers.opencode = { runId: "125", runAttempt: "3" };
    setProducers(f, producers);
    if (encoding === "JSON") f.options.producers = JSON.stringify(producers);
    const result = await verify(f);
    expect(result.producers).toEqual(producers);
    expect(result).not.toHaveProperty("sourceRun"); expect(result).not.toHaveProperty("sourceAttempt");
    expect(result.signatureAudit).toEqual({ registrySignatures: 3, attestations: 3 });
    for (const kind of kinds) expect(result.packages.find((item: Data) => item.kind === kind)).toMatchObject({
      name: nameFor(kind), version: f.options.version, sha256: f.options.expectedSha256[kind], producer: producers[kind],
    });
    const report = JSON.parse(readFileSync(join(f.options.outputDirectory, "verification.json"), "utf8"));
    expect(report).toEqual(result); expect(report).not.toHaveProperty("sourceRun"); expect(report).not.toHaveProperty("sourceAttempt");
  });
  it("permits explicitly matched different attempts within one run without claiming a common producer", async () => {
    const f = fixture(), producers = producerMap(); producers.pi.runAttempt = "3"; setProducers(f, producers);
    const result = await verify(f);
    expect(result.producers).toEqual(producers);
    expect(result).not.toHaveProperty("sourceRun"); expect(result).not.toHaveProperty("sourceAttempt");
    expect(result.packages.find((item: Data) => item.kind === "pi").producer).toEqual(producers.pi);
  });
  it.each([false, true])("keeps common producer reporting with an explicit map (paired global selectors: %s)", async global => {
    const f = fixture(); f.options.producers = producerMap();
    if (global) Object.assign(f.options, { sourceRun: "123", sourceAttempt: "2" });
    expect(await verify(f)).toMatchObject({ sourceRun: "123", sourceAttempt: "2", producers: producerMap() });
  });
  it("matches each explicit package run AND attempt rather than treating a map as blanket reuse permission", async () => {
    for (const kind of kinds) for (const field of ["runId", "runAttempt"] as const) {
      const f = fixture(); f.options.producers = producerMap(); f.options.producers[kind][field] = "999";
      await expect(verify(f)).rejects.toThrow(/producer run\/attempt mismatch/);
      expect(commands(f)).not.toContain("install"); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
  });
  it("rejects contradictory global and per-package producer selectors before any execution", async () => {
    for (const change of [{ sourceRun: "124", sourceAttempt: "2" }, { sourceRun: "123", sourceAttempt: "3" },
      { sourceRun: "123", sourceAttempt: "2", mixed: true }]) {
      const f = fixture(); f.options.producers = producerMap();
      if (change.mixed) f.options.producers.pi.runId = "124";
      Object.assign(f.options, { sourceRun: change.sourceRun, sourceAttempt: change.sourceAttempt });
      await expect(verify(f)).rejects.toThrow(/contradict/);
      expect(f.execute).not.toHaveBeenCalled(); expect(f.fetchJson).not.toHaveBeenCalled(); expect(existsSync(f.options.outputDirectory)).toBe(false);
    }
  });
  it.each([
    ["archive hash", (f: ReturnType<typeof fixture>) => { f.options.expectedSha256.pi = "b".repeat(64); }],
    ["source commit", (f: ReturnType<typeof fixture>) => { f.statements.pi.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = legacySource; }],
    ["source ref", (f: ReturnType<typeof fixture>) => { f.statements.pi.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/v0.3.0"; }],
    ["subject version", (f: ReturnType<typeof fixture>) => { f.statements.pi.subject[0].name = "pkg:npm/%40cursor-harness-provider/pi@0.3.0"; }],
    ["public version", (f: ReturnType<typeof fixture>) => { f.metadata.pi.version = "0.3.0"; }],
    ["hosted builder", (f: ReturnType<typeof fixture>) => { f.statements.pi.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted"; }],
    ["crypto audit", (f: ReturnType<typeof fixture>) => { f.behavior.auditOutput = auditOutput.replace("3 packages have verified attestations", "2 packages have verified attestations"); }],
  ])("does not relax %s checks for explicitly allowed mixed-run reuse", async (_label, change) => {
    const f = fixture(), producers = producerMap(); producers.pi = { runId: "124", runAttempt: "1" }; setProducers(f, producers);
    change(f); await expect(verify(f)).rejects.toThrow(); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it("accepts only the explicitly pinned historical 0.3.0 main provenance exception", async () => {
    const legacy = fixture({ version: "0.3.0", source: legacySource, sourceRef: "refs/heads/main" }); legacy.options.expectedSourceRef = "refs/heads/main";
    expect((await verify(legacy)).sourceRef).toBe("refs/heads/main");
    const defaultRef = fixture({ version: "0.3.0", source: legacySource, sourceRef: "refs/heads/main" }); await expect(verify(defaultRef)).rejects.toThrow(/version ref/);
    for (const options of [{ version: "0.3.1", source: legacySource }, { version: "0.3.0", source: "b".repeat(40) }]) {
      const f = fixture(options); f.options.expectedSourceRef = "refs/heads/main"; await expect(verify(f)).rejects.toThrow(/version tag/); expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects absent/duplicate provenance, malformed DSSE/base64/JSON and nonstandard bundle shapes", async () => {
    const f = fixture(); await f.fetchJson(f.metadata.native.dist.attestations.url);
    const valid = structuredClone(f.documents.native);
    const malformed: Data[] = [[], { attestations: [] }, { attestations: valid.attestations.slice(1) }, { attestations: [valid.attestations[0], valid.attestations[0]] }] as Data[];
    for (const change of [(e: Data) => { e.payloadType = "text/plain"; }, (e: Data) => { e.signatures = []; },
      (e: Data) => { e.payload = "%%%"; }, (e: Data) => { e.payload += "\n"; }, (e: Data) => { e.payload = Buffer.from("not JSON").toString("base64"); },
      (e: Data) => { e.payload = Buffer.from([0xff]).toString("base64"); }, (e: Data) => { e.signatures[0].sig = "not base64"; }]) {
      const item = structuredClone(valid); change(item.attestations[0].bundle.dsseEnvelope); malformed.push(item);
    }
    for (const document of malformed) expect(() => verifyProvenance(document, { kind: "native", version: "0.3.1", source: f.options.source, sha512: digest(f.bytes.native, "sha512") })).toThrow();
  });

  it.each([
    ["extra package", (lock: Data) => { lock.packages["node_modules/extra"] = { version: "1.0.0" }; }],
    ["missing package", (lock: Data) => { delete lock.packages["node_modules/" + nameFor("pi")]; }],
    ["wrong version", (lock: Data) => { lock.packages["node_modules/" + nameFor("pi")].version = "0.3.0"; }],
    ["wrong integrity", (lock: Data) => { lock.packages["node_modules/" + nameFor("pi")].integrity = "sha512-other"; }],
    ["wrong origin", (lock: Data) => { lock.packages["node_modules/" + nameFor("pi")].resolved = "https://other.invalid/pi.tgz"; }],
    ["wrong tarball", (lock: Data) => { lock.packages["node_modules/" + nameFor("pi")].resolved = registry + "other.tgz"; }],
    ["link", (lock: Data) => { lock.packages["node_modules/" + nameFor("pi")].link = true; }],
    ["nonexact root", (lock: Data) => { lock.packages[""].dependencies[nameFor("pi")] = "^0.3.1"; }],
    ["wrong lock version", (lock: Data) => { lock.lockfileVersion = 2; }],
  ])("refuses signature audit for invalid isolated installed lock: %s", async (_label, change) => {
    const f = fixture(); f.behavior.onInstall = lock => change(lock); await expect(verify(f)).rejects.toThrow(); expect(commands(f)).not.toContain("audit");
  });
  it("checks actual installed package manifests too", async () => {
    const f = fixture(); f.behavior.onInstall = (_lock, cwd) => writeJson(join(cwd, "node_modules", nameFor("native"), "package.json"), { ...f.manifests.native, version: "0.3.0" });
    await expect(verify(f)).rejects.toThrow(/identity/); expect(commands(f)).not.toContain("audit");
  });

  it.each(["", "audited 0 packages in 0s\n", "3 packages have verified registry signatures\n", "3 packages have verified attestations\n",
    auditOutput.replace("3 packages have verified attestations", "2 packages have verified attestations"),
    auditOutput.replace("audited 3", "audited 0"), auditOutput + "1 package has an invalid attestation\n",
    auditOutput.replace("verified registry signatures", "verified signatures"), auditOutput + "arbitrary extra line\n",
    capturedAuditOutput + "arbitrary extra line\n", capturedAuditOutput + auditHint + "\n", auditHint + "\n" + auditOutput,
    auditOutput.replace("\n\n", "\n" + auditHint + "\n"), capturedAuditOutput.replace("--include-attestations ", ""),
    capturedAuditOutput.replace("attestation details)", "attestation details!)"),
    capturedAuditOutput.replace("3 packages have verified attestations", "2 packages have verified attestations")])("rejects zero/partial/misparsed audit output %j", async stdout => {
    expect(() => verifySignatureAudit(stdout)).toThrow(/exactly 3/);
    const f = fixture(); f.behavior.auditOutput = stdout; await expect(verify(f)).rejects.toThrow(/exactly 3/); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it("accepts pinned npm audit wording with or without its exact optional final hint (also CRLF)", () => {
    for (const stdout of [auditOutput, capturedAuditOutput]) for (const output of [stdout, stdout.replace(/\n/g, "\r\n")]) {
      expect(verifySignatureAudit(output)).toEqual({ registrySignatures: 3, attestations: 3 });
    }
  });
  it("regresses the captured successful npm 11.21.0 four-line stdout for 0.3.0", async () => {
    const f = fixture({ version: "0.3.0", source: legacySource, sourceRef: "refs/heads/main" });
    f.options.expectedSourceRef = "refs/heads/main"; f.behavior.auditOutput = capturedAuditOutput;
    expect(await verify(f)).toMatchObject({ outcome: "verified", version: "0.3.0", npmVersion: "11.21.0",
      signatureAudit: { registrySignatures: 3, attestations: 3 } });
  });
  it.each([
    ["source commit", (s: Data) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); }],
    ["source ref", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"; }],
    ["source repository", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repo"; }],
    ["source workflow", (s: Data) => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/foreign.yml"; }],
    ["digest", (s: Data) => { s.subject[0].digest.sha512 = "b".repeat(128); }],
    ["subject", (s: Data) => { s.subject[0].name = "pkg:npm/%40cursor-harness-provider/pi@0.3.0"; }],
    ["producer run", (s: Data) => { s.predicate.runDetails.metadata.invocationId = repository + "/actions/runs/999/attempts/2"; }],
    ["producer attempt", (s: Data) => { s.predicate.runDetails.metadata.invocationId = repository + "/actions/runs/123/attempts/9"; }],
    ["builder", (s: Data) => { s.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted"; }],
  ])("rejects registry equivocation: correct preflight but crypto-verified foreign %s", async (_label, change) => {
    const f = fixture(); Object.assign(f.options, { sourceRun: "123", sourceAttempt: "2" });
    f.behavior.onVerified = audit => changeVerifiedPayload(audit, "pi", change);
    await expect(verify(f)).rejects.toThrow();
    expect(f.fetchJson).toHaveBeenCalledTimes(3); expect(commands(f).slice(-2)).toEqual(["audit", "audit"]);
    expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it("binds exact payload bytes for every verified bundle, not just parsed provenance fields", async () => {
    for (const index of [0, 1]) {
      const f = fixture(); f.behavior.onVerified = audit => changeVerifiedPayload(audit, "pi", s => { s.unexpected = true; }, index);
      await expect(verify(f)).rejects.toThrow(/payloads changed/);
      expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
    const common = fixture(); common.behavior.onVerified = audit => {
      for (const kind of kinds) changeVerifiedPayload(audit, kind, s => { s.predicate.runDetails.metadata.invocationId = repository + "/actions/runs/999/attempts/2"; });
    };
    await expect(verify(common)).rejects.toThrow(/payloads changed/);
  });
  it.each([
    ["invalid entry", (a: Data) => { a.invalid.push({ code: "EATTESTATIONVERIFY" }); }],
    ["missing entry", (a: Data) => { a.missing.push({ name: nameFor("pi") }); }],
    ["invalid array missing", (a: Data) => { delete a.invalid; }],
    ["missing array missing", (a: Data) => { delete a.missing; }],
    ["no verified JSON", (a: Data) => { delete a.verified; }],
    ["non-array verified JSON", (a: Data) => { a.verified = {}; }],
    ["zero verified rows", (a: Data) => { a.verified = []; }],
    ["partial verified rows", (a: Data) => { a.verified.pop(); }],
    ["extra verified row", (a: Data) => { a.verified.push(a.verified[0]); }],
    ["duplicate verified package", (a: Data) => { a.verified[1] = a.verified[0]; }],
    ["foreign package", (a: Data) => { a.verified[0].name = "@other/native"; }],
    ["wrong version", (a: Data) => { a.verified[0].version = "0.3.0"; }],
    ["wrong location", (a: Data) => { a.verified[0].location += "/nested"; }],
    ["wrong registry", (a: Data) => { a.verified[0].registry = "https://registry.example.invalid/"; }],
    ["noncanonical registry", (a: Data) => { a.verified[0].registry = registry.slice(0, -1); }],
    ["missing row field", (a: Data) => { delete a.verified[0].attestations; }],
    ["unverified row shape", (a: Data) => { a.verified[0].unverified = true; }],
    ["missing bundles", (a: Data) => { delete a.verified[0].attestationBundles; }],
    ["empty bundles", (a: Data) => { a.verified[0].attestationBundles = []; }],
    ["non-array bundles", (a: Data) => { a.verified[0].attestationBundles = {}; }],
    ["missing provenance", (a: Data) => { a.verified[0].attestationBundles.shift(); }],
    ["duplicate provenance", (a: Data) => { a.verified[0].attestationBundles.push(a.verified[0].attestationBundles[0]); }],
    ["non-JSON payload", (a: Data) => { a.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from("not JSON").toString("base64"); }],
    ["unsigned envelope", (a: Data) => { a.verified[0].attestationBundles[0].bundle.dsseEnvelope.signatures = []; }],
    ["wrong attestation endpoint", (a: Data) => { a.verified[0].attestations = { url: registry + "-/npm/v1/attestations/foreign" }; }],
    ["foreign attestation endpoint", (a: Data) => { a.verified[0].attestations = { url: "https://other.invalid/-/npm/v1/attestations/native" }; }],
  ])("rejects crypto JSON %s even with successful text counts", async (_label, change) => {
    const f = fixture(); f.behavior.onVerified = change;
    await expect(verify(f)).rejects.toThrow(); expect(commands(f).filter(c => c === "audit")).toHaveLength(2);
    expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it.each(["", "not JSON", "null", "[]", "{}", JSON.stringify({ invalid: [], missing: [] }),
    JSON.stringify({ invalid: [], missing: [], verified: [] })])("rejects absent/malformed verified audit JSON %j", async auditJsonOutput => {
    const f = fixture(); f.behavior.auditJsonOutput = auditJsonOutput;
    await expect(verify(f)).rejects.toThrow(); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it("accepts reordered verified rows without associating bundles/producers by position", async () => {
    const f = fixture(); f.behavior.onVerified = audit => audit.verified.reverse();
    expect((await verify(f)).producers).toEqual(producerMap());
  });

  it("rehashes ALL three saved archives after install/audit and rejects extra archives or lock mutation", async () => {
    for (const kind of kinds) {
      const f = fixture(); f.behavior.onAudit = () => writeFileSync(join(f.options.outputDirectory, "archives", kind + ".tgz"), "changed after download");
      await expect(verify(f)).rejects.toThrow(/SHA256/); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
    const extra = fixture(); extra.behavior.onAudit = () => writeFileSync(join(extra.options.outputDirectory, "archives", "extra.tgz"), "unexpected"); await expect(verify(extra)).rejects.toThrow(/inventory/);
    const lock = fixture(); lock.behavior.onAudit = () => { const path = join(lock.options.outputDirectory, "audit", "package-lock.json"); writeFileSync(path, readFileSync(path, "utf8") + "\n"); };
    await expect(verify(lock)).rejects.toThrow(/lockfile changed/);
  });
});

describe("partial publication reconciliation", () => {
  it.each([{ absent: ["pi", "opencode"] }, { absent: ["opencode"] }, { absent: ["pi"] }, { absent: [] }] as { absent: Kind[] }[])(
    "verifies exactly the available package closure with E404 missing $absent", async ({ absent }) => {
      const f = fixture(); missingPackages(f, ...absent);
      const available = kinds.filter(kind => !absent.includes(kind)), count = available.length, complete = count === 3;
      const report = await verify(f);
      expect(report).toMatchObject({ complete, outcome: complete ? "verified" : "partial",
        missing: absent.map(kind => ({ kind, name: nameFor(kind), version: "0.3.1" })),
        signatureAudit: { registrySignatures: count, attestations: count } });
      expect(report.packages.map((item: Data) => item.kind)).toEqual(available);
      expect(Object.keys(report.producers)).toEqual(available);
      expect(readdirSync(report.archivesDirectory).sort()).toEqual(available.map(kind => kind + ".tgz").sort());
      expect(f.fetchJson).toHaveBeenCalledTimes(count);
      const install = f.execute.mock.calls.find(call => call[1][1] === "install")!;
      for (const kind of kinds) expect(install[1].includes(nameFor(kind) + "@0.3.1")).toBe(available.includes(kind));
      const lock = JSON.parse(readFileSync(join(f.options.outputDirectory, "audit", "package-lock.json"), "utf8"));
      expect(Object.keys(lock.packages).sort()).toEqual(["", ...available.map(kind => "node_modules/" + nameFor(kind))].sort());
      for (const kind of available) expect(report.packages.find((item: Data) => item.kind === kind)).toMatchObject({
        sha256: f.options.expectedSha256[kind], attestationBundles: f.documents[kind].attestations, producer: producerMap()[kind],
      });
      expect(JSON.parse(readFileSync(join(f.options.outputDirectory, "verification.json"), "utf8"))).toEqual(report);
    });
  it("reports explicit total absence with no fake audit, producer or successful-release claims", async () => {
    const f = fixture(); missingPackages(f, ...kinds);
    const report = await verify(f);
    expect(report).toMatchObject({ complete: false, outcome: "absent", packages: [], producers: {},
      missing: kinds.map(kind => ({ kind, name: nameFor(kind), version: "0.3.1" })) });
    expect(report).not.toHaveProperty("signatureAudit"); expect(report).not.toHaveProperty("sourceRun"); expect(report).not.toHaveProperty("sourceAttempt");
    expect(commands(f)).toEqual(["--version", "view", "view", "view"]); expect(f.fetchJson).not.toHaveBeenCalled();
    expect(readdirSync(report.archivesDirectory)).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.options.outputDirectory, "verification.json"), "utf8"))).toEqual(report);
  });
  it("does not reconcile E404 without explicit opt-in (including allowPartial:false)", async () => {
    for (const allowPartial of [undefined, false]) {
      const f = fixture(); f.behavior.viewErrors.native = view404(); f.options.allowPartial = allowPartial;
      await expect(verify(f)).rejects.toThrow(/^npm view failed; verification stopped without retry$/);
      expect(commands(f)).toEqual(["--version", "view"]); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
  });
  it.each(["E401", "E403", "ETARGET", "ENOENT", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "E404-not-exact", ""])(
    "does not turn npm view %s into absence", async code => {
      const f = fixture(); f.options.allowPartial = true;
      f.behavior.viewErrors.native = Object.assign(view404(), { stdout: JSON.stringify({ error: { code, detail: "E404 is not the actual code" } }) });
      await expect(verify(f)).rejects.toThrow(/^npm view failed; verification stopped without retry$/);
      expect(commands(f)).toEqual(["--version", "view"]); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    });
  it("requires an explicit, bounded structured E404 from a normal failed view process", async () => {
    const failures = [Error("E404 prose only"), Object.assign(Error("unknown"), { code: "E404" }),
      Object.assign(view404(), { stdout: "npm error code E404\n" }), Object.assign(view404(), { stdout: "not JSON" }),
      Object.assign(view404(), { stdout: JSON.stringify({ code: "E404" }) }), Object.assign(view404(), { stdout: "x".repeat(4 * 1024 * 1024 + 1) }),
      Object.assign(view404(), { status: undefined }), Object.assign(view404(), { status: 0 }), Object.assign(view404(), { signal: "SIGTERM" }),
      Object.assign(view404(), { code: "ETIMEDOUT" }), Object.assign(view404(), { code: "ENOBUFS" }), Object.assign(view404(), { killed: true })];
    for (const failure of failures) {
      const f = fixture(); f.options.allowPartial = true; f.behavior.viewErrors.native = failure;
      await expect(verify(f)).rejects.toThrow(/^npm view failed; verification stopped without retry$/);
      expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
    const buffer = fixture(); missingPackages(buffer, ...kinds);
    for (const kind of kinds) buffer.behavior.viewErrors[kind] = Object.assign(view404(), { stdout: Buffer.from(view404().stdout) });
    expect((await verify(buffer)).outcome).toBe("absent");
  });
  it("does not treat E404 from pack or crypto audit as a missing version", async () => {
    for (const command of ["pack", "audit"]) {
      const f = fixture(); f.options.allowPartial = true;
      if (command === "pack") f.behavior.onPack = () => { throw view404(); };
      else f.behavior.onAudit = () => { throw view404(); };
      await expect(verify(f)).rejects.toThrow(new RegExp("^npm " + command + " failed; verification stopped without retry$"));
      expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
  });
  it.each(["pi", "opencode"] as const)("fails explicitly if %s exists but its native version is missing", async adapter => {
    const f = fixture(); missingPackages(f, "native", ...(adapter === "opencode" ? ["pi" as const] : []));
    await expect(verify(f)).rejects.toThrow(/native is unexpectedly missing/);
    expect(commands(f)).not.toContain("install"); expect(commands(f)).not.toContain("pack"); expect(commands(f)).not.toContain("audit");
    expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
  });
  it.each([false, true])("allows actual mixed signed producers without a map only in partial mode (all available: %s)", async allAvailable => {
    const f = fixture(), producers = producerMap(); producers.pi = { runId: "124", runAttempt: "1" }; setProducers(f, producers);
    delete f.options.producers; missingPackages(f, ...(allAvailable ? [] : ["opencode" as const]));
    const report = await verify(f);
    expect(report.complete).toBe(allAvailable); expect(report.outcome).toBe(allAvailable ? "verified" : "partial");
    expect(report.producers).toEqual(Object.fromEntries(kinds.filter(kind => allAvailable || kind !== "opencode").map(kind => [kind, producers[kind]])));
    expect(report).not.toHaveProperty("sourceRun"); expect(report).not.toHaveProperty("sourceAttempt");
    for (const receipt of report.packages) expect(receipt.producer).toEqual(producers[receipt.kind as Kind]);
  });
  it("requires an exact three-key producer map even in partial mode, constraining every observed package", async () => {
    const incomplete = fixture(); missingPackages(incomplete, "opencode"); incomplete.options.producers = { native: producerMap().native, pi: producerMap().pi };
    await expect(verify(incomplete)).rejects.toThrow(/Exactly three/); expect(incomplete.execute).not.toHaveBeenCalled();
    const f = fixture(); missingPackages(f, "opencode"); f.options.producers = producerMap(); f.options.producers.pi.runAttempt = "9";
    await expect(verify(f)).rejects.toThrow(/producer run\/attempt mismatch/);
    const absentSelector = fixture(); missingPackages(absentSelector, "opencode"); absentSelector.options.producers = producerMap(); absentSelector.options.producers.opencode.runId = "999";
    const report = await verify(absentSelector); expect(Object.keys(report.producers)).toEqual(["native", "pi"]);
  });
  it("requires exact three hashes and all source identities even for total absence", async () => {
    for (const change of [{ expectedSha256: { native: "a".repeat(64) } }, { source: "short" }, { expectedSourceRef: "refs/heads/main" }]) {
      const f = fixture(); missingPackages(f, ...kinds); Object.assign(f.options, change);
      await expect(verify(f)).rejects.toThrow(); expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it.each(["hash", "signed source", "signed producer", "installed closure", "installed dependency", "extra archive", "changed archive"])(
    "does not relax %s checks in partial mode", async which => {
      const f = fixture(); missingPackages(f, "opencode");
      if (which === "hash") f.options.expectedSha256.pi = "b".repeat(64);
      if (which === "signed source") f.behavior.onVerified = a => changeVerifiedPayload(a, "pi", s => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); });
      if (which === "signed producer") f.behavior.onVerified = a => changeVerifiedPayload(a, "pi", s => { s.predicate.runDetails.metadata.invocationId = repository + "/actions/runs/999/attempts/2"; });
      if (which === "installed closure") f.behavior.onInstall = lock => { lock.packages["node_modules/" + nameFor("opencode")] = { version: "0.3.1" }; };
      if (which === "installed dependency") f.behavior.onInstall = lock => { lock.packages["node_modules/" + nameFor("pi")].dependencies = { [nameFor("native")]: "^0.3.1" }; };
      if (which === "extra archive") f.behavior.onAudit = () => writeFileSync(join(f.options.outputDirectory, "archives", "opencode.tgz"), "unexpected");
      if (which === "changed archive") f.behavior.onAudit = () => writeFileSync(join(f.options.outputDirectory, "archives", "pi.tgz"), "changed");
      await expect(verify(f)).rejects.toThrow(); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    });
  it.each([1, 2, 3])("accepts only exact singular/plural signature text and verified JSON counts for %i available packages", async count => {
    for (const stdout of [textAudit(count), textAudit(count) + auditHint + "\n"]) {
      expect(verifySignatureAudit(stdout, count)).toEqual({ registrySignatures: count, attestations: count });
    }
    for (const wrongCount of [1, 2, 3].filter(n => n !== count)) expect(() => verifySignatureAudit(textAudit(wrongCount), count)).toThrow(/exactly/);
    for (const mode of ["json", "text"]) {
      const f = fixture(); missingPackages(f, ...kinds.slice(count));
      if (mode === "json") f.behavior.onVerified = audit => { audit.verified.pop(); };
      else f.behavior.auditOutput = textAudit(count === 1 ? 2 : 1);
      await expect(verify(f)).rejects.toThrow(); expect(existsSync(join(f.options.outputDirectory, "verification.json"))).toBe(false);
    }
  });
  it("cannot represent a successful zero-package audit", () => {
    for (const count of [0, -1, 4, 1.5, "1", null]) expect(() => verifySignatureAudit(textAudit(0), count)).toThrow();
  });
});

describe("bounded public attestation JSON transport", () => {
  const url = registry + "-/npm/v1/attestations/@cursor-harness-provider%2fnative@0.3.1";
  const response = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, { headers: { "content-type": "application/json" }, ...init });
  it("requests only public JSON without credentials or redirects, with a deadline", async () => {
    const fetch = vi.fn(async () => response('{"attestations":[]}'));
    expect(await fetchRegistryJson(url, { fetch })).toEqual({ attestations: [] });
    const [requested, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(requested).toBe(url); expect(options).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json" } });
    expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.signal?.aborted).toBe(false);
  });
  it("rejects nonregistry endpoints without invoking fetch", async () => {
    const fetch = vi.fn();
    for (const unsafe of ["https://example.invalid/-/npm/v1/attestations/a", registry + "-/npm/v1/keys", url + "?auth=x"]) await expect(fetchRegistryJson(unsafe, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never follows redirects or retries a failed request", async () => {
    const fetch = vi.fn(async () => response("{}", { status: 302, headers: { location: "https://example.invalid/" } }));
    await expect(fetchRegistryJson(url, { fetch })).rejects.toThrow(/redirected/); expect(fetch).toHaveBeenCalledOnce();
    const failed = vi.fn(async () => { throw Error("synthetic-secret transport exception"); });
    await expect(fetchRegistryJson(url, { fetch: failed })).rejects.toThrow(/^Public attestation GET failed; stopped without retry$/); expect(failed).toHaveBeenCalledOnce();
  });
  it("cancels rejected bodies before reading them and when the byte budget is exceeded", async () => {
    for (const oversizedHeader of [true, false]) {
      const cancel = vi.fn();
      const body = new ReadableStream({ start(controller) { if (!oversizedHeader) controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel });
      const fetch = vi.fn(async () => response(body, { headers: { "content-type": "application/json", ...(oversizedHeader ? { "content-length": String(4 * 1024 * 1024 + 1) } : {}) } }));
      await expect(fetchRegistryJson(url, { fetch })).rejects.toThrow(/Oversized/); expect(cancel).toHaveBeenCalledOnce();
    }
  });
  it("rejects oversized declared/streamed responses, invalid JSON/UTF8 and non-JSON content", async () => {
    for (const result of [response("{}", { headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024 + 1) } }),
      response("x".repeat(4 * 1024 * 1024 + 1)), response("not JSON"), response(new Uint8Array([0xff])), response("{}", { headers: { "content-type": "text/plain" } })]) {
      const fetch = vi.fn(async () => result); await expect(fetchRegistryJson(url, { fetch })).rejects.toBeInstanceOf(PublishedVerificationError); expect(fetch).toHaveBeenCalledOnce();
    }
  });
});

describe("explicit verification CLI arguments", () => {
  const hashes = { native: "a".repeat(64), pi: "b".repeat(64), opencode: "c".repeat(64) };
  const args = ["--version", "0.3.1", "--source", "d".repeat(40), "--sha256", JSON.stringify(hashes), "--npm-cli", "/tmp/npm-cli.js", "--output", "/tmp/fresh-verification"];
  it("parses all required arguments and optional paired producer selectors", () => {
    expect(parseVerifyPublishedArgs([...args, "--source-run", "123", "--source-attempt", "2"])).toEqual({ version: "0.3.1", source: "d".repeat(40), expectedSha256: hashes,
      npmCli: "/tmp/npm-cli.js", outputDirectory: "/tmp/fresh-verification", sourceRun: "123", sourceAttempt: "2", allowPartial: false });
    expect(parseVerifyPublishedArgs(args).expectedSha256).toEqual(hashes);
  });
  it("defaults to a full cohort and accepts only literal --partial true|false", () => {
    expect(parseVerifyPublishedArgs(args).allowPartial).toBe(false);
    expect(parseVerifyPublishedArgs([...args, "--partial", "true"]).allowPartial).toBe(true);
    expect(parseVerifyPublishedArgs([...args, "--partial", "false"]).allowPartial).toBe(false);
    for (const value of ["TRUE", "False", "1", "0", "null", " true", "true\n", "yes", "{}"]) {
      expect(() => parseVerifyPublishedArgs([...args, "--partial", value])).toThrow(/partial/);
    }
    for (const extra of [["--partial"], ["--partial", "true", "--partial", "false"]]) expect(() => parseVerifyPublishedArgs([...args, ...extra])).toThrow();
    expect(parseVerifyPublishedArgs([...args, "--partial", "true", "--producers", JSON.stringify(producerMap())]).producers).toEqual(producerMap());
  });
  it("parses strict per-package producers and matching optional common selectors", () => {
    const producers = producerMap(); producers.pi = { runId: "124", runAttempt: "1" };
    expect(parseVerifyPublishedArgs([...args, "--producers", JSON.stringify(producers)]).producers).toEqual(producers);
    expect(parseVerifyPublishedArgs([...args, "--producers", JSON.stringify(producerMap()), "--source-run", "123", "--source-attempt", "2"])).toMatchObject({
      producers: producerMap(), sourceRun: "123", sourceAttempt: "2",
    });
    const reordered = { opencode: { runAttempt: "2", runId: "123" }, pi: { runAttempt: "2", runId: "123" }, native: { runAttempt: "2", runId: "123" } };
    expect(parseVerifyPublishedArgs([...args, "--producers", JSON.stringify(reordered, null, 2)]).producers).toEqual(producerMap());
  });
  it("rejects contradictory common selectors and explicit maps", () => {
    const mixed = producerMap(); mixed.pi.runAttempt = "3";
    for (const [producers, runId, runAttempt] of [[producerMap(), "124", "2"], [producerMap(), "123", "3"], [mixed, "123", "2"]] as const) {
      expect(() => parseVerifyPublishedArgs([...args, "--producers", JSON.stringify(producers), "--source-run", runId, "--source-attempt", runAttempt])).toThrow(/contradict/);
    }
  });
  it("requires strict producer keys/decimal-string IDs, rejecting duplicate/escaped/extra JSON members", () => {
    const encoded = JSON.stringify(producerMap());
    const invalid = ["null", "[]", "{}", encoded.slice(0, -1),
      encoded.replace('"native"', '"other"'), encoded.replace('"native"', '"\\u006eative"'),
      encoded.replace('"runId"', '"\\u0072unId"'), encoded.replace('"runId":"123"', '"runId":"123","runId":"123"'),
      encoded.replace('"runAttempt":"2"', '"runId":"123"'), encoded.replace(/}$/, ',"native":' + JSON.stringify(producerMap().native) + '}'),
      encoded.replace(/}$/, ',"other":' + JSON.stringify(producerMap().native) + '}'), encoded.replace('"runId":"123"', '"runId":"123","extra":"1"'),
      encoded.replace('"runAttempt":"2"', '"runAttempt":2'), encoded.replace('"runId":"123"', '"runId":"0"'),
      encoded.replace('"runId":"123"', '"runId":"0123"'), encoded.replace('"runAttempt":"2"', '"runAttempt":"1e2"')];
    for (const value of invalid) expect(() => parseVerifyPublishedArgs([...args, "--producers", value])).toThrow(/producers/);
  });
  it("rejects unknown/missing/duplicate arguments and unpaired run selectors", () => {
    for (const bad of [[], args.slice(0, -2), [...args, "--publish", "true"], [...args, "--source-ref", "refs/heads/main"],
      [...args, "--version", "0.3.1"], [...args, "--source-run", "123"], [...args, "--source-attempt", "2"], [...args, "--source-run"],
      [...args, "--producers"], [...args, "--producers", JSON.stringify(producerMap()), "--producers", JSON.stringify(producerMap())],
      [...args, "--producers", JSON.stringify(producerMap()), "--source-run", "123"],
      [...args, "--producers", JSON.stringify(producerMap()), "--source-attempt", "2"]]) expect(() => parseVerifyPublishedArgs(bad)).toThrow();
  });
  it("requires exactly three lowercase hashes, rejecting duplicate/escaped/extra JSON members", () => {
    const encoded = JSON.stringify(hashes);
    const invalid = ["null", "[]", encoded.replace(/a/g, "A"), encoded.replace('"native"', '"other"'),
      encoded.replace(/}$/, ',"other":"' + "d".repeat(64) + '"}'), encoded.replace(/}$/, ',"native":"' + hashes.native + '"}'),
      encoded.replace('"native"', '"\\u006eative"'), '{"native":"x","pi":"x","opencode":"x"}'];
    for (const value of invalid) { const bad = [...args]; bad[5] = value; expect(() => parseVerifyPublishedArgs(bad)).toThrow(/hashes/); }
  });
});
