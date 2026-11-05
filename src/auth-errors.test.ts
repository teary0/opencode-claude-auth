import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { OpenCode } from "@opencode/client"
import { buildOAuthCredential, realOAuthDeps } from "./oauth-method.ts"
import { createAuthStatus, ClaudeAuthError } from "./auth-errors.ts"
import { SESSION_CREDENTIAL_RPC } from "./session-credentials.ts"

describe("safe auth diagnostics", () => {
  it("distinguishes absent/unreadable stores, missing subscription tokens and invalid blobs", async () => {
    const root = join(
      process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!,
      "diagnostics",
    )
    mkdirSync(root)
    const deps = { ...realOAuthDeps, getAccountBySource: () => null }
    const check = async (dir: string, code: string) => {
      await assert.rejects(
        buildOAuthCredential("file", deps, dir),
        (error: any) => {
          assert.equal(error.code, code)
          assert.match(
            error.message,
            /Selected Claude credential source is (unavailable|unreadable)\. Re-import with \/connect\./,
          )
          assert.doesNotMatch(
            JSON.stringify(error) + String(error),
            /sentinel|diagnostics|credentials\.json/,
          )
          assert.equal(error.cause, undefined)
          return true
        },
      )
    }
    await check(root, "CLAUDE_IMPORT_SOURCE_UNAVAILABLE")
    const path = join(root, ".credentials.json")
    for (const blob of [
      {},
      { mcpOAuth: { token: "sentinel-mcp" } },
      {
        claudeAiOauth: {
          accessToken: "",
          refreshToken: "sentinel-refresh",
          expiresAt: 1,
        },
      },
      { accessToken: "  ", refreshToken: "sentinel-refresh", expiresAt: 1 },
      { accessToken: "sentinel-access", refreshToken: "", expiresAt: 1 },
    ]) {
      writeFileSync(path, JSON.stringify(blob))
      await check(root, "CLAUDE_IMPORT_TOKEN_MISSING")
    }
    for (const raw of [
      "{sentinel",
      "null",
      "[]",
      JSON.stringify({
        accessToken: "sentinel-access",
        refreshToken: "sentinel-refresh",
      }),
    ]) {
      writeFileSync(path, raw)
      await check(root, "CLAUDE_IMPORT_SOURCE_INVALID")
    }
    const blocked = join(root, "blocked")
    mkdirSync(join(blocked, ".credentials.json"), { recursive: true })
    await check(blocked, "CLAUDE_IMPORT_SOURCE_UNREADABLE")
  })

  it("keeps bounded, expiring, copied observations without causes or identifiers", () => {
    let time = 0
    const status = createAuthStatus(() => time)
    assert.deepEqual(status.get("import"), { state: "unknown" })
    status.failure("import", new ClaudeAuthError("CLAUDE_IMPORT_TOKEN_MISSING"))
    assert.deepEqual(status.get("import"), {
      state: "error",
      code: "CLAUDE_IMPORT_TOKEN_MISSING",
    })
    status.success("import")
    assert.deepEqual(status.get("import"), { state: "ok" })
    status.failure(
      "session",
      new ClaudeAuthError("CLAUDE_SESSION_ACCOUNT_NOT_FOUND"),
      "sentinel-session",
    )
    const result: any = status.get("session", "sentinel-session")
    result.code = "sentinel-injected"
    assert.equal(
      status.get("session", "sentinel-session").code,
      "CLAUDE_SESSION_ACCOUNT_NOT_FOUND",
    )
    for (let i = 0; i < 1024; i++) status.success("session", String(i))
    assert.deepEqual(status.get("session", "sentinel-session"), {
      state: "unknown",
    })
    time += 300001
    assert.deepEqual(status.get("import"), { state: "unknown" })
    assert.deepEqual(status.get("session", "1023"), { state: "unknown" })
  })

  it("installed SDK discards undeclared 500 bodies but preserves successful status RPC output", async () => {
    const original = globalThis.fetch
    const client = OpenCode.make({
      baseUrl: "http://example.invalid",
      fetch: (...args) => globalThis.fetch(...args),
    })
    let cancelled = false
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"code":"sentinel-body"}'),
            )
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      )
    try {
      await assert.rejects(
        client.session.get({ sessionID: "fake" }),
        (error: any) => {
          assert.equal(error.reason, "UnexpectedStatus")
          assert.doesNotMatch(JSON.stringify(error), /sentinel-body/)
          return true
        },
      )
      assert.equal(cancelled, true)
      globalThis.fetch = async (url, init) => {
        assert.match(
          String(url),
          /\/api\/rpc\/griffinmartin.claude-auth\/authStatus/,
        )
        assert.deepEqual(JSON.parse(String(init?.body)), {
          input: { scope: "session", sessionID: "fake" },
        })
        return Response.json({
          output: { state: "error", code: "CLAUDE_SESSION_ACCOUNT_NOT_FOUND" },
        })
      }
      assert.deepEqual(
        await client
          .rpc(SESSION_CREDENTIAL_RPC)
          .authStatus({ scope: "session", sessionID: "fake" }),
        {
          state: "error",
          code: "CLAUDE_SESSION_ACCOUNT_NOT_FOUND",
        },
      )
    } finally {
      globalThis.fetch = original
    }
  })
})
