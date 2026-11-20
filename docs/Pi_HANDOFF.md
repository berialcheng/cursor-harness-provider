# Pi focused completion handoff

Historical handoff for the initial migration. Its test counts and Max/system-refresh limitations below describe that snapshot, not current behavior. Current reliability, image, parameter-route and audit M1–M10/L1/C1 changes are documented in [Pi replacement review](Pi_REPLACEMENT_REVIEW.md) and [capabilities](CAPABILITIES.md).

## Current operational handoff — local acceptance passed (2026-11-10)

- Latest evidence: `VALIDATION.json` → `operationalHardening20261110`. Full check: 126 Rust / 512 JS-host tests in 48 files, typecheck/fmt/clippy/source guards. Packed Pi1.4.0/1.5.1 each passed 6+1 gates including actual RPC operations. SDK1.5.1 injected-engine suite: 121 tests. macOS26.7.1 arm64/Node22.22.0, OpenCode2.2.5/Bun1.3.13 only; remote targets, minimum OS and power loss remain unqualified.
- [OPERATIONS.md](OPERATIONS.md) is the operator/rollback runbook. Provider auth waits default to 25s (1–30000ms), not whole human-login/tool deadlines; cancelled/replaced owners ignore late results. Optional deadline helpers use `@cursor-harness-provider/native/lifecycle`, keeping the default RustEngine declaration usable with ES2023 alone.
- Pi doctor exposes phase/recovery/resource snapshots. Reset is known-full-scope only with UI confirmation or `--scope HASH --confirm-discard`; no args are dry help. Stop own work/drain native starts; 5s maximum (`PI_CURSOR_RESET_TIMEOUT_MS` ≤5000ms) timeout stays fenced, never success/tool undo.
- Cache: a known scope anchors **root-wide** dry-run/default or explicitly consented apply (`--apply --confirm-prune` headless). Expired payloads become tombstones; active/locked/corrupt records are skipped. Native byte/mode/mtime/inventory checks passed. No arbitrary-root/auth lookup/JS filesystem fallback/DSO cleanup.
- Limits: 512MiB tracked payload per loaded core generation, not RSS (containers/allocator/runtime/old DSOs excluded); per-root 1GiB committed/4096 recognized regular records plus serialized 200MiB staging (unsafe/unrecognized/lock/legacy orphan files excluded). Expiry 24h on access unless explicit maintenance; not encryption/secure erase.
- Runtime-local route pins preserve tool turns through metadata changes, not cross-process migration. No account/endpoint/model borrowing; retain fully reconciled quiescent rebuilds.
- Qualify injected/native/real-host/exact packed artifacts separately, per platform; SIGKILL is not power-loss testing. Rollback needs explicit installation approval, exact native/Pi/OpenCode trio and cold host restart; no journal backward-compatibility assumption, unknown-action auto-clear, `auth.json` copy or token migration.

## Historical audit handoff — local acceptance passed (2026-11-10 snapshot)

- M1–M10/L1 safeguards are implemented across Rust bounded transport/protocol/recovery, OpenCode cleanup/admission/catalog lifecycle, Pi OAuth/model routing and canonical package staging. The replacement review records the design boundaries; the historical passes below do not certify these latest changes.
- C1 is implemented for `cursor-native-rust` only: live ephemeral model-owner UUID selection, exact live parent-session fallback only for untagged models, and rejection of stale/ambiguous/mismatched ownership before auth/native work. Auth is canonical to that owner and same-account refresh only; compat checkpoint/request-kind namespaces are isolated. No-ID one-shots disable tools and clean on success; stable logical IDs retain host tool continuations, with uncertainty retained on errors.
- Retained provider configurations snapshot the owned runtime, so BTW configurations cannot borrow a replacement parent runtime. No last-owner/unique-owner guessing or override of the old API is added.
- The build ships `packages/pi/src/extension.ts` → `dist/extension.ts`, with private-root/public Pi manifests selecting those entries respectively. The shim imports the actual host registry and injects it into the backend through optional dependencies; compiled `dist/index.js` stays programmatic, not a manual extension entry. Physical compiled-native ESM and Pi's extension registry can differ even at the same SDK version; bundling an SDK/private host API is not a solution.
- Final checks passed: 112 Rust tests, 377 JS/host tests in 42 files, typecheck/rustfmt/clippy, source guard and whitespace checks. Actual offline-installed tarballs passed all six original host cases plus one advanced catalog/restart/image/Max/compat case on each of Pi1.4 and Pi1.5 (with OpenCode2.2.5). SDK1.5 additionally passed 25 injected-engine ownership/lifecycle unit tests. Dated audit evidence and native hash are in `VALIDATION.json` → `auditRemediation20261110`; these passes do not qualify subsequent operational changes. No installed provider or credentials were changed, no live Cursor calls made, and no commit/publish performed.

## Historical initial-migration snapshot

## Fixes

- Kept SDK-standard mutable assistant-message references. The balancing test now spies on `stream.push` immediately after `streamSimple` and clones only its test snapshots at emission time.
- Corrected payload-hook tests: missing `prompt`/`tools` are actually removed after the merge; empty present arrays have a separate accepted-replacement test. Genuine payload validation remains strict.
- Native token refresh now asks an injected `resolveAuth(signal)` callback. Registration resolves via the live session context's `modelRegistry.getProviderAuth("cursor")`, leaving normal expiry refresh and rotating-token persistence inside Pi's locked store. An unchanged rejected token requires `/login cursor`; another account is rejected. Bound refresh never calls raw OAuth rotation or falls through to system credentials after an explicit Pi token fails.
- `CursorAuth.refreshCredential` remains the raw registered host OAuth callback. There is no shadow credential-pair cache to poison with late callbacks. Public `bind.refresh` requires canonical host resolution for explicit tokens, or fails safely. Legacy default-allow CLI/IDE credential reuse remains a separate path with explicit opt-out.
- Ported the pure MIT context-normalization helper into the Pi adapter with attribution and a packaged `packages/pi/THIRD_PARTY_NOTICES.md`. V3 `file`/`mediaType` images survive notice folding. Mixed tasks, context-mode/pi-lens/context notices and compaction/resume memory are retained with appropriate framing; no tool actions are synthesized.
- Corrected inference's default to the canonical `agentn` route (OAuth remains on `api2`). Both `PI_CURSOR_AGENT_URL` and `CURSOR_AGENT_URL` are supported without mutating process environment.
- Reject custom request/model headers, including header suppression. Unsupported request controls and unavailable response-header instrumentation have explicit diagnostics. Image capability checks also cover payload-hook replacements.

## Verification

- `npm run typecheck`: passed.
- `npm test -- test/pi`: 3 files, 79 tests passed (fixture-only run, including auth, transcript, routing, instrumentation and cancellation regressions).
- Final repeat: typecheck passed; Pi fixture suite passed again (3 files, 79 tests). No credential/network fixtures use real storage or live Cursor.
- Only Pi tests/typecheck were run by this worker. Main agent owns `test/pi/host.test.ts`, the full suite, build and Rust verification. Rebuild Pi `dist` from these sources before packaging; this worker did not regenerate build output.

## Limitations / safety

- Development SDK is Pi 1.4; the installed host is 1.5. No installed-provider replacement, hot reload, plugin queue, config edits, credentials access or live Cursor calls were performed. Host 1.5 still needs the main agent's isolated host verification.
- The host registry API has no abort-signal argument. The adapter stops waiting and rejects cancelled/replaced-session results; Pi remains responsible for its own persistent storage transaction.
- A rejected token that Pi still considers unexpired cannot be forcibly rotated by this adapter; `/login cursor` is required. Opaque rotated tokens cannot prove account continuity and fail conservatively.
- Legacy system refresh may rotate an external CLI/IDE token in memory, without writing it back; it is deliberately not a fallback after an explicit Pi credential is rejected. `PI_CURSOR_SYSTEM_CREDENTIALS=0` disables scraping.
- Catalog pricing is unknown (zero placeholders), not a free-use/quota assertion. No synthetic Max/parameterized model routes. Only discovered exact reasoning routes are supported.
- No JS protobuf/Connect/HTTP2 inference implementation or CLI inference fallback. All inference remains in the shared Rust engine; tools stay behind Pi's permission gate.
- `timeoutMs` maps to Rust stream idleness, not a whole-request deadline; short/long cache retention does not assert provider cache accounting. HTTP response headers/status are unavailable at the current native boundary. Usage RPC is explicitly unavailable unless the binding exposes it; there is no JS/quota-estimation fallback. Unreported usage remains marked unknown.

## Files / key entry points

- `packages/pi/src/auth/index.ts`: `ResolveAuth`, `CursorAuth.bind`, `refreshCredential`.
- `packages/pi/src/runtime.ts`: `RuntimeDependencies.resolveAuth`, `streamSimple`, `discover`.
- `packages/pi/src/index.ts`: `registerCursorNative`, live session auth resolution.
- `packages/pi/src/constants.ts`: inference route.
- `packages/pi/package.json`, `packages/pi/THIRD_PARTY_NOTICES.md`: shipped MIT helper notice.
- `packages/pi/src/context-normalize.ts`: attributed pure V3 notice normalization.
- `packages/pi/src/transcript.ts`: normalization before validation.
- `test/pi/auth.test.ts`, `test/pi/runtime.test.ts`, `test/pi/transcript.test.ts`, `test/pi/fixtures.ts`: focused regression fixtures and assertions.
- `test/pi/host.test.ts`: main-agent ownership; untouched by this worker.
