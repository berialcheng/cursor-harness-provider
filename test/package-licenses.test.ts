import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error Build tooling is intentionally plain JavaScript, not a public package API.
import { classifyDependencies, normalDependencyIds, preparePackageLicenses, verifyPackagedLicenses } from "../scripts/package-licenses.mjs";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-license-fixture-")); temporary.push(root);
  const put = (path: string, data: string | object) => {
    const file = join(root, path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  };
  const dependency = { name: "fixture-lib", version: "1.0.0", license: "MIT", dependencyScope: "normal", notices: ["rust/fixture-lib-1.0.0/LICENSE"] };
  const inventory = { target: "aarch64-apple-darwin", dependencies: [dependency] };
  const manifest = { version: "0.3.0", artifacts: { "darwin-arm64": { file: "fixture.node", sha256: "fixture" } } };
  put("package.json", { version: "0.3.0", license: "MIT" });
  put("LICENSE", "MIT License\nCopyright project fixture\n");
  put("vendor/pi-cursor/LICENSE", "MIT License\nCopyright upstream fixture\n");
  put("licenses/rust-dependencies.json", inventory);
  put("licenses/upstream-notices.json", {});
  put("licenses/rust/fixture-lib-1.0.0/LICENSE", "MIT License\nCopyright Rust fixture\n");
  put("packages/native/native/manifest.json", manifest);
  for (const kind of ["native", "pi", "opencode"]) {
    put("packages/" + kind + "/package.json", { version: "0.3.0", license: "MIT", private: true });
    put("packages/" + kind + "/THIRD_PARTY_NOTICES.md", "Original notice: licenses/pi-cursor/LICENSE\n");
  }
  return { root, put, inventory, manifest, dependency };
}
function generate() {
  const f = fixture(); preparePackageLicenses(f.root); return f;
}
describe("package license distribution", () => {
  it("classifies only normal Cargo edges, conservatively retaining proc macros", () => {
    const dep = (pkg: string, kind: string | null) => ({ pkg, dep_kinds: [{ kind }] });
    const metadata = { workspace_members: ["root"], resolve: { nodes: [
      { id: "root", deps: [dep("runtime", null), dep("builder", "build"), dep("tester", "dev")] },
      { id: "runtime", deps: [dep("proc-macro", null)] },
      { id: "proc-macro", deps: [] }, { id: "builder", deps: [] }, { id: "tester", deps: [] },
      { id: "other-target-only", deps: [] },
    ] } };
    expect([...normalDependencyIds(metadata)].sort()).toEqual(["proc-macro", "root", "runtime"]);
    const scope = classifyDependencies(metadata);
    expect(scope.get("builder")).toBe("build-or-test");
    expect(scope.get("tester")).toBe("build-or-test");
    expect(scope.get("other-target-only")).toBe("inactive");
  });
  it("copies project/upstream texts unchanged and makes every package self-contained", () => {
    const f = generate();
    for (const kind of ["native", "pi", "opencode"]) {
      const base = join(f.root, "packages", kind);
      expect(readFileSync(join(base, "LICENSE"))).toEqual(readFileSync(join(f.root, "LICENSE")));
      expect(readFileSync(join(base, "licenses/pi-cursor/LICENSE"))).toEqual(readFileSync(join(f.root, "vendor/pi-cursor/LICENSE")));
      expect(verifyPackagedLicenses(base, kind, f.root).kind).toBe(kind);
      expect(JSON.parse(readFileSync(join(base, "package.json"), "utf8")).private).toBe(true);
    }
    expect(existsSync(join(f.root, "packages/pi/licenses/rust"))).toBe(false);
  });
  it("does not rewrite existing upstream attribution and produces deterministic manifests", () => {
    const f = generate(), path = join(f.root, "packages/pi/THIRD_PARTY_NOTICES.md");
    const notice = readFileSync(path), before = readFileSync(join(f.root, "packages/native/licenses/distribution.json"));
    preparePackageLicenses(f.root);
    expect(readFileSync(path)).toEqual(notice);
    expect(readFileSync(join(f.root, "packages/native/licenses/distribution.json"))).toEqual(before);
  });
  it("fails before output generation when a normal dependency has no notice text", () => {
    const f = fixture(); f.dependency.notices = []; f.put("licenses/rust-dependencies.json", f.inventory);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Missing third-party license text/);
    expect(existsSync(join(f.root, "packages/native/LICENSE"))).toBe(false);
  });
  it("does not exempt an unknown build dependency with missing notices", () => {
    const f = fixture(); f.dependency.notices = []; f.dependency.dependencyScope = "build-or-test"; f.put("licenses/rust-dependencies.json", f.inventory);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Missing third-party license text/);
  });
  it("permits only explicitly classified non-distributed protoc build-tool text gaps", () => {
    const f = fixture(); f.dependency.name = "protoc-bin-vendored-linux-x86_64"; f.dependency.notices = []; f.dependency.dependencyScope = "build-or-test"; f.put("licenses/rust-dependencies.json", f.inventory);
    preparePackageLicenses(f.root);
    const base = join(f.root, "packages/native");
    expect(verifyPackagedLicenses(base, "native", f.root).kind).toBe("native");
    expect(JSON.parse(readFileSync(join(base, "licenses/distribution.json"), "utf8")).knownBuildToolGaps).toEqual(["protoc-bin-vendored-linux-x86_64@1.0.0"]);
    f.dependency.dependencyScope = "normal"; f.put("licenses/rust-dependencies.json", f.inventory);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Missing third-party license text/);
  });
  it("rejects escaped license paths", () => {
    const f = fixture(); f.dependency.notices = ["../LICENSE"]; f.put("licenses/rust-dependencies.json", f.inventory);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Unsafe notice path/);
  });
  it("rejects license symlinks instead of following them", () => {
    const f = fixture(), path = join(f.root, f.dependency.notices[0] ? "licenses/" + f.dependency.notices[0] : "");
    rmSync(path); symlinkSync(join(f.root, "LICENSE"), path);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Non-regular notice path/);
  });
  it("refuses to replace an unmanaged license directory", () => {
    const f = fixture(); f.put("packages/native/licenses/distribution.json", { generatedBy: "someone-else" });
    f.put("packages/native/licenses/keep.txt", "user-authored text");
    expect(() => preparePackageLicenses(f.root)).toThrow(/unmanaged license directory/);
    expect(readFileSync(join(f.root, "packages/native/licenses/keep.txt"), "utf8")).toBe("user-authored text");
  });
  it("does not follow a dangling package LICENSE link or create its external target", () => {
    const f = fixture(), outside = join(f.root, "outside-license");
    symlinkSync(outside, join(f.root, "packages/pi/LICENSE"));
    expect(() => preparePackageLicenses(f.root)).toThrow(/Non-regular notice path/);
    expect(existsSync(outside)).toBe(false);
  });
  it("preserves manually changed package copyrights instead of overwriting them", () => {
    const f = generate(); f.put("packages/pi/LICENSE", "Custom copyright");
    expect(() => preparePackageLicenses(f.root)).toThrow(/modified package LICENSE/);
    expect(readFileSync(join(f.root, "packages/pi/LICENSE"), "utf8")).toBe("Custom copyright");
  });
  it("rejects additional binary platforms without target-specific license inventories", () => {
    const f = fixture(); Object.assign(f.manifest.artifacts, { "linux-x64-gnu": { file: "other.node" } }); f.put("packages/native/native/manifest.json", f.manifest);
    expect(() => preparePackageLicenses(f.root)).toThrow(/Missing target-specific license inventories/);
  });
  it("detects tampered license contents in a packaged artifact", () => {
    const f = generate(); f.put("packages/native/licenses/rust/fixture-lib-1.0.0/LICENSE", "changed");
    expect(() => verifyPackagedLicenses(join(f.root, "packages/native"), "native", f.root)).toThrow(/checksum mismatch/);
  });
  it("detects an omitted project LICENSE and unexpected files in generated license trees", () => {
    const f = generate(), base = join(f.root, "packages/pi"); rmSync(join(base, "LICENSE"));
    expect(() => verifyPackagedLicenses(base, "pi", f.root)).toThrow();
    f.put("packages/pi/LICENSE", readFileSync(join(f.root, "LICENSE"), "utf8"));
    f.put("packages/pi/licenses/unlisted.txt", "not inventoried");
    expect(() => verifyPackagedLicenses(base, "pi", f.root)).toThrow(/Unexpected license file/);
  });
});
