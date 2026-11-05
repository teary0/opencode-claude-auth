# Safe authentication diagnostics (version 1)

Existing user-facing exception messages are retained. `ClaudeAuthError.code`
adds a stable discriminator for in-process consumers; it is **not** assumed to
survive the native OAuth/session HTTP error transport.

## Codes

| Code                                 | Meaning                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_IMPORT_TOKEN_MISSING`        | Readable JSON credential store has missing/blank access or refresh subscription token (including MCP-only credentials). |
| `CLAUDE_IMPORT_SOURCE_UNAVAILABLE`   | Selected source does not exist or returns no stored credential.                                                         |
| `CLAUDE_IMPORT_SOURCE_UNREADABLE`    | Selected source cannot be read.                                                                                         |
| `CLAUDE_IMPORT_SOURCE_INVALID`       | Invalid JSON, non-object credential blob, or invalid/missing expiry.                                                    |
| `CLAUDE_IMPORT_INPUT_INVALID`        | Missing source or invalid location/form input.                                                                          |
| `CLAUDE_SESSION_ACCOUNT_NOT_FOUND`   | Pin has no matching credential connection in the Anthropic integration.                                                 |
| `CLAUDE_SESSION_ACCOUNT_NOT_MANAGED` | Connection is not OAuth, or resolved credential does not satisfy the existing method/v2 managed contract.               |
| `CLAUDE_SESSION_RESOLVE_FAILED`      | Connection listing/resolve throws, refresh fails, or resolve returns no credential.                                     |
| `CLAUDE_SESSION_METADATA_FAILED`     | Session lookup, malformed pin, cyclic/deep parent chain, or repeated concurrent metadata invalidation fails.            |

Import diagnostics use a strict import-only read. The legacy credential parser,
refresh flow, v2 managed predicate and pin inheritance are unchanged. Missing
connections, unmanaged values and resolution failures never fall back globally.

## Transport decision and evidence

- Official RPC documentation: <https://opencode.ai/v2/docs/build/plugins/rpc>.
  `ctx.rpc.register` implements methods with input/output schemas; clients call
  `client.rpc(definition).method(input, { location })`. Declared RPC errors are
  supported **for RPC methods**, not arbitrary native OAuth/session endpoints.
- Installed `@opencode/client` **2.0.31**, file
  `dist/chunks/contract-qfk0hgz0.js:50-56`: an undeclared status cancels the body
  and throws `ClientError("UnexpectedStatus", { cause: { status }, ... })`.
  Merely changing an exception message or adding `code` cannot fix that path.
- The same file, lines 1027-1036: RPC uses
  `POST /api/rpc/{rpcID}/{method}?location=...`, body `{ "input": ... }`, success
  status 200; its declared statuses also include 500.
- `dist/chunks/contract-1y4a697q.js:43-57` unwraps `result.output` and preserves
  declared RPC error type/message/data. We use **successful output**, not errors.
- Installed plugin `dist/promise/integration.d.ts:50-56` provides authorize and
  refresh registrations, but no native endpoint error-schema registration.
  `connection.status` exists, but requires a connection and is not a unified
  solution for missing import stores or already-deleted pinned connections.
- Tests exercise the installed SDK with a fake HTTP response: native undeclared
  500 discards the body; the successful RPC result preserves the code. Plugin
  registration is tested with a fake host. No live server or model is contacted.

## Dashboard integration

Use the existing RPC ID `griffinmartin.claude-auth` and exported
`SESSION_CREDENTIAL_RPC` definition. Existing capability fields remain; new
fields are `authStatus: true` and `authErrorCodesVersion: 1`.

```ts
const auth = client.rpc(SESSION_CREDENTIAL_RPC)
const capabilities = await auth.capabilities({}, { location })
if (capabilities.authStatus && capabilities.authErrorCodesVersion === 1) {
  // After a failed /connect attempt:
  const imported = await auth.authStatus({ scope: "import" }, { location })
  // After a session pin/credential failure:
  const pinned = await auth.authStatus(
    { scope: "session", sessionID },
    { location },
  )
}
```

Raw HTTP example: `POST /api/rpc/griffinmartin.claude-auth/authStatus` with the
same location as the failing request and JSON body
`{"input":{"scope":"session","sessionID":"..."}}`. The wire result is
`{"output":{"state":"error","code":"CLAUDE_SESSION_ACCOUNT_NOT_FOUND"}}`.
The SDK subclient returns only the inner output.

Output is exactly `{ state: "unknown" | "ok" | "error", code?: AuthErrorCode }`.
No token, refresh token, credential ID, source/path, label, raw cause, or session
ID is returned. Session IDs are only private lookup keys, never output fields.
New exception messages contain no original cause; existing user text is retained.

### Observation semantics and limits

- This is a **passive recent-operation observation**, not a live health check.
  A lookup never reads an auth file, lists/resolves connections, refreshes tokens,
  switches accounts, starts a model request, or consumes the observation.
- State lives in the plugin instance/location memory, capped at 1024 entries
  (import plus sessions), with a five-minute TTL. Restart, eviction, expiry or no
  observed operation yields `unknown`, **not** success. Metadata invalidation
  clears session observations along with the existing provenance cache.
- Import scope is the latest completed import in that location, not per-client
  or per-attempt. Session scope is the latest completed pin selection for that
  session (or a metadata failure in an identity hook). Concurrent operations
  are last-completion-wins; do not claim exact failed-request attribution.
- `ok` means the import completed or the pin-selection stage completed; an
  unpinned session can also be `ok`. It does not certify global auth, upstream
  availability, billing, model response success, or credential persistence.
- A failure before the plugin authorize/session hooks run cannot be diagnosed
  here. A disconnected/restarted server cannot answer. Keep the generic error
  for `unknown`, an unavailable RPC, unknown versions/codes, or unsupported
  capabilities. Show codes as recent diagnostic context, not definitive cause
  of every HTTP 500. Do not retry/refresh/connect automatically on lookup.
- The dashboard must add its own code-to-guidance mapping: import/login for
  missing tokens, source-access checks for unreadable sources, reselect/clear
  the pin for missing/unmanaged accounts, and explicit retry/re-import for
  resolve failures. Never display the underlying credential ID or raw cause.

## Isolated build

Set `OPENCODE_CLAUDE_AUTH_ISOLATED_BUILD=1` before `node scripts/build.mjs` to
write generated output only to `test-results/build/`. Normal builds retain the
existing `dist/` destination. Tests run through `scripts/test-isolated.mjs`,
which sandboxes auth/config/home/temp paths and blocks real network/subprocesses.
