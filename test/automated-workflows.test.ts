import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

type Permissions = Record<string, "read" | "write" | "none">;
interface Step {
  name?: string;
  id?: string;
  if?: string;
  shell?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Permissions;
  environment?: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { matrix?: { os?: string[]; include?: { platform: string }[] } };
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Permissions;
  concurrency?: { group: string; "cancel-in-progress": boolean; queue?: string };
  jobs: Record<string, Job>;
}
const names = ["auto-release", "publish", "check", "verify-published"] as const;
const workflows = Object.fromEntries(names.map(name => {
  const document = YAML.parseDocument(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"), { uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${name}.yml must be valid YAML`);
  return [name, document.toJS() as Workflow];
})) as Record<typeof names[number], Workflow>;
const repository = "berialcheng/cursor-harness-provider";
const version = "0.3.1";
const commit = "a".repeat(40), parent = "b".repeat(40), tagObject = "c".repeat(40), otherCommit = "d".repeat(40);
const tagRef = "refs/tags/v" + version;
const automationVariable = "${{ vars.AUTOMATED_NPM_RELEASES || 'false' }}";
const sourceJob = workflows.publish.jobs.source;
const publisher = workflows.publish.jobs["publish-npm"];
const originalChecks = workflows.check.jobs.check;
function step(job: Job, selector: string): Step {
  const matches = job.steps.filter(value => value.name === selector || value.id === selector);
  assert.equal(matches.length, 1, `Expected exactly one step: ${selector}`);
  return matches[0];
}
const sourceStep = step(sourceJob, "Validate source versions, main ancestry and coordinator tag trace");
const classifierStep = step(workflows.check.jobs.classify, "classify");

// These fixtures use lowercase strings/booleans, for which this expression
// subset has the same comparisons as Actions. (Actions strings ignore case.)
// Every namespace is synthetic; absent vars/outputs stay absent.
function expressionValue(expression: string | undefined, context: Record<string, unknown>, cancelled = false): unknown {
  assert(typeof expression === "string" && expression.startsWith("${{ ") && expression.endsWith(" }}"));
  return new Script(expression.slice(4, -3)).runInNewContext({
    github: {}, vars: {}, inputs: {}, needs: {}, ...context,
    cancelled: () => cancelled, always: () => true,
    format: (template: string, ...values: unknown[]) => template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)])),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
function condition(expression: string | undefined, context: Record<string, unknown>, cancelled = false): boolean {
  return Boolean(expressionValue(expression, context, cancelled));
}
function publishContext() {
  return {
    github: { repository, event_name: "workflow_dispatch", ref: tagRef },
    inputs: { version, publish_npm: true }, vars: { AUTOMATED_NPM_RELEASES: "true" },
    needs: Object.fromEntries(["source", "build", "aggregate", "verify-packed"].map(name => [name, { result: "success" }])),
  };
}
function checkCondition(result: string, output?: string, cancelled = false) {
  return condition(originalChecks.if, { needs: { classify: { result, outputs: output === undefined ? {} : { run_checks: output } } } }, cancelled);
}

describe("unattended release workflow contracts", () => {
  it.each(names)("parses .github/workflows/%s.yml with explicit least-privilege defaults and pinned actions", name => {
    const workflow = workflows[name];
    expect(workflow.permissions).toEqual(name === "auto-release" ? {} : { contents: "read" });
    expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps.length).toBeGreaterThan(0);
      for (const value of job.steps) {
        if (value.uses) expect(value.uses).toMatch(/@[a-f0-9]{40}$/);
        if (value.uses?.startsWith("actions/checkout@")) expect(value.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  it("grants OIDC only to the tagged publisher and contents/actions write only to preparation", () => {
    const writers = names.flatMap(name => Object.entries(workflows[name].jobs).flatMap(([id, job]) =>
      Object.entries(job.permissions ?? workflows[name].permissions)
        .filter(([, permission]) => permission === "write").map(([scope]) => `${name}/${id}/${scope}`)));
    expect(writers.sort()).toEqual([
      "auto-release/prepare/actions", "auto-release/prepare/contents", "publish/publish-npm/id-token",
    ]);
    expect(workflows["auto-release"].jobs.prepare.permissions).toEqual({ contents: "write", actions: "write" });
    expect(publisher.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publisher.environment).toBe("npm-release");
    for (const name of names) for (const [id, job] of Object.entries(workflows[name].jobs)) {
      if (name !== "publish" || id !== "publish-npm") expect(job.environment).toBeUndefined();
    }
  });

  it("has no token secrets, interactive approvals/2FA, bootstrap or staged-publication commands", () => {
    for (const workflow of Object.values(workflows)) {
      const text = JSON.stringify(workflow);
      expect(text).not.toMatch(/secrets\s*(?:\.|\[)|\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN|NPM_BOOTSTRAP_TOKEN)\b/i);
      expect(text).not.toMatch(/manual[-_/ ]approval|reviewers?|2fa|two[-_ ]factor|--otp|webauthn|security[-_ ]key/i);
      expect(text).not.toMatch(/\bnpm\s+(?:stage|login|logout|token)\b|(?:stage-release|bootstrap-npm)\.mjs|\bgh\s+[^"\n]*\bapprove\b/i);
    }
    const credentialSteps = names.flatMap(name => Object.values(workflows[name].jobs).flatMap(job =>
      job.steps.filter(value => JSON.stringify(value).includes("github.token")).map(value => ({ name, value }))));
    expect(credentialSteps).toHaveLength(1);
    expect(credentialSteps[0].name).toBe("auto-release");
    expect(credentialSteps[0].value.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(credentialSteps[0].value.run).toContain("node scripts/prepare-release.mjs");
  });

  it("uses documented queue:max without cancellation and separates writers from read-only runs", () => {
    expect(workflows["auto-release"].on.push).toEqual({ branches: ["main"] });
    expect(Object.keys(workflows["auto-release"].on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(Object.keys(workflows.publish.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflows["verify-published"].on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(workflows.check.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflows.publish.concurrency).toEqual({
      group: "${{ inputs.publish_npm == true && 'npm-release' || format('npm-release-readonly-{0}', github.ref) }}",
      "cancel-in-progress": false, queue: "max",
    });
    expect(workflows["auto-release"].concurrency).toEqual({ group: "automatic-release-preparation", "cancel-in-progress": false, queue: "max" });
    // queue:max retains up to 100 pending runs (FIFO once waiting, not dispatch order).
    // All tagged writers share a queue; neither main nor tag previews share it.
    const group = workflows.publish.concurrency?.group;
    for (const ref of [tagRef, "refs/tags/v0.3.2", "refs/heads/main"]) {
      expect(expressionValue(group, { inputs: { publish_npm: true }, github: { ref } })).toBe("npm-release");
      for (const publish_npm of [false, undefined]) {
        expect(expressionValue(group, { inputs: { publish_npm }, github: { ref } })).toBe("npm-release-readonly-" + ref);
      }
    }
    expect(sourceStep.env).toMatchObject({ AUTOMATED_NPM_RELEASES: automationVariable, WORKFLOW_COMMIT: "${{ github.workflow_sha }}" });
    expect(classifierStep.env?.AUTOMATED_NPM_RELEASES).toBe(automationVariable);
    expect(releaseAutomationSteps()).toHaveLength(2);
    const context = { github: { repository, event_name: "workflow_dispatch" } };
    expect(condition(sourceJob.if, context)).toBe(true);
    expect(condition(sourceJob.if, { github: { repository, event_name: "push" } })).toBe(false);
    expect(condition(sourceJob.if, { github: { repository: "foreign/repo", event_name: "workflow_dispatch" } })).toBe(false);
  });

  it("enables preparation only on this main branch, with an explicit read-only manual preview exception", () => {
    const prepare = workflows["auto-release"].jobs.prepare;
    const context = { github: { repository, ref: "refs/heads/main", event_name: "push" }, vars: { AUTOMATED_NPM_RELEASES: "true" }, inputs: {} };
    expect(condition(prepare.if, context)).toBe(true);
    for (const value of [undefined, "", "false", "1"]) {
      expect(condition(prepare.if, { ...context, vars: { AUTOMATED_NPM_RELEASES: value } })).toBe(false);
    }
    for (const ref of [tagRef, "refs/heads/feature"]) {
      expect(condition(prepare.if, { ...context, github: { ...context.github, ref } })).toBe(false);
    }
    expect(condition(prepare.if, { ...context, github: { ...context.github, repository: "foreign/repo" } })).toBe(false);
    const preview = { ...context, vars: {}, inputs: { preview: true } };
    expect(condition(prepare.if, preview)).toBe(false);
    expect(condition(prepare.if, { ...preview, github: { ...context.github, event_name: "workflow_dispatch" } })).toBe(true);
    expect(condition(prepare.if, { ...preview, github: { ...context.github, event_name: "workflow_dispatch", ref: "refs/heads/feature" } })).toBe(false);
  });

  it("requires the exact dispatch/tag/version/enablement and every same-run gate to publish", () => {
    expect(publisher.needs).toEqual(["source", "build", "aggregate", "verify-packed"]);
    expect(condition(publisher.if, publishContext())).toBe(true);
    for (const patch of [
      { ref: "refs/heads/main" }, { ref: "refs/heads/feature" }, { ref: "refs/tags/v0.3.2" },
      { event_name: "push" }, { repository: "foreign/repo" },
    ]) {
      const context = publishContext(); Object.assign(context.github, patch);
      expect(condition(publisher.if, context)).toBe(false);
    }
    for (const value of [undefined, "", "false", "1"]) {
      expect(condition(publisher.if, { ...publishContext(), vars: { AUTOMATED_NPM_RELEASES: value } })).toBe(false);
    }
    expect(condition(publisher.if, { ...publishContext(), inputs: { version, publish_npm: false } })).toBe(false);
    expect(condition(publisher.if, { ...publishContext(), inputs: { version: "0.3.2", publish_npm: true } })).toBe(false);
    for (const gate of ["source", "build", "aggregate", "verify-packed"]) for (const result of ["failure", "skipped", "cancelled", ""]) {
      const context = publishContext(); context.needs[gate].result = result;
      expect(condition(publisher.if, context)).toBe(false);
    }
    expect(workflows.publish.jobs.build.strategy?.matrix?.include?.map(value => value.platform)).toEqual(["darwin-arm64", "darwin-x64", "linux-x64-gnu"]);
    expect(workflows.publish.jobs["verify-packed"].needs).toEqual(["source", "aggregate"]);
    expect(workflows.publish.jobs["verify-packed"].steps.some(value => value.run?.includes('npm run test:packages -- --archives "$RUNNER_TEMP/bundle"'))).toBe(true);
  });

  it("keeps original full checks on missing, failed or ambiguous classifier output", () => {
    expect(workflows.check.jobs.classify.outputs?.run_checks).toBe("${{ steps.classify.outputs.run_checks }}");
    expect(originalChecks.needs).toBe("classify");
    expect(checkCondition("success", "false")).toBe(false);
    for (const output of [undefined, "", "true", " false ", "uncertain"]) expect(checkCondition("success", output)).toBe(true);
    for (const result of ["failure", "cancelled", "skipped", ""]) expect(checkCondition(result, "false")).toBe(true);
    expect(checkCondition("failure", undefined, true)).toBe(false);
    expect(originalChecks.strategy?.matrix?.os).toEqual(["macos-15", "ubuntu-22.04"]);
    expect(originalChecks.env).toMatchObject({ OPENCODE_CURSOR_REQUIRE_HOST: "1", CURSOR_NATIVE_REQUIRE_PI: "1" });
    expect(originalChecks.steps.some(value => value.run === "npm run check")).toBe(true);
    expect(originalChecks.steps.some(value => value.run === "npm run audit:source")).toBe(true);
  });

  it("audits attempted failed/cancelled publication after all same-run gates, even without publisher outputs", () => {
    const automatic = workflows.publish.jobs["verify-published"];
    expect(automatic.needs).toEqual(["source", "build", "aggregate", "verify-packed", "publish-npm"]);
    expect(automatic.if).toContain("always()");
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const completion of [undefined, "true", "false", ""]) for (const cancelled of [false, true]) {
        const needs = { ...publishContext().needs, "publish-npm": { result, outputs: completion === undefined ? {} : { completion } } };
        expect(condition(automatic.if, { needs }, cancelled)).toBe(result !== "skipped");
      }
    }
    for (const gate of ["source", "build", "aggregate", "verify-packed"]) for (const result of ["failure", "skipped", "cancelled", ""]) {
      const needs: Record<string, { result: string; outputs?: Record<string, string> }> = {
        ...publishContext().needs, "publish-npm": { result: "failure", outputs: {} },
      };
      needs[gate].result = result;
      expect(condition(automatic.if, { needs }, true)).toBe(false);
    }
    expect(automatic.permissions).toEqual({ contents: "read" });
    expect(automatic.environment).toBeUndefined();
    expect(publisher.if).not.toMatch(/always\(|cancelled\(/);
    expect(JSON.stringify(automatic)).not.toMatch(/id-token|github\.token|\bnpm publish\b|scripts\/publish-release\.mjs|continue-on-error/);
    expect(automatic.env?.RELEASE_VERSION).toBe("${{ inputs.version }}");
    expect(automatic.env?.EXPECTED_PRODUCERS).toBe("${{ needs['publish-npm'].outputs.producers }}");
    expect(JSON.stringify(automatic)).not.toMatch(/outputs\.(?:version|native_sha256|pi_sha256|opencode_sha256)/);
    const download = automatic.steps.find(value => value.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with).toEqual({ name: "release-preflight-bundle", path: "${{ runner.temp }}/bundle/" });
    const recover = step(automatic, "Recover expected hashes from the verified same-run bundle");
    const provision = step(automatic, "Install credential-free pinned verification CLI");
    expect(automatic.steps.indexOf(download!)).toBeLessThan(automatic.steps.indexOf(recover));
    expect(automatic.steps.indexOf(recover)).toBeLessThan(automatic.steps.indexOf(provision));
    expect(step(automatic, "verify").run).toContain('--sha256 "$EXPECTED_SHA256" --partial true');
    expect(step(automatic, "verify").run).toContain('--output "$RUNNER_TEMP/public-verification"');
  });

  it("exposes only the report completion and runs all seven host cases for every complete cohort", () => {
    const automatic = workflows.publish.jobs["verify-published"];
    expect(automatic.outputs).toEqual({ completion: "${{ steps.report.outputs.completion }}" });
    expect(step(automatic, "report").if).toBe("${{ always() }}");
    expect(automatic.env).toMatchObject({ OPENCODE_CURSOR_REQUIRE_HOST: "1", CURSOR_NATIVE_REQUIRE_PI: "1" });
    const hostSteps = automatic.steps.filter(value => value.run?.includes("npm ci") || value.run?.includes("npm run build:js") ||
      value.run?.includes("@opencode/cli@") || value.run?.includes("npm run test:packages"));
    expect(hostSteps).toHaveLength(4);
    expect(hostSteps.map(value => value.run)).toEqual([
      "npm ci --ignore-scripts --legacy-peer-deps",
      "npm run build:js && npm run build:types",
      "npm install --global --legacy-peer-deps @opencode/cli@2.2.5\nopencode --version\n",
      'npm run test:packages -- --archives "$RUNNER_TEMP/public-verification/archives"',
    ]);
    for (const completion of [undefined, "", "false", "true", "uncertain"]) {
      const context = { steps: { report: { outputs: completion === undefined ? {} : { completion } } } };
      for (const value of hostSteps) expect(condition(value.if, context)).toBe(completion === "true");
      const failed = step(automatic, "Fail incomplete or unverified public release cohorts");
      expect(condition(failed.if, context, true)).toBe(completion !== "true");
      expect(failed.run).toContain("exit 1");
    }
    expect(automatic.steps.at(-1)?.name).toBe("Fail incomplete or unverified public release cohorts");
  });

  it("keeps standalone recovery read-only/main-only with an optional explicit producer map", () => {
    const manual = workflows["verify-published"].jobs["registry-and-hosts"];
    const dispatch = workflows["verify-published"].on.workflow_dispatch as { inputs: Record<string, unknown> };
    expect(dispatch.inputs.producers).toMatchObject({ type: "string", required: false, default: "" });
    expect(manual.env?.EXPECTED_PRODUCERS).toBe("${{ inputs.producers }}");
    expect(condition(manual.if, { github: { repository, ref: "refs/heads/main" } })).toBe(true);
    expect(condition(manual.if, { github: { repository, ref: tagRef } })).toBe(false);
    expect(condition(manual.if, { github: { repository: "foreign/repo", ref: "refs/heads/main" } })).toBe(false);
    expect(manual.permissions).toEqual({ contents: "read" });
    expect(manual.env?.VERIFIER_COMMIT).toBe("${{ github.workflow_sha }}");
    expect(manual.steps.find(value => value.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe("${{ inputs.source_commit }}");
    expect(manual.steps.some(value => value.run?.includes('git show "$VERIFIER_COMMIT:scripts/verify-published.mjs"'))).toBe(true);
    for (const job of [workflows.publish.jobs["verify-published"], manual]) {
      expect(JSON.stringify(job)).not.toMatch(/process\.env\.GITHUB_\w+\s*=|GITHUB_RUN_(?:ID|ATTEMPT)=|localOnly:\s*true/);
    }
  });
});
function releaseAutomationSteps() {
  const steps = [workflows["auto-release"].jobs.prepare, publisher].flatMap(job => job.steps)
    .filter(value => value.env?.AUTOMATED_NPM_RELEASES !== undefined);
  for (const value of steps) expect(value.env?.AUTOMATED_NPM_RELEASES).toBe(automationVariable);
  return steps;
}

// Execute the actual YAML heredocs, not copies of their validation logic. Static
// imports are an explicit allowlist and are removed before entering a VM with no
// real process, module loader, filesystem, subprocess or network capabilities.
function inlineBody(value: Step, imports: string[]): string {
  assert.equal(typeof value.run, "string");
  const matches = [...value.run!.matchAll(/^node --input-type=module <<'NODE'\n([\s\S]*?)^NODE$/gm)];
  assert.equal(matches.length, 1);
  const body = matches[0][1];
  assert.deepEqual(body.match(/^import .+;$/gm), imports);
  return body.replace(/^import .+;\n/gm, "");
}
const sourceBody = inlineBody(sourceStep, [
  "import assert from 'node:assert/strict';",
  "import { execFileSync } from 'node:child_process';",
  "import { releaseSource, sourceIdentity } from './scripts/release.mjs';",
  "import { versionFiles } from './scripts/prepare-release.mjs';",
  "import { checkRustWorkspace } from './scripts/rust-env.mjs';",
]);
const rawClassifierBody = inlineBody(classifierStep, [
  "import assert from 'node:assert/strict';",
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync, readFileSync } from 'node:fs';",
]);
const dynamicImport = "await import('./scripts/prepare-release.mjs')";
assert.equal(rawClassifierBody.split(dynamicImport).length, 2);
const classifierBody = rawClassifierBody.replace(dynamicImport, "await importPrepareRelease('./scripts/prepare-release.mjs')");
for (const body of [sourceBody, classifierBody]) assert.doesNotMatch(body, /\bimport\s*(?:\(|["'{*])/);
async function executeInline(body: string, env: Record<string, string>, bindings: Record<string, unknown>) {
  await new Script(`"use strict"; (async () => {\n${body}\n})()`, { filename: "synthetic-workflow-inline.js" }).runInNewContext({
    assert, TextDecoder, ...bindings,
    process: Object.freeze({ env: Object.freeze({ ...env }), cwd: () => "/synthetic/source" }),
  }, { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } });
}
type GitReply = string | Uint8Array | Error | (() => string | Uint8Array);
function syntheticGit(entries: [string[], GitReply][], source = false) {
  const replies = new Map(entries.map(([args, reply]) => [JSON.stringify(args), reply]));
  const unexpected: unknown[] = [];
  const execute = vi.fn((binary: string, args: string[], options: Record<string, unknown>) => {
    const command = source ? args.slice(1) : args;
    try {
      assert.equal(binary, "git");
      if (source) assert.equal(args[0], "--no-replace-objects");
      assert.deepEqual(Object.fromEntries(Object.entries(options)), source
        ? { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 } : { maxBuffer: 16 * 1024 * 1024 });
      assert(replies.has(JSON.stringify(command)), "Unexpected synthetic Git command: " + JSON.stringify(args));
    } catch (error) { unexpected.push(error); throw error; }
    const reply = replies.get(JSON.stringify(command))!;
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply;
  });
  return { execute, unexpected, reply: (args: string[], value: GitReply) => replies.set(JSON.stringify(args), value) };
}
// Injected allowlist: the workflow must compare the complete set, not merely
// accept changes under a directory. No preparation/source modules are imported.
const versionFiles = Object.freeze([
  "package.json", "packages/native/package.json", "packages/pi/package.json", "packages/opencode/package.json",
  "package-lock.json", "Cargo.toml", "crates/cursor-node/Cargo.toml", "Cargo.lock",
  "licenses/locked-target-dependencies.json", "CHANGELOG.md",
]);
function sourceFixture(main = false) {
  const ref = main ? "refs/heads/main" : tagRef;
  const env: Record<string, string> = {
    RELEASE_VERSION: version, PUBLISH_NPM: main ? "false" : "true", AUTOMATED_NPM_RELEASES: main ? "false" : "true",
    GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: commit,
    WORKFLOW_COMMIT: commit, GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/publish.yml@${ref}`,
  };
  const state = {
    head: commit, sourceVersion: version, rustVersion: version, sourceCommit: commit, tagCommit: commit, tagObject,
    tag: `object ${commit}\ntype commit\ntag v${version}\ntagger Synthetic Coordinator <fixture@example.invalid> 1 +0000\n\n` +
      `cursor-harness-provider automated release\n\nRelease-Version: ${version}\nRelease-Source: ${parent}\n` +
      "Release-Publish-Npm: true\nRelease-Run: 123\nRelease-Attempt: 2\nRelease-Nonce: 00000000-0000-4000-8000-000000000001\n",
    parents: `${commit} ${parent}\n`,
    message: `chore(release): prepare v${version}\n\nKeep all distributable package and native source versions coordinated.\n\nRelease-Source: ${parent}\n`,
    changed: [...versionFiles].reverse().join("\0") + "\0",
  };
  const git = syntheticGit([
    [["rev-parse", "--verify", "HEAD"], () => state.head + "\n"],
    [["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], ""],
    [["rev-parse", "--verify", tagRef + "^{tag}"], () => state.tagObject + "\n"],
    [["rev-parse", "--verify", tagRef + "^{commit}"], () => state.tagCommit + "\n"],
    [["cat-file", "-p", tagObject], () => state.tag],
    [["rev-list", "--parents", "-n", "1", "HEAD"], () => state.parents],
    [["show", "-s", "--format=%B", "HEAD"], () => state.message],
    [["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", parent, "HEAD", "--"], () => state.changed],
  ], true);
  const releaseSource = vi.fn((_root: string) => ({ version: state.sourceVersion }));
  const checkRustWorkspace = vi.fn(() => ({ version: state.rustVersion }));
  const sourceIdentity = vi.fn((_root: string) => ({ commit: state.sourceCommit }));
  const log = vi.fn();
  const run = () => executeInline(sourceBody, env, { execFileSync: git.execute, releaseSource, sourceIdentity, checkRustWorkspace, versionFiles, console: { log } });
  return { env, state, git, releaseSource, checkRustWorkspace, sourceIdentity, log, run };
}
type SourceFixture = ReturnType<typeof sourceFixture>;
const sourceFailures: [string, (f: SourceFixture) => void][] = [
  ["foreign repository", f => { f.env.GITHUB_REPOSITORY = "foreign/repo"; }],
  ["push rather than dispatch", f => { f.env.GITHUB_EVENT_NAME = "push"; }],
  ["malformed SHA", f => { f.env.GITHUB_SHA = "not-a-sha"; }],
  ["wrong SHA", f => { f.env.GITHUB_SHA = otherCommit; }],
  ["workflow_sha outside main ancestry", f => {
    f.env.WORKFLOW_COMMIT = otherCommit;
    f.git.reply(["merge-base", "--is-ancestor", otherCommit, commit], Error("Synthetic non-ancestor workflow commit"));
  }],
  ["workflow_sha with a differing workflow file", f => {
    f.env.WORKFLOW_COMMIT = otherCommit;
    f.git.reply(["merge-base", "--is-ancestor", otherCommit, commit], "");
    f.git.reply(["diff", "--quiet", otherCommit, commit, "--", ".github/workflows/publish.yml"], Error("Synthetic workflow file differs"));
  }],
  ["different workflow file", f => { f.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/other.yml@${tagRef}`; }],
  ["workflow loaded from main instead of tag", f => { f.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/publish.yml@refs/heads/main`; }],
  ["wrong checked-out HEAD", f => { f.state.head = otherCommit; }],
  ["source package version mismatch", f => { f.state.sourceVersion = "0.3.2"; }],
  ["Rust workspace version mismatch", f => { f.state.rustVersion = "0.3.2"; }],
  ["source identity mismatch", f => { f.state.sourceCommit = otherCommit; }],
  ["non-main branch", f => { f.env.GITHUB_REF = "refs/heads/feature"; f.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/publish.yml@${f.env.GITHUB_REF}`; }],
  ["wrong version tag", f => { f.env.GITHUB_REF = "refs/tags/v0.3.2"; f.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/publish.yml@${f.env.GITHUB_REF}`; }],
  ["main publication", f => { f.env.GITHUB_REF = "refs/heads/main"; f.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/publish.yml@refs/heads/main`; }],
  ["not in main ancestry", f => { f.git.reply(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"], Error("Synthetic non-ancestor")); }],
  ["lightweight rather than annotated tag", f => { f.git.reply(["rev-parse", "--verify", tagRef + "^{tag}"], Error("Synthetic missing tag object")); }],
  ["malformed tag object ID", f => { f.state.tagObject = "invalid"; }],
  ["tag points to another commit", f => { f.state.tagCommit = otherCommit; }],
  ["tag header object mismatch", f => { f.state.tag = f.state.tag.replace("object " + commit, "object " + otherCommit); }],
  ["tag header type mismatch", f => { f.state.tag = f.state.tag.replace("type commit", "type tree"); }],
  ["tag header version mismatch", f => { f.state.tag = f.state.tag.replace("tag v" + version, "tag v0.3.2"); }],
  ["ambiguous extra tag header", f => { f.state.tag = f.state.tag.replace("\n\n", "\nextra header\n\n"); }],
  ["missing coordinator annotation", f => { f.state.tag = f.state.tag.split("\n\n")[0] + "\n\nordinary tag\n"; }],
  ["annotation version mismatch", f => { f.state.tag = f.state.tag.replace("Release-Version: " + version, "Release-Version: 0.3.2"); }],
  ["preview annotation cannot authorize publication", f => { f.state.tag = f.state.tag.replace("Release-Publish-Npm: true", "Release-Publish-Npm: false"); }],
  ["ambiguous annotation trailer", f => { f.state.tag += "Release-Version: " + version + "\n"; }],
  ["invalid coordinator run", f => { f.state.tag = f.state.tag.replace("Release-Run: 123", "Release-Run: 0"); }],
  ["invalid coordinator nonce", f => { f.state.tag = f.state.tag.replace("Release-Nonce: 00000000-0000-4000-8000-000000000001", "Release-Nonce: invalid"); }],
  ["different annotated parent", f => { f.state.tag = f.state.tag.replace("Release-Source: " + parent, "Release-Source: " + otherCommit); }],
  ["wrong single parent", f => { f.state.parents = `${commit} ${otherCommit}\n`; }],
  ["merge commit with an extra parent", f => { f.state.parents = `${commit} ${parent} ${otherCommit}\n`; }],
  ["wrong coordinator commit message", f => { f.state.message = "chore: unrelated commit\n"; }],
  ["extra distributable path", f => { f.state.changed += "packages/pi/src/extension.ts\0"; }],
  ["missing version path", f => { f.state.changed = versionFiles.slice(1).join("\0") + "\0"; }],
  ["duplicate version path", f => { f.state.changed += versionFiles[0] + "\0"; }],
  ["unterminated changed-path list", f => { f.state.changed = f.state.changed.slice(0, -1); }],
];

describe("publish.yml inline source gate (synthetic boundaries only)", () => {
  it("accepts a read-only main migration run even with automation disabled", async () => {
    const f = sourceFixture(true); await f.run();
    expect(f.git.unexpected).toEqual([]);
    expect(f.git.execute).toHaveBeenCalledTimes(2);
    expect(f.releaseSource).toHaveBeenCalledWith("/synthetic/source");
    expect(f.sourceIdentity).toHaveBeenCalledWith("/synthetic/source");
    expect(f.checkRustWorkspace).toHaveBeenCalledOnce();
    expect(f.log).toHaveBeenCalledWith("Validated source/version/ref and main ancestry: " + commit);
  });
  it("accepts an annotated coordinator tag with exactly the complete version-file changes", async () => {
    const f = sourceFixture(); await f.run();
    expect(f.git.unexpected).toEqual([]);
    expect(f.git.execute).toHaveBeenCalledTimes(8);
    expect(f.log).toHaveBeenCalledOnce();
  });
  it("allows tagged read-only previews without enabling automatic publication", async () => {
    const f = sourceFixture(); f.env.PUBLISH_NPM = "false"; f.env.AUTOMATED_NPM_RELEASES = "false";
    f.state.tag = f.state.tag.replace("Release-Publish-Npm: true", "Release-Publish-Npm: false");
    await f.run(); expect(f.git.unexpected).toEqual([]); expect(f.log).toHaveBeenCalledOnce();
  });
  it("accepts a workflow_sha naming an ancestor with the same workflow file", async () => {
    const f = sourceFixture();
    f.env.WORKFLOW_COMMIT = otherCommit;
    f.git.reply(["merge-base", "--is-ancestor", otherCommit, commit], "");
    f.git.reply(["diff", "--quiet", otherCommit, commit, "--", ".github/workflows/publish.yml"], "");
    await f.run();
    expect(f.git.unexpected).toEqual([]);
    expect(f.git.execute).toHaveBeenCalledTimes(10);
    expect(f.log).toHaveBeenCalledOnce();
  });
  it.each(sourceFailures)("rejects %s", async (_name, change) => {
    const f = sourceFixture(); change(f);
    await expect(f.run()).rejects.toThrow();
    expect(f.git.unexpected).toEqual([]);
    expect(f.log).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "false", "TRUE", "1"])("rejects publication with AUTOMATED_NPM_RELEASES=%s before any boundary call", async value => {
    const f = sourceFixture();
    if (value === undefined) delete f.env.AUTOMATED_NPM_RELEASES; else f.env.AUTOMATED_NPM_RELEASES = value;
    await expect(f.run()).rejects.toThrow("Automatic publication is disabled");
    expect(f.git.execute).not.toHaveBeenCalled(); expect(f.releaseSource).not.toHaveBeenCalled();
    expect(f.checkRustWorkspace).not.toHaveBeenCalled(); expect(f.sourceIdentity).not.toHaveBeenCalled();
  });
  it.each(["0.03.1", "0.3.1-beta.1", "v0.3.1", "9007199254740992.3.1", ""])("rejects invalid/unsafe version %s", async value => {
    const f = sourceFixture(); f.env.RELEASE_VERSION = value;
    await expect(f.run()).rejects.toThrow(); expect(f.git.execute).not.toHaveBeenCalled();
  });
  it.each(["", "TRUE", "1"])("rejects non-boolean publication flag %s", async value => {
    const f = sourceFixture(); f.env.PUBLISH_NPM = value;
    await expect(f.run()).rejects.toThrow(); expect(f.git.execute).not.toHaveBeenCalled();
  });
});

const eventPath = "/synthetic/event.json", outputPath = "/synthetic/output";
const diffCommand = ["diff", "--name-only", "--no-renames", "-z", parent, commit, "--"];
function classifierFixture() {
  const env: Record<string, string> = {
    GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_SHA: commit,
    AUTOMATED_NPM_RELEASES: "true", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
  };
  const event: Record<string, unknown> = { before: parent, after: commit, created: false, deleted: false, forced: false };
  const state: { head: string; diff: Uint8Array; rawEvent?: string; readError?: Error; importError?: Error } = {
    head: commit, diff: Buffer.from("packages/pi/src/extension.ts\0"),
  };
  const git = syntheticGit([
    [["rev-parse", "HEAD"], () => Buffer.from(state.head + "\n")],
    [["merge-base", "--is-ancestor", parent, commit], Buffer.alloc(0)],
    [diffCommand, () => state.diff],
  ]);
  const isDistributablePath = vi.fn((path: string) => path.startsWith("packages/") || path.startsWith("crates/") || path === "scripts/build.mjs");
  const importPrepareRelease = vi.fn(async (_specifier: string) => {
    if (state.importError) throw state.importError;
    return { isDistributablePath };
  });
  const read = vi.fn((_path: string, _encoding: string) => {
    if (state.readError) throw state.readError;
    return state.rawEvent ?? JSON.stringify(event);
  });
  const append = vi.fn((_path: string, _text: string) => {}), log = vi.fn();
  const run = async () => {
    await executeInline(classifierBody, env, {
      execFileSync: git.execute, readFileSync: read, appendFileSync: append, importPrepareRelease, console: { log },
    });
    expect(git.unexpected).toEqual([]);
    for (const args of read.mock.calls) expect(args).toEqual([eventPath, "utf8"]);
    for (const args of importPrepareRelease.mock.calls) expect(args).toEqual(["./scripts/prepare-release.mjs"]);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0]).toBe(outputPath);
    expect(append.mock.calls[0][1]).toMatch(/^run_checks=(?:true|false)\n$/);
    const runChecks = append.mock.calls[0][1] === "run_checks=true\n";
    expect(checkCondition("success", String(runChecks))).toBe(runChecks);
    return runChecks;
  };
  return { env, event, state, git, isDistributablePath, importPrepareRelease, read, append, log, run };
}
type ClassifierFixture = ReturnType<typeof classifierFixture>;
const ambiguousClassifications: [string, (f: ClassifierFixture) => void][] = [
  ["malformed event JSON", f => { f.state.rawEvent = "{"; }],
  ["unreadable event", f => { f.state.readError = Error("Synthetic event read failure"); }],
  ["null event", f => { f.state.rawEvent = "null"; }],
  ["zero before SHA", f => { f.event.before = "0".repeat(40); }],
  ["zero after SHA", f => { f.event.after = "0".repeat(40); }],
  ["missing before SHA", f => { delete f.event.before; }],
  ["non-string SHA", f => { f.event.before = 123; }],
  ["malformed before SHA", f => { f.event.before = "not-a-sha"; }],
  ["uppercase SHA", f => { f.event.before = "B".repeat(40); }],
  ["event/SHA mismatch", f => { f.event.after = otherCommit; }],
  ["branch creation", f => { f.event.created = true; }],
  ["branch deletion", f => { f.event.deleted = true; }],
  ["forced update", f => { f.event.forced = true; }],
  ["missing creation flag", f => { delete f.event.created; }],
  ["missing deletion flag", f => { delete f.event.deleted; }],
  ["missing force flag", f => { delete f.event.forced; }],
  ["string rather than boolean flag", f => { f.event.forced = "false"; }],
  ["HEAD mismatch", f => { f.state.head = otherCommit; }],
  ["HEAD lookup failure", f => { f.git.reply(["rev-parse", "HEAD"], Error("Synthetic HEAD failure")); }],
  ["non-ancestor before commit", f => { f.git.reply(["merge-base", "--is-ancestor", parent, commit], Error("Synthetic non-ancestor")); }],
  ["diff failure", f => { f.git.reply(diffCommand, Error("Synthetic diff failure")); }],
  ["invalid UTF-8 diff", f => { f.state.diff = new Uint8Array([0xc3, 0x28, 0]); }],
  ["missing NUL terminator", f => { f.state.diff = Buffer.from("packages/pi/src/extension.ts"); }],
  ["empty changed path", f => { f.state.diff = Buffer.from("packages/pi/src/extension.ts\0\0"); }],
  ["empty-only changed path", f => { f.state.diff = Buffer.from("\0"); }],
  ["classifier import failure", f => { f.state.importError = Error("Synthetic import failure"); }],
  ["path predicate failure", f => { f.isDistributablePath.mockImplementation(() => { throw Error("Synthetic classification failure"); }); }],
];

describe("check.yml inline push classifier (offline event/diff/import fixtures)", () => {
  it.each([
    ["package change", ["packages/pi/src/extension.ts"]],
    ["Rust change", ["crates/cursor-core/src/lib.rs"]],
    ["mixed documentation and distribution changes", ["README.md", "scripts/build.mjs"]],
    ["NUL-delimited filenames with whitespace/unicode", ["docs/notes.md", "packages/pi/src/a\n空 格.ts"]],
  ] as const)("delegates an unambiguous enabled main push: %s", async (_name, paths) => {
    const f = classifierFixture(); f.state.diff = Buffer.from(paths.join("\0") + "\0");
    expect(await f.run()).toBe(false);
    expect(f.git.execute.mock.calls.map(([, args]) => args)).toEqual([
      ["rev-parse", "HEAD"], ["merge-base", "--is-ancestor", parent, commit], diffCommand,
    ]);
    expect(f.importPrepareRelease).toHaveBeenCalledOnce();
    expect(f.isDistributablePath.mock.calls.map(([path]) => path)).toEqual(paths);
    expect(f.log).not.toHaveBeenCalledWith("Push classification uncertain; retaining the original full checks.");
  });
  it.each([["documentation only", ["README.md", "docs/releases.md"]], ["empty diff", []]] as const)("retains full checks for %s", async (_name, paths) => {
    const f = classifierFixture(); f.state.diff = Buffer.from(paths.length ? paths.join("\0") + "\0" : "");
    expect(await f.run()).toBe(true);
    expect(f.isDistributablePath.mock.calls.map(([path]) => path)).toEqual(paths);
    expect(f.log).toHaveBeenCalledWith("Run original checks.");
  });
  it("uses the injected path predicate rather than an embedded path heuristic", async () => {
    const f = classifierFixture(); f.isDistributablePath.mockReturnValue(false);
    expect(await f.run()).toBe(true);
    expect(f.isDistributablePath).toHaveBeenCalledWith("packages/pi/src/extension.ts", 0, ["packages/pi/src/extension.ts"]);
  });
  it.each([
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_REF: tagRef }, { GITHUB_REPOSITORY: "foreign/repo" },
    { AUTOMATED_NPM_RELEASES: "" }, { AUTOMATED_NPM_RELEASES: "false" }, { AUTOMATED_NPM_RELEASES: "TRUE" }, { AUTOMATED_NPM_RELEASES: "1" },
  ])("retains checks without reading/importing/executing anything for an ineligible context: %j", async patch => {
    const f = classifierFixture(); Object.assign(f.env, patch);
    expect(await f.run()).toBe(true);
    expect(f.read).not.toHaveBeenCalled(); expect(f.git.execute).not.toHaveBeenCalled();
    expect(f.importPrepareRelease).not.toHaveBeenCalled(); expect(f.isDistributablePath).not.toHaveBeenCalled();
  });
  it("treats an unset automation variable as disabled", async () => {
    const f = classifierFixture(); delete f.env.AUTOMATED_NPM_RELEASES;
    expect(await f.run()).toBe(true); expect(f.read).not.toHaveBeenCalled(); expect(f.git.execute).not.toHaveBeenCalled();
  });
  it.each(ambiguousClassifications)("retains the original checks on %s", async (_name, change) => {
    const f = classifierFixture(); change(f);
    expect(await f.run()).toBe(true);
    expect(f.log).toHaveBeenCalledWith("Push classification uncertain; retaining the original full checks.");
    expect(f.log).toHaveBeenCalledWith("Run original checks.");
  });
});

const automaticVerification = workflows.publish.jobs["verify-published"];
const bundleBody = inlineBody(step(automaticVerification, "Recover expected hashes from the verified same-run bundle"), [
  "import assert from 'node:assert/strict';",
  "import { appendFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { verifyBundle } from './scripts/release.mjs';",
]);
const reportBody = inlineBody(step(automaticVerification, "report"), [
  "import assert from 'node:assert/strict';",
  "import { appendFileSync, readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
]);
const standaloneStep = step(workflows["verify-published"].jobs["registry-and-hosts"], "Verify public metadata, bytes, signatures and attestations");
const rawStandaloneBody = inlineBody(standaloneStep, [
  "import assert from 'node:assert/strict';",
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { pathToFileURL } from 'node:url';",
]);
const standaloneImport = "await import(pathToFileURL(join(env.RUNNER_TEMP, 'verify-published.mjs')).href)";
assert.equal(rawStandaloneBody.split(standaloneImport).length, 2);
const standaloneBody = rawStandaloneBody.replace(standaloneImport, "await importCurrentVerifier(pathToFileURL(join(env.RUNNER_TEMP, 'verify-published.mjs')).href)");
for (const body of [bundleBody, reportBody, standaloneBody]) assert.doesNotMatch(body, /\bimport\s*(?:\(|["'{*])/);
const runnerTemp = "/synthetic/runner-temp", environmentPath = "/synthetic/environment", summaryPath = "/synthetic/summary";
const kinds = ["native", "pi", "opencode"];
const expectedHashes = { native: "e".repeat(64), pi: "f".repeat(64), opencode: "0".repeat(64) };
function verificationEnv(): Record<string, string> {
  return { RUNNER_TEMP: runnerTemp, GITHUB_ENV: environmentPath, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath,
    RELEASE_VERSION: version, GITHUB_SHA: commit, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" };
}
function bundleFixture() {
  const env = verificationEnv();
  const bundle = { version, identity: { commit, runId: "123", runAttempt: "2", localOnly: false },
    packages: Object.entries(expectedHashes).map(([kind, sha256]) => ({ kind, sha256 })) };
  const verifyBundle = vi.fn((_options: Record<string, unknown>) => bundle);
  const append = vi.fn((_path: string, _text: string) => {});
  const run = () => executeInline(bundleBody, env, { verifyBundle, appendFileSync: append, join });
  return { env, bundle, verifyBundle, append, run };
}
describe("automatic post-publication audit inline boundaries (offline fixtures)", () => {
  it("recovers all hashes from verifyBundle without any publisher outputs or spoofed run environment", async () => {
    const f = bundleFixture(); await f.run();
    expect(f.verifyBundle).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/synthetic/source", bundleDirectory: join(runnerTemp, "bundle"), localOnly: false });
    expect(f.append).toHaveBeenCalledExactlyOnceWith(environmentPath, "EXPECTED_SHA256=" + JSON.stringify(expectedHashes) + "\n");
    expect(f.env).not.toHaveProperty("NATIVE_SHA256");
    expect(f.env).not.toHaveProperty("EXPECTED_PRODUCERS");
  });
  it.each([
    ["version", (f: ReturnType<typeof bundleFixture>) => { f.bundle.version = "0.3.2"; }],
    ["source", (f: ReturnType<typeof bundleFixture>) => { f.bundle.identity.commit = otherCommit; }],
    ["run", (f: ReturnType<typeof bundleFixture>) => { f.bundle.identity.runId = "124"; }],
    ["attempt", (f: ReturnType<typeof bundleFixture>) => { f.env.GITHUB_RUN_ATTEMPT = "3"; }],
    ["local evidence", (f: ReturnType<typeof bundleFixture>) => { f.bundle.identity.localOnly = true; }],
    ["missing hash", (f: ReturnType<typeof bundleFixture>) => { f.bundle.packages.pop(); }],
    ["duplicate kind", (f: ReturnType<typeof bundleFixture>) => { f.bundle.packages[1].kind = "native"; }],
    ["injected hash", (f: ReturnType<typeof bundleFixture>) => { f.bundle.packages[0].sha256 += "\nUNSAFE=true"; }],
    ["failed bundle verification", (f: ReturnType<typeof bundleFixture>) => { f.verifyBundle.mockImplementation(() => { throw Error("Rejected bundle/locks/attempt"); }); }],
  ] as const)("does not export hashes after mismatched %s", async (_label, change) => {
    const f = bundleFixture(); change(f);
    await expect(f.run()).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });
  it.each(["", JSON.stringify(Object.fromEntries(kinds.map(kind => [kind, { runId: "123", runAttempt: "2" }]))), "$(blocked)\nnot-evaluated"])(
    "passes optional producers as one literal shell argument only when nonempty: %j", producers => {
      const verify = step(automaticVerification, "verify");
      expect(verify.shell).toBe("bash");
      // Capture the actual shell argv. node is a shell function and PATH has no
      // executable commands, so no npm, filesystem writes or network can run.
      const stdout = execFileSync("/bin/bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c",
        "node() { printf '%s\\0' \"$@\"; }\n" + verify.run!], {
        env: { PATH: "/unavailable", ...verificationEnv(), EXPECTED_SHA256: JSON.stringify(expectedHashes), EXPECTED_PRODUCERS: producers },
        encoding: "utf8", timeout: 5000,
      });
      expect(stdout.split("\0")).toEqual([
        "scripts/verify-published.mjs", "--version", version, "--source", commit, "--sha256", JSON.stringify(expectedHashes), "--partial", "true",
        "--npm-cli", join(runnerTemp, "verify-cli/node_modules/npm/bin/npm-cli.js"), "--output", join(runnerTemp, "public-verification"),
        ...(producers ? ["--producers", producers] : []), "",
      ]);
    });
});
function reportFixture() {
  const env = verificationEnv();
  const state: { report: { complete: unknown; version: string; source: string; packages: { kind: string }[]; missing: { kind: string }[]; unsafe: string }; error?: Error; raw?: string } = {
    report: { complete: true, version, source: commit, packages: kinds.map(kind => ({ kind })), missing: [], unsafe: "```\n[unsafe](https://invalid.example/)\n::error::injected" },
  };
  const read = vi.fn((_path: string, _encoding: string) => {
    if (state.error) throw state.error;
    return state.raw ?? JSON.stringify(state.report);
  });
  const append = vi.fn((_path: string, _text: string) => {});
  const run = () => executeInline(reportBody, env, { readFileSync: read, appendFileSync: append, join });
  return { env, state, read, append, run };
}
describe("post-publication report completion and sanitized summary", () => {
  it.each([3, 1, 0])("reports only the verified subset, complete only for all three (%i present)", async count => {
    const f = reportFixture();
    f.state.report.complete = count === 3;
    f.state.report.packages = kinds.slice(0, count).map(kind => ({ kind }));
    f.state.report.missing = kinds.slice(count).map(kind => ({ kind }));
    await f.run();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(join(runnerTemp, "public-verification/verification.json"), "utf8");
    expect(f.append).toHaveBeenCalledWith(outputPath, `completion=${count === 3}\n`);
    const summary = f.append.mock.calls.find(([path]) => path === summaryPath)![1];
    expect(summary).toContain(JSON.stringify({ complete: count === 3, verified: kinds.slice(0, count), missing: kinds.slice(count) }, null, 2));
    expect(summary).not.toContain("unsafe");
    expect(summary).not.toContain("::error::");
  });
  it("fails closed with a static unknown-status summary when no report was produced", async () => {
    const f = reportFixture(); f.state.error = Object.assign(Error("Missing report"), { code: "ENOENT" });
    await f.run();
    expect(f.append).toHaveBeenCalledWith(outputPath, "completion=false\n");
    expect(f.append).toHaveBeenCalledWith(summaryPath, expect.stringContaining("public registry status is unknown"));
  });
  it.each([
    ["string completion", (f: ReturnType<typeof reportFixture>) => { f.state.report.complete = "true"; }],
    ["source mismatch", (f: ReturnType<typeof reportFixture>) => { f.state.report.source = otherCommit; }],
    ["version mismatch", (f: ReturnType<typeof reportFixture>) => { f.state.report.version = "0.3.2"; }],
    ["missing cohort marked complete", (f: ReturnType<typeof reportFixture>) => { f.state.report.packages.pop(); f.state.report.missing.push({ kind: "opencode" }); }],
    ["duplicate package", (f: ReturnType<typeof reportFixture>) => { f.state.report.packages[0].kind = "pi"; }],
    ["injected package kind", (f: ReturnType<typeof reportFixture>) => { f.state.report.packages[0].kind = "native\n::error::injected"; }],
    ["unreadable report", (f: ReturnType<typeof reportFixture>) => { f.state.error = Object.assign(Error("Unreadable"), { code: "EACCES" }); }],
    ["malformed report", (f: ReturnType<typeof reportFixture>) => { f.state.raw = "{"; }],
  ] as const)("cannot expose successful completion from %s", async (_label, change) => {
    const f = reportFixture(); change(f);
    await expect(f.run()).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });
});
function standaloneFixture() {
  const env = { ...verificationEnv(), SOURCE_COMMIT: commit, EXPECTED_SHA256: JSON.stringify(expectedHashes), EXPECTED_PRODUCERS: "" } as Record<string, string>;
  const report = { source: commit };
  const verify = vi.fn(async (_options: Record<string, unknown>) => report);
  const importer = vi.fn(async (_url: string) => ({ verifyPublished: verify }));
  const git = vi.fn((_binary: string, _args: string[], _options: Record<string, unknown>) => env.SOURCE_COMMIT + "\n");
  const append = vi.fn((_path: string, _text: string) => {}), log = vi.fn();
  const run = () => executeInline(standaloneBody, env, { execFileSync: git, appendFileSync: append, join, pathToFileURL,
    importCurrentVerifier: importer, console: { log } });
  return { env, verify, importer, git, append, run };
}
describe("standalone current verifier options (offline import boundary)", () => {
  it.each([undefined, "", JSON.stringify(Object.fromEntries(kinds.map(kind => [kind, { runId: "123", runAttempt: "2" }])))])(
    "adds producers only when explicitly nonempty: %j", async producers => {
      const f = standaloneFixture();
      if (producers === undefined) delete f.env.EXPECTED_PRODUCERS; else f.env.EXPECTED_PRODUCERS = producers;
      await f.run();
      expect(f.git).toHaveBeenCalledExactlyOnceWith("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
      expect(f.importer).toHaveBeenCalledExactlyOnceWith(pathToFileURL(join(runnerTemp, "verify-published.mjs")).href);
      expect(f.verify).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/synthetic/source", version, source: commit,
        expectedSha256: JSON.stringify(expectedHashes), npmCli: join(runnerTemp, "verify-cli/node_modules/npm/bin/npm-cli.js"),
        outputDirectory: join(runnerTemp, "published-verification"), ...(producers ? { producers } : {}),
      });
    });
  it("retains only the exact historical 0.3.0/main provenance exception", async () => {
    for (const [release, source, exception] of [
      ["0.3.0", "fb6089e011b40f89c65bf66a4afcb43791040919", true],
      ["0.3.0", commit, false], [version, "fb6089e011b40f89c65bf66a4afcb43791040919", false],
    ] as const) {
      const f = standaloneFixture(); f.env.RELEASE_VERSION = release; f.env.SOURCE_COMMIT = source;
      await f.run();
      const options = f.verify.mock.calls[0][0];
      if (exception) expect(options.expectedSourceRef).toBe("refs/heads/main");
      else expect(options).not.toHaveProperty("expectedSourceRef");
    }
  });
});
