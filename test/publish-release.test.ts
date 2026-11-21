import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFileSyncOptions } from "node:child_process";
// @ts-expect-error Build tooling is intentionally JavaScript.
import { publishRelease, parsePublishArgs, PublishReleaseError } from "../scripts/publish-release.mjs";

// Even an accidentally uninjected reader must fail locally, never use the network.
vi.mock("node:https", () => ({ get: vi.fn(() => { throw Error("Network forbidden in publication tests"); }) }));
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const kinds = ["native", "pi", "opencode"] as const;
type Kind = typeof kinds[number];
const repository = "berialcheng/cursor-harness-provider";
const version = "0.3.1";
const registry = "https://registry.npmjs.org/";
const predicateType = "https://slsa.dev/provenance/v1";
const digest = (algorithm: string, bytes: Buffer) => createHash(algorithm).update(bytes).digest("hex");
const missing = () => Object.assign(Error("Synthetic private lookup text"), { code: "E404" });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cursor-publish-test-")); temporary.push(directory);
  const names = { native: "@cursor-harness-provider/native", pi: "@cursor-harness-provider/pi", opencode: "@cursor-harness-provider/opencode" };
  const identity = { commit: "a".repeat(40), runId: "123", runAttempt: "2", localOnly: false,
    npmLockSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64) };
  const packages = kinds.map(kind => {
    const file = kind + ".tgz", bytes = Buffer.from(kind + ": synthetic verified archive");
    writeFileSync(join(directory, file), bytes);
    return { kind, name: names[kind], file, sha256: digest("sha256", bytes) };
  });
  const env: Record<string, string> = { PUBLISH_NPM: "true", AUTOMATED_NPM_RELEASES: "true", GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/tags/v" + version, GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: repository + "/.github/workflows/publish.yml@refs/tags/v" + version,
    GITHUB_SERVER_URL: "https://github.com", GITHUB_SHA: identity.commit, GITHUB_RUN_ID: identity.runId,
    GITHUB_RUN_ATTEMPT: identity.runAttempt, RUNNER_TEMP: directory,
    ACTIONS_ID_TOKEN_REQUEST_URL: "synthetic-endpoint-do-not-log", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc-do-not-log" };
  const options = { bundleDirectory: directory, version, npmCli: join(directory, "npm-cli.js"), env };
  const bundle = { version, identity, packages };
  const prepared = { version, policy: { repository, packages: names } };
  const verify = vi.fn(() => bundle), source = vi.fn(() => prepared);
  const uploads: Kind[] = [];
  const latest = new Map<Kind, string>(kinds.map(kind => [kind, "0.3.0"]));
  const metadata = new Map<Kind, ReturnType<typeof packageMetadata>>();
  const attestations = new Map<Kind, ReturnType<typeof attestation>>();
  function packageMetadata(kind: Kind) {
    const bytes = readFileSync(join(directory, kind + ".tgz"));
    return { name: names[kind], version, untrustedExtra: "private-registry-field-do-not-log", dist: {
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"), shasum: digest("sha1", bytes),
      attestations: { url: registry + "-/npm/v1/attestations/" + names[kind].replace("/", "%2f") + "@" + version,
        provenance: { predicateType } },
    } };
  }
  function statement(kind: Kind, runId = identity.runId, runAttempt = identity.runAttempt) {
    return { _type: "https://in-toto.io/Statement/v1", predicateType,
      subject: [{ name: "pkg:npm/" + names[kind].replace(/^@/, "%40") + "@" + version,
        digest: { sha512: digest("sha512", readFileSync(join(directory, kind + ".tgz"))) } }],
      predicate: { buildDefinition: { buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: "https://github.com/" + repository,
          path: ".github/workflows/publish.yml", ref: env.GITHUB_REF } },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [{ uri: "git+https://github.com/" + repository + "@" + env.GITHUB_REF,
          digest: { gitCommit: identity.commit } }],
      }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: "https://github.com/" + repository + "/actions/runs/" + runId + "/attempts/" + runAttempt } } },
    };
  }
  function attestation(kind: Kind, runId?: string, runAttempt?: string) {
    return { attestations: [{ predicateType, bundle: { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement(kind, runId, runAttempt))).toString("base64"),
        signatures: [{ keyid: "", sig: "c3ludGhldGljLXNpZ25hdHVyZQ==" }] },
    } }] };
  }
  function accept(kind: Kind, runId?: string, runAttempt?: string) {
    metadata.set(kind, packageMetadata(kind)); attestations.set(kind, attestation(kind, runId, runAttempt)); latest.set(kind, version);
  }
  function changeStatement(kind: Kind, change: (value: ReturnType<typeof statement>) => void) {
    const envelope = attestations.get(kind)!.attestations[0].bundle.dsseEnvelope;
    const value = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as ReturnType<typeof statement>;
    change(value); envelope.payload = Buffer.from(JSON.stringify(value)).toString("base64");
  }
  const baseReadJSON = async (raw: string) => {
    const url = new URL(raw);
    expect(url.origin).toBe(registry.slice(0, -1));
    const path = decodeURIComponent(url.pathname);
    const kind = kinds.find(kind => path.includes(names[kind]));
    if (!kind) throw Error("Unexpected fixture URL");
    if (path.startsWith("/-/npm/v1/attestations/")) {
      if (!attestations.has(kind)) throw missing();
      return attestations.get(kind)!;
    }
    if (path === "/" + names[kind] + "/latest") {
      if (!latest.has(kind)) throw missing();
      return { name: names[kind], version: latest.get(kind)! };
    }
    expect(path).toBe("/" + names[kind] + "/" + version);
    if (!metadata.has(kind)) throw missing();
    return metadata.get(kind)!;
  };
  const readJSON = vi.fn(baseReadJSON), wait = vi.fn(async (_milliseconds: number) => {});
  const baseExecute = (_binary: string, args: string[], _options: ExecFileSyncOptions): string => {
    if (args[1] === "--version") return "11.21.0\n";
    expect(args[1]).toBe("publish");
    const kind = kinds.find(kind => args[2] === join(directory, kind + ".tgz"));
    if (!kind) throw Error("Unexpected fixture archive");
    uploads.push(kind); accept(kind);
    return "private-child-output-do-not-log";
  };
  const execute = vi.fn<(binary: string, args: string[], options: ExecFileSyncOptions) => string | Promise<string>>(baseExecute);
  return { directory, env, options, verify, source, execute, readJSON, wait, identity, packages, bundle, prepared,
    uploads, latest, metadata, attestations, accept, changeStatement, baseExecute, baseReadJSON };
}
async function failure(f: ReturnType<typeof fixture>) {
  try { await publishRelease(f.options, f); }
  catch (error) { expect(error).toBeInstanceOf(PublishReleaseError); return error as Error & { audit: any }; }
  throw Error("Expected publication refusal");
}
function readProducers(f: ReturnType<typeof fixture>) {
  const lines = readFileSync(f.env.GITHUB_OUTPUT, "utf8").split("\n").filter(line => line.startsWith("producers="));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice("producers=".length));
}

describe("direct OIDC release publication", () => {
  it("verifies and inspects every package first, then publishes native → Pi → OpenCode", async () => {
    const f = fixture(), result = await publishRelease(f.options, f);
    expect(result.outcome).toBe("published"); expect(result.completion).toBe(true); expect(result.freshPublication).toBe(true);
    expect(f.uploads).toEqual(kinds); expect(f.verify).toHaveBeenCalledWith({ projectRoot: expect.any(String), bundleDirectory: f.directory, localOnly: false });
    expect(f.source).toHaveBeenCalledOnce(); expect(f.verify).toHaveBeenCalledOnce();
    expect(f.execute.mock.invocationCallOrder[0]).toBeGreaterThan(f.verify.mock.invocationCallOrder[0]);
    expect(f.execute.mock.invocationCallOrder[1]).toBeGreaterThan(f.readJSON.mock.invocationCallOrder[5]);
    expect(f.readJSON.mock.calls.slice(0, 6).map(([url]) => decodeURIComponent(new URL(url).pathname))).toEqual(
      kinds.flatMap(kind => ["/@cursor-harness-provider/" + kind + "/" + version, "/@cursor-harness-provider/" + kind + "/latest"]));
    expect(result.packages.map((item: any) => item.status)).toEqual(["published", "published", "published"]);
    expect(f.wait).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/private-|synthetic-oidc|synthetic-endpoint/);
  });

  it("uses distinct private empty configs, a private cwd/cache and only pinned official-registry publish flags", async () => {
    const f = fixture(); await publishRelease(f.options, f);
    for (const [binary, args, options] of f.execute.mock.calls) {
      expect(binary).toBe(process.execPath); expect(args[0]).toBe(f.options.npmCli);
      const flag = (name: string) => args[args.indexOf(name) + 1];
      const user = flag("--userconfig"), global = flag("--globalconfig");
      expect(user).not.toBe(global); expect(readFileSync(user, "utf8")).toBe(""); expect(readFileSync(global, "utf8")).toBe("");
      expect(statSync(user).mode & 0o777).toBe(0o600); expect(statSync(global).mode & 0o777).toBe(0o600);
      expect(statSync(options.cwd as string).mode & 0o777).toBe(0o700); expect(options.cwd).not.toBe(f.directory);
      expect(flag("--registry")).toBe(registry); expect(flag("--fetch-retries")).toBe("0");
      expect(flag("--prefix")).toBe(options.cwd); expect(flag("--cache")).toBe(join(options.cwd as string, "cache"));
      expect(options.env).toBe(f.env); expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(options.timeout).toBe(120000); expect(args).not.toContain("stage");
      if (args[1] === "publish") {
        expect(args).toContain("--ignore-scripts"); expect(args).toContain("--provenance");
        expect(flag("--tag")).toBe("latest"); expect(flag("--access")).toBe("public");
      }
    }
  });

  it.each([
    { PUBLISH_NPM: "false" }, { AUTOMATED_NPM_RELEASES: "" }, { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/main" }, { GITHUB_REF: "refs/tags/v0.3.2" }, { GITHUB_REPOSITORY: "foreign/repository" },
    { GITHUB_WORKFLOW_REF: repository + "/.github/workflows/other.yml@refs/tags/v" + version },
    { GITHUB_WORKFLOW_REF: repository + "/.github/workflows/publish.yml@refs/heads/main" },
    { GITHUB_SHA: "not-a-commit" }, { GITHUB_RUN_ID: "0" }, { GITHUB_RUN_ATTEMPT: "0" }, { RUNNER_TEMP: "relative" },
    { GITHUB_SERVER_URL: "https://foreign.invalid" },
  ])("refuses an unauthorized context before any subprocess or registry lookup: %j", async change => {
    const f = fixture(); Object.assign(f.env, change); await failure(f);
    expect(f.execute).not.toHaveBeenCalled(); expect(f.readJSON).not.toHaveBeenCalled();
  });
  it("tolerates a workflow_sha naming the workflow file's last-modified commit", async () => {
    const f = fixture(); f.env.GITHUB_WORKFLOW_SHA = "d".repeat(40);
    expect((await publishRelease(f.options, f)).outcome).toBe("published");
  });

  it.each(["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"])("requires OIDC endpoint presence: %s", async key => {
    const f = fixture(); delete f.env[key]; expect((await failure(f)).message).toMatch(/OIDC/);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("never reads the OIDC endpoint or token values (including empty values)", async () => {
    const f = fixture();
    for (const key of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"]) Object.defineProperty(f.env, key,
      { enumerable: true, configurable: true, get: () => { throw Error("OIDC value must not be read"); } });
    expect((await publishRelease(f.options, f)).outcome).toBe("published");
    const g = fixture(); g.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = ""; g.env.ACTIONS_ID_TOKEN_REQUEST_URL = "";
    expect((await publishRelease(g.options, g)).outcome).toBe("published");
  });
  it.each(["NPM_TOKEN", "npm_token", "NODE_AUTH_TOKEN", "node_auth_token", "NPM_AUTH_TOKEN", "NPM_CONFIG_REGISTRY", "npm_config_userconfig", "nPm_CoNfIg__authToken", "NPM_CONFIG_", "NODE_OPTIONS", "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS"])(
    "rejects even an empty legacy token/config/injection override: %s", async key => {
      const f = fixture(); f.env[key] = ""; expect((await failure(f)).message).toMatch(/overrides/);
      expect(f.execute).not.toHaveBeenCalled(); expect(f.readJSON).not.toHaveBeenCalled();
    });

  it("requires Node 22.22.0 and the pinned npm 11.21.0", async () => {
    const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    try {
      Object.defineProperty(process.versions, "node", { value: "22.23.0", configurable: true });
      expect((await failure(f)).message).toMatch(/Node 22.22.0/); expect(f.execute).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process.versions, "node", descriptor); }
    const g = fixture(); g.execute.mockReturnValue("11.20.0\n");
    expect((await failure(g)).message).toMatch(/npm 11.21.0/); expect(g.readJSON).not.toHaveBeenCalled();
  });
  it("supports asynchronous execute, and sanitizes a CLI verification failure", async () => {
    const f = fixture(); f.execute.mockImplementation(async (...args) => f.baseExecute(...args));
    expect((await publishRelease(f.options, f)).completion).toBe(true);
    const g = fixture(); g.execute.mockImplementation(() => { throw Error("private-cli-output-do-not-log"); });
    expect((await failure(g)).message).not.toContain("private-cli"); expect(g.readJSON).not.toHaveBeenCalled();
  });

  it("rejects a different requested source version or foreign package policy", async () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { f.options.version = "0.3.2"; },
      (f: ReturnType<typeof fixture>) => { f.prepared.version = "0.3.2"; },
      (f: ReturnType<typeof fixture>) => { f.prepared.policy.repository = "foreign/repo"; },
      (f: ReturnType<typeof fixture>) => { f.prepared.policy.packages.pi = "@foreign/pi"; }]) {
      const f = fixture(); mutate(f); await failure(f); expect(f.execute).not.toHaveBeenCalled();
    }
    const f = fixture(); f.source.mockImplementation(() => { throw Error("private-source-error"); });
    expect((await failure(f)).message).toMatch(/source validation/); expect(f.verify).not.toHaveBeenCalled();
  });
  it.each(["version", "commit", "runId", "runAttempt", "localOnly", "npmLockSha256", "cargoLockSha256"])(
    "rejects a foreign/unbound verified bundle: %s", async field => {
      const f = fixture();
      if (field === "version") f.bundle.version = "0.3.2";
      else Object.assign(f.identity, { [field]: field === "localOnly" ? true : "foreign" });
      expect((await failure(f)).message).toMatch(/current release/); expect(f.execute).not.toHaveBeenCalled();
    });
  it("rejects failed verification and invalid or duplicate inventory before contacting npm", async () => {
    const f = fixture(); f.verify.mockImplementation(() => { throw Error("private-verification-error"); });
    expect((await failure(f)).message).toMatch(/bundle verification/); expect(f.execute).not.toHaveBeenCalled();
    for (const mutate of [(g: ReturnType<typeof fixture>) => { g.packages[1].kind = "native"; },
      (g: ReturnType<typeof fixture>) => { g.packages[1].file = "../pi.tgz"; },
      (g: ReturnType<typeof fixture>) => { g.packages[1].name = "@foreign/pi"; },
      (g: ReturnType<typeof fixture>) => { g.packages.pop(); }]) {
      const g = fixture(); mutate(g); await failure(g); expect(g.execute).not.toHaveBeenCalled();
    }
  });

  it("checks every archive after verification and again after npm version/registry reads", async () => {
    const f = fixture(); writeFileSync(join(f.directory, "opencode.tgz"), "mutated");
    expect((await failure(f)).message).toMatch(/changed/); expect(f.execute).not.toHaveBeenCalled();
    const g = fixture(); g.execute.mockImplementation((...args) => {
      const result = g.baseExecute(...args); writeFileSync(join(g.directory, "pi.tgz"), "mutated"); return result;
    });
    expect((await failure(g)).message).toMatch(/changed/); expect(g.uploads).toEqual([]);
  });
  it("rechecks ALL archives before each following upload, not merely the next archive", async () => {
    const f = fixture(); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args);
      if (args[1][1] === "publish") writeFileSync(join(f.directory, "opencode.tgz"), "mutated after native");
      return result;
    });
    const error = await failure(f);
    expect(error.message).toMatch(/changed/); expect(f.uploads).toEqual(["native"]);
    expect(error.audit.outcome).toBe("uncertain"); expect(error.audit.freshPublication).toBe(true);
    expect(error.audit.packages[0].status).toBe("published");
  });

  it("reuses exact public bytes with tag/workflow/SHA evidence from a prior run, without a same-run claim", async () => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output");
    for (const kind of kinds) f.accept(kind, "77", "1");
    const result = await publishRelease(f.options, f);
    expect(readProducers(f)).toEqual({ native: { runId: "77", runAttempt: "1" },
      pi: { runId: "77", runAttempt: "1" }, opencode: { runId: "77", runAttempt: "1" } });
    expect(result.outcome).toBe("complete"); expect(result.completion).toBe(true); expect(result.freshPublication).toBe(false);
    expect(f.uploads).toEqual([]); expect(f.execute).toHaveBeenCalledOnce();
    expect(result.bundleIdentity.runId).toBe("123");
    for (const item of result.packages) {
      expect(item.status).toBe("already-published"); expect(item.provenance.runId).toBe("77"); expect(item.provenance.runAttempt).toBe("1");
      expect(item.provenance.cryptographicVerification).toBe("required-post-publication");
    }
  });
  it.each([["77", "1"], ["123", "1"]])("exports mixed producers when source-identical native bytes from %s/%s are reused", async (runId, runAttempt) => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output");
    f.accept("native", runId, runAttempt); const result = await publishRelease(f.options, f);
    expect(f.uploads).toEqual(["pi", "opencode"]);
    expect(result.completion).toBe(true); expect(result.freshPublication).toBe(true);
    expect(result.bundleIdentity.runId).toBe("123"); expect(result.bundleIdentity.runAttempt).toBe("2");
    expect(result.packages.map((item: any) => item.status)).toEqual(["already-published", "published", "published"]);
    expect(readProducers(f)).toEqual({ native: { runId, runAttempt },
      pi: { runId: "123", runAttempt: "2" }, opencode: { runId: "123", runAttempt: "2" } });
  });
  it.each(["integrity", "shasum"])("stops before any writes when an existing adapter's %s conflicts", async field => {
    const f = fixture(); f.accept("opencode"); Object.assign(f.metadata.get("opencode")!.dist, { [field]: "wrong" });
    expect((await failure(f)).message).toMatch(/bytes\/source conflict/); expect(f.uploads).toEqual([]);
  });
  it.each(["repository", "workflow", "ref", "sha", "dependencyUri", "invocation", "subjectDigest", "subjectName", "event", "builder"])(
    "does not silently reuse foreign or unbound public provenance: %s", async field => {
      const f = fixture(); f.accept("pi", "77", "1");
      f.changeStatement("pi", value => {
        const definition = value.predicate.buildDefinition;
        if (field === "repository") definition.externalParameters.workflow.repository = "https://github.com/foreign/repository";
        if (field === "workflow") definition.externalParameters.workflow.path = ".github/workflows/foreign.yml";
        if (field === "ref") definition.externalParameters.workflow.ref = "refs/heads/main";
        if (field === "sha") definition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40);
        if (field === "dependencyUri") definition.resolvedDependencies[0].uri = "git+https://github.com/foreign/repository";
        if (field === "invocation") value.predicate.runDetails.metadata.invocationId = "https://github.com/foreign/repository/actions/runs/77/attempts/1";
        if (field === "subjectDigest") value.subject[0].digest.sha512 = "b".repeat(128);
        if (field === "subjectName") value.subject[0].name = "pkg:npm/foreign@" + version;
        if (field === "event") definition.internalParameters.github.event_name = "push";
        if (field === "builder") value.predicate.runDetails.builder.id = "https://foreign.invalid/builder";
      });
      expect((await failure(f)).message).toMatch(/conflict/); expect(f.uploads).toEqual([]);
    });
  it.each(["https://github.com/actions/runner/self-hosted", "https://github.com/actions/runner/github-hosted/",
    "https://github.com/actions/runner/github-hosted\n"])("rejects unsupported or inexact GitHub builder identities: %j", async builder => {
    const f = fixture(); f.accept("native", "77", "1");
    f.changeStatement("native", value => { value.predicate.runDetails.builder.id = builder; });
    expect((await failure(f)).message).toMatch(/conflict/); expect(f.uploads).toEqual([]);
  });
  it.each(["runId", "runAttempt"])("refuses invalid producer %s identities without exporting raw data", async field => {
    for (const value of ["", "0", "01", "-1", "1.5", "1e2", "1\nprivate-output=injected"]) {
      const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output");
      f.accept("native", field === "runId" ? value : "77", field === "runAttempt" ? value : "1");
      expect((await failure(f)).message).toMatch(/conflict/); expect(f.uploads).toEqual([]);
      const output = readFileSync(f.env.GITHUB_OUTPUT, "utf8");
      expect(output).toContain("completion=false\n"); expect(output).not.toMatch(/producers=|private-output|injected/);
    }
  });
  it.each(["https://foreign.invalid/provenance", "http://registry.npmjs.org/provenance",
    "https://user:password@registry.npmjs.org/-/npm/v1/attestations/@cursor-harness-provider%2fpi@0.3.1",
    registry + "-/npm/v1/attestations/@cursor-harness-provider%2fpi@0.3.2",
    registry + "-/npm/v1/attestations/@cursor-harness-provider%2fpi@0.3.1?token=private",
    registry + "unrelated/path"])("rejects a nonstandard/foreign provenance URL without fetching it: %s", async url => {
      const f = fixture(); f.accept("pi"); f.metadata.get("pi")!.dist.attestations.url = url;
      await failure(f); expect(f.uploads).toEqual([]);
      expect(f.readJSON.mock.calls.some(([value]) => value === url)).toBe(false);
    });
  it("fails closed on malformed, ambiguous or older provenance envelopes", async () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { f.attestations.get("pi")!.attestations[0].bundle.dsseEnvelope.payload = "bad-base64!"; },
      (f: ReturnType<typeof fixture>) => { f.attestations.get("pi")!.attestations[0].bundle.dsseEnvelope.payloadType = "text/plain"; },
      (f: ReturnType<typeof fixture>) => { f.attestations.get("pi")!.attestations.push(f.attestations.get("pi")!.attestations[0]); },
      (f: ReturnType<typeof fixture>) => { f.changeStatement("pi", value => { value.subject.push(value.subject[0]); }); },
      (f: ReturnType<typeof fixture>) => { f.changeStatement("pi", value => { value.predicateType = "https://slsa.dev/provenance/v0.2"; }); }]) {
      const f = fixture(); f.accept("pi"); mutate(f); await failure(f); expect(f.uploads).toEqual([]);
    }
  });

  it("rejects source bindings encoded with coercible arrays instead of strings", async () => {
    for (const field of ["invocation", "builder", "mediaType", "url"]) {
      const f = fixture(); f.accept("pi");
      if (field === "url") {
        const value = f.metadata.get("pi")!.dist.attestations;
        Object.assign(value, { url: [value.url] });
      } else if (field === "mediaType") {
        const value = f.attestations.get("pi")!.attestations[0].bundle;
        Object.assign(value, { mediaType: [value.mediaType] });
      } else f.changeStatement("pi", value => {
        const details = value.predicate.runDetails;
        if (field === "invocation") Object.assign(details.metadata, { invocationId: [details.metadata.invocationId] });
        else Object.assign(details.builder, { id: [details.builder.id] });
      });
      expect((await failure(f)).message).toMatch(/conflict/); expect(f.uploads).toEqual([]);
    }
  });

  it.each(["E403", "E401", "ENOTFOUND", "ETIMEDOUT", "ENOENT", undefined])("only treats explicit E404 as absence, not %s", async code => {
    const f = fixture(); f.readJSON.mockImplementation(async url => {
      if (url.includes("opencode")) throw Object.assign(Error("private-network-text"), { code, statusCode: 404 });
      return f.baseReadJSON(url);
    });
    const error = await failure(f); expect(error.message).toMatch(/lookup unknown/); expect(error.message).not.toContain("private-network");
    expect(f.uploads).toEqual([]); expect(f.wait).not.toHaveBeenCalled();
  });
  it("does not infer absence from an empty/malformed successful lookup or invalid latest", async () => {
    const f = fixture(); f.readJSON.mockResolvedValue({ error: "Not found" } as never);
    await failure(f); expect(f.uploads).toEqual([]);
    for (const latest of ["not-semver", "v0.3.2", "00.4.0", "0.4.0-01"]) {
      const g = fixture(); g.latest.set("pi", latest); await failure(g); expect(g.uploads).toEqual([]);
    }
  });
  it("allows explicit E404 for both exact version and latest", async () => {
    const f = fixture(); f.latest.clear(); expect((await publishRelease(f.options, f)).completion).toBe(true);
  });

  it("reconciles accepted-after-error with bounded reads and continues, without a second upload", async () => {
    const f = fixture(); let misses = 0;
    f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args);
      if (args[1][1] === "publish" && args[1][2].endsWith("native.tgz")) throw Object.assign(Error("private-child-error"), { stdout: "private-output", stderr: "private-env" });
      return result;
    });
    f.readJSON.mockImplementation(async url => {
      if (f.uploads.includes("native") && url.endsWith("native/" + version) && misses++ < 2) throw missing();
      return f.baseReadJSON(url);
    });
    const result = await publishRelease(f.options, f);
    expect(result.outcome).toBe("published"); expect(f.uploads).toEqual(kinds);
    expect(result.packages[0].status).toBe("accepted-after-error"); expect(f.wait.mock.calls).toEqual([[1000], [3000]]);
    expect(f.execute.mock.calls.filter(([, args]) => args[1] === "publish")).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/private-child|private-output|private-env/);
  });
  it("records prior-run acceptance discovered after an error as reuse, never as a fresh same-run native build", async () => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output"); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args);
      if (args[1][1] === "publish" && args[1][2].endsWith("native.tgz")) { f.accept("native", "77", "1"); throw Error("ambiguous"); }
      return result;
    });
    const result = await publishRelease(f.options, f);
    expect(f.uploads).toEqual(kinds); expect(result.packages[0].status).toBe("already-published");
    expect(result.packages[0].provenance.runId).toBe("77"); expect(result.packages[0].provenance.runAttempt).toBe("1");
    expect(readProducers(f)).toEqual({ native: { runId: "77", runAttempt: "1" },
      pi: { runId: "123", runAttempt: "2" }, opencode: { runId: "123", runAttempt: "2" } });
  });
  it("uses bounded read-only retries when the registry fails after an ambiguous upload", async () => {
    const f = fixture(); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args); if (args[1][1] === "publish") throw Error("ambiguous"); return result;
    });
    f.readJSON.mockImplementation(async url => {
      if (f.uploads.length) throw Object.assign(Error("private-network-outcome"), { code: "ETIMEDOUT" });
      return f.baseReadJSON(url);
    });
    const error = await failure(f); expect(error.audit.outcome).toBe("uncertain"); expect(f.uploads).toEqual(["native"]);
    expect(f.wait.mock.calls).toEqual([[1000], [3000], [6000], [10000], [15000]]); expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it.each([true, false])("stops without retry/following packages when acceptance cannot be proved (nonzero=%s)", async nonzero => {
    const f = fixture(); f.execute.mockImplementation((_binary, args) => {
      if (args[1] === "--version") return "11.21.0";
      if (nonzero) throw Error("private-child-error");
      return "false-success-private-output";
    });
    const error = await failure(f);
    expect(error.message).toMatch(/outcome uncertain/); expect(error.audit.outcome).toBe("uncertain");
    expect(error.audit.completion).toBe(false); expect(error.audit.freshPublication).toBe(false);
    expect(error.audit.packages.map((item: any) => item.status)).toEqual(["uncertain", "not-attempted", "not-attempted"]);
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.wait).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(error.audit)).not.toContain("private");
  });
  it("stops after an ambiguous upload with conflicting bytes/source, not even the next package", async () => {
    const f = fixture(); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args);
      if (args[1][1] === "publish") { f.changeStatement("native", value => { value.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/foreign"; }); throw Error("ambiguous"); }
      return result;
    });
    const error = await failure(f); expect(error.audit.outcome).toBe("uncertain"); expect(f.uploads).toEqual(["native"]); expect(f.wait).not.toHaveBeenCalled();
  });
  it("does not proceed with matching checksums when provenance stays unreadable after upload", async () => {
    const f = fixture(); f.readJSON.mockImplementation(async url => {
      if (url.includes("/-/npm/v1/attestations/")) throw missing();
      return f.baseReadJSON(url);
    });
    const error = await failure(f); expect(error.audit.outcome).toBe("uncertain"); expect(f.uploads).toEqual(["native"]);
    expect(f.wait).toHaveBeenCalledTimes(5);
  });

  it.each(["0.3.2", "0.3.10", "0.10.0", "1.0.0", "0.4.0-rc.1"])("returns safe superseded without writing if any latest is ahead: %s", async latest => {
    const f = fixture(); f.latest.set("opencode", latest); const result = await publishRelease(f.options, f);
    expect(result.outcome).toBe("superseded"); expect(result.completion).toBe(false); expect(result.freshPublication).toBe(false); expect(f.uploads).toEqual([]);
  });
  it.each(["0.3.0", "0.2.99", "0.3.1-rc.1", "0.3.1+build.1"])("compares latest monotonically (not lexically): %s", async latest => {
    const f = fixture(); f.latest.set("native", latest); expect((await publishRelease(f.options, f)).completion).toBe(true);
  });
  it("rechecks latest immediately before publishing, not merely at preflight", async () => {
    const f = fixture(); let reads = 0;
    f.readJSON.mockImplementation(async url => {
      if (url.endsWith("native/latest") && ++reads === 2) f.latest.set("native", "0.4.0");
      return f.baseReadJSON(url);
    });
    expect((await publishRelease(f.options, f)).outcome).toBe("superseded"); expect(f.uploads).toEqual([]);
  });
  it("stops safely if latest advances between packages, preserving a truthful partial-publication audit", async () => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output"); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args); if (args[1][1] === "publish") f.latest.set("pi", "0.4.0"); return result;
    });
    const result = await publishRelease(f.options, f);
    expect(result.outcome).toBe("superseded"); expect(result.completion).toBe(false); expect(result.freshPublication).toBe(true);
    expect(f.uploads).toEqual(["native"]); expect(result.packages[0].status).toBe("published");
    expect(readFileSync(f.env.GITHUB_OUTPUT, "utf8")).not.toContain("producers=");
  });

  it("reports superseded if a newer latest is observed while reconciling an accepted ambiguous write", async () => {
    const f = fixture(); f.execute.mockImplementation((...args) => {
      const result = f.baseExecute(...args);
      if (args[1][1] === "publish") { f.latest.set("native", "0.4.0"); throw Error("ambiguous"); }
      return result;
    });
    const result = await publishRelease(f.options, f);
    expect(result.outcome).toBe("superseded"); expect(result.completion).toBe(false); expect(result.freshPublication).toBe(true);
    expect(result.packages[0].status).toBe("accepted-after-error"); expect(f.uploads).toEqual(["native"]);
  });

  it("exports sanitized hashes/version/completion/fresh-publication/producers and a sanitized summary", async () => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output"); f.env.GITHUB_STEP_SUMMARY = join(f.directory, "summary");
    const result = await publishRelease(f.options, f), output = readFileSync(f.env.GITHUB_OUTPUT, "utf8"), summary = readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8");
    expect(output).toContain("version=0.3.1\n"); expect(output).toContain("completion=true\n"); expect(output).toContain("fresh_publication=true\n");
    expect(readProducers(f)).toEqual({ native: { runId: "123", runAttempt: "2" },
      pi: { runId: "123", runAttempt: "2" }, opencode: { runId: "123", runAttempt: "2" } });
    for (const item of result.packages) for (const hash of ["sha256", "sha512", "sha1"]) expect(output).toContain(item.kind + "_" + hash + "=" + item[hash] + "\n");
    expect(summary).toContain("required-post-publication"); expect(output + summary).not.toMatch(/private-|synthetic-endpoint|synthetic-oidc/);
  });
  it("also exports an unresolved audit, including hashes, without forwarding child errors", async () => {
    const f = fixture(); f.env.GITHUB_OUTPUT = join(f.directory, "github-output"); f.env.GITHUB_STEP_SUMMARY = join(f.directory, "summary");
    f.execute.mockImplementation((_binary, args) => { if (args[1] === "--version") return "11.21.0"; throw Error("private-sensitive-child"); });
    await failure(f); const output = readFileSync(f.env.GITHUB_OUTPUT, "utf8"), summary = readFileSync(f.env.GITHUB_STEP_SUMMARY, "utf8");
    expect(output).toContain("outcome=uncertain\n"); expect(output).toContain("completion=false\n"); expect(output).toContain("fresh_publication=false\n");
    expect(output).toContain("native_sha256=" + f.packages[0].sha256); expect(summary).not.toContain("private-sensitive");
    expect(output).not.toContain("producers=");
  });

  it("parses exactly the three explicit absolute arguments and canonical stable versions", () => {
    const args = ["--bundle", "/tmp/bundle", "--version", version, "--npm-cli", "/tmp/npm-cli.js"];
    expect(parsePublishArgs(args)).toEqual({ bundleDirectory: "/tmp/bundle", version, npmCli: "/tmp/npm-cli.js" });
    for (const invalid of [[], args.slice(0, 4), [...args, "--publish", "true"], [...args, "--version", version],
      ["--bundle", "relative", ...args.slice(2)], [...args.slice(0, 5), "relative"],
      ...["v0.3.1", "0.3.1-beta.1", "0.3.1+build", "00.3.1", "0.3", "0.3.1\n", "9007199254740992.0.0"].map(value => ["--bundle", "/tmp/bundle", "--version", value, "--npm-cli", "/tmp/npm-cli.js"])]) {
      expect(() => parsePublishArgs(invalid)).toThrow(PublishReleaseError);
    }
  });
});
