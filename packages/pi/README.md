# @cursor-harness-provider/pi

Unofficial Cursor model access for Pi, backed by the shared Rust runtime.

For a published version:
```sh
pi install npm:@cursor-harness-provider/pi
```

Do not load this provider alongside another Cursor provider. Restart/reload when idle, select cursor/auto, and use /login cursor for authentication. Credentials and tool permissions remain owned by Pi; never place a token in this package.

Validated host families: Pi 1.4/1.5, Node >=22.19. Native platform support follows the native package manifest. Max/structured-parameterized models and HTTP-header instrumentation are not full upstream feature parity.

See LICENSE, THIRD_PARTY_NOTICES.md and licenses/. Source, capabilities and publication status: https://github.com/berialcheng/cursor-harness-provider .
