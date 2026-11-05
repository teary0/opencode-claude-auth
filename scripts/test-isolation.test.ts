import assert from "node:assert/strict"
import { it } from "node:test"
import { homedir, tmpdir } from "node:os"
import { relative, isAbsolute } from "node:path"
import { execFileSync } from "node:child_process"

it("isolates every credential/config root per worker and blocks unfaked I/O", async () => {
  const root = process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX!
  assert.ok(root)
  for (const value of [
    homedir(),
    tmpdir(),
    ...[
      "HOME",
      "USERPROFILE",
      "CLAUDE_CONFIG_DIR",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "XDG_RUNTIME_DIR",
      "OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR",
    ].map((key) => process.env[key]!),
  ]) {
    assert.ok(value)
    const path = relative(root, value)
    assert.equal(isAbsolute(path), false)
    assert.equal(path.startsWith(".."), false)
  }
  assert.equal(process.env.HOME, process.env.USERPROFILE)
  await assert.rejects(
    () => fetch("https://example.invalid"),
    /blocked real network/,
  )
  assert.throws(
    () => execFileSync("isolated-test-never-executed"),
    /blocked real subprocess/,
  )
})
