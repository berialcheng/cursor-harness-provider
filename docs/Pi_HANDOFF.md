# Pi focused completion handoff

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
