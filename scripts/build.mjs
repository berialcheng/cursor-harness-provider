import { build } from "esbuild";
const targets = [
  { host: "native", entryPoints: ["packages/native/src/index.ts"], outdir: "packages/native/dist" },
  { host: "opencode", entryPoints: ["packages/opencode/src/plugin.ts", "packages/opencode/src/model.ts"], outdir: "packages/opencode/dist" },
  { host: "pi", entryPoints: ["packages/pi/src/index.ts"], outdir: "packages/pi/dist" },
];
for (const target of targets) {
  const result = await build({ entryPoints: target.entryPoints, outdir: target.outdir, bundle: true, platform: "node", target: "node22", format: "esm", packages: "external", sourcemap: true, metafile: true });
  for (const source of Object.keys(result.metafile.inputs)) {
    if (/test\/reference|reference-model\.ts|vendor\/pi-cursor\/src\/(stream|client)\//.test(source)) throw new Error("Production imported a JS inference engine: " + source);
    if (target.host !== "opencode" && source.includes("packages/opencode/")) throw new Error("Cross-host dependency: " + source);
    if (target.host !== "pi" && source.includes("packages/pi/")) throw new Error("Cross-host dependency: " + source);
  }
  for (const output of Object.values(result.metafile.outputs)) for (const dep of output.imports) {
    if (!dep.external) continue;
    if (dep.path === "node:http2" || dep.path === "http2" || dep.path.startsWith("@bufbuild/")) throw new Error("Forbidden JS protocol dependency: " + dep.path);
    if (target.host !== "pi" && dep.path.startsWith("@earendil-works/")) throw new Error("Pi dependency outside Pi adapter: " + dep.path);
    if (dep.path.startsWith("@opencode/")) throw new Error("OpenCode SDK must be type-only: " + dep.path);
  }
}
