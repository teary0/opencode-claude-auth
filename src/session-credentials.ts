import type { Credential } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import { isManagedClaudeCredential, METHOD_ID } from "./oauth-method.ts"
import {
  AUTH_STATUS_RPC_METHOD,
  ClaudeAuthError,
  type AuthStatus,
} from "./auth-errors.ts"

export const SESSION_CREDENTIAL_METADATA_KEY =
  "opencode-claude-auth/credentialID"
export const SESSION_CREDENTIAL_CAPABILITIES = {
  sessionCredential: true,
  metadataKey: SESSION_CREDENTIAL_METADATA_KEY,
  authStatus: true,
  authErrorCodesVersion: 1,
} as const

export const SESSION_CREDENTIAL_RPC = {
  id: "griffinmartin.claude-auth",
  methods: {
    authStatus: AUTH_STATUS_RPC_METHOD,
    capabilities: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          sessionCredential: { type: "boolean", const: true },
          authStatus: { type: "boolean", const: true },
          authErrorCodesVersion: { type: "integer", const: 1 },
          metadataKey: {
            type: "string",
            const: SESSION_CREDENTIAL_METADATA_KEY,
          },
        },
        required: [
          "sessionCredential",
          "metadataKey",
          "authStatus",
          "authErrorCodesVersion",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const

interface SessionSnapshot {
  parentID?: string
  metadata?: Record<string, unknown>
}
export interface SessionCredentialDeps {
  getSession: (sessionID: string) => Promise<SessionSnapshot>
  getConnections: () => Promise<readonly ConnectionInfo[]>
  resolveConnection: (
    connection: ConnectionInfo,
  ) => Promise<Credential.Value | undefined>
}

const CACHE_TTL_MS = 5_000
const CACHE_LIMIT = 1024
const MAX_PARENT_LINKS = 10
const failure = () => new ClaudeAuthError("CLAUDE_SESSION_METADATA_FAILED")

/** Cache provenance only, never a token, resolved credential or global selection. */
export function createSessionCredentialSelector(
  deps: SessionCredentialDeps,
  now = Date.now,
  status?: AuthStatus,
) {
  const cache = new Map<
    string,
    { parentID?: string; pin: unknown; expires: number }
  >()
  const pending = new Map<
    string,
    Promise<{ parentID?: string; pin: unknown }>
  >()
  let generation = 0

  const invalidate = () => {
    generation++
    // A parent's metadata affects all descendants, including cached unpinned ones.
    cache.clear()
    pending.clear()
    status?.invalidateSessions()
  }
  const read = async (sessionID: string) => {
    const cached = cache.get(sessionID)
    if (cached && cached.expires > now()) return cached
    const version = generation
    let promise = pending.get(sessionID)
    if (!promise) {
      promise = Promise.resolve().then(async () => {
        const session = await deps.getSession(sessionID)
        return {
          parentID: session.parentID,
          pin: session.metadata?.[SESSION_CREDENTIAL_METADATA_KEY],
        }
      })
      pending.set(sessionID, promise)
    }
    try {
      const value = await promise
      if (version === generation) {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        cache.set(sessionID, { ...value, expires: now() + CACHE_TTL_MS })
      }
      return value
    } finally {
      if (pending.get(sessionID) === promise) pending.delete(sessionID)
    }
  }

  const credentialID = async (
    sessionID: string,
  ): Promise<string | undefined> => {
    try {
      if (!sessionID) throw failure()
      // An update arriving during a read must not repopulate or return stale data.
      for (let retry = 0; retry < 3; retry++) {
        const version = generation,
          seen = new Set<string>()
        let current = sessionID,
          result: string | undefined
        for (let depth = 0; depth <= MAX_PARENT_LINKS; depth++) {
          if (seen.has(current)) throw failure()
          seen.add(current)
          const value = await read(current)
          if (value.pin !== undefined && value.pin !== null) {
            if (typeof value.pin !== "string" || !value.pin.trim())
              throw failure()
            result = value.pin
            break
          }
          if (!value.parentID) break
          if (depth === MAX_PARENT_LINKS) throw failure()
          current = value.parentID
        }
        if (version === generation) return result
      }
      throw failure()
    } catch {
      // Session errors and malicious metadata must never echo tokens or labels.
      const error = failure()
      status?.failure("session", error, sessionID)
      throw error
    }
  }

  const select = async (
    sessionID: string,
  ): Promise<Credential.OAuth | undefined> => {
    const id = await credentialID(sessionID)
    if (id === undefined) {
      // This observes only the pin path, not the global credential's health.
      status?.success("session", sessionID)
      return undefined
    }
    try {
      const connection = (await deps.getConnections()).find(
        (item) => item.type === "credential" && item.id === id,
      )
      if (!connection)
        throw new ClaudeAuthError("CLAUDE_SESSION_ACCOUNT_NOT_FOUND")
      if (connection.type !== "credential" || connection.method !== "oauth")
        throw new ClaudeAuthError("CLAUDE_SESSION_ACCOUNT_NOT_MANAGED")
      const value = await deps.resolveConnection(connection)
      if (!value) throw new ClaudeAuthError("CLAUDE_SESSION_RESOLVE_FAILED")
      if (
        value?.type !== "oauth" ||
        value.methodID !== METHOD_ID ||
        !isManagedClaudeCredential(value)
      )
        throw new ClaudeAuthError("CLAUDE_SESSION_ACCOUNT_NOT_MANAGED")
      status?.success("session", sessionID)
      return value
    } catch (cause) {
      const error =
        cause instanceof ClaudeAuthError &&
        cause.code.startsWith("CLAUDE_SESSION_")
          ? cause
          : new ClaudeAuthError("CLAUDE_SESSION_RESOLVE_FAILED")
      status?.failure("session", error, sessionID)
      throw error
    }
  }
  return { credentialID, select, invalidate }
}
