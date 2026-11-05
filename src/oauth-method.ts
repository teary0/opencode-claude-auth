import { Credential, Integration } from "@opencode/plugin"
import type { IntegrationOAuthMethod } from "@opencode/plugin/promise/integration"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  getAccountBySource,
  getCachedCredentials,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshViaOAuth,
  refreshManagedViaOAuth,
  reloadCredentialsFromSource,
  rotateAccountCredentials,
  saveAccountSource,
  setActiveAccountSource,
} from "./credentials.ts"
import {
  refreshAccount,
  readImportCredentials,
  writeBackCredentials,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"
import { log } from "./logger.ts"
import { ClaudeAuthError } from "./auth-errors.ts"
import {
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE,
  isManagedClaudeCredential,
} from "./credential-metadata.ts"
export * from "./credential-metadata.ts"

export const INTEGRATION_ID: Integration.ID = Integration.ID.make("anthropic")
export const METHOD_ID: Integration.MethodID =
  Integration.MethodID.make("claude-code")

/** Form field key the account chooser collects its answer under. */
const ACCOUNT_FIELD_KEY = "account"

/**
 * Everything this module needs from credentials.ts/keychain.ts/logger.ts,
 * injected rather than imported directly. Keeps this file framework-agnostic
 * (no Effect, no Promise-specific wrapping) and trivially testable with plain
 * fakes - both the Effect-based and Promise-based plugin entrypoints wire in
 * the same real implementations at the top level.
 */
export interface OAuthDeps {
  refreshAccountsList: () => ClaudeAccount[]
  loadPersistedAccountSource: () => string | null
  getCachedCredentials: () => Promise<ClaudeCredentials | null>
  setActiveAccountSource: (source: string) => void
  saveAccountSource: (source: string) => void
  reloadCredentialsFromSource: () => ClaudeCredentials | null
  /** Raw read of the account's store, without the usable-expiry check. */
  readStoredCredentials: (
    source: string,
    configDir: string | undefined,
  ) => ClaudeCredentials | null
  /** Import diagnostics do not alter legacy refresh/store parsing. */
  readImportCredentials?: (
    source: string,
    configDir: string | undefined,
  ) => ClaudeCredentials | null
  getAccountBySource: (source: string) => ClaudeAccount | null
  /** Single-flight, lock-guarded rotation that also persists the result. */
  rotateAccountCredentials: (
    account: ClaudeAccount,
  ) => Promise<ClaudeCredentials | null>
  refreshViaOAuth: (refreshToken: string) => Promise<ClaudeCredentials | null>
  refreshManagedViaOAuth: (
    refreshToken: string,
  ) => Promise<ClaudeCredentials | null>
  writeBackCredentials: (
    source: string,
    creds: ClaudeCredentials,
    configDir: string | undefined,
    expectedPriorAccessToken: string,
  ) => boolean
  log: (event: string, data?: Record<string, unknown>) => void
}

/** A `Form.Answer` as the host collected it from {@link oauthMethodDescriptor}. */
export interface AuthorizeInputs {
  readonly account?: unknown
  readonly configLocation?: unknown
  readonly configDir?: unknown
}

/** Keep the displayed default and the imported file location in sync. */
function defaultConfigDir(account?: ClaudeAccount | null): string {
  return (
    account?.configDir ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), ".claude")
  )
}

/**
 * `/connect` always requires an explicit source. OpenCode renders a
 * `string` field that has `options` as a pick list (no `custom`, so only a
 * listed account can be chosen) and hands the selection back to `authorize`
 * under the field's key. Each option is described by its credential source,
 * which is what tells two accounts on the same subscription tier apart.
 */
export function oauthMethodDescriptor(
  accounts: readonly ClaudeAccount[],
): IntegrationOAuthMethod {
  const method = {
    id: METHOD_ID,
    type: "oauth",
    label: "Import Claude Code subscription",
  } as const
  const options = accounts.map((account) => ({
    value: account.source,
    label: account.label,
    description: account.source,
  }))
  if (!options.some((option) => option.value === "file"))
    options.push({
      value: "file",
      label: "Credentials file",
      description: "Use an existing Claude Code login from a credentials file.",
    })
  return {
    ...method,
    form: [
      {
        type: "string",
        key: ACCOUNT_FIELD_KEY,
        title: "Select a Claude Code account",
        description:
          "Sign in to Claude Code first, then select the account to import.",
        required: true,
        options,
      },
      {
        type: "string",
        key: "configLocation",
        title: "Where are your Claude Code credentials?",
        description: "Usually no folder path is needed.",
        required: true,
        default: "default",
        when: [{ key: ACCOUNT_FIELD_KEY, op: "eq", value: "file" }],
        options: [
          {
            value: "default",
            label: "Use default location (recommended)",
            description: `Uses: ${defaultConfigDir(accounts.find((account) => account.source === "file"))}`,
          },
          {
            value: "custom",
            label: "Use a different location",
            description: "For a separate Claude Code setup or another account.",
          },
        ],
      },
      {
        type: "string",
        key: "configDir",
        title: "Claude Code folder (absolute path)",
        description:
          "Enter the full path to the folder containing .credentials.json, not the file itself.",
        required: true,
        when: [
          { key: ACCOUNT_FIELD_KEY, op: "eq", value: "file" },
          { key: "configLocation", op: "eq", value: "custom" },
        ],
      },
    ],
  }
}

export function resolveAuthorizeSource(
  inputs: AuthorizeInputs,
  _fallbackAccounts: readonly ClaudeAccount[],
  _deps: Pick<OAuthDeps, "refreshAccountsList" | "loadPersistedAccountSource">,
): string | undefined {
  const chosen = inputs[ACCOUNT_FIELD_KEY]
  return typeof chosen === "string" && chosen.trim() ? chosen : undefined
}

export async function buildOAuthCredential(
  source: string,
  deps: OAuthDeps,
  explicitConfigDir?: string,
): Promise<Credential.OAuth> {
  if (
    explicitConfigDir !== undefined &&
    (source !== "file" ||
      !explicitConfigDir.trim() ||
      !isAbsolute(explicitConfigDir))
  )
    throw new ClaudeAuthError(
      "CLAUDE_IMPORT_INPUT_INVALID",
      "Choose the file source with an absolute Claude config directory.",
    )
  const known = deps.getAccountBySource(source)
  const configDir =
    source === "file"
      ? (explicitConfigDir ?? defaultConfigDir(known))
      : known?.configDir
  let value: ClaudeCredentials | null
  try {
    value = (deps.readImportCredentials ?? deps.readStoredCredentials)(
      source,
      configDir,
    )
  } catch (error) {
    if (error instanceof ClaudeAuthError) throw error
    throw new ClaudeAuthError("CLAUDE_IMPORT_SOURCE_UNREADABLE")
  }
  if (!value) throw new ClaudeAuthError("CLAUDE_IMPORT_SOURCE_UNAVAILABLE")
  if (!value.accessToken?.trim() || !value.refreshToken?.trim())
    throw new ClaudeAuthError("CLAUDE_IMPORT_TOKEN_MISSING")
  return Credential.OAuth.make({
    type: "oauth",
    methodID: METHOD_ID,
    access: value.accessToken,
    refresh: value.refreshToken,
    expires: value.expiresAt,
    metadata: {
      [CLAUDE_CODE_OAUTH_METADATA_KEY]:
        MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE,
      credentialAuthority: "opencode",
      source,
      label:
        known && (!explicitConfigDir || known.configDir === explicitConfigDir)
          ? known.label
          : "Claude Code subscription",
      ...(configDir ? { configDir } : {}),
      ...(value.subscriptionType
        ? { subscriptionType: value.subscriptionType }
        : {}),
    },
  })
}

export async function authorizeOAuth(
  inputs: AuthorizeInputs,
  fallbackAccounts: readonly ClaudeAccount[],
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  const source = resolveAuthorizeSource(inputs, fallbackAccounts, deps)
  if (!source)
    throw new ClaudeAuthError(
      "CLAUDE_IMPORT_INPUT_INVALID",
      "Select a Claude credential source explicitly in /connect.",
    )
  // Conditional form fields may leave old answers behind after a user changes
  // their selection. Never let those answers redirect a non-file/default import.
  if (source !== "file" || inputs.configLocation === "default")
    return buildOAuthCredential(source, deps)
  if (inputs.configLocation === "custom") {
    const directory =
      typeof inputs.configDir === "string" ? inputs.configDir.trim() : ""
    if (!directory || !isAbsolute(directory))
      throw new ClaudeAuthError(
        "CLAUDE_IMPORT_INPUT_INVALID",
        "Enter an absolute path to the Claude Code folder.",
      )
    return buildOAuthCredential(source, deps, directory)
  }
  if (inputs.configLocation !== undefined)
    throw new ClaudeAuthError(
      "CLAUDE_IMPORT_INPUT_INVALID",
      "Choose a Claude Code credentials location in /connect.",
    )
  // Older clients send only configDir: retain their explicit-path / blank-default
  // behavior, without weakening validation for the new custom-location mode.
  if (inputs.configDir !== undefined && typeof inputs.configDir !== "string")
    throw new ClaudeAuthError(
      "CLAUDE_IMPORT_INPUT_INVALID",
      "Claude config directory must be a string.",
    )
  return buildOAuthCredential(
    source,
    deps,
    inputs.configDir?.trim() || undefined,
  )
}

export interface RefreshableCredential {
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  readonly metadata?: Record<string, unknown>
}

// In-process only. A source is provenance, NOT an identity: many credentials can
// originate from the same file. Share the exchange, never another caller's metadata.
const managedRefreshes = new Map<string, Promise<ClaudeCredentials | null>>()

async function refreshManagedCredential(
  value: RefreshableCredential,
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  const key = createHash("sha256").update(value.refresh).digest("hex")
  let pending = managedRefreshes.get(key)
  if (!pending) {
    pending = Promise.resolve().then(() =>
      deps.refreshManagedViaOAuth(value.refresh),
    )
    managedRefreshes.set(key, pending)
  }
  try {
    const refreshed = await pending
    if (!refreshed) throw new Error("refresh failed")
    return Credential.OAuth.make({
      ...value,
      methodID: METHOD_ID,
      access: refreshed.accessToken,
      refresh: refreshed.refreshToken,
      expires: refreshed.expiresAt,
    })
  } catch {
    // Never expose endpoint bodies or transport exceptions, which may echo tokens.
    throw new Error(
      "Managed Claude OAuth refresh failed. Retry later or re-import with /connect; no other account was used.",
    )
  } finally {
    if (managedRefreshes.get(key) === pending) managedRefreshes.delete(key)
  }
}

export async function refreshOAuthCredential(
  value: RefreshableCredential,
  deps: OAuthDeps,
): Promise<Credential.OAuth> {
  if (isManagedClaudeCredential(value))
    return refreshManagedCredential(value, deps)
  // A malformed/future managed marker must not fall into the legacy store path.
  if (value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY] === "v2")
    throw new Error(
      "Invalid managed Claude credential metadata. Re-import with /connect.",
    )
  const source =
    typeof value.metadata?.source === "string"
      ? value.metadata.source
      : undefined
  const configDir =
    typeof value.metadata?.configDir === "string"
      ? value.metadata.configDir
      : undefined

  // OpenCode persists whatever this returns and replays that same value on
  // every future refresh, forever, until we return something different. If
  // `claude` has since rotated credentials independently of this connection
  // (a fresh interactive login, its own periodic refresh, ...), the stored
  // refresh token goes permanently stale and every refresh fails with
  // invalid_grant even though a working credential is sitting in the
  // keychain right now. The keychain is the real source of truth, so check
  // it before ever attempting a network refresh with a token that may
  // already be dead.
  if (source) deps.setActiveAccountSource(source)
  const fresh = deps.reloadCredentialsFromSource()
  if (fresh && fresh.refreshToken !== value.refresh) {
    deps.log("refresh_resynced_from_keychain", { source })
    return Credential.OAuth.make({
      ...value,
      methodID: METHOD_ID,
      access: fresh.accessToken,
      refresh: fresh.refreshToken,
      expires: fresh.expiresAt,
    })
  }

  // An account the plugin tracks is also refreshed by the request path. Rotate
  // it through that same single-flight, cross-process-locked refresh: two
  // independent exchanges of one refresh token would leave one side holding
  // a token the other already spent.
  const account = source ? deps.getAccountBySource(source) : null
  if (account) {
    const rotated = await deps.rotateAccountCredentials(account)
    if (!rotated)
      throw new Error(
        "Claude OAuth refresh failed. Run `claude` to re-authenticate.",
      )
    return Credential.OAuth.make({
      ...value,
      methodID: METHOD_ID,
      access: rotated.accessToken,
      refresh: rotated.refreshToken,
      expires: rotated.expiresAt,
    })
  }

  // The reload above rejects a store whose access token is about to expire,
  // but its refresh token can still be newer than ours: after a sleep past
  // expiry, `claude` may have rotated it while our copy is already dead.
  // Refresh with the stored token and compare-and-swap against the stored
  // access token so the store receives the rotation.
  let stored: ClaudeCredentials | null = null
  try {
    if (source) stored = deps.readStoredCredentials(source, configDir)
  } catch {
    // A locked or denied keychain leaves our own token as the only candidate.
  }
  const current = stored?.refreshToken
    ? stored
    : { accessToken: value.access, refreshToken: value.refresh }
  if (current.refreshToken !== value.refresh)
    deps.log("refresh_using_stored_refresh_token", { source })

  const refreshed = await deps.refreshViaOAuth(current.refreshToken)
  if (!refreshed)
    throw new Error(
      "Claude OAuth refresh failed. Run `claude` to re-authenticate.",
    )
  if (source)
    deps.writeBackCredentials(source, refreshed, configDir, current.accessToken)
  return Credential.OAuth.make({
    ...value,
    methodID: METHOD_ID,
    access: refreshed.accessToken,
    refresh: refreshed.refreshToken,
    expires: refreshed.expiresAt,
  })
}

export function labelOAuthCredential(value: {
  metadata?: Record<string, unknown>
}): string | undefined {
  return typeof value.metadata?.label === "string"
    ? value.metadata.label
    : undefined
}

/** The real, non-test wiring - shared by both the Effect and Promise plugin entrypoints. */
export const realOAuthDeps: OAuthDeps = {
  refreshAccountsList,
  loadPersistedAccountSource,
  getCachedCredentials,
  setActiveAccountSource,
  saveAccountSource,
  reloadCredentialsFromSource,
  readStoredCredentials: refreshAccount,
  readImportCredentials,
  getAccountBySource,
  rotateAccountCredentials,
  refreshViaOAuth,
  refreshManagedViaOAuth,
  writeBackCredentials,
  log,
}
