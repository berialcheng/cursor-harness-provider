# Third-party notices

The project's MIT license is included in `LICENSE`.

## pi-cursor source and schema

The Rust protocol/session implementation adapts source/schema from MIT-licensed
`Rahularya01/pi-cursor` 1.4.39, revision
`ef3cafb5c38081ce6e06df8e594241aabd9621e3`.
The original copyright and full license are included in `licenses/pi-cursor/LICENSE`.
The upstream JavaScript inference engine is not included in this package.

## Rust dependencies

`licenses/rust-dependencies.json` records the locked, target-specific Cargo
inventory. This is conservative: it includes build/test dependencies and normal
proc-macro/codegen dependencies, not just statically linked runtime objects.
The referenced license/copyright/notice texts are included under `licenses/`.
Exact-commit origins for crate-archive notice gaps are recorded in
`licenses/upstream-notices.json`.

`licenses/distribution.json` records the covered target, license file hashes and
explicitly identified build-tool text gaps. The protoc-bin-vendored tool family
is used only while building and its compiler binaries are not distributed in
this package. Its metadata-only entries are not a claim of complete license
text collection or legal-compliance certification.
