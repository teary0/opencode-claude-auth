export const AUTH_ERROR_CODES = [
  "CLAUDE_IMPORT_TOKEN_MISSING",
  "CLAUDE_IMPORT_SOURCE_UNAVAILABLE",
  "CLAUDE_IMPORT_SOURCE_UNREADABLE",
  "CLAUDE_IMPORT_SOURCE_INVALID",
  "CLAUDE_IMPORT_INPUT_INVALID",
  "CLAUDE_SESSION_ACCOUNT_NOT_FOUND",
  "CLAUDE_SESSION_ACCOUNT_NOT_MANAGED",
  "CLAUDE_SESSION_RESOLVE_FAILED",
  "CLAUDE_SESSION_METADATA_FAILED",
] as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]
export type AuthScope = "import" | "session"
export interface AuthObservation {
  state: "unknown" | "ok" | "error"
  code?: AuthErrorCode
}

const SESSION_MESSAGE =
  "Claude session credential is unavailable or invalid. Select a managed Claude credential or clear the session pin."
const IMPORT_MESSAGE =
  "Selected Claude credential source is unavailable. Re-import with /connect."

/** No cause, input, credential identifier or credential material is retained. */
export class ClaudeAuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message?: string) {
    super(
      message ??
        (code.startsWith("CLAUDE_SESSION_")
          ? SESSION_MESSAGE
          : code === "CLAUDE_IMPORT_SOURCE_UNREADABLE"
            ? "Selected Claude credential source is unreadable. Re-import with /connect."
            : IMPORT_MESSAGE),
    )
    this.code = code
  }
}

/** Passive, location-local observations; never a health check or a refresh. */
export function createAuthStatus(now = Date.now) {
  const entries = new Map<string, { value: AuthObservation; expires: number }>()
  const key = (scope: AuthScope, sessionID?: string) =>
    scope === "import" ? "import" : `session:${sessionID ?? ""}`
  const put = (
    scope: AuthScope,
    value: AuthObservation,
    sessionID?: string,
  ) => {
    const id = key(scope, sessionID)
    entries.delete(id)
    if (entries.size >= 1024) entries.delete(entries.keys().next().value!)
    entries.set(id, { value, expires: now() + 300_000 })
  }
  return {
    get(scope: AuthScope, sessionID?: string): AuthObservation {
      const id = key(scope, sessionID),
        entry = entries.get(id)
      if (!entry || entry.expires <= now()) {
        entries.delete(id)
        return { state: "unknown" }
      }
      return { ...entry.value }
    },
    success(scope: AuthScope, sessionID?: string) {
      put(scope, { state: "ok" }, sessionID)
    },
    failure(scope: AuthScope, error: ClaudeAuthError, sessionID?: string) {
      put(scope, { state: "error", code: error.code }, sessionID)
    },
    invalidateSessions() {
      for (const id of entries.keys())
        if (id.startsWith("session:")) entries.delete(id)
    },
  }
}

export type AuthStatus = ReturnType<typeof createAuthStatus>

export const AUTH_STATUS_RPC_METHOD = {
  input: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["import", "session"] },
      sessionID: { type: "string", minLength: 1 },
    },
    required: ["scope"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      state: { type: "string", enum: ["unknown", "ok", "error"] },
      code: { type: "string", enum: AUTH_ERROR_CODES },
    },
    required: ["state"],
    additionalProperties: false,
  },
} as const
