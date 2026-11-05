import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { Writable } from "node:stream"
import { initLogger, closeLogger } from "./logger.ts"
import * as oauth from "./oauth-method.ts"
import { initAccounts, setActiveAccountSource } from "./credentials.ts"
import { prepareClaudeRequest, finishClaudeResponse } from "./provider.ts"

const marker = {
  "opencode-claude-auth/claude-code-oauth": "v2",
  credentialAuthority: "opencode",
}
const credential = (id = "A") => ({
  type: "oauth" as const,
  access: `sentinel-access-${id}`,
  refresh: `sentinel-refresh-${id}`,
  metadata: { ...marker, source: "file", label: id, custom: "preserved" },
})
const context = { source: "file", credentialAuthority: "opencode" as const }
const request = () =>
  new Request("https://example.invalid/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [],
      tools: [{ name: "read", input_schema: {} }],
    }),
  })
function deps(refresh: (token: string) => Promise<any>) {
  const forbidden = () => {
    assert.fail("managed path accessed legacy source/cache/CLI/write-back")
  }
  return {
    ...Object.fromEntries(
      [
        "refreshAccountsList",
        "loadPersistedAccountSource",
        "getCachedCredentials",
        "setActiveAccountSource",
        "saveAccountSource",
        "reloadCredentialsFromSource",
        "readStoredCredentials",
        "getAccountBySource",
        "rotateAccountCredentials",
        "writeBackCredentials",
        "refreshViaOAuth",
      ].map((key) => [key, forbidden]),
    ),
    refreshManagedViaOAuth: refresh,
    log: forbidden,
  } as unknown as oauth.OAuthDeps
}

describe("managed credential authority", () => {
  it("exports an exact v2 + authority predicate; v1 cannot be silently promoted", () => {
    assert.equal(oauth.isManagedClaudeCredential(credential()), true)
    for (const metadata of [
      {},
      { ...marker, credentialAuthority: "cli" },
      { ...marker, "opencode-claude-auth/claude-code-oauth": "v1" },
      { "opencode-claude-auth/claude-code-oauth": "v2" },
    ])
      assert.equal(oauth.isManagedClaudeCredential({ metadata }), false)
  })

  it("keeps A/B/A inside 30 seconds despite same-source file B and never changes source bytes", async () => {
    const dir = process.env.CLAUDE_CONFIG_DIR!
    mkdirSync(dir, { recursive: true })
    const file = join(dir, ".credentials.json")
    const B = {
      accessToken: "sentinel-access-B",
      refreshToken: "sentinel-refresh-B",
      expiresAt: Date.now() + 3600000,
    }
    const bytes = JSON.stringify({ claudeAiOauth: B })
    writeFileSync(file, bytes)
    const counts = (globalThis as any).__isolatedTestCalls
    assert.ok(counts, "must run through the isolated test runner")
    const before = { ...counts }
    initAccounts([
      { label: "B", source: "file", configDir: dir, credentials: B },
    ])
    setActiveAccountSource("file")
    try {
      for (const id of ["A", "B", "A"]) {
        const prepared = await prepareClaudeRequest(
          request(),
          credential(id).access,
          context,
        )
        assert.equal(
          prepared.headers.get("authorization"),
          `Bearer sentinel-access-${id}`,
        )
        assert.match(await prepared.clone().text(), /mcp_Read/)
      }
      const noSource = { credentialAuthority: "opencode" as const }
      assert.equal(
        (
          await prepareClaudeRequest(request(), credential().access, noSource)
        ).headers.get("authorization"),
        "Bearer sentinel-access-A",
      )
      await assert.rejects(
        () => prepareClaudeRequest(request(), "", noSource),
        /Run \/connect/,
      )
      for (const status of [401, 429]) {
        const prepared = await prepareClaudeRequest(
          request(),
          credential().access,
          context,
        )
        let sends = 0
        const initial = new Response("rejected", { status })
        const response = await finishClaudeResponse(
          prepared,
          initial,
          context,
          async () => {
            sends++
            return new Response()
          },
        )
        assert.equal(response.status, status)
        assert.equal(sends, 0)
      }
      assert.equal(readFileSync(file, "utf8"), bytes)
      assert.deepEqual(
        counts,
        before,
        "managed requests must not even attempt network refresh or CLI",
      )
    } finally {
      initAccounts([])
    }
  })

  it("refreshes only A.refresh and preserves all metadata without source or CLI access", async () => {
    const used: string[] = []
    const result = await oauth.refreshOAuthCredential(
      credential(),
      deps(async (token) => {
        used.push(token)
        return {
          accessToken: "new-A",
          refreshToken: "new-refresh-A",
          expiresAt: 1234,
        }
      }),
    )
    assert.deepEqual(used, ["sentinel-refresh-A"])
    assert.equal(result.access, "new-A")
    assert.deepEqual(result.metadata, credential().metadata)
  })

  it("single-flights the same refresh token but separates different credentials sharing a source", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const used: string[] = []
    const dependencies = deps(async (token) => {
      used.push(token)
      await gate
      return {
        accessToken: token + "-access",
        refreshToken: token + "-next",
        expiresAt: 1234,
      }
    })
    const pending = [
      oauth.refreshOAuthCredential(credential(), dependencies),
      oauth.refreshOAuthCredential(
        {
          ...credential(),
          metadata: { ...credential().metadata, label: "alias-A" },
        },
        dependencies,
      ),
      oauth.refreshOAuthCredential(credential("B"), dependencies),
    ]
    await Promise.resolve()
    release()
    const values = await Promise.all(pending)
    assert.deepEqual(used.sort(), ["sentinel-refresh-A", "sentinel-refresh-B"])
    assert.equal(values[0].access, values[1].access)
    assert.equal(values[0].metadata?.label, "A")
    assert.equal(values[1].metadata?.label, "alias-A")
    assert.notEqual(values[0].access, values[2].access)
    assert.equal(values[2].metadata?.label, "B")
  })

  it("fails closed without token sentinels in errors, including a thrown transport error", async () => {
    for (const refresh of [
      async () => null,
      async () => {
        throw new Error("sentinel-refresh-A sentinel-access-B")
      },
    ]) {
      await assert.rejects(
        () => oauth.refreshOAuthCredential(credential(), deps(refresh)),
        (error) => {
          assert.match(String(error), /Managed Claude OAuth refresh failed/)
          assert.doesNotMatch(String(error), /sentinel/)
          return true
        },
      )
    }
  })

  it("real managed refresh wiring ignores file B on success, invalid_grant, 429, 503 and network failure", async () => {
    const file = join(process.env.CLAUDE_CONFIG_DIR!, ".credentials.json")
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sentinel-access-B",
          refreshToken: "sentinel-refresh-B",
          expiresAt: Date.now() + 3600000,
        },
      }),
    )
    const bytes = readFileSync(file, "utf8")
    const originalFetch = globalThis.fetch
    const counts = (globalThis as any).__isolatedTestCalls
    const before = { ...counts }
    let logs = ""
    initLogger({
      stream: new Writable({
        write(chunk, _encoding, done) {
          logs += chunk.toString()
          done()
        },
      }),
    })
    const tokens: string[] = []
    try {
      for (const status of [200, 400, 429, 503, 0]) {
        globalThis.fetch = async (_url, init) => {
          tokens.push(
            new URLSearchParams(String(init?.body)).get("refresh_token")!,
          )
          if (!status) throw new Error("sentinel-refresh-A sentinel-access-B")
          return new Response(
            JSON.stringify(
              status === 200
                ? {
                    access_token: "sentinel-new-A",
                    refresh_token: "sentinel-next-A",
                    expires_in: 3600,
                  }
                : {
                    error: "invalid_grant",
                    error_description: "sentinel-refresh-A sentinel-access-B",
                  },
            ),
            { status },
          )
        }
        if (status === 200) {
          const result = await oauth.refreshOAuthCredential(
            credential(),
            oauth.realOAuthDeps,
          )
          assert.equal(result.access, "sentinel-new-A")
          assert.deepEqual(result.metadata, credential().metadata)
        } else {
          await assert.rejects(
            () =>
              oauth.refreshOAuthCredential(credential(), oauth.realOAuthDeps),
            (error) => {
              assert.doesNotMatch(String(error), /sentinel/)
              return true
            },
          )
        }
      }
      assert.deepEqual(tokens, Array(5).fill("sentinel-refresh-A"))
      assert.equal(readFileSync(file, "utf8"), bytes)
      assert.doesNotMatch(logs, /sentinel/)
      assert.deepEqual(counts, before)
    } finally {
      globalThis.fetch = originalFetch
      closeLogger()
    }
  })

  it("rejects malformed v2 without entering legacy recovery", async () => {
    const value = credential()
    value.metadata.credentialAuthority = "cli"
    await assert.rejects(
      () =>
        oauth.refreshOAuthCredential(
          value,
          deps(async () => null),
        ),
      /Invalid managed/,
    )
  })

  it("imports an explicitly selected config directory freshly and fails if it disappears", async () => {
    const root = process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!
    const directory = join(root, "account-a")
    mkdirSync(directory, { recursive: true })
    const file = join(directory, ".credentials.json")
    const bytes = JSON.stringify({
      claudeAiOauth: {
        accessToken: "import-A",
        refreshToken: "refresh-A",
        expiresAt: Date.now() + 3600000,
      },
    })
    writeFileSync(file, bytes)
    const value = await oauth.authorizeOAuth(
      { account: "file", configDir: directory },
      [],
      oauth.realOAuthDeps,
    )
    assert.equal(value.access, "import-A")
    assert.equal(value.metadata?.configDir, directory)
    assert.equal(oauth.isManagedClaudeCredential(value), true)
    assert.equal(readFileSync(file, "utf8"), bytes)
    unlinkSync(file)
    await assert.rejects(
      () =>
        oauth.authorizeOAuth(
          { account: "file", configDir: directory },
          [],
          oauth.realOAuthDeps,
        ),
      /source is unavailable/,
    )
    await assert.rejects(
      () => oauth.authorizeOAuth({}, [], oauth.realOAuthDeps),
      /explicitly/,
    )
    await assert.rejects(
      () =>
        oauth.authorizeOAuth(
          { account: "file", configDir: "relative" },
          [],
          oauth.realOAuthDeps,
        ),
      /absolute/,
    )
  })
})
