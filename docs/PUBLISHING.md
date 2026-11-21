# Automatic npm releases

Packages are `@cursor-harness-provider/native`, `/pi` and `/opencode`; the root remains private. npm names do not change host provider/API/OAuth identities. Publishing never switches an installed provider or reads host credentials.

## Routine operation: push, not approve

The owner has authorized accepted distributable-code changes on this repository's `main` branch to trigger automatic coordinated versions and **direct OIDC npm publication** once the one-time migration is complete and repository variable `AUTOMATED_NPM_RELEASES` is exactly `true`. An unset/false variable disables automatic publication. Other branches do not authorize a release.

```text
accepted main code change
  -> auto-release.yml: plan version + changelog
  -> one version-only commit and annotated vVERSION tag, atomic Git push
  -> explicit dispatch of publish.yml AT that immutable tag
  -> source/version/tag/main-ancestry gate
  -> 3 native builds and tested single-target packages
  -> aggregate matching source/run/attempt/locks/licenses/hashes
  -> actual merged-tarball acceptance on all 3 supported hosts
  -> OIDC npm publish: native, then Pi, then OpenCode
  -> automatic public registry, cryptographic provenance and installation checks
```

There is no release PR, routine environment reviewer, npm login, staged candidate or per-version 2FA prompt. Account 2FA stays enabled. Configuring trust/security permissions or recovering an account can still require the owner; an agent never supplies biometric/key presence, recovery codes or stored OTPs.

**Trust boundary:** after enabling this policy, accepted main code and its release workflows have publication authority. Removing human release reviews changes that boundary; it is not identical to the former stage-only maximum-security policy. Protect main/workflow changes and immutable tags accordingly.

## One-time migration

Do not repeat namespace initialization: all three real `0.3.0` packages already exist and were publicly verified. No new npm/PAT token, server or bootstrap is needed.

1. Qualify the new source locally and in current CI while the automation variable is disabled. A `publish.yml` dispatch on `main` with the exact current source version and `publish_npm=false` runs read-only source/build/package gates. It cannot deploy to the npm environment or publish. The standalone public verifier can also check the already-public `0.3.0` with the new verification code.
2. Keep each existing npm Trusted Publisher's owner/repository/workflow/environment identity below. Enable **Allow npm publish**; standalone `npm dist-tag` management is not needed by this workflow and should remain disabled. These optional-action changes do not require bootstrapping a package again.
3. In GitHub environment `npm-release`, remove the recurring required-reviewer rule, retain deployment-ref restrictions, and allow only the intended `v*` release tags. No npm token Secret is used. Do not add a tag ruleset for `v*` unless it is first proven to permit the coordinator's `GITHUB_TOKEN` tag creation; GitHub tag rules can block non-admin tag creation, which would break unattended releases. The pipeline's immutability fences (annotated-tag CAS push, no force, reuse detection) stand in until such a rule is validated.
4. Keep npm account2FA enabled. The recommended package policy disallows traditional bypass tokens while allowing OIDC. Its setup may require an additional real owner security-key confirmation; do not bypass that check or claim it completed before a fresh settings readback.
5. Set repository Actions variable `AUTOMATED_NPM_RELEASES=true`. For the initial controlled acceptance, dispatch `auto-release.yml` on `main` with `force_release=true`, `preview=false`; the coordinator chooses the version from the release history (the current `feat` release-tooling commits select `0.4.0`); it is never manually edited. Subsequent eligible main pushes require no release dispatch or approval.
6. Confirm the first direct publication and automatic public verification actually succeed. A tag or successful build alone is not a completed release. Keep existing local Pi/OpenCode providers unchanged unless separately authorized.

| npm Trusted Publisher field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization/user | berialcheng |
| Repository | cursor-harness-provider |
| Workflow filename | publish.yml |
| Environment | npm-release |
| Allowed actions | npm publish (npm stage publish remains implicit); no standalone dist-tag action |

Only `publish-npm` receives `id-token: write`. Version preparation alone receives narrowly scoped `contents: write` and `actions: write` through the temporary repository `GITHUB_TOKEN`; it neither reads its value nor persists credentials. Build/verification jobs use `contents: read`. No PAT or npm token is introduced.

## Versions and source identity

This first automation phase retains a unified root/native/Pi/OpenCode/Cargo version. Exact adapter-to-native dependency pins remain. The coordinator updates only its explicit allowlist of version manifests, two local Cargo.lock records, workspace npm-lock scalars, changelog and locked-license source hashes in one commit. Third-party lock records, notices and target dependency sets must remain byte-equivalent during a version-only change. A dependency-graph/license change must be reviewed and regenerated separately, not silently legalized by the version bot.

- Applicable fixes/refactors/build changes default to a patch.
- `feat` selects a minor; breaking changes select a minor while0.x, a major at1.x+.
- Docs/tests/.github-only changes do not automatically publish; ambiguous mixed changes are conservatively classified.
- Versions are canonical stable SemVer for now. No automatic prerelease channel is implied.
- An unused candidate version/tag may be skipped, never overwritten or reassigned.
- The Rust binary still embeds its real Cargo version. The native package, manifest and binary must agree; an old binary is never relabeled as a new version.

The version commit is created **before** building. The publisher tag, actual checkout, `GITHUB_SHA`, artifact identity and signed provenance therefore describe the same source. Bot `GITHUB_TOKEN` pushes do not normally start another workflow, so the coordinator explicitly dispatches `publish.yml` at its version tag. It does not fake `GITHUB_SHA`, build a dirty version tree or add a PAT to work around GitHub event semantics.

`auto-release.yml` also exposes `preview=true` for explicit testing: this creates a real version commit/tag but dispatches verification without npm writes. Its annotation records that publication mode. A preview tag is not repurposed for a public release; use the main-branch read-only dispatch for migration qualification instead of consuming the intended first public version.

Native/adapter independent versions are a separate future optimization, not implemented by merely relaxing checks. Reusing an unchanged published native package would require its unchanged version, exact registry digest/provenance and current adapter-pair acceptance; it must not be presented as a new same-run native build.

## Gates and performance

`release.config.json` defines macos-15 ARM, macos-15-intel and Ubuntu22.04 x64 GNU targets, with initial macOS15/glibc2.35 floors. Windows, Linux arm64 and musl are not advertised. Missing artifacts fail instead of compiling/downloading a runtime or using CLI/JS inference.

`npm run check:release` retains type checks, Rust fmt/clippy/tests, actual builds and JS/host tests. `release:export` then tests and exports the exact single-target tarballs once, avoiding a duplicate `test:packages` immediately beforehand. The final merged archives are still installed and executed on all three native platforms. Ordinary `npm run check` retains its own packed-package acceptance for local/PR checks.

The lightweight `check.yml` classifier delegates only unambiguous automatic main distribution pushes to the authoritative three-target release pipeline. PRs, non-main/manual/disabled-automation or uncertain classifications retain the original checks. Existing non-publishing Rust caches remain separate; release builds do not restore a compiled target cache. npm download caching is permitted; it does not replace source/native version checks or actual host acceptance.

The preparation and publication queues use GitHub's `queue: max` with `cancel-in-progress:false` (up to100 pending entries). Read-only release checks use a separate queue so they cannot replace a pending publisher. GitHub ordering is based on when work starts waiting, not necessarily dispatch order; publication also checks latest to prevent rollback. Queue overflow and service/account failures are exceptional failures, not reasons to silently publish unverified code.

## Registry writes, reconciliation and verification

Direct publication requires the expected repository and exact `publish.yml` workflow at `refs/tags/vVERSION`, the enabled switch, current source/run/attempt/lock binding, Node22.22.0/npm11.21.0 and OIDC endpoints. Empty/case-varied traditional token/config or Node/TLS injection overrides are rejected. Config files and caches are private, separate and temporary. No raw child output, auth endpoint values or environment dumps are exposed.

Before every upload, all archive hashes are rechecked. Public version/latest lookups must be known; only explicit404 means absent. Existing versions can be reused only when exact bytes and source/provenance match. A newer latest is never moved backward. A nonzero upload may already have been accepted: bounded registry reads reconcile it, without another upload or blindly continuing. Irreconcilable/foreign data stops the release and signals failure. Three npm packages are **not a cross-package transaction**; already-published versions are not deleted to simulate rollback.

Read-only post-publication reconciliation also runs after attempted/partial publisher failures. It derives expected bytes from the same-run verified bundle, checks every observed accepted package cryptographically, and reports missing/unknown versions honestly. Complete cohorts additionally require the actual isolated Pi/OpenCode host cases. Partial/absent cohorts are not successful releases.

Public verification compares archive SHA256/SHA1/SRI, exact names/versions/native dependencies and installed lock entries. It checks source/ref/digest/producer claims from the **cryptographically verified attestation bundles returned by pinned npm's audit**, not only a separately fetched unsigned observation. Explicit per-package producer maps support genuine same-source partial-release reuse without pretending every package came from the current run. The standalone read-only verifier supports the same producer map, and has only the narrowly pinned historical0.3.0/main provenance exception.

## License and archive integrity

Root/upstream license texts are preserved. `licenses/locked-target-dependencies.json` is an independent locked Cargo reference bound to Cargo.lock/workspace manifests; each target verifies graph membership/classification and original notice paths/hashes. A self-consistent supplied inventory is not proof of completeness. Real dependency changes require reviewed notices and `npm run licenses:lock` before release.

Merged notices remain under `licenses/targets/<platform>/`; they are not flattened. Normal closure conservatively includes proc macros/codegen, not an exact runtime-link SBOM. The nine disclosed protoc-bin-vendored build-tool text gaps remain exceptions, not distributed compiler binaries or legal-compliance certification.

`pack-utils` permits only offline pack/install. Extraction rejects traversal, links/devices, duplicates/private paths and oversized input, including PAX/GNU expanded-byte budgets and subprocess deadlines. Local-only evidence cannot become CI release evidence. Same-run parts bind commit/run/attempt/locks and tested target coverage. The seven-day bundle artifact contains exactly the three tarballs plus release-manifest.json; a successful artifact run alone does not imply publication.

## Historical bootstrap and manual staging

The one-time stage-only bootstrap credential was revoked and `NPM_BOOTSTRAP_TOKEN` removed after namespace initialization. Do not create another token or repeat bootstrap for these existing packages. Never approve `0.0.0-bootstrap`. Its candidates remain pending; rejection/unpublish is not automatic, even though the real0.3.0 packages are now public and verified. Rejecting the sole candidate of a new package before a real release could remove its namespace/trust and trigger name cooldown; that historical safety rule remains relevant to any separately authorized future namespace setup.

`stage-release.mjs` and its regression tests document the previous owner-approved staging flow; they are not the unattended publisher. Normal releases do not call `npm stage publish`, `npm stage approve`, `npm login` or `npm unpublish`. Account credentials, recovery codes and installed-provider state are never migrated by releasing.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing), [GitHub token-trigger semantics](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [GitHub concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
