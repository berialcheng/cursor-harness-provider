# Third-party notices

## pi-cursor
This project includes and adapts MIT-licensed source/schema from [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor), version1.4.39, commit `ef3cafb5c38081ce6e06df8e594241aabd9621e3`.
The original copyright/license is preserved in `vendor/pi-cursor/LICENSE`.
The unchanged source snapshot is reference/provenance, not the runtime inference engine.
`test/reference/pi-cursor` contains the earlier ported JavaScript implementation solely for regression oracles, with its original license and patch manifest.
Pi's adapted infrastructure normalization includes a separate notice in `packages/pi/THIRD_PARTY_NOTICES.md`.
The upstream acknowledges community lineage from ephraimduncan/opencode-cursor and @pi-stef/cursor; see its README.

## Rust dependencies and native binaries
`licenses/rust-dependencies.json` is a conservative, locked, target-specific dependency inventory.
It includes build and test dependencies, not an exact list of statically linked runtime objects.
Upstream license/copyright/notice files are retained under `licenses/rust`.
NAPI crates missing license text in their published crate archives use exact-vcs-commit upstream notices, with origins in `licenses/upstream-notices.json`.
The remaining protoc-bin-vendored family is build tooling, not shipped in the .node module; its SPDX metadata is recorded, and notice-text gaps are explicitly marked.
No blanket legal-compliance certification is claimed. Re-run `npm run licenses` on every target before distributing a native release.
The inventory now classifies Cargo's conservative normal dependency closure separately from build/test-only dependencies and inactive target/optional entries. `npm run build` also assembles self-contained workspace license copies; `npm run check` verifies their actual tarballs. Missing normal-dependency texts fail preparation; the known protoc build-tool gaps remain explicitly listed and are not declared resolved.

## Host SDKs
Pi libraries are external, host-provided peer dependencies, not bundled copies.
OpenCode's MIT SDK is a type-only development dependency.
Development/test dependencies are not included in the native runtime module.
The repository's npm overrides pin patched undici8.12.3 for the development Pi SDK; SDK transitive moderate/low audit findings remain recorded in the validation report.
