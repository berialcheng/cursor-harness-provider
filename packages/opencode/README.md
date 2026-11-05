# @cursor-harness-provider/opencode

Unofficial Cursor model access for OpenCode 2.2.5, backed by the shared Rust runtime.

For a published version, add this npm package to your OpenCode plugins list:
```json
{ "plugins": ["@cursor-harness-provider/opencode"] }
```

Replace the prior Cursor plugin entry rather than loading both. Reload only when idle. Provider/model remains cursor-native/auto and the existing cursor-pkce authentication method is retained. Host credentials, journals and permissions are not migrated or bypassed.

Native platform support follows the native package manifest. This is experimental, not endorsed by Cursor/Anysphere, and makes no performance or billing claims.

See LICENSE, THIRD_PARTY_NOTICES.md and licenses/. Source and publication status: https://github.com/berialcheng/cursor-harness-provider .
