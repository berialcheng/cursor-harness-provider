# Capability / migration matrix

The hosts share the same compiled Rust Node-API engine, not each other's SDK, auth store, tools or checkpoints.

| Capability | OpenCode | Pi |
|---|---|---|
| Text/thinking streaming | Real Bun host + mock verified | Real Pi1.4/1.5 + mock verified |
| Host tools/results and allow/deny | Verified | Verified; one parked Rust RPC resumes after the host result |
| Cancellation, unsafe replay fencing | Native/adapter regression suite | Native/adapter regression suite |
| OAuth storage/normal expiry refresh | Existing integration retained | Pi owns locked storage/rotation |
| Rejected but unexpired access token | Reconnect when host cannot refresh | Canonical host resolution only; unchanged token requires /login |
| Catalog | Exact basic Rust-discovered IDs | Exact IDs plus discovered reasoning suffix routes |
| Max/structured parameterized model routes | Not exposed | Not exposed: **upstream Pi feature gap** |
| Inline images | Validated bytes, bounded; live images unverified | Explicit inline bytes/results only; live images unverified |
| Tool sampling | Full schema + host validation | Preferred JSON schema accepted; required grammar/strict sampling rejected |
| Structured response enforcement | Unsupported | Unsupported; do not assume JSON grammar support |
| HTTP custom headers/onResponse | Existing restricted interface | Custom headers rejected; raw HTTP response headers/status not exposed |
| Pi onPayload / provider event hooks | N/A | Normalized, nonsecret payload replacement and ordered structured native events |
| Pi infrastructure/resume context | N/A | Mixed user task preserved; context-mode/pi-lens/compaction memory normalized |
| /cursor.usage | N/A | Narrow read-only Rust JSON RPC; recognized values only, not estimated quota |
| Pricing/cost/billing | Not independently certified | Unknown rates are zero placeholders, with explicit unknown/estimate diagnostics |

Only macOS arm64 is locally tested. Linux/macOS CI is configured, not remotely exercised; Windows journal support is not implemented.
The SDK1.4 build and installed Pi1.5 host both pass isolated local transport tests. Other versions need verification.
Malformed/error responses never grant tools. No native filesystem read, command execution, external URL fetch or automatic prompt-path image reading is provided.

## Distribution / notices

No npm package, remote git repository or precompiled release was published by this task.
Local native files and dist outputs are gitignored; users cloning source must build.
Target-specific license inventory is conservative and includes non-shipped build/test packages. All registry license expressions observed for the validated target are permissive; this is not a legal opinion.
Nine protoc-bin-vendored build-tool packages lack standalone notice files in their archives; they are recorded as metadata-only and are not shipped inside the runtime .node.
NAPI notice text was fetched from the exact vcs commits and is retained, rather than treating MIT metadata alone as a complete binary notice.
Development SDK dependencies still have moderate/low npm audit findings. A targeted undici8.12.3 override removes the observed high advisory; runtime npm audit reports no dependencies with advisories.
