# Third-party notices

The project's MIT license is included in `LICENSE`. An unchanged copy of the
upstream license is also included in `licenses/pi-cursor/LICENSE`.
Pi SDKs remain external host-provided peers. Rust dependency notices are supplied
with the separate native dependency package.

## pi-cursor

`src/auth/oauth.ts`, `src/auth/system.ts`, and
`src/context-normalize.ts` adapt authentication and pure prompt-framing helpers
from `@rahularya01/pi-cursor` 1.4.39, upstream revision
`ef3cafb5c38081ce6e06df8e594241aabd9621e3`.
Authentication helpers also credit Ephraim Duncan's opencode-cursor upstream.

The adaptations use injected I/O, Pi-owned persistent OAuth transactions and
native V3 transcript parts. No upstream inference/stream/HTTP2 client is used in
this production adapter. The source reference is retained in `vendor/pi-cursor`
in the repository.

MIT License

Copyright (c) 2026 Rahul Arya

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
