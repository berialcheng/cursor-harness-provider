# Staged npm releases

Public package names are `@cursor-harness-provider/native`, `@cursor-harness-provider/pi` and `@cursor-harness-provider/opencode`. The root remains private. Provider/API/OAuth IDs and installed plugins are unrelated to npm package names and must not be changed by a release.

## Release model

`publish.yml` builds matching native targets, checks source and actual installed tarballs, aggregates matching commit/run/attempt/lockfile parts, then executes the exact merged tarballs on all three hosts. A final **stage-only** job is available only for an explicit main-branch manual dispatch with `stage_npm=true` and an exact version input.

```text
3 native builds + source/packed-host tests
  -> aggregate matching binaries, metadata and complete target notices
  -> verify merged native/Pi/OpenCode archives on all 3 native hosts
  -> protected npm-release environment approval
  -> OIDC npm stage publish: native, Pi, OpenCode
  -> maintainer inspection and npm 2FA approval (native first)
```

Pushes do not write to npm. No job runs direct `npm publish`, stage approval or unpublish. The staging job alone receives `id-token: write`; all other jobs remain `contents: read`. It uses GitHub-hosted Ubuntu, Node 22.22.0 and an isolated npm 11.21.0 CLI, no dependency/build cache, no persisted checkout credentials and no long-lived npm token or Secret. Workflow concurrency does not cancel active releases.

The publisher revalidates the same-run bundle against source, version, coverage, license and binary hashes before any upload, and rechecks every archive before each upload. It rejects foreign commits/runs/attempts, non-main/non-dispatch contexts and legacy token/config environment overrides. Ambiguous/nonzero uploads stop immediately without retries or following packages; reconcile the npm staging queue before another dispatch. Three-package releases are not transactional and versions cannot be overwritten.

## One-time setup for new package names

Trusted Publishers are configured on existing npm package entries. When a developer machine cannot reach the official registry, use the separate `npm-bootstrap.yml` workflow rather than forwarding credentials to a mirror:

1. Dispatch **one-time npm package bootstrap** on main, confirmation `create-three-public-package-placeholders`.
2. Review/approve the protected `npm-release` environment deployment.
3. Open the npm CLI login URL from the running job and confirm the expected account in the browser. Do not paste passwords, tokens or recovery codes into logs/chat. The CLI manages its temporary credentials; scripts never read the credential file.
4. The job checks `npm whoami` equals `berialcheng`, then stages metadata-only **0.0.0-bootstrap** candidates for absent names. npm creates public **0.0.0-stage** placeholders. These placeholders are not usable provider releases.
5. **Never approve the 0.0.0-bootstrap candidates.** Reject those setup candidates in npm after package settings become available. The real version comes from the verified OIDC pipeline, not these tiny setup payloads.
6. The job always attempts npm logout/revocation and removes only its runner-created private session directory. No credential/cache/session artifact is uploaded. If revocation fails or the job is interrupted, inspect/revoke the temporary login in npm before proceeding.

Only this explicit setup workflow may use an owner web-login session; it has no OIDC permission and cannot publish or approve a real version. Existing package entries are not modified. Failures after an upload may mean a placeholder was created: inspect npm before retrying. The login URL is an authorization request, not an access token; the expected owner check prevents another account from staging packages through that request.

## GitHub and npm configuration

Configure a GitHub environment named `npm-release`, with reviewer `berialcheng`, administrator bypass disabled, and only the **main branch** allowed (no tag patterns). Sole-owner self-review prevention must remain disabled so the human who dispatches can approve; this is not permission for an agent to bypass review. No npm token Secret is needed.

For each package, configure its Trusted Publisher:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| GitHub organization/user | berialcheng |
| Repository | cursor-harness-provider |
| Workflow filename | publish.yml |
| Environment | npm-release |
| Allowed actions | stage only; no direct publish or dist-tag management |

The npm organization name is not the GitHub owner field. Newly configured publishers must complete the first successful publish within two days or expire; configure them only when ready. After validating OIDC, require 2FA and disallow traditional publishing tokens. GitHub/public-package OIDC automatically generates provenance; do not disable it for real release candidates. This is distinct from the metadata-only bootstrap, which is not approved or advertised as a release.

## Execute a real release

1. Verify source/workspace/Cargo/native versions match and choose the intended main commit.
2. Dispatch `publish.yml` on main with `stage_npm=true` and version `0.3.0` (or the exact intentionally updated source version).
3. Require every same-run native build, aggregate and merged-tarball host gate to succeed, then review the protected environment deployment.
4. Inspect the three staged versions, provenance and integrity against the run's manifest/audit. The workflow does not automatically approve anything.
5. Approve **native first** with maintainer 2FA, then Pi and OpenCode. Never approve a bootstrap candidate.
6. Verify published versions, dependencies, registry integrity, provenance and installation from registry tarballs. A staged candidate or public placeholder is not a completed release. Do not switch an installed plugin without separate authorization.

## Artifact and license gates

`release.config.json` is the platform policy: darwin-arm64/aarch64-apple-darwin on macos-15, darwin-x64/x86_64-apple-darwin on macos-15-intel, and linux-x64-gnu/x86_64-unknown-linux-gnu on Ubuntu 22.04. Initial floors are macOS 15 and x64 GNU/glibc 2.35. Windows, Linux arm64 and musl are not advertised. Missing artifacts fail rather than downloading, compiling or using CLI/JS inference.

The root/upstream license texts are preserved. `licenses/locked-target-dependencies.json` is a source-controlled reference derived from locked, offline target Cargo metadata and bound to Cargo.lock/workspace-manifest hashes. Each native build independently checks membership/classification; package preparation/verification additionally requires each dependency's exact original notice paths and content hashes. A self-consistent supplied manifest is not proof of completeness. Regenerate with `npm run licenses:lock` after collecting/reviewing original notices from exact locked crates under `licenses/rust/<name>-<version>/`.

Each target retains its own full inventory and notices under the merged package's `licenses/targets/<platform>/`; files are not flattened or silently overwritten. The conservative normal closure includes proc macros/codegen and is not an exact runtime-link SBOM. The nine documented protoc-bin-vendored build-tool text gaps remain explicit exceptions, not distributed compiler binaries. This is not legal-compliance certification.

`npm run check` includes typechecking, Rust formatting/clippy/tests, builds, JS tests and real tarball acceptance. Actual tarballs are installed offline with scripts/peer auto-install disabled, verified for exact licenses/hashes, loaded with no Rust executable available, typechecked by a standalone consumer, then tested in six actual Pi/OpenCode host cases with local mock HTTP/2. Only provisioned host SDK peers are linked, not project workspaces. This is not live Cursor-service certification.

Build helpers in `pack-utils.mjs` permit only offline pack/install. Archive extraction rejects traversal, links/devices, duplicate/private paths and oversized data; the entire expanded TAR (including PAX/GNU headers) is byte-bounded before parsing with a 30-second subprocess deadline. Release export/aggregate/verify binds Git commit, both lock hashes, run and attempt. `--local` evidence is marked local-only and forbidden in CI. Existing output directories are not overwritten.

The merged CI artifact contains exactly native.tgz, pi.tgz, opencode.tgz and release-manifest.json, retained seven days. A successful artifact run does not itself publish anything. Historical source preflight 41992048529 for commit 2a9d175 passed all seven jobs; publishing-workflow changes require their own current-run gates.

References: [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing), [provenance](https://docs.npmjs.com/generating-provenance-statements).
