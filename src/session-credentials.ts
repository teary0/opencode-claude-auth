import type { Credential } from "@opencode/plugin"
import type { ConnectionInfo } from "@opencode/client"
import { isManagedClaudeCredential, METHOD_ID } from "./oauth-method.ts"

export const SESSION_CREDENTIAL_METADATA_KEY =
  "opencode-claude-auth/credentialID"
export const SESSION_CREDENTIAL_CAPABILITIES = {
  sessionCredential: true,
  metadataKey: SESSION_CREDENTIAL_METADATA_KEY,
} as const

export const SESSION_CREDENTIAL_RPC = {
  id: "griffinmartin.claude-auth",
  methods: {
    capabilities: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          sessionCredential: { type: "boolean", const: true },
          metadataKey: {
            type: "string",
            const: SESSION_CREDENTIAL_METADATA_KEY,
          },
        },
        required: ["sessionCredential", "metadataKey"],
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
const failure = () =>
  new Error(
    "Claude session credential is unavailable or invalid. Select a managed Claude credential or clear the session pin.",
  )

/** Cache provenance only, never a token, resolved credential or global selection. */
export function createSessionCredentialSelector(
  deps: SessionCredentialDeps,
  now = Date.now,
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
      throw failure()
    }
  }

  const select = async (
    sessionID: string,
  ): Promise<Credential.OAuth | undefined> => {
    const id = await credentialID(sessionID)
    if (id === undefined) return undefined
    try {
      const connection = (await deps.getConnections()).find(
        (item) => item.type === "credential" && item.id === id,
      )
      if (
        !connection ||
        connection.type !== "credential" ||
        connection.method !== "oauth"
      )
        throw failure()
      const value = await deps.resolveConnection(connection)
      if (
        value?.type !== "oauth" ||
        value.methodID !== METHOD_ID ||
        !isManagedClaudeCredential(value)
      )
        throw failure()
      return value
    } catch {
      throw failure()
    }
  }
  return { credentialID, select, invalidate }
}
