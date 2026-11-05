# Per-session managed Claude credentials

Date: 2026-11-05
Branch: `feat/session-credentials`, worktree `plugins/opencode-claude-auth-session`
Base: managed credentials at `0bd46bf`
Status: implemented and tested; not deployed

## Contract

Session metadata `opencode-claude-auth/credentialID` is an Anthropic managed credential ID. Missing/null means no local pin: traverse the nearest ancestor, at most ten parent links, then use the existing global-active path only when the bounded chain ends without a pin. A local nonempty string overrides its ancestors. Empty/wrong-type values, cycles, missing sessions and chains exceeding the bound fail closed rather than risk charging an unintended account. Null on a child still inherits.

A pin is not a global activation. Resolve it from Anthropic integration connections using `ctx.integration.get({ integrationID: "anthropic" })`, then `ctx.integration.connection.resolve(connection)`. Require OAuth method `claude-code` and exact v2/`credentialAuthority: "opencode"` metadata. Missing, legacy or wrong-method/key targets fail before request preparation; never fall back to global credentials on these failures. Resolve is responsible for credential-specific refresh/persistence. Errors are fixed strings without IDs, tokens, labels or source exception text.

The HTTP hook applies the same rule regardless of request kind (`primary`, `compaction`, `title`, `generate`) and stores the existing prepared-Request response context. The context/compaction/title/generate identity hooks recognize session pins even if the global connection is an API key. Other providers bypass all session account lookups. Provider model availability and the host's own pre-hook global resolution remain host concerns.

## SDK and RPC

Verified against the installed SDK `@opencode/plugin@2.0.31`, running on OpenCode 2.2.5:

- `ctx.session.get({ sessionID })` returns the session directly.
- `ctx.integration.get({ integrationID })` returns `{ data: IntegrationInfo, location }`.
- `ConnectionInfo` identifies credential connections by `type: "credential"`, `id`, `method`.
- `session.metadata.updated` carries `data.sessionID` and `data.metadata`. Metadata belongs to the session, not `event.metadata`.
- `ctx.rpc.register(definition, handlers)` accepts portable JSON schemas. Register ID `griffinmartin.claude-auth`, method `capabilities`, input `{}`, output `{ sessionCredential: true, metadataKey: "opencode-claude-auth/credentialID" }`.
- The real REST RPC wraps this output in `{ output: ... }`; dashboards must unwrap it.

## Cache and concurrency

Cache only each session's own pin and parent ID, with a five-second TTL and 1024-entry bound. Share concurrent session reads, not tokens or account selections. Resolve the credential anew for every HTTP request, letting OpenCode own refresh.

Any metadata update or session deletion clears the metadata cache and pending-read map, conservatively including descendants and unpinned entries. A generation counter prevents reads begun before invalidation from publishing stale snapshots. An inheritance traversal retries if invalidated while reading, with a bounded retry count. Continuous churn fails closed. This is not a transaction with credential resolution: an already selected/prepared request may finish on the previous pin; changes apply to future selections.

## Metadata write semantics

OpenCode 2.2.5 was measured using real `PATCH /api/session/{sessionID}`:

1. Write `{ fixtureKeep: { nested: true }, [key]: A }`.
2. Write `{ [key]: B }` alone.
3. Read session: `fixtureKeep` is gone. **Replacement, not merge.**
4. Read-modify-write a complete metadata object with `[key]: null`: the unrelated key remains and the next request immediately follows global B.

The plugin does not write metadata. Dashboard callers must preserve unrelated keys and coordinate concurrent writers; no compare-and-swap API is added here.

## Verification

- RED: `node scripts/test-isolated.mjs src/session-credentials.test.ts` — 10 tests, 1 pass, 9 fail, exit 1 before implementation.
- Focused GREEN: `node scripts/test-isolated.mjs src/session-credentials.test.ts src/index.test.ts` — 20 pass, exit 0.
- Full isolated regression: `node scripts/test-isolated.mjs` — 339 pass, 0 fail, exit 0.
- Build: `node scripts/build.mjs`, exit 0; outputs only in this worktree's ignored `dist`.
- Tests cover capability registration, inactive pins/concurrent sessions, all request kinds and identity, ten-link nearest-ancestor inheritance, null/default behavior, API-key/other-provider regression, missing/legacy/wrong-method failures, TTL/event invalidation including descendants, in-flight stale reads, deletion, and pinned-only refresh.

Isolated runtime evidence: `%LOCALAPPDATA%\Temp\opencode\claude-session-measure\evidence\report.md`. Server 127.0.0.1:14352, mock 127.0.0.1:14353, OpenCode 2.2.5. The config loads only this worktree's `dist`. All credential/config/data/home/app-data/XDG/temp paths are fake, inherited provider keys removed, password ephemeral/unrecorded. Native OAuth fetch reaches a local CONNECT/TLS mock, which never forwards to the external host. Native model calls go to local provider baseURL. External catalog requests are denied by that mock proxy.

Runtime scenarios: actual OAuth/form imports A/B, capabilities RPC, simultaneous overlapping X=A/Y=B requests with global B unchanged, child created with parentID=X inheriting A, metadata replacement measurement, unpin/cache invalidation, missing-ID failure without upstream calls, inactive pinned A refresh through mock with persistence and unchanged sources, legacy rejection without upstream calls. The overlap mock does not release either response until both requests have arrived.

## Safety and limits

- The operational `plugins/opencode-claude-auth` is read/hash-only; no build/install/branch change/file modification occurred there. Its `dist/index.js` remains SHA-256 `3CD0C5D9E8D462FAFAF5D774E86913E903AD4202860837C753BC91687B4DF1FF`. The runtime harness compares all operational dist/src files plus entry/package/lock/README/CHANGELOG before and after.
- No production configuration/authentication file content or stat was requested for this measurement. Shared listener PIDs are queried only, never controlled. No 4317 request or installed-plugin replacement. Only spawned measurement processes are terminated; 14352/14353 listeners end at zero.
- HTTP model calls are mock Haiku 5.5 fixtures, not evidence of actual Anthropic access or model availability. The runtime exercises primary HTTP; all auxiliary-kind identity/transport selections are unit-tested, not real compaction/title/generate executions.
- Child inheritance uses a real session created with `parentID=X`, not an agent invoking a subagent tool.
- Expired inactive A is prepared by removing/recreating the sandbox credential with the same ID and only changing expiry, not by waiting for natural expiry or editing the source file. Global B remains active.
- Metadata event delivery is asynchronous; TTL is the fallback if an event is missed. No promise of immediate cross-process metadata synchronization is made.
- Same-token refresh single-flight remains process-local; shared CLI rotating tokens and multiple OpenCode processes still require care. An expired global connection's own host-level resolution is not disabled by this plugin.
- No packet capture, syscall/ACL audit, production credentials, real Keychain, dashboard UI or deployment was exercised. Loopback TCP sampling and no-forward proxy evidence must not be described as OS-wide access auditing.
