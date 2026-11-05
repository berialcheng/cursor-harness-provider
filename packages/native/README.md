# @cursor-harness-provider/native

Shared Rust protocol/session/recovery runtime and Node-API loader. Normally installed as a dependency of the Pi or OpenCode adapter.

Requires Node >=22.19 or the validated OpenCode Bun host. Binaries are selected by platform and verified against the version/SHA-256 manifest; no install script, Rust toolchain, download or JS/CLI inference fallback is used.

Release candidates target macOS 15+ (arm64/x64) and Linux x64 GNU (Ubuntu 22.04/glibc 2.35+). Only tested entries in the shipped manifest are supported; Windows, Linux arm64 and musl are not part of the initial release.

See LICENSE, THIRD_PARTY_NOTICES.md and licenses/ for attribution. This is experimental and unofficial, not endorsed by Cursor/Anysphere. Public package availability is determined by the release, not by the existence of this source README.
