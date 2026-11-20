# Capability / migration matrix

The hosts share the same compiled Rust Node-API engine, not each other's SDK, auth store, tools or checkpoints.

**Historical evidence — 2026-11-10 audit M1–M10/L1/C1 snapshot:** local checks passed: 112 Rust tests and 377 JS/host tests across 42 files, including reference oracles—not 377 production-native scenarios. Actual offline-installed packed flows passed on Pi1.4/1.5 and OpenCode2.2.5. SDK1.5's 25 ownership/lifecycle unit tests use injected engines; real native transport is checked separately through the CLI. No production or live Cursor certification is implied.

**Current operational acceptance: local PASS (2026-11-10).** 126 Rust tests and 512 JS/host tests in 48 files; actual offline-installed Pi1.4.0/1.5.1 and OpenCode2.2.5/Bun1.3.13 flows passed on macOS26.7.1 arm64/Node22.22.0. SDK1.5.1 additionally passed 121 injected-engine ownership/lifecycle tests. Counts include reference oracles and are not all native scenarios. No fresh remote three-target/minimum-OS/live-service or power-loss certification. See [operations/rollback](OPERATIONS.md).

**Performance round: local PASS (2026-11-13).** 139 Rust tests and 515 JS/host tests in 48 files; Pi1.4.0 packed 6+1 gates passed with the LTO build. Pi1.5.1 packed runs, the SDK1.5.1 injected suite and remote CI were not rerun. Journal commits hash with ring's accelerated SHA-256 (same digests and format), reads and denials skip commits, and queued live frames share one commit before their acknowledgements. Pooled HTTP/2 connections are probed only during silence with an active stream. Root capacity failures are named and Pi doctor reports root usage; retention stays manual. Details: `VALIDATION.json` → `performanceRound20261113`.

| Capability | OpenCode | Pi |
|---|---|---|
| Text/thinking streaming | Real Bun host + mock verified | Real Pi1.4/1.5 + mock verified |
| Host tools/results and allow/deny | Verified | Verified; unchanged continuations keep the parked RPC; reconciled steering/tool changes rebuild safely |
| Cancellation, unsafe replay fencing | Native/adapter regression suite | Native/adapter regression suite |
| OAuth storage/normal expiry refresh | Existing integration retained | Pi owns locked storage/rotation |
| Rejected but unexpired access token | Reconnect when host cannot refresh | Canonical host resolution only; unchanged token requires /login |
| Catalog | Exact basic Rust-discovered IDs; metadata-only rows excluded | Auto/default alias, discovered suffixes and advertised parameter variants; account/endpoint-scoped snapshots through Pi |
| Max/structured parameterized model routes | Not exposed | Explicit advertised variant sets routed as Rust RequestedModel parameters/maxMode; reasoning:max is separate |
| Inline images | Validated bytes, bounded; live images unverified | Explicitly advertised image models: host attachments and host-gated image results; SDK/CLI + local H2 verified, live images unverified |
| Tool sampling | Full schema + host validation | Preferred JSON schema accepted; required grammar/strict sampling rejected |
| Structured response enforcement | Unsupported | Unsupported; do not assume JSON grammar support |
| HTTP custom headers/onResponse | Existing restricted interface | Custom headers rejected; raw HTTP response headers/status not exposed |
| Pi onPayload / provider event hooks | N/A | Normalized, nonsecret payload replacement and ordered structured native events |
| Pi infrastructure/resume context | N/A | Mixed tasks/recovery memory preserved; tree navigation, manual compaction and process restart tested with real Pi + local H2 |
| Pi child sessions | N/A | BTW-style copied configurations snapshot their owned runtime; child continuations are isolated from parent/one-shot summaries and cannot borrow a replacement runtime |
| Pi compatibility API (C1) | N/A | Implemented only for `cursor-native-rust`: live model-owner UUID or exact live parent-session fallback for untagged models; no owner guessing; source/packed actual-host acceptance verified |
| Auxiliary lifecycle | Title/compaction/stateless success cleanup; completed generate tool loops clean only at terminal EOF under shared scope admission; uncertain failed loops retain fences | Compat request-kind/checkpoint isolation; no-ID requests disable tools and clean on success, retaining uncertainty on failure |
| /cursor.usage | N/A | Narrow read-only Rust JSON RPC; recognized values only, not estimated quota |
| Pricing/cost/billing | Not independently certified | Unknown rates are zero placeholders, with explicit unknown/estimate diagnostics |

The dated local audit tested macOS arm64; it does not establish fresh remote Linux/macOS CI coverage. Windows journal support is not implemented.
The SDK1.4 build and isolated Pi1.5 host passed the dated local transport tests; current operational changes and other versions still need verification.
Malformed/error responses never grant tools. All prohibited native execution and interaction-query bodies (including AskQuestion/plan) are shape-checked before prost decoding; mixed/duplicate oneofs fail closed. Nested Value and checkpoint allocations are also preflight-bounded. Rust HTTP/2 receive windows are 8 MiB per connection and 64 KiB per stream. Frozen KV updates validate/persist without replies. At most 256 retired recovery-root locations are remembered; unknown/forgotten scope removal errors until the same binding/cacheDir is registered, never reports a fake clear. No native filesystem read, command execution, external URL fetch or automatic prompt-path image reading is provided.

Only metadata that explicitly attests images/variant combinations is exposed. A model-level supportsMaxMode flag alone does not synthesize a parameter cross-product. Plain screenshot paths are not images: attach through Pi or use an authorized host tool. Both the pinned old Pi provider and this adapter lack caller-supplied HTTP headers/onResponse; those are not capabilities lost in this migration.

Completed history rewrites invalidate upstream checkpoints and rotate the conversation. Changes at a quiescent, fully reconciled tool-result boundary can rebuild from authoritative host history; uncertain/incomplete action turns still fail closed. Old journals without provenance cannot restore interrupted actions blindly. Journals retain bounded action identities (512) and expire after 24 hours; a new Pi session may be required after a fail-closed recovery error. These policies are not an exactly-once guarantee. External CLI/IDE reuse only reads current access tokens and never rotates the external owner's refresh pair; renew externally or use browser login.

OAuth token bodies are bounded to 64 KiB, 4096 chunks and a 15-second read deadline, with strict UTF-8, sanitized errors and preserved caller aborts. Catalogs reset by account before discovery; generation checks prevent late account-A results or failures from contaminating account B. Omitted protobuf `parameterValue` means empty string; opaque effort IDs are injective and exact routes do not silently fall back to off.

## Operational contracts — local qualification passed

- Provider-initiated auth callbacks: 25s default; `PI_CURSOR_AUTH_TIMEOUT_MS` / `OPENCODE_CURSOR_AUTH_TIMEOUT_MS` within 1–30000ms. Not a whole human-login/tool deadline; late results cannot apply to cancelled/replaced owners.
- Pi doctor reports `idle/auth/preparing/start/streaming/awaiting-tools/error/aborted/fenced` request phases, recovery and available numeric resource snapshots. No-argument reset/cache is dry help/list, without auth lookup.
- Reset requires a known full scope and explicit UI confirmation or `--scope HASH --confirm-discard`; stops own requests/drains native starts. Default 5s, `PI_CURSOR_RESET_TIMEOUT_MS` ≤5000ms; timeout leaves a fence, not success. Never tool undo.
- Cache uses a known scope only as a **root-wide** anchor: dry-run default, apply requires UI consent or `--apply --confirm-prune`. On apply, other eligible expired records become fail-closed tombstones; active/locked/corrupt records skipped. No arbitrary roots, JS filesystem fallback or DSO cleanup. Native dry-run contents, inventory, permissions and mtime invariants passed.
- 512MiB tracked payload per loaded core generation is not RSS; containers/allocator/runtime/old DSOs excluded. Root cache: 1GiB committed/4096 recognized regular records plus separate serialized 200MiB staging; unsafe/unrecognized/lock/legacy orphan files excluded. Expiry is 24h on access unless explicit maintenance, not encryption/secure erase.
- Pi `timeoutMs` is stream idleness. Pi's disabled idle timeout (0, sent as 2147483647) and longer values use the one-hour native maximum; negative/non-integer values are rejected.
- Runtime-local tool-turn route pins survive metadata changes, not process migration. Account/endpoint/model changes cannot borrow turns; fully reconciled quiescent rebuild capability is retained.

See [replacement review and dated validation](Pi_REPLACEMENT_REVIEW.md) and the [safe operator/fixture/rollback runbook](OPERATIONS.md). Exact-trio rollback needs explicit installation approval and cold host restart; journal backward compatibility is not assumed.

## Distribution / notices

No npm package, remote git repository or precompiled release was published by this task.
Local native files and dist outputs are gitignored; users cloning source must build.
Canonical packing uses isolated staging and includes only manifest-selected DSOs, retaining old loaded DSOs in source. Packed inventory, licenses and evidence remain strict: the capability evidence must report `packedPiCapabilityCases: 1` in addition to `packedHostCases: 6`; both Pi1.4 and Pi1.5 packed runs passed these gates; this is not inferred from baseline evidence.
Target-specific license inventory is conservative and includes non-shipped build/test packages. All registry license expressions observed for the validated target are permissive; this is not a legal opinion.
Nine protoc-bin-vendored build-tool packages lack standalone notice files in their archives; they are recorded as metadata-only and are not shipped inside the runtime .node.
NAPI notice text was fetched from the exact vcs commits and is retained, rather than treating MIT metadata alone as a complete binary notice.
The historical npm audit recorded moderate/low development findings and no runtime advisories after an undici8.12.3 override. This round did not refresh vulnerability databases or install cargo-audit/cargo-deny; those historical counts are not a fresh dependency-security certification.
