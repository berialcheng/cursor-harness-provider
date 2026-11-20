# Pi replacement review — working tree and historical evidence

Source revision: initial replacement changes began at `f734f08`; this audit-remediation round uses `d5aabf7` plus the preserved uncommitted tree. Version remains the package-manifest version, 0.3.0. This work changes the repository, not installed providers. No commits, publishing, plugin switches, real credential inspection or live Cursor calls are part of this task.

## Performance round — local acceptance passed (2026-11-13)

Evidence: `VALIDATION.json` → `performanceRound20261113`. Final `npm run check` passed (139 Rust / 515 JS-host tests, Pi1.4.0 packed 6+1 gates with the LTO artifact); Pi1.5.1 packed runs, the SDK1.5.1 injected suite and remote CI were not rerun.

- Journal commits use ring's CPU-dispatched SHA-256 and measure quota size without hashing; format, checksum and durability are unchanged (32 MiB: 204 → 40 ms). Only blob-store writes commit before their reply; reads and denials do not. Live turns coalesce commits across frames that already arrived, and acknowledgements still follow their commit.
- Header timeouts retire their pooled connection; a silent connection with an active stream gets one PING per silent period and is dropped if unanswered. Retry policy is unchanged. Model discovery requests run concurrently.
- Output-only continuation frames release their speculative reservation while waiting on host delivery; every other frame keeps admission before allocation. Unary bodies are joined once.
- Pi: the disabled idle timeout no longer fails every request; image validation is about 6x faster with an identical accepted set; the hook-normalized JSON is reused for the native start. OpenCode byte images encode without a copy.
- Release builds use fat LTO and stripped symbols (9.19 → 4.80 MB). Capacity failures are named and reported; by decision, cache retention remains manual and consented.

## Current operational hardening — local acceptance passed

Current evidence is `VALIDATION.json` → `operationalHardening20261110`: 126 Rust tests, 512 JS/host tests in 48 files, typecheck/fmt/clippy/source checks, and original 6+1 offline packed-host gates on Pi1.4.0 and Pi1.5.1. The advanced case now includes actual RPC doctor/cache/reset and fresh-conversation checks. SDK1.5.1 additionally passed 121 injected-engine ownership/lifecycle tests. Local platform: macOS26.7.1 arm64, Node22.22.0, Bun1.3.13; no new remote matrix, live Cursor or power-loss certification.

The [operations runbook](OPERATIONS.md) covers provider auth waits (25s default, 1–30000ms), owner/late-result fencing, doctor phases, consented known-scope reset and root-wide cache maintenance. Reset drains own starts/requests; its 5s maximum timeout leaves a fence, not success/tool undo. Cache defaults to dry run; apply retains tombstones and skips active/locked/corrupt records. Registered commands were exercised through real N-API plus actual source/packed Pi RPC, without arbitrary roots/auth lookup/JS filesystem fallback/DSO cleanup.

Tracked payload is bounded at 512MiB per loaded core generation, not RSS; containers/allocator/runtime/old DSOs remain outside complete accounting. Root committed cache is 1GiB/4096 recognized regular records plus serialized 200MiB staging. Concurrent admission, large restore, pre-install accounting, dry-run inventory and deterministic write/sync/rename faults have local regressions. Root admission uses same-process FIFO plus bounded cross-process locking; OS filesystem calls and preceding queued writes cannot be forcibly interrupted.

Runtime-local pins preserve a pending tool turn across catalog drift while retaining reconciled system/tool/payload/steering changes. Reasoning spellings share lifecycle/reset fencing but never silently borrow another reasoning pin. Account/endpoint/model switches cannot borrow turns; cross-process route-pin migration is not implemented. Five real-native process-fault tests cover contention/SIGKILL/corruption/cancel-restart sequences—not every crash window or power loss. Exact package-group rollback remains an explicitly approved manual procedure.

## Historical audit M1–M10/L1 + C1 — 2026-11-10

The following design ledger and passes describe that dated snapshot, not subsequent operational changes. Evidence is retained in `VALIDATION.json` → `auditRemediation20261110`; it does not certify production readiness. The historical 2026-11-09 baseline below is retained separately.

### Rust transport, protocol and recovery

- HTTP/2 receive credit is bounded to **8 MiB per connection / 64 KiB per stream**, rather than a large window per idle or parked RPC. Payload/decoder budgets remain separate limits; these windows are not a process-memory or OS sandbox guarantee.
- A frozen RPC validates and persists KV updates without sending obsolete replies/uploads. Invalid KV, unexpected tools or ambiguous messages still taint/fail the turn; freezing does not grant permission to ignore malformed state.
- Retired actors retain only recovery locations/bindings, not live journal descriptors or action state. The registry is bounded to **256 locations**, including custom cache roots. `remove(scope)` rejects unknown/forgotten scopes until the same binding/cacheDir is registered again; it must not pretend a journal was cleared when its location is unknown.
- Shape validation runs **before prost decoding** for all prohibited native-execution bodies and interaction-query bodies, including AskQuestion and plan-shaped requests. Known rejection responses are explicit rejections, not execution or fabricated success; where no safe rejection shape exists the stream fails closed. Mixed/duplicate executable, interaction and nested Value oneofs remain strict in both wire orders. Observational update 27 alone still neither progresses nor finishes a turn.

### Adapter lifecycle and authentication

- OpenCode cleans successful title, compaction and stateless requests. A completed `generate` tool loop is cleaned only after terminal completion **and EOF**, never at a tool handoff. Shared scope admission/lease ownership holds through pending native starts and cleanup so old cleanup cannot erase a newer request's actor/fences. Failed/cancelled uncertain durable tool loops retain their recovery fences.
- Catalogs are account/endpoint scoped and reset conservatively before discovery. A switch to account B whose discovery fails must not expose account A's catalog; generation checks also discard late successes/failures. This is an isolation policy, not a guarantee that metadata discovery always succeeds.
- Pi OAuth token-response reading is limited to **64 KiB, 4096 chunks and a 15-second read deadline**. Strict UTF-8/JSON/reader failures receive sanitized diagnostics; caller aborts stay aborts and teardown must not replace them with leaked response data. Pi still owns browser-token persistence/normal rotation; external CLI/IDE reuse remains access-only.

### Catalog routes and package artifacts

- An omitted protobuf `parameterValue` is the protobuf default **empty string**, not a malformed/missing route. Opaque effort values use injective public-ID encoding, preserving exact routes without empty/literal/delimiter collisions. An unsupported effort does not silently fall back to off; advertised none/off routes remain distinct from arbitrary values. Max Mode and reasoning max remain separate, with no invented parameter cross-product.
- Canonical packing stages isolated copies outside source and selects only manifest-listed native DSOs. Older loaded source DSOs are retained for existing processes, never deleted to make a pack pass. Archives undergo exact inventory/hash, license and evidence checks; staging selection does not relax archive validation.
- Advanced packed-host evidence must require **`packedPiCapabilityCases: 1` in addition to `packedHostCases: 6`**, the original Pi/OpenCode cases. Commit/run/attempt/lock and target-specific license/evidence matching remain required; no acceptance is inferred for untested targets.

### C1 compatibility ownership and loader boundary

- C1 is now implemented: a global dispatcher registers **only `cursor-native-rust`**, not the old Cursor API. It selects a live ephemeral owner UUID attached to a host model. An untagged model may fall back **only to one exact live parent `sessionId`**. Stale, ambiguous, provider/API-mismatched or conflicting model/parent ownership is rejected before auth/native work; neither “last owner” nor “only owner” is a guessable fallback.
- Auth resolves through the selected owner's canonical host registry, with lifecycle rechecks around awaits and same-account refresh only. A caller-supplied credential cannot switch the selected host account. No credential-pair cache or fallback to another live owner is added.
- Compat has its own request-kind/checkpoint namespace. No-ID calls are one-shot, disable tools and clean up on successful completion; stable logical session IDs permit host tool continuation. Failed/aborted calls retain uncertainty rather than erase fences. Provider-config callbacks snapshot their owned runtime/UUID, so retained BTW configurations cannot borrow a replacement runtime.
- **Loader integration verified:** the build ships a tiny TS host entry `packages/pi/src/extension.ts` → `dist/extension.ts`. The private root Pi manifest selects `packages/pi/src/extension.ts`; the public package Pi manifest selects `dist/extension.ts`. The compiled backend `dist/index.js` remains the programmatic export, **not a manual extension entry**.
- The shim imports the actual host registry and passes it to the backend via optional dependencies. A physical compiled-native ESM compatibility registry can differ from Pi's extension view even with the same SDK version. This is why source checkout must load TS through Pi, and packed acceptance must load the TS shim plus compiled backend from actual npm artifacts—not substitute a direct JS import. SDKs remain external peers; no SDK bundle or private host API is introduced.

### Historical local acceptance — 2026-11-10 audit snapshot

- Full `npm run check` passed: typecheck, rustfmt, clippy with denied warnings, **112 Rust tests**, build, **377 JS/host tests in 42 files**, and offline package acceptance. JS totals include reference oracles, not 377 production-native scenarios.
- Actual installed tarballs passed **six original host cases plus one advanced Pi case** on both Pi1.5 and Pi1.4, with OpenCode2.2.5/Bun. The advanced case includes catalog persistence/restart, explicit image/Max routing and a real `compat.complete()` → Rust/local-H2 request without overriding the old API. The TS shim loads the packaged compiled backend, not workspace source.
- SDK1.5 additionally passed **25 injected-engine compat ownership/lifecycle tests**; actual native behavior is separately exercised by CLI acceptance. SDK1.4's native SDK suite covers compat images/parameters, isolated one-shots and stable host-tool continuation. Tree/manual-compaction evidence remains the SDK1.4 coverage below, not a new SDK1.5 claim.
- Source-disclosure and diff-whitespace guards passed. Focused independent follow-up reviews found no remaining concrete high/medium issues within the reviewed changes; this is not a full security audit or a fresh vulnerability-database scan.
- Freeze/KV timing and retired-root cases include deterministic internal Rust fixtures, not live-host scheduling certification. Uncertain failed tool loops deliberately retain fences; no aggressive cleanup/replay is used to manufacture passing results.
- Audit-snapshot native artifact: `cursor_native.darwin-arm64.29a1c75f40ce7264.node`, SHA-256 `29a1c75f40ce72646e15d4f4b576e120df4db8baa7d0975c3b55bad7bd405edb`. Old source generations remain present; only this manifest-selected generation is packed.
- No live Cursor requests, real credential inspection, installed-provider changes, commits, pushes or publication were performed.

## Historical baseline — 2026-11-09

### Scope and comparison correction

The installed comparison was `@rahularya01/pi-cursor@1.4.39` on Pi 1.5.0, Node 22.22.0, macOS arm64. The pinned old provider implements image ingestion, Max/structured-parameter routing and history/checkpoint/journal recovery mechanisms. It does **not** wire caller-supplied HTTP headers or Pi's `onResponse` callback; those are not capabilities lost by switching. Pi owns `/tree`, compaction and session loading; the provider must correctly synchronize its private upstream state with the authoritative host transcript.

## Correctness and safety changes

- Durable bounded transcript/configuration provenance binds checkpoint reuse to host history. A completed rewind, branch or compaction rotates the upstream conversation instead of retaining stale summary/opaque state.
- Unchanged tool continuations keep their parked RPC. Steering, changed system instructions/payload or an activated tool registry rebuild only at a verified quiescent boundary with complete exact call/results. Buffered/unexposed actions, partial output and uncertain recovery still fail closed.
- Known tool IDs must retain name, arguments and result; validation is atomic before consuming results. Restart recovery without action provenance cannot blindly reuse an old checkpoint.
- Stable child session IDs (including BTW-style copied provider configurations) retain their own tool continuations. Parent, child and one-shot compaction/summaries have separate identities; account, endpoint, workspace and complete model route are also part of isolation.
- Text/reasoning block IDs and upstream tool IDs have separate namespaces. Malformed/failed assistant tool arguments are quarantined, not replayed as executable calls.
- Nested executable/KV/query/recursive protobuf Value ambiguities are checked before dispatch. Shared field/depth budgets also bound checkpoint decoding, including nested subagent/map state. Standalone observational update 27 remains non-executing/non-finishing.
- Auto/default aliases survive discovery; thinking off uses an advertised none route. Public catalog snapshots restore through Pi's generation-checked model store, scoped by account and endpoint; no direct auth-store access or startup credential scraping is added.
- CLI/IDE reuse reads current access tokens only, including fallback and rejected-token paths. It never rotates an external owner's refresh pair. Imported expiry no longer equals Pi's refresh-ahead margin. Browser OAuth rotation remains inside Pi's canonical credential transaction.

## Added capability routing

Rust performs both GetUsableModels and optional AvailableModels discovery/decoding. The existing listModels JSON-array API is retained; metadata-only rows are marked and excluded from OpenCode's basic picker. Start JSON accepts additive modelParameters/maxMode fields, encoded in RequestedModel without changing existing RustEngine method signatures.

Pi exposes only explicit advertised parameter sets, including context, fast/thinking, reasoning and Max Mode. Model-level supportsMaxMode alone does not create a synthetic parameter cross-product. Public IDs for Max Mode use `-max-mode`; reasoning `max` is a separate effort, not a mode flag. A metadata default in a later group still controls the basic model selection.

Images are enabled only with explicit metadata. Inline PNG/JPEG/GIF/WebP attachments and host-gated image tool results remain bounded (5 MiB each; 16 images/20 MiB aggregate). Plain screenshot paths, clipboard paths and URLs are not read/fetched by the provider. Optional metadata failure leaves a conservative basic text catalog; no model-name capability guess is used.

## Historical verification — not current-audit acceptance

The completion checks are recorded in `VALIDATION.json` under `replacementFixes20261109`, separately from the historical initial-migration counts/artifact. That baseline uses localhost mock H2 and synthetic credentials; no network traffic is performed by this documentation task.

Coverage includes:

- Rust raw-wire metadata/request oracles, mixed/duplicate oneofs in both orders, recursive Value and checkpoint allocation bounds, durable lineage/journal compatibility and uncertain-action fencing.
- Actual native steering/dynamic-tool/history reconciliation and exact action identity tests.
- Real Pi SDK 1.4 with native Rust: inline attachments, image tool results through a permission gate, reasoning max versus Max/context/fast/thinking, BTW-style child continuation, offline persistent restart, tree navigation and manual compaction while a stale upstream checkpoint is present.
- Actual isolated Pi CLI 1.5: discovery and persisted non-Auto catalog across processes, history continuation and an explicit image attachment in an advertised Max route.
- The same CLI discovery/restart/image/Max scenario additionally runs from the offline-installed tarball, alongside the six unchanged release-required Pi/OpenCode packed-host cases.

## Remaining limitations

This is local mock-backed acceptance, **not** a fresh live Cursor/model/account certification or an assertion of full upstream feature parity. Other platforms/host versions require their own verification; no all-platform certification is implied, and Windows journal support remains unimplemented. OpenCode does not expose parameterized/Max picker routes. Headers/onResponse, structured output enforcement and strict grammar sampling remain unsupported. Pricing/billing/cache rates are unverified.

Old interrupted action journals without provenance, uncertain partial-output turns, expired journals or full ledgers can require a new host session; recovery is deliberately not unconditional. Journal limits (including 512 action identities and 24-hour expiry) remain conservative. No exactly-once, performance or quota advantage is claimed. Installed-plugin switching remains a separate explicit user decision.
