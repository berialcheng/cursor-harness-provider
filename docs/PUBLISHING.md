# npm release design

Status: **proposal, not an enabled publishing workflow**. Source push authorization does not authorize an npm publish, stage, tag, account change or installed-plugin switch.

Reviewed 2026-11-04 against the current package layout and npm documentation. The [first successful public CI run](https://github.com/berialcheng/cursor-harness-provider/actions/runs/41799648850) checked macOS and Linux. It did not publish or retain distributable binaries.

## Recommended package model

Keep the root workspace private and publish three packages: the shared native loader/binaries, the Pi adapter, and the OpenCode adapter. Use a confirmed, owner-controlled npm scope; neither the GitHub username nor the Git author email establishes npm ownership. Do not assume the current `@cursor-native` scope is available to this project.

Final npm names remain a user decision. Renaming npm workspaces requires updating imports, exact native dependencies and the lockfile, but must not rename the stable host provider, OAuth, API or session identifiers.

For the first release, put the tested platform binaries together in the native package. This matches the existing relative `native/manifest.json` loader. Per-platform optional packages are a later size optimization and require a loader change, not just a CI matrix.

## Observed release blockers

`npm pack --dry-run --ignore-scripts --json` was run for all three workspaces:

| Area | Current result | Required preparation |
| --- | --- | --- |
| Publish permission | All packages have `private: true` | Keep root private; enable only approved publishable workspaces |
| Native types | Export points to `src/index.ts`, absent from tarball | Emit declarations and export the included `dist/index.d.ts` |
| Licenses | No workspace tarball includes `LICENSE` | Include the project license in every package |
| Notices | Pi includes a notice; native/OpenCode do not | Assemble package-appropriate attribution and actual referenced license texts |
| Native platforms | Local tarball contains only darwin-arm64 | Build, test and merge the explicitly supported target set |
| Registry metadata | No publish/repository configuration | Set public access, npmjs registry, repository URL and workspace directory |

Add package-level READMEs and a tested Pi peer-dependency range. Test the real tarballs, not workspace symlinks. Re-run the production bundle guard so no reference JS protocol engine or cross-host SDK enters a release.

## Native build policy

Candidate initial targets are macOS arm64/x64 and Linux x64 GNU, but include a target only after its native Node/Bun host tests pass on matching architecture. Pin runner architecture and Rust target explicitly rather than inferring architecture from a mutable image label. Define the minimum macOS/glibc versions; success on Ubuntu 22.04 does not prove compatibility with every GNU/Linux distribution.

Do not advertise Windows, musl or Linux arm64 until those builds and host tests exist. Windows journal support is currently absent.

Each matrix job must produce its binary, platform manifest entry and target-specific license inventory. The aggregation job must:

- Verify one source commit and version across root/workspaces, Cargo crates, binding and manifests.
- Reject duplicate/missing platform entries, mixed versions and SHA-256 mismatches.
- Merge target-specific notices into a distribution inventory, preserving upstream attribution and documented build-tool limitations; do not claim legal certification.
- Build from the release commit in CI, not upload a developer's local binary.
- Install packed packages into a clean consumer fixture and exercise real Pi/OpenCode permission and tool-result flows without real Cursor credentials.
- Demonstrate installation with lifecycle scripts disabled and no Rust toolchain. Missing/unsupported binaries must fail clearly, with no download, compilation, CLI or JS inference fallback.

## Proposed GitHub release pipeline

```text
approved vX.Y.Z tag on a trusted main commit
  -> verify versions and run checks
  -> native build/test matrix (no publishing credentials)
  -> merge binaries/manifests/notices
  -> npm pack + isolated tarball installation/host smoke tests
  -> protected npm-release environment
  -> OIDC stage candidates
  -> maintainer 2FA approval: native first, then adapters
```

Use `needs` inside the release workflow to enforce the gates. A separate check workflow happening to run on the same tag does not gate publishing automatically. Do not publish from pull requests or consume artifacts from an untrusted fork workflow.

Publish only the approved workspaces, never an unconditional root/workspaces publish. npm versions are immutable and a three-package release is not transactional: native must be available before adapters depending on it become available. Handle partial releases explicitly; never automatically unpublish or overwrite a version.

Use maintained actions pinned to reviewed commit SHAs. Disable release dependency/build-cache restoration initially; keep the privileged publishing job minimal and consume only verified artifacts from the same trusted run. Give `id-token: write` only to the publishing job, with `contents: read`; no `packages: write` is needed for npmjs.com. Protect the release environment and tag creation.

## npm authentication and first-release setup

Use [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers/), not a long-lived `NPM_TOKEN`. npm's `GITHUB_TOKEN` example for GitHub Packages is a different registry and is not npmjs authentication.

Before enabling publishing:

1. Confirm the actual npm account/scope, package names and 2FA with the owner. No credentials need to be placed in this repository or chat.
2. Bootstrap package ownership if needed. [Staged publishing](https://docs.npmjs.com/staged-publishing) supports new packages: an authenticated maintainer can stage a package, creating a **public `0.0.0-stage` placeholder**, while candidate contents remain unavailable until approval. This is still a registry write and needs explicit authorization. Do not assume OIDC can bootstrap an unconfigured new package by itself.
3. Configure a trusted publisher separately for each package: GitHub owner `berialcheng`, repository `cursor-harness-provider`, workflow filename `publish.yml` (not the full path), and environment `npm-release`. The proposed workflow must exist before activation.
4. Create the configuration shortly before the release. npm requires its first successful publish within two days or the configuration expires.
5. Start with stage-only permissions and approve candidates with maintainer 2FA. New trusted publishers default to staging; direct `npm publish` must be explicitly allowed if chosen later. After verification, restrict traditional publishing tokens in npm settings.

Use GitHub-hosted runners. Current minimum versions are Node 22.14+, npm 11.5.1+ for basic OIDC, and npm 11.15+ for staged publishing. If CI manages dist-tags, npm documents 11.21+ or 12.2+ and a separate **Allow npm dist-tag** permission. Pin a compatible, verified CLI version explicitly; installing Node alone does not guarantee a sufficiently new npm CLI. Do not use `npm whoami` as an OIDC permission test.

For public packages from this public repository, npm OIDC publishing supports automatic provenance. Verify the published attestation and tarball integrity; a provenance statement does not replace tests or license review. No persistent npm token, host OAuth store, Cursor token or developer journal belongs in an artifact.

The next implementation step is packaging/preflight work plus confirmation of the npm namespace. No `publish.yml`, version tag, npm staging operation or npm release was created by this design.
