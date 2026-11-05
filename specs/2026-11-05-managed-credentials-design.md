# OpenCode-authoritative managed credentials

Date: 2026-11-05
Status: implemented in fork branch `feat/managed-credentials`; isolated tests only, not deployed

## Scope and compatibility

Dashboard design 5-B requires account selection to mean the resolved OpenCode credential, not whatever now occupies a Claude source file. Implement the approved behavior change and isolated verification without operating a real OpenCode service, replacing an installed plugin, invoking real Claude/security commands, or contacting Anthropic.

New imports carry metadata `"opencode-claude-auth/claude-code-oauth": "v2"` AND `"credentialAuthority": "opencode"`. `isManagedClaudeCredential({ metadata })` checks both exact strings; consumers must also restrict to Anthropic OAuth method `claude-code`. v1 remains legacy, including its source-adoption/write-back/fallback behavior. Never upgrade a v1 marker automatically. Dashboards should reject or visibly segregate legacy credentials in managed account workflows. An incomplete v2 marker must not enter legacy refresh.

## Invariants

1. Managed request authorization is exactly the resolved credential's access token, including A → B → A inside the legacy 30-second cache interval. A shared `source: "file"` is provenance, not account identity.
2. Request preparation bypasses `getCachedCredentials`, source resolution and all legacy refresh/backoff/borrowing code. Missing access fails rather than selecting a fallback account.
3. The HTTP request hook stores authority/source context keyed by the prepared Request. The response hook consumes that context, not the current active connection. Authorization on that Request pins permitted internal beta-repair/transport retries.
4. Managed 401/429 recovery never re-reads a source or forces refresh; the account's error is surfaced. A 400 beta-repair retry may still run, with the same starting token. The existing transport retry helper also keeps the same token.
5. Managed refresh exchanges only its input refresh token via a dedicated native-fetch function. No account list, cache, source read, source write, CLI, legacy cross-process source lock, or sibling-account fallback is reachable. OpenCode persists the returned credential; all input metadata is retained.
6. A SHA-256 refresh-token key shares only an in-flight exchange result in-process; metadata is rebuilt separately for each caller. Different tokens sharing a source cannot join. The map is cleared on success/failure and is never persisted or logged.
7. Endpoint error bodies and transport exception text are never logged or exposed by managed refresh. Logs contain only fixed event/reason and HTTP status. Errors are fixed, token-free instructions to retry or re-import.

## Explicit import

The OpenCode 2 form SDK accepts a required string pick list and an optional free-text string field. Always ask for `account`; add a `file` choice if discovery did not find one. `configDir` accepts an absolute file-source directory, not a credentials-file filename. A blank path uses the discovered/default Claude directory. A path with a non-file source or a relative path is rejected.

Import reads the chosen source freshly with `readStoredCredentials(source, configDir)`. The known account supplies only provenance/label information. It never supplies fallback credentials, triggers refresh, or mutates legacy active-account selection. Missing/unreadable source is an error. A custom directory does not inherit another directory's account label.

## Test boundaries

`scripts/test-isolated.mjs` launches only unit test files. All default credential/config/temp roots are sandboxed before module import, with an additional worker-private root to avoid cross-file test pollution. HOME and USERPROFILE are always redirected together on Windows. APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME/DATA_HOME/CACHE_HOME/STATE_HOME/RUNTIME_DIR and the refresh lock directory are fake. Inherited Claude/OpenCode/Anthropic overrides and NODE_OPTIONS are removed.

The worker preload replaces native fetch and child_process exports with throwing fakes and blocks net/tls connections. Individual tests may inject fake fetch/subprocess modules. Managed tests assert zero attempted native subprocess/network fallback, unchanged fake-source bytes, and no token sentinels in logs/errors. A runner self-test checks every root and verifies unfaked I/O is blocked. Shell compatibility delegates to the Node runner. Test fixtures changing HOME also update USERPROFILE and CLAUDE_CONFIG_DIR.

Coverage includes exact marker rejection, same-source B vs active A, fast A/B/A, missing source/access, refresh metadata, same-token single-flight/different-token separation, invalid_grant/429/503/network failures, explicit-directory fresh reads and disappearance, in-flight A/B response handling and pinned beta retries, API-key/other-provider bypass, body/SSE transformations, and retained legacy v1 tests.

## Known limits and staged validation

- Import does not mint an independent OAuth session. The CLI and OpenCode can still share a rotating refresh token; either consumer may invalidate the other's copy. Re-authenticate/import explicitly, preferably using independent sessions/config directories.
- Single-flight is process-local and only concurrent. Multiple server processes or a later retry of an old credential are not coordinated. OpenCode must persist successful rotations and own its credential lifecycle.
- Request context relies on the host passing the prepared Request object back to `http.response`, as required by the existing hook integration. If a future host clones/replaces it, recovery/response transformation will not run; there is no unsafe global fallback.
- Existing plugin startup discovery and legacy v1 behavior are retained. The isolation guarantee is for managed import/request/refresh paths, not a promise to remove startup discovery or legacy store access.
- This does not validate OpenCode's on-disk persistence, credential-switch event ordering, UI account selection or refresh scheduling in a real server.
- Next stage: a separately approved OpenCode server with a private fake HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG/config/data directory, this local build, fake credentials and a fake OAuth/API endpoint or injected transport. Verify form answers, persisted metadata/rotation, immediate A/B/A request headers, in-flight response identity, restart behavior, mixed-v1 blocking, and no production store/service access. Do not run live model/OAuth validation scripts.

## Rollback and artifacts

Restore the prior plugin/config only after switching away from managed connections; explicitly re-authenticate/re-import under that version. Do not relabel v2 as v1 or assume the original CLI token remains usable. No managed rotation is merged back into source storage.

`scripts/build.mjs` performs the existing clean/TypeScript/prompt-copy build using Node filesystem APIs on Windows and Unix. `dist/` is ignored, not git-tracked; build artifacts remain local and are not installed or committed. Record local SHA-256 hashes with verification results before any separately approved deployment.
