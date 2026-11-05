import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import plugin from "./index.ts"
import { CLAUDE_CODE_OAUTH_METADATA_KEY, METHOD_ID } from "./oauth-method.ts"

const KEY = "opencode-claude-auth/credentialID"
const managed = (id: string) => ({
  type: "oauth",
  methodID: METHOD_ID,
  access: `sentinel-access-${id}`,
  refresh: `sentinel-refresh-${id}`,
  expires: Date.now() + 3600000,
  metadata: {
    [CLAUDE_CODE_OAUTH_METADATA_KEY]: "v2",
    credentialAuthority: "opencode",
    label: `sentinel-label-${id}`,
  },
})

async function harness() {
  const hooks = new Map<string, (event: any) => Promise<void>>()
  const sessions = new Map<string, any>([
    ["X", { metadata: { [KEY]: "A" } }],
    ["Y", { metadata: { [KEY]: "B" } }],
    ["free", { metadata: {} }],
  ])
  const values = new Map<string, any>([
    ["A", managed("A")],
    ["B", managed("B")],
  ])
  let active: string | undefined = "B"
  let activeCalls = 0
  const reads: string[] = [],
    resolved: string[] = [],
    rpc: any[] = []
  let refresh: ((value: any) => Promise<any>) | undefined
  let authorize: ((value: any) => Promise<any>) | undefined
  let pending: ((value: any) => void) | undefined
  const queue: any[] = []
  const ctx = {
    rpc: {
      register: async (definition: any, handlers: any) => {
        rpc.push({ definition, handlers })
        return { dispose: () => {} }
      },
    },
    integration: {
      transform: async (edit: any) =>
        edit({
          update: () => {},
          method: {
            update: (registration: any) => {
              refresh = registration.refresh
              authorize = registration.authorize
            },
          },
        }),
      get: async () => ({
        data: {
          connections: [...values.keys()].map((id) => ({
            type: "credential",
            id,
            label: "sentinel-connection-label",
            method: "oauth",
          })),
        },
      }),
      connection: {
        active: async () => {
          activeCalls++
          return active ? { type: "credential", id: active } : undefined
        },
        resolve: async (connection: any) => {
          resolved.push(connection.id)
          let value = values.get(connection.id)
          if (value && value.expires <= Date.now()) {
            value = await refresh!(value)
            values.set(connection.id, value)
          }
          return value
        },
      },
    },
    provider: { transform: async () => {}, reload: async () => {} },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", () => pending?.(undefined), {
          once: true,
        })
        while (!signal.aborted) {
          const value = queue.length
            ? queue.shift()
            : await new Promise((resolve) => {
                pending = resolve
              })
          pending = undefined
          if (value) yield value
        }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        reads.push(sessionID)
        const value = sessions.get(sessionID)
        if (!value)
          throw new Error("sentinel-access-A sentinel-label-A missing session")
        return structuredClone(value)
      },
      hook: async (kind: string, handler: any) => {
        hooks.set(kind, handler)
      },
    },
  }
  const dispose = await plugin.setup(ctx as never)
  resolved.length = 0
  activeCalls = 0
  const event = (
    sessionID = "X",
    kind = "primary",
    providerID = "anthropic",
  ) => ({
    sessionID,
    kind,
    model: { providerID, id: "claude-haiku-5-5" },
    request: new Request("https://example.invalid/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
    }),
  })
  return {
    hooks,
    sessions,
    values,
    reads,
    resolved,
    rpc,
    ctx,
    authorize: (input: any) => authorize!(input),
    event,
    activeCalls: () => activeCalls,
    setActive: (id?: string) => {
      active = id
    },
    request: async (sessionID = "X", kind = "primary") => {
      const value = event(sessionID, kind)
      await hooks.get("http.request")!(value)
      return value
    },
    emit: async (value: any) => {
      if (pending) pending(value)
      else queue.push(value)
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    },
    dispose: async () => {
      await dispose?.()
    },
  }
}

describe("session credential pinning", () => {
  it("registers the capabilities RPC contract", async () => {
    const h = await harness()
    try {
      const entry = h.rpc.find(
        (r) => r.definition.id === "griffinmartin.claude-auth",
      )
      assert.ok(entry)
      assert.deepEqual(await entry.handlers.capabilities({}), {
        sessionCredential: true,
        metadataKey: KEY,
        authStatus: true,
        authErrorCodesVersion: 1,
      })
    } finally {
      await h.dispose()
    }
  })

  it("publishes safe passive import/session observations via RPC, never resolving on lookup", async () => {
    const h = await harness()
    try {
      const rpc = h.rpc[0].handlers
      const status = (sessionID = "X") =>
        rpc.authStatus({ scope: "session", sessionID })
      assert.deepEqual(await status(), { state: "unknown" })
      assert.deepEqual(h.resolved, [])
      for (const [value, code] of [
        [undefined, "CLAUDE_SESSION_ACCOUNT_NOT_FOUND"],
        [
          { ...managed("A"), metadata: {} },
          "CLAUDE_SESSION_ACCOUNT_NOT_MANAGED",
        ],
        [
          { ...managed("A"), methodID: "wrong" },
          "CLAUDE_SESSION_ACCOUNT_NOT_MANAGED",
        ],
      ] as const) {
        if (value) h.values.set("A", value)
        else h.values.delete("A")
        await assert.rejects(h.request(), (error: any) => error.code === code)
        assert.deepEqual(await status(), { state: "error", code })
      }
      h.values.set("A", managed("A"))
      const resolve = h.ctx.integration.connection.resolve
      h.ctx.integration.connection.resolve = async () => {
        throw new Error("sentinel-secret-cause")
      }
      await assert.rejects(
        h.request(),
        (error: any) => error.code === "CLAUDE_SESSION_RESOLVE_FAILED",
      )
      assert.deepEqual(await status(), {
        state: "error",
        code: "CLAUDE_SESSION_RESOLVE_FAILED",
      })
      h.ctx.integration.connection.resolve = async () => undefined
      await assert.rejects(
        h.request(),
        (error: any) => error.code === "CLAUDE_SESSION_RESOLVE_FAILED",
      )
      h.ctx.integration.connection.resolve = resolve
      const count = h.resolved.length
      await status()
      assert.equal(h.resolved.length, count)
      await h.request()
      assert.deepEqual(await status(), { state: "ok" })
      assert.deepEqual(await status("Y"), { state: "unknown" })
      await assert.rejects(
        h.request("missing"),
        (error: any) => error.code === "CLAUDE_SESSION_METADATA_FAILED",
      )
      assert.deepEqual(await status("missing"), {
        state: "error",
        code: "CLAUDE_SESSION_METADATA_FAILED",
      })
      await assert.rejects(
        h.authorize({ account: "file" }),
        (error: any) => error.code === "CLAUDE_IMPORT_SOURCE_UNAVAILABLE",
      )
      assert.deepEqual(await rpc.authStatus({ scope: "import" }), {
        state: "error",
        code: "CLAUDE_IMPORT_SOURCE_UNAVAILABLE",
      })
      const configDir = join(
        process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!,
        "rpc-import",
      )
      mkdirSync(configDir)
      writeFileSync(
        join(configDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "",
            refreshToken: "sentinel-refresh",
            expiresAt: 1,
          },
        }),
      )
      const inputs = { account: "file", configLocation: "custom", configDir }
      await assert.rejects(
        h.authorize(inputs),
        (error: any) => error.code === "CLAUDE_IMPORT_TOKEN_MISSING",
      )
      assert.deepEqual(await rpc.authStatus({ scope: "import" }), {
        state: "error",
        code: "CLAUDE_IMPORT_TOKEN_MISSING",
      })
      writeFileSync(
        join(configDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "sentinel-access",
            refreshToken: "sentinel-refresh",
            expiresAt: 1,
          },
        }),
      )
      await h.authorize(inputs)
      assert.deepEqual(await rpc.authStatus({ scope: "import" }), {
        state: "ok",
      })
      assert.deepEqual(await rpc.authStatus({ scope: "session" }), {
        state: "unknown",
      })
      assert.equal(h.activeCalls(), 0)
    } finally {
      await h.dispose()
    }
  })

  it("resolves inactive A for X and active B for Y concurrently without activating anything", async () => {
    const h = await harness()
    try {
      const [x, y] = await Promise.all([h.request("X"), h.request("Y")])
      assert.equal(
        x.request.headers.get("authorization"),
        "Bearer sentinel-access-A",
      )
      assert.equal(
        y.request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
      assert.deepEqual(h.resolved.sort(), ["A", "B"])
      assert.equal(h.activeCalls(), 0)
    } finally {
      await h.dispose()
    }
  })

  it("pins primary, compaction, title and generate, including identity when global auth is a key", async () => {
    const h = await harness()
    h.values.set("B", { type: "key", key: "sentinel-key-B" })
    await h.emit({ type: "credential.updated", data: {} })
    try {
      for (const kind of ["primary", "compaction", "title", "generate"]) {
        const event = await h.request("X", kind)
        assert.equal(
          event.request.headers.get("authorization"),
          "Bearer sentinel-access-A",
        )
        const identity: any = {
          sessionID: "X",
          model: event.model,
          system: [],
          messages: [],
          options: {},
        }
        await h.hooks.get(kind === "primary" ? "context" : kind)!(identity)
        assert.match(identity.system[0]?.text ?? "", /You are Claude Code/)
      }
    } finally {
      await h.dispose()
    }
  })

  it("follows the nearest parent pin up to ten parent links; null inherits", async () => {
    const h = await harness()
    try {
      for (let i = 0; i < 10; i++)
        h.sessions.set("child" + i, {
          parentID: i === 9 ? "X" : "child" + (i + 1),
          metadata: { [KEY]: null },
        })
      assert.equal(
        (await h.request("child0")).request.headers.get("authorization"),
        "Bearer sentinel-access-A",
      )
      h.sessions.set("child4", { parentID: "child5", metadata: { [KEY]: "B" } })
      await h.emit({
        type: "session.metadata.updated",
        data: { sessionID: "child4", metadata: { [KEY]: "B" } },
      })
      assert.equal(
        (await h.request("child0")).request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
    } finally {
      await h.dispose()
    }
  })

  it("keeps unpinned/null roots on the existing global path and ignores other providers", async () => {
    const h = await harness()
    try {
      h.sessions.set("null", { metadata: { [KEY]: null } })
      for (const sessionID of ["free", "null"])
        assert.equal(
          (await h.request(sessionID)).request.headers.get("authorization"),
          "Bearer sentinel-access-B",
        )
      h.setActive("A")
      assert.equal(
        (await h.request("free")).request.headers.get("authorization"),
        "Bearer sentinel-access-A",
      )
      const event = h.event("not-present", "primary", "openai"),
        original = event.request
      await h.hooks.get("http.request")!(event)
      assert.equal(event.request, original)
      assert.equal(h.reads.includes("not-present"), false)
    } finally {
      await h.dispose()
    }
  })

  it("fails closed for missing, legacy, wrong method and key credentials without secret/label errors", async () => {
    const h = await harness()
    try {
      for (const value of [
        undefined,
        {
          ...managed("A"),
          metadata: { [CLAUDE_CODE_OAUTH_METADATA_KEY]: "v1" },
        },
        { ...managed("A"), methodID: "other" },
        { type: "key", key: "sentinel-key-A" },
      ]) {
        if (value) h.values.set("A", value)
        else h.values.delete("A")
        await assert.rejects(
          () => h.request(),
          (error) => {
            assert.match(String(error), /Claude session credential/)
            assert.doesNotMatch(String(error), /sentinel|label/)
            return true
          },
        )
      }
      assert.equal(h.activeCalls(), 0)
    } finally {
      await h.dispose()
    }
  })

  it("invalidates descendant and cached-unpinned sessions immediately on metadata updates", async () => {
    const h = await harness()
    try {
      h.sessions.set("child", { parentID: "X", metadata: {} })
      await h.request("child")
      const reads = h.reads.length
      await h.request("child")
      assert.equal(h.reads.length, reads)
      h.sessions.set("X", { metadata: { [KEY]: "B" } })
      await h.emit({
        type: "session.metadata.updated",
        data: { sessionID: "X", metadata: { [KEY]: "B" } },
      })
      assert.equal(
        (await h.request("child")).request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
      await h.request("free")
      h.sessions.set("free", { metadata: { [KEY]: "A" } })
      await h.emit({
        type: "session.metadata.updated",
        data: { sessionID: "free", metadata: { [KEY]: "A" } },
      })
      assert.equal(
        (await h.request("free")).request.headers.get("authorization"),
        "Bearer sentinel-access-A",
      )
    } finally {
      await h.dispose()
    }
  })

  it("expires metadata cache after five seconds without caching credential values", async () => {
    const h = await harness(),
      original = Date.now
    let now = original()
    Date.now = () => now
    try {
      await h.request("X")
      h.values.set("A", { ...managed("A"), access: "sentinel-access-A-new" })
      assert.equal(
        (await h.request("X")).request.headers.get("authorization"),
        "Bearer sentinel-access-A-new",
      )
      h.sessions.set("X", { metadata: { [KEY]: "B" } })
      now += 5001
      assert.equal(
        (await h.request("X")).request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
    } finally {
      Date.now = original
      await h.dispose()
    }
  })

  it("rejects malformed pins, missing session, cycles and a chain beyond ten parents", async () => {
    const h = await harness()
    try {
      for (const pin of [123, "", ["A"]]) {
        h.sessions.set("bad", { metadata: { [KEY]: pin } })
        await h.emit({
          type: "session.metadata.updated",
          data: { sessionID: "bad", metadata: { [KEY]: pin } },
        })
        await assert.rejects(
          () => h.request("bad"),
          /Claude session credential/,
        )
      }
      await assert.rejects(
        () => h.request("missing"),
        /Claude session credential/,
      )
      h.sessions.set("cycle", { metadata: {}, parentID: "cycle" })
      await assert.rejects(
        () => h.request("cycle"),
        /Claude session credential/,
      )
      for (let i = 0; i < 11; i++)
        h.sessions.set("deep" + i, {
          metadata: {},
          parentID: i === 10 ? "X" : "deep" + (i + 1),
        })
      await assert.rejects(
        () => h.request("deep0"),
        /Claude session credential/,
      )
    } finally {
      await h.dispose()
    }
  })

  it("refreshes only pinned expired A while B remains globally active", async () => {
    const h = await harness(),
      original = globalThis.fetch,
      tokens: string[] = []
    h.values.set("A", { ...managed("A"), expires: 0 })
    globalThis.fetch = async (_url, init) => {
      tokens.push(new URLSearchParams(String(init?.body)).get("refresh_token")!)
      return new Response(
        JSON.stringify({
          access_token: "sentinel-access-A2",
          refresh_token: "sentinel-refresh-A2",
          expires_in: 3600,
        }),
      )
    }
    try {
      assert.equal(
        (await h.request("X")).request.headers.get("authorization"),
        "Bearer sentinel-access-A2",
      )
      assert.deepEqual(tokens, ["sentinel-refresh-A"])
      assert.equal(h.values.get("B").access, "sentinel-access-B")
      assert.equal(h.activeCalls(), 0)
    } finally {
      globalThis.fetch = original
      await h.dispose()
    }
  })

  it("records actual managed refresh rejection without exposing the endpoint body", async () => {
    const h = await harness(),
      original = globalThis.fetch
    h.values.set("A", { ...managed("A"), expires: 0 })
    let exchanges = 0
    globalThis.fetch = async () => {
      exchanges++
      return new Response("sentinel-refresh sentinel-access /sentinel/path", {
        status: 400,
      })
    }
    try {
      await assert.rejects(h.request(), (error: any) => {
        assert.equal(error.code, "CLAUDE_SESSION_RESOLVE_FAILED")
        assert.doesNotMatch(JSON.stringify(error) + String(error), /sentinel/)
        assert.equal(error.cause, undefined)
        return true
      })
      assert.deepEqual(
        await h.rpc[0].handlers.authStatus({
          scope: "session",
          sessionID: "X",
        }),
        {
          state: "error",
          code: "CLAUDE_SESSION_RESOLVE_FAILED",
        },
      )
      assert.equal(exchanges, 1)
      assert.equal(h.activeCalls(), 0)
    } finally {
      globalThis.fetch = original
      await h.dispose()
    }
  })

  it("does not publish a stale in-flight metadata read after invalidation", async () => {
    const h = await harness(),
      originalGet = h.ctx.session.get
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let first = true
    h.ctx.session.get = async (input) => {
      const value = await originalGet(input)
      if (first) {
        first = false
        started()
        await gate
      }
      return value
    }
    try {
      const request = h.request("X")
      await readStarted
      h.sessions.set("X", { metadata: { [KEY]: "B" } })
      await h.emit({
        type: "session.metadata.updated",
        data: { sessionID: "X", metadata: { [KEY]: "B" } },
      })
      release()
      assert.equal(
        (await request).request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
      assert.equal(
        (await h.request("X")).request.headers.get("authorization"),
        "Bearer sentinel-access-B",
      )
    } finally {
      release()
      await h.dispose()
    }
  })

  it("invalidates a deleted ancestor and sanitizes connection/refresh failures without global fallback", async () => {
    const h = await harness(),
      originalResolve = h.ctx.integration.connection.resolve
    try {
      h.sessions.set("child", { parentID: "X", metadata: {} })
      await h.request("child")
      h.sessions.delete("X")
      await h.emit({ type: "session.deleted", data: { sessionID: "X" } })
      await assert.rejects(
        () => h.request("child"),
        /Claude session credential/,
      )
      h.sessions.set("X", { metadata: { [KEY]: "A" } })
      h.ctx.integration.connection.resolve = async () => {
        throw new Error("sentinel-refresh-A sentinel-label-A")
      }
      await assert.rejects(
        () => h.request("X"),
        (error) => {
          assert.match(String(error), /Claude session credential/)
          assert.doesNotMatch(String(error), /sentinel/)
          return true
        },
      )
      assert.equal(h.activeCalls(), 0)
    } finally {
      h.ctx.integration.connection.resolve = originalResolve
      await h.dispose()
    }
  })
})
