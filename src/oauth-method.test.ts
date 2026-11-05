import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { Integration } from "@opencode/plugin"
import type { ClaudeAccount } from "./keychain.ts"
import {
  authorizeOAuth,
  buildOAuthCredential,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE,
  labelOAuthCredential,
  oauthMethodDescriptor,
  refreshOAuthCredential,
  resolveAuthorizeSource,
  type OAuthDeps,
} from "./oauth-method.ts"

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    label: "Claude Pro",
    source: "Claude Code-credentials",
    credentials: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<OAuthDeps> = {}): OAuthDeps & {
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {
    setActiveAccountSource: [],
    saveAccountSource: [],
    writeBackCredentials: [],
    log: [],
  }
  const dependencies = {
    calls,
    refreshAccountsList: () => [account()],
    loadPersistedAccountSource: () => null,
    getCachedCredentials: async () => null,
    setActiveAccountSource: (source) => {
      calls.setActiveAccountSource.push(source)
    },
    saveAccountSource: (source) => {
      calls.saveAccountSource.push(source)
    },
    reloadCredentialsFromSource: () => null,
    readStoredCredentials: () => null,
    // No tracked account by default, so refresh tests exercise the direct
    // exchange used for credentials the plugin no longer knows about.
    getAccountBySource: () => null,
    rotateAccountCredentials: async () => null,
    refreshViaOAuth: async () => null,
    refreshManagedViaOAuth: async () => null,
    writeBackCredentials: (source, creds, configDir, expected) => {
      calls.writeBackCredentials.push([source, creds, configDir, expected])
      return true
    },
    log: (event, data) => {
      calls.log.push([event, data])
    },
    ...overrides,
  } satisfies OAuthDeps & { calls: Record<string, unknown[]> }
  if (!overrides.getAccountBySource)
    dependencies.getAccountBySource = (source) =>
      dependencies
        .refreshAccountsList()
        .find((item) => item.source === source) ?? null
  if (!overrides.readStoredCredentials)
    dependencies.readStoredCredentials = (source) =>
      dependencies.refreshAccountsList().find((item) => item.source === source)
        ?.credentials ?? null
  return dependencies
}

describe("oauthMethodDescriptor", () => {
  it("requires an explicit choice even for a single account", () => {
    const descriptor = oauthMethodDescriptor([account()])
    assert.equal(descriptor.id, "claude-code")
    assert.equal(descriptor.type, "oauth")
    assert.equal(descriptor.label, "Import Claude Code subscription")
    assert.equal(descriptor.form?.[0].required, true)
  })

  it("offers explicit file import when discovery finds no accounts", () => {
    assert.equal(oauthMethodDescriptor([]).form?.[0].key, "account")
  })

  it("offers every account through a pick-list form field", () => {
    const descriptor = oauthMethodDescriptor([
      account({ label: "Claude Pro", source: "a" }),
      account({ label: "Claude Max", source: "b" }),
    ])
    // A chooser is a `string` field carrying `options`; OpenCode has no
    // `select` field type, and a field without `options` renders as free text.
    assert.equal(descriptor.form?.length, 3)
    const field = descriptor.form?.[0]
    assert.equal(field?.type, "string")
    assert.equal(field?.key, "account")
    assert.equal(field?.title, "Select a Claude Code account")
    assert.equal(field?.required, true)
    assert.deepEqual(field?.type === "string" ? field.options : undefined, [
      { value: "a", label: "Claude Pro", description: "a" },
      { value: "b", label: "Claude Max", description: "b" },
      {
        value: "file",
        label: "Credentials file",
        description:
          "Use an existing Claude Code login from a credentials file.",
      },
    ])
    // Without `custom` the host only accepts one of the listed accounts.
    assert.equal(field?.type === "string" ? field.custom : undefined, undefined)
  })

  it("collects the answer under the key resolveAuthorizeSource reads", () => {
    const accounts = [
      account({ label: "Claude Pro", source: "a" }),
      account({ label: "Claude Max", source: "b" }),
    ]
    const field = oauthMethodDescriptor(accounts).form?.[0]
    assert.ok(field)
    const answer = { [field.key]: "b" }
    assert.equal(
      resolveAuthorizeSource(answer, accounts, {
        refreshAccountsList: () => accounts,
        loadPersistedAccountSource: () => "a",
      }),
      "b",
    )
  })

  it("defaults to the recommended location and asks for a path only for custom file imports", () => {
    const descriptor = oauthMethodDescriptor([])
    const [accountField, location, directory] = descriptor.form!
    assert.equal(accountField.required, true)
    assert.equal("default" in accountField, false)
    assert.match(accountField.description!, /Sign in to Claude Code first/)
    assert.equal(location.key, "configLocation")
    assert.equal(location.type, "string")
    assert.equal(location.required, true)
    assert.deepEqual(location.when, [
      { key: "account", op: "eq", value: "file" },
    ])
    assert.equal(location.type === "string" && location.default, "default")
    assert.deepEqual(
      location.type === "string" &&
        location.options?.map(({ value, label }) => ({ value, label })),
      [
        { value: "default", label: "Use default location (recommended)" },
        { value: "custom", label: "Use a different location" },
      ],
    )
    assert.equal(directory.key, "configDir")
    assert.equal(directory.required, true)
    assert.deepEqual(directory.when, [
      { key: "account", op: "eq", value: "file" },
      { key: "configLocation", op: "eq", value: "custom" },
    ])
    assert.match(
      directory.description!,
      /folder containing .credentials.json, not the file/,
    )
    // The installed SDK schema validates and retains default/when. Rendering
    // and conditional answer enforcement belong to the host, not this plugin.
    const parsed = Integration.OAuthMethod.make(descriptor)
    assert.deepEqual(parsed.form, descriptor.form)
    for (const [index, field] of descriptor.form!.entries()) {
      if ("when" in field)
        for (const condition of field.when ?? [])
          assert.ok(
            descriptor
              .form!.slice(0, index)
              .some((earlier) => earlier.key === condition.key),
          )
    }
  })
})

describe("resolveAuthorizeSource", () => {
  it("prefers inputs.account over everything else", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      { account: "explicit" },
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "explicit")
  })

  it("does not fall back to the persisted account source", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, undefined)
  })

  it("does not select the first freshly-listed account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, undefined)
  })

  it("does not select from the original snapshot", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, undefined)
  })

  it("returns undefined when nothing is available", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({}, [], deps)
    assert.equal(source, undefined)
  })

  it("ignores a non-string inputs.account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({ account: 42 }, [], deps)
    assert.equal(source, undefined)
  })
})

describe("buildOAuthCredential", () => {
  it("builds a credential for the matching account", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", label: "A" }),
        account({ source: "b", label: "B" }),
      ],
    })
    const value = await buildOAuthCredential("b", deps)
    assert.equal(value.type, "oauth")
    assert.equal(value.methodID, "claude-code")
    assert.equal(value.metadata?.source, "b")
    assert.equal(value.metadata?.label, "B")
    assert.equal(
      value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
      MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE,
    )
  })

  it("rejects a missing selected source rather than importing the first account", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "only" })],
    })
    await assert.rejects(
      () => buildOAuthCredential("missing", deps),
      /source is unavailable/,
    )
  })

  it("throws when there are no accounts at all", async () => {
    const deps = makeDeps({ refreshAccountsList: () => [] })
    await assert.rejects(
      () => buildOAuthCredential("anything", deps),
      /source is unavailable/,
    )
  })

  it("ignores cached credentials and imports only the selected fresh store", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
      getCachedCredentials: async () => ({
        accessToken: "cached-access",
        refreshToken: "cached-refresh",
        expiresAt: 123,
      }),
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "sk-ant-oat01-access")
    assert.equal(value.refresh, "sk-ant-ort01-refresh")
    assert.notEqual(value.expires, 123)
  })

  it("falls back to the account's stored credentials when nothing is cached", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "stored-access",
            refreshToken: "stored-refresh",
            expiresAt: 456,
          },
        }),
      ],
      getCachedCredentials: async () => null,
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "stored-access")
    assert.equal(value.refresh, "stored-refresh")
    assert.equal(value.expires, 456)
  })

  it("includes configDir in metadata only when present", async () => {
    const withConfigDir = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", configDir: "/tmp/claude" }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withConfigDir)).metadata?.configDir,
      "/tmp/claude",
    )
    assert.equal(
      "configDir" in (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("includes subscriptionType in metadata only when present", async () => {
    const withType = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "x",
            refreshToken: "y",
            expiresAt: 1,
            subscriptionType: "team",
          },
        }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withType)).metadata?.subscriptionType,
      "team",
    )
    assert.equal(
      "subscriptionType" in
        (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("does not mutate legacy active-account selection", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "chosen" })],
    })
    await buildOAuthCredential("chosen", deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, [])
    assert.deepEqual(deps.calls.saveAccountSource, [])
  })
})

describe("authorizeOAuth", () => {
  it("builds a credential for the resolved source", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "resolved" })],
      loadPersistedAccountSource: () => "resolved",
    })
    const value = await authorizeOAuth({ account: "resolved" }, [], deps)
    assert.equal(value.metadata?.source, "resolved")
  })

  it("throws a clear error when no source can be resolved", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    await assert.rejects(
      () => authorizeOAuth({}, [], deps),
      /Select a Claude credential source explicitly/,
    )
  })

  it("shows and imports the same default: discovered folder, environment, then home", async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    const root = process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!
    assert.ok(root, "must run through the isolated test runner")
    try {
      for (const scenario of [
        {
          discovered: join(root, "discovered"),
          env: join(root, "env"),
          expected: join(root, "discovered"),
        },
        {
          discovered: undefined,
          env: join(root, "env"),
          expected: join(root, "env"),
        },
        {
          discovered: undefined,
          env: undefined,
          expected: join(homedir(), ".claude"),
        },
      ]) {
        if (scenario.env === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = scenario.env
        const accounts = scenario.discovered
          ? [account({ source: "file", configDir: scenario.discovered })]
          : []
        const reads: unknown[] = []
        const deps = makeDeps({
          refreshAccountsList: () => accounts,
          readStoredCredentials: (source, directory) => {
            reads.push([source, directory])
            return account().credentials
          },
        })
        const location = oauthMethodDescriptor(accounts).form![1]
        assert.equal(
          location.type === "string" && location.options?.[0].description,
          `Uses: ${scenario.expected}`,
        )
        for (const configDir of [
          undefined,
          join(root, "stale-custom"),
          "relative",
          "   ",
          42,
        ]) {
          const value = await authorizeOAuth(
            { account: "file", configLocation: "default", configDir },
            [],
            deps,
          )
          assert.equal(value.metadata?.configDir, scenario.expected)
          assert.equal(value.metadata?.source, "file")
          assert.equal(value.metadata?.credentialAuthority, "opencode")
          assert.equal(
            value.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
            MANAGED_CLAUDE_CODE_OAUTH_METADATA_VALUE,
          )
        }
        assert.deepEqual(reads, Array(5).fill(["file", scenario.expected]))
      }
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  it("uses a custom absolute folder ahead of discovery and the environment", async () => {
    const root = process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!
    const directory = join(root, "custom")
    const reads: unknown[] = []
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({ source: "file", configDir: join(root, "discovered") }),
      ],
      readStoredCredentials: (source, configDir) => {
        reads.push([source, configDir])
        return account().credentials
      },
    })
    const value = await authorizeOAuth(
      {
        account: "file",
        configLocation: "custom",
        configDir: `  ${directory}  `,
      },
      [],
      deps,
    )
    assert.deepEqual(reads, [["file", directory]])
    assert.equal(value.metadata?.configDir, directory)
    assert.equal(value.metadata?.label, "Claude Code subscription")
    assert.equal(value.metadata?.source, "file")
    assert.equal(value.metadata?.credentialAuthority, "opencode")
  })

  it("rejects blank, missing, non-string, and relative custom paths before reading any store", async () => {
    const deps = makeDeps({
      readStoredCredentials: () =>
        assert.fail("invalid custom input read a store"),
    })
    for (const configDir of [undefined, "", "   ", "relative", "~/.claude", 42])
      await assert.rejects(
        () =>
          authorizeOAuth(
            { account: "file", configLocation: "custom", configDir },
            [],
            deps,
          ),
        /absolute path/,
      )
    for (const configLocation of ["other", "", 42, null])
      await assert.rejects(
        () => authorizeOAuth({ account: "file", configLocation }, [], deps),
        /Choose a Claude Code credentials location/,
      )
  })

  it("ignores hidden location answers for a non-file source", async () => {
    const reads: unknown[] = []
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "keychain" })],
      readStoredCredentials: (source, configDir) => {
        reads.push([source, configDir])
        return account().credentials
      },
    })
    for (const configDir of ["relative", 42]) {
      const value = await authorizeOAuth(
        { account: "keychain", configLocation: "custom", configDir },
        [],
        deps,
      )
      assert.equal(value.metadata?.source, "keychain")
      assert.equal(value.metadata?.configDir, undefined)
    }
    assert.deepEqual(reads, [
      ["keychain", undefined],
      ["keychain", undefined],
    ])
  })

  it("accepts older clients without a location field, preserving explicit paths", async () => {
    const directory = join(
      process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!,
      "legacy-custom",
    )
    const deps = makeDeps({
      readStoredCredentials: () => account().credentials,
    })
    assert.equal(
      (
        await authorizeOAuth(
          { account: "file", configDir: directory },
          [],
          deps,
        )
      ).metadata?.configDir,
      directory,
    )
    for (const configDir of [undefined, "", "   "])
      assert.equal(
        (await authorizeOAuth({ account: "file", configDir }, [], deps))
          .metadata?.configDir,
        process.env.CLAUDE_CONFIG_DIR,
      )
    await assert.rejects(
      () =>
        authorizeOAuth({ account: "file", configDir: "relative" }, [], deps),
      /absolute/,
    )
    await assert.rejects(
      () => authorizeOAuth({ account: "file", configDir: 42 }, [], deps),
      /must be a string/,
    )
  })

  it("never falls back to another source or cached credentials after a selected source fails", async () => {
    for (const failure of ["missing", "unreadable"]) {
      const reads: unknown[] = []
      const deps = makeDeps({
        refreshAccountsList: () => [account({ source: "other" })],
        getCachedCredentials: async () =>
          assert.fail("used cached credentials"),
        readStoredCredentials: (source, directory) => {
          reads.push([source, directory])
          if (failure === "unreadable") throw new Error("private store error")
          return null
        },
      })
      for (const inputs of [
        { account: "file", configLocation: "default" },
        {
          account: "file",
          configLocation: "custom",
          configDir: join(
            process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!,
            "missing",
          ),
        },
        { account: "missing-keychain" },
      ])
        await assert.rejects(
          () => authorizeOAuth(inputs, [], deps),
          /Selected Claude credential source is (unavailable|unreadable)/,
        )
      assert.deepEqual(
        reads.map((read) => (read as unknown[])[0]),
        ["file", "file", "missing-keychain"],
      )
      assert.deepEqual(deps.calls.setActiveAccountSource, [])
      assert.deepEqual(deps.calls.saveAccountSource, [])
    }
  })
})

describe("refreshOAuthCredential", () => {
  const value = {
    type: "oauth" as const,
    access: "old-access",
    refresh: "old-refresh",
    metadata: { source: "acct", configDir: "/tmp/claude" },
  }

  it("resyncs from the keychain instead of hitting the network when it disagrees", async () => {
    let refreshViaOAuthCalled = false
    const deps = makeDeps({
      reloadCredentialsFromSource: () => ({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: 999,
      }),
      refreshViaOAuth: async () => {
        refreshViaOAuthCalled = true
        return null
      },
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "fresh-access")
    assert.equal(result.refresh, "fresh-refresh")
    assert.equal(result.expires, 999)
    assert.equal(refreshViaOAuthCalled, false)
    assert.deepEqual(deps.calls.log[0], [
      "refresh_resynced_from_keychain",
      { source: "acct" },
    ])
  })

  it("uses the stored refresh token even when the stored access token has expired", async () => {
    let tokenUsed: string | undefined
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      readStoredCredentials: (source, configDir) => {
        assert.equal(source, "acct")
        assert.equal(configDir, "/tmp/claude")
        return {
          accessToken: "expired-stored-access",
          refreshToken: "rotated-stored-refresh",
          expiresAt: 0,
        }
      },
      refreshViaOAuth: async (token) => {
        tokenUsed = token
        return {
          accessToken: "refreshed-access",
          refreshToken: "refreshed-refresh",
          expiresAt: 333,
        }
      },
    })

    const result = await refreshOAuthCredential(value, deps)

    assert.equal(tokenUsed, "rotated-stored-refresh")
    assert.equal(result.refresh, "refreshed-refresh")
    assert.equal(
      deps.calls.writeBackCredentials[0]?.[3],
      "expired-stored-access",
    )
  })

  it("falls back to OpenCode's refresh token when the store read throws", async () => {
    let tokenUsed: string | undefined
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      readStoredCredentials: () => {
        throw new Error("keychain locked")
      },
      refreshViaOAuth: async (token) => {
        tokenUsed = token
        return {
          accessToken: "refreshed-access",
          refreshToken: "refreshed-refresh",
          expiresAt: 333,
        }
      },
    })

    await refreshOAuthCredential(value, deps)

    assert.equal(tokenUsed, "old-refresh")
    assert.equal(deps.calls.writeBackCredentials[0]?.[3], "old-access")
  })

  it("preserves the Claude Code OAuth marker across refresh", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 111,
      }),
    })
    const result = await refreshOAuthCredential(
      {
        ...value,
        metadata: {
          ...value.metadata,
          [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
        },
      },
      deps,
    )
    assert.equal(
      result.metadata?.[CLAUDE_CODE_OAUTH_METADATA_KEY],
      CLAUDE_CODE_OAUTH_METADATA_VALUE,
    )
  })

  it("falls through to a network refresh when the keychain is unavailable", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 111,
      }),
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "refreshed-access")
  })

  it("falls through to a network refresh when the keychain agrees with what we have", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => ({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
      }),
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 222,
      }),
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "refreshed-access")
  })

  it("throws a clear error when the network refresh fails", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => null,
    })
    await assert.rejects(
      () => refreshOAuthCredential(value, deps),
      /Run `claude` to re-authenticate/,
    )
  })

  it("writes back credentials after a successful network refresh", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      }),
    })
    await refreshOAuthCredential(value, deps)
    assert.equal(deps.calls.writeBackCredentials.length, 1)
    assert.deepEqual(deps.calls.writeBackCredentials[0], [
      "acct",
      {
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      },
      "/tmp/claude",
      "old-access",
    ])
  })

  it("does not write back credentials when there is no source in metadata", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      }),
    })
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      deps,
    )
    assert.equal(deps.calls.writeBackCredentials.length, 0)
  })

  it("marks the account active before checking the keychain, only when a source is present", async () => {
    const successfulRefresh = {
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 999,
      }),
    }
    const deps = makeDeps(successfulRefresh)
    await refreshOAuthCredential(value, deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, ["acct"])

    const depsNoSource = makeDeps(successfulRefresh)
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      depsNoSource,
    )
    assert.deepEqual(depsNoSource.calls.setActiveAccountSource, [])
  })

  describe("for an account the plugin tracks", () => {
    const tracked = account({ source: "acct" })
    const rotated = {
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresAt: 444,
    }

    it("rotates through the shared refresh instead of exchanging the token itself", async () => {
      let rotatedAccount: ClaudeAccount | undefined
      let directExchange = false
      const deps = makeDeps({
        getAccountBySource: (source) => (source === "acct" ? tracked : null),
        rotateAccountCredentials: async (target) => {
          rotatedAccount = target
          return rotated
        },
        refreshViaOAuth: async () => {
          directExchange = true
          return null
        },
      })

      const result = await refreshOAuthCredential(value, deps)

      assert.equal(rotatedAccount, tracked)
      assert.equal(directExchange, false)
      assert.equal(result.access, "rotated-access")
      assert.equal(result.refresh, "rotated-refresh")
      assert.equal(result.expires, 444)
      // The shared refresh already persisted the rotation to the store.
      assert.equal(deps.calls.writeBackCredentials.length, 0)
    })

    it("still resyncs from the keychain before rotating", async () => {
      let rotations = 0
      const deps = makeDeps({
        getAccountBySource: () => tracked,
        reloadCredentialsFromSource: () => ({
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
          expiresAt: 999,
        }),
        rotateAccountCredentials: async () => {
          rotations += 1
          return rotated
        },
      })

      const result = await refreshOAuthCredential(value, deps)

      assert.equal(result.access, "fresh-access")
      assert.equal(rotations, 0)
    })

    it("throws a clear error when the shared refresh produces nothing", async () => {
      const deps = makeDeps({
        getAccountBySource: () => tracked,
        rotateAccountCredentials: async () => null,
      })
      await assert.rejects(
        () => refreshOAuthCredential(value, deps),
        /Run `claude` to re-authenticate/,
      )
    })
  })
})

describe("labelOAuthCredential", () => {
  it("returns the label when it is a string", () => {
    assert.equal(
      labelOAuthCredential({ metadata: { label: "Claude Pro" } }),
      "Claude Pro",
    )
  })

  it("returns undefined when metadata is absent", () => {
    assert.equal(labelOAuthCredential({}), undefined)
  })

  it("returns undefined when the label is not a string", () => {
    assert.equal(labelOAuthCredential({ metadata: { label: 42 } }), undefined)
  })
})
