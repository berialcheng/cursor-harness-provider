import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
// @ts-expect-error Build tooling is intentionally JavaScript.
import { bootstrapPackages } from "../scripts/bootstrap-npm.mjs";

const temporary: string[] = [];
const syntheticToken = "synthetic-bootstrap-token-not-a-credential";
const kinds = ["native", "pi", "opencode"];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-bootstrap-test-"));
  temporary.push(root);
  writeFileSync(join(root, "LICENSE"), "MIT License\n");
  const env: Record<string, string> = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "berialcheng/cursor-harness-provider",
    GITHUB_WORKFLOW_REF: "berialcheng/cursor-harness-provider/.github/workflows/npm-bootstrap.yml@refs/heads/main",
    BOOTSTRAP_NPM: "create-three-public-package-placeholders",
    NODE_AUTH_TOKEN: syntheticToken,
    RUNNER_TEMP: root,
  };
  const options = { npmCli: join(root, "npm-cli.js"), directory: join(root, "work"), projectRoot: root, env };
  const execute = vi.fn((_binary: string, args: string[], _options: { env: Record<string, string>; cwd: string }): string => {
    if (args[1] === "--version") return "11.21.0";
    if (args[1] === "whoami") return "berialcheng";
    if (args[1] === "view") throw Object.assign(Error("absent"), { stdout: JSON.stringify({ error: { code: "E404" } }) });
    if (args[1] === "stage" && args[2] === "publish") return "synthetic staged";
    throw Error("Unexpected subprocess command");
  });
  return { root, env, options, execute };
}

describe("one-time stage-only token bootstrap", () => {
  it("exposes the Secret only to the protected metadata staging step", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const text = readFileSync(join(root, ".github/workflows/npm-bootstrap.yml"), "utf8");
    const workflow = YAML.parse(text);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.confirmation.required).toBe(true);
    expect(workflow.env).toBeUndefined();
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    const job = workflow.jobs.bootstrap;
    expect(job.environment).toBe("npm-release");
    expect(job.permissions).toBeUndefined();
    expect(job.env).toBeUndefined();
    expect(job.if).toContain("refs/heads/main");
    expect(job.if).toContain("create-three-public-package-placeholders");
    const authenticated = job.steps.filter((step: { env?: Record<string, string> }) => step.env?.NODE_AUTH_TOKEN !== undefined);
    expect(authenticated).toHaveLength(1);
    expect(authenticated[0].env.NODE_AUTH_TOKEN).toBe("${{ secrets.NPM_BOOTSTRAP_TOKEN }}");
    expect(authenticated[0].run).toContain('if [ -z "$NODE_AUTH_TOKEN" ]');
    expect(authenticated[0].run).toContain("node scripts/bootstrap-npm.mjs");
    expect((JSON.stringify(workflow).match(/secrets\.NPM_BOOTSTRAP_TOKEN/g) || [])).toHaveLength(1);
    expect(JSON.stringify(workflow)).not.toMatch(/id-token|\blogin\b|\blogout\b|upload-artifact/);
    const cleanup = job.steps.find((step: { name?: string }) => step.name?.startsWith("Remove only bootstrap files"));
    expect(cleanup.if).toContain("always()");
    expect(cleanup.env).toBeUndefined();
    expect(cleanup.run).toContain('"$RUNNER_TEMP/npm-bootstrap-work"');
    expect(cleanup.run).toContain("does not revoke the npm token");
    for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    const release = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
    expect(release).not.toContain("NPM_BOOTSTRAP_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
  });

  it("creates only the three metadata candidates and retains them until the real release", () => {
    const f = fixture();
    const result = bootstrapPackages(f.options, f.execute);
    expect(result).toEqual(kinds.map(kind => ({
      name: "@cursor-harness-provider/" + kind,
      status: "placeholder-created-keep-bootstrap-pending-real-release",
    })));
    const calls = f.execute.mock.calls.filter(call => call[1][1] === "stage");
    expect(calls.map(call => call[1].slice(1, 4))).toEqual(kinds.map(kind => ["stage", "publish", join(f.options.directory, kind)]));
    for (const kind of kinds) {
      const base = join(f.options.directory, kind);
      const manifest = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
      expect(manifest.name).toBe("@cursor-harness-provider/" + kind);
      expect(manifest.version).toBe("0.0.0-bootstrap");
      expect(manifest.private).toBe(false);
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.publishConfig).toEqual({ registry: "https://registry.npmjs.org/", access: "public" });
      expect(readdirSync(base).sort()).toEqual(["LICENSE", "README.md", "package.json"]);
      expect(readFileSync(join(base, "LICENSE"), "utf8")).toBe("MIT License\n");
      expect(readFileSync(join(base, "README.md"), "utf8")).toContain("Keep it pending until the real 0.3.0 version is publicly published and verified");
    }
    for (const [, args] of f.execute.mock.calls) {
      expect(args).toContain("--fetch-retries");
      expect(args[args.indexOf("--fetch-retries") + 1]).toBe("0");
      expect(args[args.indexOf("--registry") + 1]).toBe("https://registry.npmjs.org/");
      expect(["publish", "approve", "reject", "unpublish", "login", "logout"]).not.toContain(args[1]);
    }
    for (const [, args] of calls) {
      expect(args).toContain("--ignore-scripts");
      expect(args).toContain("--provenance=false");
      expect(args[args.indexOf("--tag") + 1]).toBe("bootstrap");
    }
  });

  it("uses private literal npm configuration without persisting credentials or putting them in argv", () => {
    const f = fixture();
    const result = bootstrapPackages(f.options, f.execute);
    const user = join(f.options.directory, "user.npmrc"), global = join(f.options.directory, "global.npmrc");
    expect(readFileSync(user, "utf8")).toBe("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n");
    expect(readFileSync(global, "utf8")).toBe("");
    expect(statSync(user).mode & 0o777).toBe(0o600);
    expect(statSync(global).mode & 0o777).toBe(0o600);
    expect(statSync(f.options.directory).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
    for (const [binary, args, options] of f.execute.mock.calls) {
      expect(binary).toBe(process.execPath);
      expect(args.join(" ")).not.toContain(syntheticToken);
      expect(args[args.indexOf("--userconfig") + 1]).toBe(user);
      expect(args[args.indexOf("--globalconfig") + 1]).toBe(global);
      expect(options.env).toBe(f.env);
      expect(options.cwd).toBe(f.options.directory);
    }
  });

  it("loads the literal configuration with the actual provisioned CLI, offline and with synthetic credentials", () => {
    const f = fixture(), cli = process.env.npm_execpath;
    if (!cli) throw Error("Run tests through npm to select the existing CLI");
    let checked = false;
    const simulated = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((binary, args, options) => {
      if (args[1] === "--version") {
        const output = execFileSync(binary, [cli, ...args.slice(1)], {
          cwd: f.options.directory,
          encoding: "utf8",
          env: { HOME: f.root, PATH: dirname(process.execPath) + ":/usr/bin:/bin", NODE_AUTH_TOKEN: syntheticToken },
          timeout: 10000,
        });
        expect(output.trim()).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+$/);
        checked = true;
        // Only config loading is real here; owner and staging remain mocked.
        // This does not claim that the provisioned CLI is the pinned 11.21.0.
        return "11.21.0";
      }
      return simulated(binary, args, options);
    });
    bootstrapPackages(f.options, f.execute);
    expect(checked).toBe(true);
    expect(readFileSync(join(f.options.directory, "user.npmrc"), "utf8")).not.toContain(syntheticToken);
  });

  it("refuses missing token presence and all other token/config overrides before invoking npm", () => {
    const absent = fixture();
    delete absent.env.NODE_AUTH_TOKEN;
    expect(() => bootstrapPackages(absent.options, absent.execute)).toThrow(/token environment/);
    expect(absent.execute).not.toHaveBeenCalled();
    for (const change of [{ NPM_TOKEN: "" }, { node_auth_token: "synthetic" }, { npm_config_registry: "https://example.invalid/" }, { NPM_CONFIG_USERCONFIG: "/outside/npmrc" }]) {
      const f = fixture();
      Object.assign(f.env, change);
      expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/overrides/);
      expect(f.execute).not.toHaveBeenCalled();
      expect(existsSync(f.options.directory)).toBe(false);
    }
  });

  it("requires the exact manual main-branch workflow context", () => {
    for (const change of [
      { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_REF: "refs/heads/other" },
      { GITHUB_REPOSITORY: "other/repository" }, { GITHUB_WORKFLOW_REF: "other/workflow" }, { BOOTSTRAP_NPM: "" },
    ]) {
      const f = fixture();
      Object.assign(f.env, change);
      expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/dispatch/);
      expect(f.execute).not.toHaveBeenCalled();
    }
  });

  it("refuses another account without staging", () => {
    const f = fixture();
    f.execute.mockImplementation((_binary, args) => args[1] === "--version" ? "11.21.0" : "other-account");
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/owner/);
    expect(f.execute.mock.calls.some(call => call[1][1] === "stage")).toBe(false);
  });

  it("refuses the wrong CLI version before owner verification", () => {
    const f = fixture();
    f.execute.mockReturnValue("11.20.0");
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/Pinned npm CLI/);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("sanitizes owner authentication failures without exposing child output", () => {
    const f = fixture();
    f.execute.mockImplementation((_binary, args) => {
      if (args[1] === "--version") return "11.21.0";
      throw Object.assign(Error(syntheticToken), { stdout: syntheticToken, stderr: syntheticToken });
    });
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow("Bootstrap owner verification failed; no packages staged");
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps CLI and working paths inside runner temporary storage", () => {
    for (const field of ["npmCli", "directory"] as const) {
      const f = fixture();
      f.options[field] = "/outside/" + field;
      expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/temporary/);
      expect(f.execute).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.options.directory = f.root;
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/temporary/);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("refuses an existing working directory or symlink instead of reusing a supplied npmrc", () => {
    for (const symlink of [false, true]) {
      const f = fixture();
      if (symlink) symlinkSync(f.root, f.options.directory, "dir");
      else mkdirSync(f.options.directory);
      expect(() => bootstrapPackages(f.options, f.execute)).toThrow();
      expect(f.execute).not.toHaveBeenCalled();
      expect(existsSync(join(f.root, "user.npmrc"))).toBe(false);
    }
  });

  it("leaves existing package entries unchanged", () => {
    const f = fixture();
    const simulated = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((binary, args, options) => args[1] === "view" ? JSON.stringify(args[2]) : simulated(binary, args, options));
    expect(bootstrapPackages(f.options, f.execute)).toEqual(kinds.map(kind => ({ name: "@cursor-harness-provider/" + kind, status: "already-exists-not-modified" })));
    expect(f.execute.mock.calls.some(call => call[1][1] === "stage")).toBe(false);
  });

  it("requires an explicit E404 rather than treating an unknown lookup error as absence", () => {
    for (const error of [Error(syntheticToken), Object.assign(Error("unauthorized"), { stdout: JSON.stringify({ error: { code: "E401" } }) })]) {
      const f = fixture();
      const simulated = f.execute.getMockImplementation()!;
      f.execute.mockImplementation((binary, args, options) => {
        if (args[1] === "view") throw error;
        return simulated(binary, args, options);
      });
      expect(() => bootstrapPackages(f.options, f.execute)).toThrow("Unable to establish package absence; bootstrap stopped");
      expect(f.execute.mock.calls.some(call => call[1][1] === "stage")).toBe(false);
    }
  });

  it("refuses a wrong package identity from a successful lookup", () => {
    const f = fixture();
    const simulated = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((binary, args, options) => args[1] === "view" ? JSON.stringify("other-package") : simulated(binary, args, options));
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow(/absence/);
    expect(f.execute.mock.calls.some(call => call[1][1] === "stage")).toBe(false);
  });

  it("stops at an uncertain upload without retries or following packages", () => {
    const f = fixture();
    const simulated = f.execute.getMockImplementation()!;
    f.execute.mockImplementation((binary, args, options) => {
      if (args[1] === "stage") throw Object.assign(Error(syntheticToken), { stdout: syntheticToken, stderr: syntheticToken });
      return simulated(binary, args, options);
    });
    expect(() => bootstrapPackages(f.options, f.execute)).toThrow("Bootstrap upload outcome uncertain; inspect npm before retrying. No further packages attempted");
    expect(f.execute.mock.calls.filter(call => call[1][1] === "stage")).toHaveLength(1);
    expect(f.execute.mock.calls.filter(call => call[1][1] === "view")).toHaveLength(1);
    expect(existsSync(join(f.options.directory, "pi"))).toBe(false);
  });
});
