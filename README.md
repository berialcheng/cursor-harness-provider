# cursor-harness-provider

Unofficial native Cursor providers for **Pi** and **OpenCode**: one Rust protocol/session/recovery core, two thin host adapters.

- In-process HTTP/2 + Connect/protobuf; no Cursor Agent CLI inference process.
- No local model HTTP proxy and no JavaScript inference fallback.
- Separate credentials, session identities and tool permission gates for each host.

Not affiliated with or endorsed by Cursor/Anysphere. Use only an account you are authorized to access. Cursor can change its protocol at any time.

## Status

**0.3.0, experimental.** Locally validated on macOS arm64 with Node22.22, Rust1.99.1, Pi1.4/1.5 and OpenCode2.2.5/Bun.
This source migration was verified against local mock Cursor HTTP/2 in the real hosts. It is not a fresh live-service certification of every model or feature.
The earlier single-host Rust implementation had live Auto text/tool smoke tests; do not confuse those with full dual-host acceptance.
Source is hosted on [GitHub](https://github.com/berialcheng/cursor-harness-provider). See [Actions](https://github.com/berialcheng/cursor-harness-provider/actions) for current remote CI results; local validation is not proof of a successful remote run. No npm package or binary release has been published.

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

Internal workspace package names (`@cursor-native/*`) and host provider/API IDs remain stable for compatibility; they are not the repository name.

## Build

Requires Node>=22.19 and **an existing Rust toolchain >=1.99.1**. No automatic toolchain installation or global PATH changes.
```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm run check
npm run licenses
```

Cargo output lives outside this watched repository. `CARGO_TARGET_DIR` can select an existing external cache.
Source and native package versions must match. `npm run build` checks Cargo/workspace versions and writes a SHA-256 manifest.
A git checkout is not a precompiled distribution: missing/mismatched native binaries fail clearly, never silently compile or fall back to CLI/JS.

Initial local development used an existing npm mirror after public npm connections were reset. The committed lockfile uses canonical public npm URLs with unchanged integrity hashes. A subsequent [clean GitHub Actions run](https://github.com/berialcheng/cursor-harness-provider/actions/runs/41799648850) passed public-registry installation and the checks on macOS and Linux.

## Load locally

Build and test first. The following are **manual installation instructions**, not changes performed by this migration.

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
Use `/login cursor` for browser OAuth or explicit CLI/IDE credential reuse. Never paste a token into this repository.
`/cursor.models`, `/cursor.doctor` and `/cursor.usage` expose the implemented catalog/diagnostics/usage RPC.
`PI_CURSOR_SYSTEM_CREDENTIALS=0` disables legacy CLI/IDE credential lookup.
Host-owned OAuth expiry refresh/persistence stays inside Pi; an unchanged rejected token requires reconnecting rather than unsafe shadow refresh-token rotation.

**Important:** This is not full upstream Pi feature parity. See [capabilities](docs/CAPABILITIES.md) before replacing a working provider.

## Safety and limitations

All file/shell/network tool actions stay at the host's permission gate; Cursor-native local/fetch operations are rejected. This is not an OS sandbox.
Journals can contain full prompts/tool data. Private file permissions are not encryption. Pi/OpenCode use separate host namespaces.
Uncertain actions, mixed/unknown executable protocol messages, and unsafe partial-output replays fail closed. No exactly-once guarantee.
No performance, quota, cache savings or billing superiority is claimed.

## Package releases

npm releases are not enabled. The [publishing design](docs/PUBLISHING.md) records tarball gaps, native build requirements and the proposed OIDC/staged-approval pipeline. Final package names and registry operations require separate authorization.

## Provenance

Adapted from MIT [pi-cursor1.4.39](https://github.com/Rahularya01/pi-cursor), pinned at `ef3cafb5c38081ce6e06df8e594241aabd9621e3`.
Source/schema licenses and attribution are retained; the JS wire engine is excluded from production bundles.
See [third-party notices](THIRD_PARTY_NOTICES.md) and the generated license inventory. No legal-compliance certification is implied.
