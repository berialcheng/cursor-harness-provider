# @cursor-harness-provider/pi

Unofficial Cursor model access for Pi, backed by the shared Rust runtime.

Only after explicit installation approval, for a published version:
```sh
pi install npm:@cursor-harness-provider/pi
```

Do not load this provider alongside another Cursor provider. Restart/reload when idle, select cursor/auto, and use /login cursor for authentication. Credentials and tool permissions remain owned by Pi; never place a token in this package.

Historical operational qualification on 2026-11-10 passed 126 Rust / 512 JS-host tests across the project, with then-current offline-installed Pi1.4.0/1.5.1 flows and 121 SDK1.5.1 injected-engine ownership/lifecycle tests. Fresh 2026-11-20 local qualification passed 146 Rust / 515 JS-host tests plus packed 6+1 cases; the older SDK1.5.1 run is not a fresh qualification of these exact bytes. No fresh remote three-target, minimum-OS or live Cursor certification is implied. Native platform support follows the manifest. Discovery exposes explicit image and advertised parameter/Max variants; reasoning `max` is not Max Mode. Pi owns public catalog snapshots and normal OAuth rotation.

Inline attachments and host-gated image tool results are supported for advertised models; plain screenshot/file paths are never opened automatically. BTW-style child tool continuations, tree navigation, manual compaction and restart have local mock-backed host coverage, not a live Cursor certification. Uncertain actions still fail closed. CLI/IDE reuse is access-only; renew externally or use browser login. Caller-supplied HTTP headers and `onResponse` remain unsupported (also absent in the pinned old provider).

The `cursor-native-rust` compatibility dispatcher selects a live model-owner UUID; untagged models require an exact live parent `sessionId`. Stale/ambiguous/mismatched owners fail before authentication or native work. No-ID calls are isolated one-shots without tools; stable logical session IDs support host tool continuations. Authentication stays with the selected host owner, including same-account refresh.

The build ships `src/extension.ts` → `dist/extension.ts`: Pi loads this tiny TypeScript shim against its actual host registry; compiled `dist/index.js` remains the programmatic backend, not a manual extension entry. Private-root discovery uses `packages/pi/src/extension.ts`; the public Pi manifest uses `dist/extension.ts`. SDKs stay external peers, with no private host API or SDK bundle. Source and actual offline-installed packed-host checks passed on Pi1.4/1.5; no live Cursor certification is implied.

## Operations — local mock-backed acceptance passed

- Provider-initiated auth callbacks: 25s default, `PI_CURSOR_AUTH_TIMEOUT_MS` within **1–30000ms** (OpenCode: `OPENCODE_CURSOR_AUTH_TIMEOUT_MS`). Not a whole human-login/tool deadline; cancelled/replaced owners cannot apply late results.
- `/cursor.doctor`: request phases (`idle`, `auth`, `preparing`, `start`, `streaming`, `awaiting-tools`, `error`, `aborted`, `fenced`), recovery and available numeric resource snapshots, plus cache-root usage from the latest commit with a warning at 80%; not proof that tools did not run.
- `/cursor.reset`: no-argument dry help/list. Only a known full 64-hex scope, explicit UI confirmation or headless `--scope HASH --confirm-discard`. Stops own requests/drains native start; default 5s (`PI_CURSOR_RESET_TIMEOUT_MS` ≤5000ms) timeout leaves it fenced, not successfully reset. No tool undo/retry.
- `/cursor.cache --scope HASH`: known scope anchors **root-wide** dry run. `--apply` needs explicit UI consent or headless `--confirm-prune`; eligible expired payloads become fail-closed tombstones and active/locked/corrupt records are skipped. No arbitrary-root/auth lookup/JS filesystem fallback/DSO cleanup. Native dry-run contents, inventory, permissions and mtime checks passed.
- 512MiB tracked payload per loaded core generation is **not RSS** (containers/allocator/runtime/old DSOs excluded). Per-root cache: 1GiB committed/4096 recognized regular records plus serialized 200MiB staging; unsafe/unrecognized/lock/legacy orphan files excluded. Expiry is 24h on access unless explicit maintenance, not secure erase or encryption.
- Tool-turn route pins are runtime-local through metadata changes, not cross-process migration; account/endpoint/model switches cannot borrow them. Quiescent fully reconciled rebuilding remains supported.
- Rollback requires explicit installation approval, the exact native/Pi/OpenCode package trio and full host restart; never assume journal backward compatibility, auto-clear unknown actions, copy `auth.json` or migrate tokens.

See [the operations runbook](https://github.com/berialcheng/cursor-harness-provider/blob/main/docs/OPERATIONS.md) for classified recovery, actual coverage, limits and rollback. Local qualification covers macOS arm64; consult the exact release's GitHub Actions run and provenance for remote platform evidence. No power-loss or live-service certification is claimed.

See LICENSE, THIRD_PARTY_NOTICES.md and licenses/. Source, capabilities and publication status: https://github.com/berialcheng/cursor-harness-provider .
