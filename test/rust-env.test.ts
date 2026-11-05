import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error Development tooling is intentionally JavaScript.
import { findExistingRustTool } from "../scripts/rust-env.mjs";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-rust-tool-path-")); temporary.push(root);
  const home = join(root, "configured-bin"), path = join(root, "image-bin");
  mkdirSync(home); mkdirSync(path);
  const executable = (directory: string, name: string) => {
    const file = join(directory, name); writeFileSync(file, "#!/bin/sh\nexit 99\n"); chmodSync(file, 0o755); return file;
  };
  return { home, path, executable };
}
describe("existing Rust tool selection", () => {
  it("uses the configured cargo home before other PATH entries", () => {
    const f = fixture(), preferred = f.executable(f.home, "cargo"); f.executable(f.path, "cargo");
    expect(findExistingRustTool("cargo", f.home, f.path)).toBe(preferred);
  });
  it("accepts runner-provisioned tools outside the home directory", () => {
    const f = fixture(), candidate = f.executable(f.path, "cargo");
    expect(findExistingRustTool("cargo", f.home, f.path)).toBe(candidate);
  });
  it("ignores relative paths, directories and non-executable files", () => {
    const f = fixture(); mkdirSync(join(f.home, "cargo"));
    writeFileSync(join(f.path, "cargo"), "not executable"); chmodSync(join(f.path, "cargo"), 0o644);
    expect(findExistingRustTool("cargo", f.home, [".", "", f.path].join(delimiter))).toBeUndefined();
  });
  it("preserves the rustup proxy name without executing any test fixture", () => {
    const f = fixture(), proxy = f.executable(f.path, "rustup"), cargo = join(f.path, "cargo");
    symlinkSync(proxy, cargo);
    expect(findExistingRustTool("cargo", f.home, f.path)).toBe(cargo);
  });
});
