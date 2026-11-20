# cursor-harness-provider

Unofficial native Cursor providers for **Pi** and **OpenCode**: one Rust protocol/session/recovery core, two thin host adapters.

- In-process HTTP/2 + Connect/protobuf; no Cursor Agent CLI inference process.
- No local model HTTP proxy and no JavaScript inference fallback.
- Separate credentials, session identities and tool permission gates for each host.

Not affiliated with or endorsed by Cursor/Anysphere. Use only an account you are authorized to access. Cursor can change its protocol at any time.

## Status

**0.3.0, experimental.** Current local qualification: macOS26.7.1 arm64, Node22.22.0, Rust1.99.1, Pi1.4.0/1.5.1 and OpenCode2.2.5/Bun1.3.13.
This source migration was verified against local mock Cursor HTTP/2 in the real hosts. It is not a fresh live-service certification of every model or feature.
The earlier single-host Rust implementation had live Auto text/tool smoke tests; do not confuse those with full dual-host acceptance.
The earlier 2026-11-10 audit recorded 112 Rust / 377 JS tests. **Current operational hardening passed 126 Rust tests and 512 JS/host tests in 48 files**, plus offline-installed packed-host gates on Pi1.4.0 and Pi1.5.1. SDK1.5.1 additionally passed 121 injected-engine ownership/lifecycle tests. See [dated evidence](docs/VALIDATION.json) and [operations/rollback](docs/OPERATIONS.md). These are local mock-backed passes, not live-service, minimum-OS or fresh remote three-target certification.
Source is hosted on [GitHub](https://github.com/berialcheng/cursor-harness-provider). See [Actions](https://github.com/berialcheng/cursor-harness-provider/actions) for current remote CI results; local validation is not proof of a successful remote run. Setup placeholders are not provider releases; see the registry and staged-release workflow for the current publication state.

## Layout

```text
crates/cursor-core/    # Pure Rust transport, protobuf, sessions, journals/recovery
crates/cursor-node/    # Node-API binding (owned asynchronous Rust values)
packages/native/      # One versioned/hash-checked native module loader
packages/opencode/    # OpenCode LanguageModelV3 + OAuth integration
packages/pi/          # Pi stream, authentication and commands
vendor/pi-cursor/     # Pinned MIT upstream source/protocol reference
test/reference/       # Earlier JS implementation, test oracles only
licenses/             # Locked target-specific third-party notice inventory
```

Planned public packages use `@cursor-harness-provider/native`, `/pi` and `/opencode`. The root workspace remains private. Host provider/OAuth identifiers are retained; Pi uses the distinct `cursor-native-rust` API without overriding the old API. npm package names are a separate layer.

## Build

Requires Node>=22.19 and **an existing Rust toolchain >=1.99.1**. No automatic toolchain installation or global PATH changes.
```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run check
```

Cargo output lives outside this watched repository. `CARGO_TARGET_DIR` can select an existing external cache.
Source and native package versions must match. `npm run build` checks Cargo/workspace versions and writes a SHA-256 manifest.
The build also emits native TypeScript declarations and assembles project/upstream/Rust license texts into the workspace packages. `npm run check` packs and installs all three tarballs offline with lifecycle scripts disabled, then checks native loading without a Rust toolchain and an isolated TypeScript consumer. It also runs actual Pi/OpenCode text/read-allow/read-deny flows from the installed tarballs, using provisioned external host SDK peers and a local mock upstream. Multi-platform execution is verified by the separate read-only release-preflight workflow, not inferred from local tests.
A git checkout is not a precompiled distribution: missing/mismatched native binaries fail clearly, never silently compile or fall back to CLI/JS.

Initial local development used an existing npm mirror after public npm connections were reset. The committed lockfile uses canonical public npm URLs with unchanged integrity hashes. A subsequent [clean GitHub Actions run](https://github.com/berialcheng/cursor-harness-provider/actions/runs/41799648850) passed public-registry installation and the checks on macOS and Linux.

## Load locally

Build and qualify exact artifacts first. The following are **manual installation instructions requiring explicit installation approval**, not changes performed by this migration. Rollback requires the exact native/Pi/OpenCode package trio and a full host restart; do not assume journal backward compatibility. See [operations](docs/OPERATIONS.md).

### OpenCode 2.2.5

Configure the plugin **package directory**, not its JavaScript file:
```json
{
  "plugins": ["/absolute/path/to/cursor-harness-provider/packages/opencode"]
}
```
Keep your other plugins/settings. Replace the old local Cursor plugin entry, rather than loading both.
Provider/model remains `cursor-native/auto`; the existing OAuth integration ID is retained. Reload OpenCode only when no request is active.
Credentials and previous journal/cache directories are not moved.

### Pi

Avoid loading both this provider and `@rahularya01/pi-cursor` in one Pi process:
```sh
pi remove npm:@rahularya01/pi-cursor
pi install /absolute/path/to/cursor-harness-provider
```
Restart Pi or use `/reload` when idle. Provider/model remains `cursor/auto`, with the distinct Rust API `cursor-native-rust`.
Pi loads a tiny TypeScript shim: private-root `packages/pi/src/extension.ts`, public-package `dist/extension.ts`. It bridges Pi's actual host registry to the compiled backend; `dist/index.js` remains a programmatic export, **not a manual extension entry**. Source and offline-installed packed entries passed actual-host checks on Pi1.4/1.5.
Use `/login cursor` for browser OAuth or explicit CLI/IDE credential reuse. Never paste a token into this repository.
`/cursor.models`, `/cursor.doctor` and `/cursor.usage` expose the implemented catalog/diagnostics/usage RPC. Model discovery enriches the basic catalog with explicit image and parameter-variant metadata; Pi persists public catalog snapshots for offline restart. Max Mode and reasoning `max` remain separate selections, with only advertised combinations exposed.
Images must arrive as Pi attachments or host-authorized image tool results; plain clipboard/file paths are never read automatically by the provider.
`PI_CURSOR_SYSTEM_CREDENTIALS=0` disables legacy CLI/IDE credential lookup; reuse is access-token-only and never rotates an external refresh pair.
Host-owned OAuth expiry refresh/persistence stays inside Pi; an unchanged rejected token requires reconnecting rather than unsafe shadow refresh-token rotation.

**Important:** This is not a blanket upstream feature-parity or live-service certification. See [capabilities](docs/CAPABILITIES.md) and the [replacement validation](docs/Pi_REPLACEMENT_REVIEW.md) before replacing a working provider. Existing installed providers are not changed by building or testing this repository.

## Operational recovery — locally qualified

Provider-initiated auth callbacks default to 25s, configurable within **1–30000ms** via `PI_CURSOR_AUTH_TIMEOUT_MS` / `OPENCODE_CURSOR_AUTH_TIMEOUT_MS`; this is not a whole human-login or tool deadline. Cancelled/replaced owners must not apply late results. `/cursor.doctor` reports request phases and recovery/resource snapshots. `/cursor.reset` without arguments only lists help/scopes; discarding a known full scope requires explicit UI confirmation or `--scope HASH --confirm-discard`. It stops its own requests/drains native starts; the default 5s timeout (`PI_CURSOR_RESET_TIMEOUT_MS`, at most 5000ms) leaves the scope fenced, not successfully reset. It never undoes tools.

`/cursor.cache --scope HASH` anchors **root-wide** dry-run maintenance; `--apply` requires explicit UI consent or headless `--confirm-prune`. Eligible expired payloads become fail-closed tombstones; active/locked/corrupt records are skipped. No arbitrary-root reads, auth lookup, JS filesystem fallback or DSO cleanup. The 512MiB tracked-payload budget is per loaded core generation, **not RSS**; root cache quotas are 1GiB committed/4096 recognized regular records plus serialized 200MiB staging. Local storage/accounting and dry-run inventory checks passed; exclusions and noninterruptible-I/O limits are in the [runbook](docs/OPERATIONS.md). This is not encryption or secure erase.

Runtime-local tool-turn route pins survive metadata changes, not process migration. Account/endpoint/model changes cannot borrow turns; fully reconciled quiescent rebuilding remains supported.

## Safety and limitations

All file/shell/network tool actions stay at the host's permission gate. Prohibited native execution/interaction bodies are handled before protobuf allocation and denied with typed failures, never fake success; supported context queries still return registered host context. This is not an OS sandbox.
Journals can contain full prompts/tool data. Private file permissions are not encryption. Pi/OpenCode use separate host namespaces.
Uncertain actions, mixed/unknown executable protocol messages, and unsafe partial-output replays fail closed. No exactly-once guarantee.
No performance, quota, cache savings or billing superiority is claimed.

## Package releases

The [release guide](docs/PUBLISHING.md) describes `publish.yml`: native-host builds, per-target license/binary aggregation and verification of the exact merged tarballs. Pushes are preflight-only; an explicit main-branch dispatch can stage the verified bundle through OIDC after protected-environment approval. npm maintainer 2FA approval is still required to make versions live. The separate one-time bootstrap workflow uses a temporary scope-limited stage-only token to create metadata setup candidates and public placeholders, never a usable provider release; it no longer waits for an interactive owner login in CI. The token must be revoked and its GitHub Secret removed after use. Never approve bootstrap candidates. Defer any rejection until a real version is publicly published and verified. Installed-plugin changes remain separately authorized.

## Provenance

Adapted from MIT [pi-cursor1.4.39](https://github.com/Rahularya01/pi-cursor), pinned at `ef3cafb5c38081ce6e06df8e594241aabd9621e3`.
Source/schema licenses and attribution are retained; the JS wire engine is excluded from production bundles.
See [third-party notices](THIRD_PARTY_NOTICES.md) and the generated license inventory. No legal-compliance certification is implied.
