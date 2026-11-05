/** Stable metadata contract for hosts and dashboards. Never infer authority from source. */
export const CLAUDE_CODE_OAUTH_METADATA_KEY =
  "opencode-claude-auth/claude-code-oauth"
export const CLAUDE_CODE_OAUTH_METADATA_VALUE = "v1"
export const MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE = "v2"

export function isManagedClaudeCredential(value: {
  metadata?: Record<string, unknown>
}): boolean {
  return (
    value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY] === "v2" &&
    value.metadata?.credentialAuthority === "opencode"
  )
}

export function isClaudeOAuthCredential(value: {
  metadata?: Record<string, unknown>
}): boolean {
  return (
    value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY] === "v1" ||
    isManagedClaudeCredential(value)
  )
}
