/** Narrow accidental-disclosure guard, not a substitute for a secret scanner/security review. */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { root } from "./rust-env.mjs";
const blockedDirs = new Set([".git", "node_modules", "dist", "target"]);
const privateOrg = ["book", "ing"].join("");
const privateReference = new RegExp(privateOrg + String.raw`\.com|` + privateOrg + String.raw`-com|/Users/[A-Za-z0-9._-]+/`, "i");
const issues = [];
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { issues.push(relative(root, join(dir, entry.name)) + ": unexpected source symlink"); continue; }
    const path = join(dir, entry.name), rel = relative(root, path);
    if (entry.isDirectory()) { if (!blockedDirs.has(entry.name) && rel.split("\\").join("/") !== "packages/native/native") visit(path); continue; }
    if (/^\.env(?:\.|$)|^(?:auth|credentials)\.json$|\.(?:node|log|jsonl)$/.test(entry.name)) { issues.push(rel + ": private/generated artifact"); continue; }
    const text = readFileSync(path, "utf8");
    if (privateReference.test(text)) issues.push(rel + ": internal URL or personal absolute path");
    // Header-only rejection fixtures are not secrets; flag plausible encoded PEM bodies.
    const pemText = text.replace(/\\\\n/g, "\n");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{40,}/.test(pemText)) issues.push(rel + ": private key material");
    if (/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/.test(text)) issues.push(rel + ": possible credential");
  }
}
visit(root);
if (issues.length) throw new Error("Source audit failed:\n" + issues.join("\n"));
console.log("No internal URLs, personal absolute paths, unexpected source symlinks or selected credential patterns found in distributable source.");
