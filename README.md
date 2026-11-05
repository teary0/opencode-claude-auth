# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode 2 using your Claude Code subscription credentials — no separate login or API key needed.

> **3.0.0 and later require OpenCode 2.0+ and will not load on OpenCode 1.x.** The last version that supports OpenCode 1.x is **2.2.1** — see [Migrating from OpenCode 1](#migrating-from-opencode-1).

## Compatibility

| opencode-claude-auth | OpenCode  | Config key | Install                       |
| -------------------- | --------- | ---------- | ----------------------------- |
| 3.0.0+               | 2.0+ only | `plugins`  | `opencode-claude-auth@latest` |
| 2.2.1 and earlier    | 1.x       | `plugin`   | `opencode-claude-auth@2.2.1`  |

## How it works

The plugin registers a Claude Code subscription auth method on OpenCode's built-in Anthropic provider. Run `/connect`, choose **Anthropic**, then **Import Claude Code subscription** — it reads OAuth tokens directly from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms) and hands them to OpenCode.

OpenCode's native Anthropic provider handles prompt conversion and streaming. Session hooks add the Claude Code identity, set `Authorization: Bearer` (and strip `x-api-key`), translate tool names, and process responses. **New imports use managed credentials:** OpenCode's resolved credential is authoritative, not the original Claude file or Keychain entry. Refreshes exchange only that credential's refresh token through Anthropic's OAuth endpoint (zero LLM tokens consumed). Existing v1 imports retain the legacy source-sync behavior until explicitly re-imported.

## Alternative: CLIProxyAPI (plugin not required)

If you run [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), you don't need this plugin. CLIProxyAPI logs in to your Claude Code account with OAuth, handles token refresh, and exposes a Claude-compatible API on `http://localhost:8317` by default. Point OpenCode's built-in Anthropic provider at it:

1. Log in with your Claude Code account (via the proxy's `-claude-login` flag) and set an `api-keys` entry in its `config.yaml`.
2. Configure the Anthropic provider in `~/.config/opencode/opencode.json`:

   ```json
   {
     "provider": {
       "anthropic": {
         "options": {
           "baseURL": "http://localhost:8317",
           "apiKey": "your-api-key-1"
         }
       }
     }
   }
   ```

Remove `opencode-claude-auth` from your `plugins` list when using this setup — the two approaches shouldn't be combined. CLIProxyAPI also supports multi-account load balancing and other providers (Codex, Gemini, Grok). This plugin remains the lighter option if you only need Claude Code credentials in OpenCode with no extra service running.

## Prerequisites

- OpenCode 2 installed — see the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1) for installation instructions
- Claude Code installed and authenticated (run `claude` at least once)

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugins": ["opencode-claude-auth@latest"]
   }
   ```

   > OpenCode 2 uses the `plugins` key (plural) — OpenCode 1 used `plugin` (singular). The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Connect it** — restart OpenCode, run `/connect`, choose **Anthropic**, then **Import Claude Code subscription**. Use `/models` and pick a model under **Anthropic**.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Run `/connect` once to import your Claude Code subscription, then use OpenCode normally — the plugin refreshes credentials automatically and provides them to the Anthropic API. If your credentials aren't OAuth-based, the connection falls through to standard API key auth.

## Managed credentials (this fork)

New `/connect` imports require an explicit source selection, even for one account. Select **Credentials file** and optionally enter an **absolute Claude config directory** to import an account-specific `.credentials.json`. Blank means the discovered/default directory (`CLAUDE_CONFIG_DIR`, otherwise `~/.claude`). The selected source is read freshly; a missing/unreadable source is an error, never a reason to import another account or cached tokens. Import does not refresh, run Claude, or write the source.

After import:

- Every request uses only the resolved OpenCode credential's access token. Switching A → B → A takes effect on the next request without the legacy 30-second source cache.
- Refresh exchanges only the input credential's refresh token, preserves its metadata, and returns the result to OpenCode for persistence. No source re-read, write-back, account borrowing, or CLI fallback occurs.
- 401/429 responses do not trigger source adoption or forced refresh. Errors stay with that account. Permitted beta-repair/transport retries retain the starting request's token; a pending A response cannot change B.
- Concurrent refreshes of the same refresh token share one exchange **within this plugin process**; different tokens are independent even when both came from `source: "file"`. There is no cross-process managed refresh lock or result store. Do not run independent servers against copies of the same refresh token.

**Shared refresh-token warning:** import copies credentials; it does not mint an independent session. Claude CLI and OpenCode may initially share a rotating refresh token. Either may invalidate the other's copy. Prefer separately authenticated sessions/config directories, avoid simultaneous use of a shared token, and re-authenticate/re-import explicitly when required. Managed mode intentionally does not repair this by adopting a different account. A transient failure should be retried later; an invalid grant may require re-authentication and `/connect` again.

### Metadata contract for dashboards

`isManagedClaudeCredential({ metadata })` is exported from the package and returns true **only** when both exact entries exist:

```json
{
  "opencode-claude-auth/claude-code-oauth": "v2",
  "credentialAuthority": "opencode"
}
```

The marker is inside the OpenCode OAuth credential's `metadata`; `source`, `configDir`, `label`, and `subscriptionType` are provenance/display fields, not authority or account identity. For an Anthropic connection also verify `type: "oauth"` and `methodID: "claude-code"`. v1, missing markers, and v2 without the authority entry are **not managed**. Dashboards must label/block legacy credentials from managed multi-account workflows rather than silently promote them. Malformed v2 refreshes fail closed.

### Migration and rollback

- Existing v1 credentials are **never automatically upgraded**. They keep source reads, write-back, CLI fallback and borrowing. Re-import each chosen account to create a managed credential, then explicitly activate that connection in OpenCode.
- To roll back, stop using managed connections, restore the previous plugin version/configuration, and explicitly re-authenticate/re-import using that version. Do not merely rewrite v2 metadata to v1: the original shared refresh token may already be stale. This branch does not replace any installed plugin or change an OpenCode service.
- Source files are unchanged by managed import/request/refresh. There is no automatic merge of OpenCode's rotated tokens back into Claude's store.

## Per-session Claude credentials (this fork)

Set the session metadata entry `opencode-claude-auth/credentialID` to an Anthropic **managed** credential ID to pin that session. The plugin resolves that connection directly, including refresh when inactive, without activating it globally. Other sessions can use other credentials concurrently. Primary, compaction, title and generate HTTP requests use the same selection rule.

```json
{
  "opencode-claude-auth/credentialID": "your-managed-anthropic-credential-id"
}
```

- Missing or `null` means no local pin. A child inherits the closest pin through at most **10 parent links**; a root without a pin follows the global active connection as before. `null` on a child does not opt out of an ancestor's pin.
- Missing credentials, legacy v1 credentials, non-Claude methods/API keys, invalid pins, missing sessions, cycles and over-depth inheritance fail closed. They never silently use the global account. Error messages do not include credential IDs, tokens or labels.
- Only session pin/parent metadata is cached (5 seconds, bounded to 1024 sessions), never resolved credentials or tokens. `session.metadata.updated` and `session.deleted` invalidate the cache including descendants. Updates arriving during a pending lookup cannot repopulate stale cache entries.
- Pin changes affect subsequent request selections; a request already prepared keeps its own token and response context. The existing managed refresh/source-isolation rules still apply. This does not change the host's global provider/model availability rules.

### Dashboard capability and metadata updates

RPC ID **`griffinmartin.claude-auth`**, method **`capabilities`**, input `{}` returns:

```json
{
  "sessionCredential": true,
  "metadataKey": "opencode-claude-auth/credentialID"
}
```

The REST call is `POST /api/rpc/griffinmartin.claude-auth/capabilities` with `{ "input": {} }` and a location query when required. OpenCode 2.2.5 wraps the result in `{ "output": ... }`. Dashboards should hide session-account controls when the RPC is unavailable.

**Measured on OpenCode 2.2.5:** `session.update({ metadata })` **replaces the entire metadata object**. Read the current metadata, change only the credential-ID entry (or set it to `null`), and submit the complete object. A read-modify-write preserves unrelated keys, but concurrent metadata writers still require coordination; this plugin does not write session metadata or provide CAS.

Offline tests: `node scripts/test-isolated.mjs`. The isolated server measurement used only this worktree's `dist`, fake accounts, loopback HTTP/TLS mocks and ports 14352/14353. It did not replace the operational plugin. See `specs/2026-11-05-session-credentials-design.md` for implementation boundaries and verification details.

## Migrating from OpenCode 1

OpenCode 2 replaced the plugin and auth APIs this plugin used under OpenCode 1, so 3.0.0 and later only load on OpenCode 2.

1. Upgrade OpenCode — see the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1).
2. In `~/.config/opencode/opencode.json`, move the plugin from the `plugin` key (OpenCode 1) to `plugins` (OpenCode 2):

   ```json
   {
     "plugins": ["opencode-claude-auth@latest"]
   }
   ```

3. Restart OpenCode, run `/connect`, choose **Anthropic**, then **Import Claude Code subscription**. The OpenCode 1 connection isn't carried over.

### Staying on OpenCode 1

**2.2.1** is the last release that supports OpenCode 1. Pin it instead of tracking `@latest`:

```json
{
  "plugin": ["opencode-claude-auth@2.2.1"]
}
```

## Supported models

14 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-fable-5-1           |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, they're all detected from the Keychain automatically and offered as a selection prompt when you run `/connect`. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To import another account, re-run `/connect` and pick its source or config directory. Switch the active credential using OpenCode; managed requests follow that resolved selection.

Even if only one account is found, explicitly select its source. A vanished selection is an error, not a fallback to the first account.

## Troubleshooting

| Problem                                                                               | Solution                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                                                               | Run `claude` to authenticate with Claude Code first                                                                                                                                                           |
| "Keychain is locked"                                                                  | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                                                                                          |
| "Token expired and refresh failed"                                                    | Managed: retry later or re-authenticate and explicitly re-import with `/connect`. Legacy v1 may run the CLI fallback. |
| Not working on Linux/Windows                                                          | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it                                                                     |
| Keychain access denied                                                                | Grant access when macOS prompts you                                                                                                                                                                           |
| Keychain read timed out                                                               | Restart Keychain Access (can happen on macOS Tahoe)                                                                                                                                                           |
| "Credentials are unavailable or expired"                                              | Run `claude` to refresh your Claude Code credentials                                                                                                                                                          |
| Auth keeps failing right after re-authenticating with `claude`                        | Managed: explicitly re-import with `/connect`; the plugin never adopts the CLI's replacement automatically. Legacy v1 still re-syncs from the source. |
| "Extra usage is required for long context requests"                                   | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                                                                                       |
| Plugin not updating to latest version                                                 | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode                                                                                             |
| `opencode auth login` prints "Only http and https links can be opened in the browser" | Harmless: importing has no browser step, but the CLI tries to open one anyway. The credential is still saved — confirm with `opencode auth list`                                                              |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

**Legacy/live diagnostic only — not an isolated managed-mode test.** This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid. Do not run this to verify managed credential isolation.

For offline verification, run `node scripts/test-isolated.mjs` (or `pnpm test`). It gives every test worker fake HOME, USERPROFILE, CLAUDE_CONFIG_DIR, APPDATA, LOCALAPPDATA, XDG and temp/lock directories, and blocks unfaked network/subprocess calls. `node scripts/build.mjs` builds on Windows and Unix. Live model/headless/OAuth scripts are separate and are not part of this runner.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                                   | Description                                                                                                                                                                                                                                                                       | Default                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`                    | Claude CLI version for user-agent and billing headers                                                                                                                                                                                                                             | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`                     | Full User-Agent string (overrides CLI version)                                                                                                                                                                                                                                    | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`                     | Comma-separated beta feature flags                                                                                                                                                                                                                                                | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_AUTH_DEBUG`                        | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                                                                                                           | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                        | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                                                                                                                        | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS`        | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets.                                                                                            | `30000`                                                            |
| `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR`         | Strategy for reconciling `tool_use`/`tool_result` adjacency broken by OpenCode auto-compaction. `placeholder` synthesizes a paired result for orphaned `tool_use` blocks (lossless, preserves `thinking` blocks); `drop` removes orphaned blocks (omitting whole thinking turns). | `placeholder`                                                      |
| `OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS`     | Max ms a single request waits through a transient token-refresh rate-limit (429) before returning a retryable error instead of a hard "run `claude`".                                                                                                                             | `45000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS` | Base per-account cooldown after a rate-limited refresh, before the plugin retries the token endpoint. Escalates with consecutive failures and is jittered; capped at 60s.                                                                                                         | `15000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` | TTL for the cross-process refresh lock. A held lock older than this is treated as stale (crashed holder) and taken over.                                                                                                                                                          | `20000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`    | Directory for the advisory cross-process refresh lock files.                                                                                                                                                                                                                      | OpenCode data dir (`~/.local/share/opencode`)                      |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers a Claude Code subscription auth method on OpenCode's built-in Anthropic integration (`ctx.integration.transform`), surfaced as **Import Claude Code subscription** under `/connect`
- Uses OpenCode 2's native Anthropic provider for prompt conversion and streaming, while session HTTP hooks in `src/index.ts` apply the subscription transport in `src/provider.ts` only to Claude Code OAuth connections
- The request hook sets `Authorization: Bearer` with the current OAuth access token and strips `x-api-key`, translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix), and sets required API headers (beta flags, billing, user-agent) with model-aware selection; the response hook buffers SSE streams at event boundaries for reliable tool name translation
- Injects the Claude Code identity into system prompts via the `context`, `compaction`, `generate`, and `title` session hooks — OpenCode 2 dispatches a separate hook per request kind, and all four bill to the connected subscription
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier; multiple accounts are offered as a selection prompt during `/connect`
- OpenCode persists the resulting OAuth credential (access + refresh token) itself and calls back into the plugin's `refresh` hook whenever it decides one is needed — the plugin doesn't run its own background timer
- Managed v2 refresh bypasses all legacy account state and directly exchanges the input refresh token; see [Managed credentials](#managed-credentials-this-fork)
- **Legacy v1 only:** before network refresh, re-reads the source and adopts an externally rotated token
- **Legacy v1 only:** the refresh callback and request path share an account-scoped refresh behind a source-based cross-process lock
- **Legacy v1 only:** direct OAuth refresh may fall back to the `claude` CLI and write tokens back to Keychain or the credentials file
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- **Legacy v1 only:** on 401/429, may adopt source tokens or force OAuth refresh and retry; managed credentials surface the account's error without source recovery
- If credentials aren't OAuth-based, the connection falls through to standard API key auth
- If credentials are unavailable or unreadable, the plugin logs the error and OpenCode continues without a Claude Code auth connection

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
