# Legacy test oracles

This directory is **test-only**. Production adapters must not import it or bundle
any of its JavaScript protocol, transport, or inference implementations.

- `pi-cursor/` retains the patched TypeScript port used by the original OpenCode
  tests. It derives from MIT-licensed pi-cursor 1.4.39, commit
  `ef3cafb5c38081ce6e06df8e594241aabd9621e3`; see its `LICENSE` and
  `UPSTREAM.json`. The metadata identifies the upstream source and original port
  patches, not a claim that these relocated files are unmodified upstream.
- `host/` is the host-neutral compatibility shim used only by that port. It does
  not import the Pi runtime.
- `opencode/` holds the old model/transcript adapter as a regression oracle. The
  production model lives in `packages/opencode/src/model.ts` and delegates to
  `@cursor-native/native`.

The full unmodified upstream source is separately preserved at
`vendor/pi-cursor/`. Only its auth/security/UI helpers may be reused at runtime;
its inference engine is not a production fallback.
