# Operations and rollback

## Status / evidence boundary

**Local operational-hardening acceptance: PASS (2026-11-10).** `VALIDATION.json` → `operationalHardening20261110` records 126 Rust tests, 512 JS/host tests in 48 files, 121 SDK1.5.1 injected-engine tests and actual offline-packed Pi1.4.0/1.5.1 gates. Local environment: macOS26.7.1 arm64, Node22.22.0, Rust1.99.1, OpenCode2.2.5/Bun1.3.13. Historical 112/377 evidence is retained separately. No installed provider was changed. Fresh remote three-target/minimum-OS, live Cursor and power-loss certification remain unperformed.

## Diagnose before changing state

1. Stop submitting new work to the affected runtime; retain the authoritative host transcript and tool call/result identities. Check whether tools actually ran through the host permission gate before considering another attempt.
2. In Pi, use `/cursor.doctor` for native version, lazy/session-owned engine, request counts, phases, known-scope/pinned-route capacity, recovery flags and available numeric resource counters. Phases are `idle`, `auth`, `preparing`, `start`, `streaming`, `awaiting-tools`, `error`, `aborted`, `fenced`; counters are snapshots, not proof of completion or tool non-execution. A fenced scope can outlive an active request. Diagnostics do not start an engine for resource statistics.
3. Use `/cursor.models --cached` for the current Pi catalog without discovery/auth lookup. No-argument `/cursor.reset` and `/cursor.cache` list known scopes/help only. Retain only sanitized errors, phases and exact artifact hashes; do not attach prompts, journals, tokens, `auth.json` or OS credentials to incident reports.
4. Classify the failure before retrying:

| Classification | Operator action |
|---|---|
| Provider auth wait timeout / caller abort | Stop that wait; check action uncertainty before any deliberate retry under the same live owner. For rejected unchanged credentials use the host login flow; never copy or migrate tokens. |
| Account, endpoint, model or owner mismatch | Restore the intended identity/configuration; never borrow another scope, catalog or tool turn. |
| Transport/transient failure before exposed output/actions | Only the core's existing conservative replay checks may allow retry; a timeout alone is not proof of safety. Do not add blanket retries. |
| Partial output, offered tools, missing results or unknown action outcome | Preserve the fence/records; reconcile against host-authoritative results. No automatic replay, reset or clear. Tools may already have effects. |
| Protocol ambiguity, corrupt/locked state, capacity exhaustion | Fail closed; preserve evidence, quiesce owners and investigate. Do not bypass validation, delete locks or clear uncertain records to obtain a pass. |
| Reset/cache timeout | State remains fenced; report incomplete maintenance, not success. Observe/drain outstanding work before another authorized operation. |

### Auth waits and route ownership

Provider-initiated auth resolution/refresh callbacks default to **25 seconds**, configured with `PI_CURSOR_AUTH_TIMEOUT_MS` / `OPENCODE_CURSOR_AUTH_TIMEOUT_MS`, within **1–30000 milliseconds**. This bounds callback waiting, not a human browser login, host storage transaction, whole inference request or tool deadline. Cancellation/replacement wins and late results must not update expired operations. A host transaction that ignores signals may continue. Shared helpers are an opt-in `@cursor-harness-provider/native/lifecycle` export; the core RustEngine declarations still pass the isolated ES2023-only consumer gate.

Pi payload and provider-event hooks share this configured callback-wait budget. A timeout stops the provider's wait, not arbitrary external hook work; a late hook result is not applied.

Runtime-local tool-turn route pins preserve the exact offered route through catalog metadata changes. They are **not cross-process pin migration**. Account, endpoint or model changes cannot borrow a parked turn. Preserve the existing capability to rebuild at a quiescent, fully reconciled tool-result boundary; incomplete/uncertain turns still fail closed.

## Maintenance: consent and scope

### Discard one known Pi recovery scope

- `/cursor.reset`: no-argument dry help/list; no destructive default.
- `/cursor.reset --select`: choose a known full scope and explicitly confirm in the UI.
- Headless: `/cursor.reset --scope HASH --confirm-discard`, where HASH is the exact known **64-hex** scope from this runtime. A supplied scope in UI also requires confirmation.
- Reset stops its own scope's requests and drains pending native start/request work before native removal. It must not cancel unrelated accounts/children or let pre-reset late work revive the discarded identity.
- Default timeout **5 seconds**; `PI_CURSOR_RESET_TIMEOUT_MS` may lower it but cannot exceed **5000 ms**. On timeout the scope stays fenced; no successful reset is confirmed, even if underlying work later settles.
- Discard is not tool undo and does not retry a request. Unknown scopes are rejected; no guessed scope/root or auth lookup.

### Root-wide cache maintenance

- `/cursor.cache` lists help/scopes. `/cursor.cache --scope HASH` inspects the **entire known root anchored by that scope**, dry-run by default; it is not a per-scope sweep.
- `/cursor.cache --scope HASH --apply` requires explicit UI root-wide confirmation. Headless apply additionally requires `--confirm-prune`. `--select` can choose the known anchor in UI.
- The anchor must be quiescent/unfenced. On apply, other eligible expired records in that root become fail-closed tombstones, retaining uncertainty; active, locked and corrupt records are skipped. Never interpret a skipped record as successfully removed.
- No arbitrary-root reader, auth lookup or JavaScript filesystem fallback. If native maintenance is unavailable, stop. No DSO cleanup. Maintenance timeout also leaves the anchor fenced.
- Dry run neither creates missing roots/locks nor prunes payloads; contents, entry inventory, permissions and mtime are checked on native fixtures. Reads can still affect OS-managed access metadata. Missing roots fail; orphan records without an existing lock are skipped rather than creating one.

### Capacity diagnostics (retention unchanged)

- A commit refused on root capacity fails the turn with `cache_quota_exceeded:`, `cache_entry_quota_exceeded:`, `cache_scan_limit:` or `cache_root_busy:` instead of a generic commit error. Pi appends `/cursor.cache --select` / `/cursor.reset --select` hints; an expired journal error points at `/cursor.reset --select`.
- `/cursor.doctor` prints `cacheRoot=` usage from the latest native commit in this process (committed bytes, records and directory entries against their limits) and `cacheWarning=` at 80% or more. It reads no files; with no commit yet there is no line.
- `/cursor.cache --scope HASH` dry runs also report `committedBytes`/`limitBytes`, `records`/`limitRecords` and `directoryEntries`/`scanLimitEntries`. Locks count toward the scan limit and are never removed; tombstones count toward records.
- Nothing prunes, tombstones or resets automatically. Use consented maintenance, known-scope reset or an explicitly approved new cache root.

### Capacity and retention boundaries

| Bound | What it means / excludes |
|---|---|
| **512 MiB tracked payload per loaded core generation** | Not RSS or a process-memory cap. Container/allocator/runtime overhead and incompletely tracked allocations are excluded; separately loaded generations do not share a budget. Admission/large-restore/concurrency regressions passed locally. |
| **1 GiB committed cache / 4096 recognized regular records per root** | Not all files or total filesystem usage. Unsafe/unrecognized files, locks and legacy orphan files are excluded from these quotas. |
| **200 MiB serialized staging per root** | Separate temporary allowance in addition to committed capacity. FIFO local admission and cross-process locking serialize root commits; quota/concurrency/fault regressions passed. |
| **24-hour expiry** | Applied on access unless explicit maintenance is requested; not a background deletion or physical-disk retention guarantee. Fail-closed tombstones can remain. |

Journals can contain sensitive prompt/tool data. Private permissions and expiry are **not encryption or secure erase**. Tombstones count toward the record limit; capacity exhaustion does not authorize forgetting actions. Use explicitly approved discard/new-root procedures, never blanket deletion of locks, unknown actions or loaded DSOs.

Same-process writers queue FIFO; cross-process quota-lock admission waits at most one second. Local queue time includes preceding writes, and executing OS filesystem calls cannot be forcibly interrupted. Adapter reset/maintenance deadlines bound the caller's wait, not rollback of such I/O; an incomplete operation remains fenced.

## Staged LOCAL fixture qualification — recorded layers and remaining gaps

The following records executed layers, not universal coverage. All native data, credentials and roots were disposable fixtures with a localhost upstream; no installed-plugin switch or live Cursor request was needed. Exact current tarball hashes are retained in `VALIDATION.json`; temporary detailed logs may expire.

| Scenario | Executed layer | Evidence / limit |
|---|---|---|
| Auth never settles, cancellation, owner disposal and late callbacks | Node injected clocks/callbacks and headless deadline process | Passed; Bun-specific hung-auth fault injection not separately run |
| Reset during auth/start/tool turn, late work and hung removal | Injected ordering; registered commands with real N-API; actual Pi RPC | Passed for covered schedules; no universal filesystem-cancellation promise |
| Root-wide cache preview/apply and expired/locked/corrupt/orphan records | Actual native private roots, snapshots and Pi RPC | Passed; expired payloads become tombstones, dry-run byte/mode/mtime/inventory retained |
| Payload admission/release, large restore and concurrent actors | Core resource fixtures and default-parallel Rust tests | Passed within one loaded generation; not cross-generation RSS accounting |
| Cache quota and concurrent commits | Native temporary roots, same-inode creation and FIFO/lock tests | Passed; documented files/staging exclusions remain |
| Catalog drift and reconciled system/tools/payload/steering | Injected lifecycle cases plus native SDK/core and real-host flows | Passed for covered combinations; no cross-process route-pin migration |
| Crash and storage failure | Five real-native process-fault cases; deterministic short-write/ENOSPC/EIO/sync/rename injection | Passed; SIGKILL tested at selected phases, not every instruction window or power loss |
| Real host and exact packed artifacts | Pi1.4.0/1.5.1 and OpenCode2.2.5/Bun1.3.13; each packed run retains 6+1 gates | Passed locally, including actual RPC doctor/cache/reset and fresh-conversation checks |
| Platform/release identity matrix | macOS26.7.1 arm64, Node22.22.0 and exact local artifact hashes | Only this local platform; fresh three-target CI, minimum OS/libc and other runtimes NOT RUN |

Stage order remains (1) injected ordering, (2) native storage/resource/process faults, (3) real local hosts, (4) exact offline-installed tarballs. Record skipped/unexecuted layers explicitly; local success is not a remote matrix or a minimum-version guarantee. No packed-host, target, license or identity gate was weakened.

## Rollback — explicit approval, exact trio, cold host restart

1. Freeze new work and check authoritative host tool outcomes. Quiesce/drain the owning runtime; preserve unknown-action records and fences. A crash/timeout is not permission to auto-clear.
2. Identify the last qualified **exact release group**: native, Pi and OpenCode packages with their tarball/native hashes and host versions. Matching `0.3.0` labels alone do not prove identical artifacts. Record the full group, but switch only the adapter/native dependency closure for the explicitly approved host—do not install an unused host adapter or overwrite other installations.
3. Obtain **explicit installation/switch approval** before changing any installed provider, host config or artifact. Source edits, builds, tests and release authorization do not authorize installation. This runbook executes no switch or registry commands and grants no publication/bootstrap approvals.
4. Do **not assume journal backward compatibility**. Never point an older reader at newer journals without fixture evidence. Preserve uncertain records in place/private protected storage without sharing their contents; if compatibility is unknown, leave the old root intact and use a separately approved fresh recovery root/new session. Never silently resume or reissue an unresolved action there.
5. Restore only the approved exact trio, then **fully exit and restart each affected host**. Reload/hot swap is not rollback qualification: old DSOs/runtime owners can remain loaded. Do not delete old DSOs from a running process.
6. Verify manifest/native hashes, expected provider/API and host versions, then perform approved local fixture checks before resuming work. If anything differs or recovery is fenced, stop and escalate rather than clear/retry automatically.

Never open/copy `auth.json`, OS credentials or tokens as part of backup/rollback. No token migration: the host retains its own auth; reconnect through the host UI if necessary. Rollback restores software, **not tool effects**, and offers no exactly-once or secure-erasure guarantee.
