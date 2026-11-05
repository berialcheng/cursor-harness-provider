# cursor-harness-provider development contract
One Rust core for Pi and OpenCode. Remote creation, commits, pushes, publishing and installed-plugin switches each require explicit user authorization. A source push does not authorize an npm release. Ordinary task; do not create/focus persistent goals. Existing installed plugins must remain untouched until verification. Never open/copy auth.json, tokens or OS credentials; test with fixtures. No toolchain installation or global PATH/registry changes.

## Layout/ownership
- crates/cursor-core: pure Rust engine/protocol/transport/journal/prost; no N-API dependencies.
- crates/cursor-node: Node-API binding only; futures own Rust values (do not use napi2 async &self).
- packages/native: shared loader/typed API; RustEngine interface stays compatible with existing start(JSON,token),listModels(token,url?),remove(scope),shutdown; RustStream.nextEvent/cancel/setAccessToken. Version0.3.0 from package manifests (not hardcoded).
- packages/opencode: adapter with same providerID cursor-native and existing OAuth method; import runtime from @cursor-harness-provider/native. Never import Pi runtime/JS protocol engine.
- packages/pi: Pi provider cursor, API cursor-native-rust (avoid globally overriding old API until actual replacement), imports runtime from @cursor-harness-provider/native. Thin conversion/lifecycle/auth/UI only, no JS HTTP2/Connect/protobuf inference/CLI. Pi host libraries peer(*) and external, never bundle.
- vendor/pi-cursor: unmodified MIT upstream1.4.39 at ef3cafb5c38081ce6e06df8e594241aabd9621e3 source reference, auth/UI helpers may be reused with attribution, not stream/client inference. test/reference/pi-cursor is the old ported TS implementation for test oracles only.
- scripts/build.mjs main agent; Rust scripts core worker; OpenCode-specific dev scripts OpenCode worker.

## Safety/compatibility
Account/workspace/model/session/request-kind isolation; add host namespace so Pi/OpenCode cannot share checkpoints. Keep tools at each host permission gate; never perform native file/shell/fetch actions. Maintain conservative uncertain-action/partial-output retry, mixed protobuf oneof failclosed, alone observed update27 ignored without progress/finish. Preserve NAPI rejected receiver GC and SDK activation nonce/retry:false. No live Cursor calls by workers. No push/commit/create remote by workers.
Use existing configured Cargo-home or PATH-selected Rust tools with command-local env only; never install tooling automatically. Keep rustup proxy basenames intact. Set CARGO_TARGET_DIR to a known external Cargo cache when reusing earlier build outputs; no target directory inside the watched repository. Root version0.3.0, all packages/Cargo/native version must match.
Release preparation is registry-read-only: scripts permit offline pack/install only; publish.yml must not stage/publish or request registry-write credentials in this phase. Release parts must match commit/run/attempt/lock hashes and have target-specific license coverage and packed-host evidence. Do not weaken validation to accept untested targets.
Return limitations honestly. Do not advertise advanced Pi capabilities without implemented routing/tests. Check the installed Pi docs (packages.md, custom-provider.md, extensions.md and sdk.md) and examples before changing the extension API.
