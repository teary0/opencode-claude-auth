import childProcess from "node:child_process"
import net from "node:net"
import tls from "node:tls"
import { syncBuiltinESMExports } from "node:module"
import { mkdtempSync, mkdirSync } from "node:fs"
import { join, relative } from "node:path"

// The parent test runner must spawn workers; workers may only use explicit fakes.
if (process.env.NODE_TEST_CONTEXT) {
  if (!process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX)
    throw new Error("Missing test sandbox")
  // Workers run concurrently: a fake credential created by one test file must
  // not become another test file's default account.
  const parent = process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX
  const sandbox = mkdtempSync(join(parent, "worker-"))
  for (const key of [
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
    "TMP",
    "TEMP",
    "TMPDIR",
    "OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR",
  ]) {
    process.env[key] = join(sandbox, relative(parent, process.env[key]))
    mkdirSync(process.env[key], { recursive: true })
  }
  process.env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX = sandbox
  const counts = (globalThis.__isolatedTestCalls = {
    subprocess: 0,
    network: 0,
  })
  const blocked = () => {
    counts.network++
    throw new Error("Isolated test blocked real network")
  }
  const blockedProcess = () => {
    counts.subprocess++
    throw new Error("Isolated test blocked real subprocess")
  }
  globalThis.fetch = async () => blocked()
  for (const name of [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ])
    childProcess[name] = blockedProcess
  net.connect = net.createConnection = tls.connect = blocked
  net.Socket.prototype.connect = blocked
  syncBuiltinESMExports()
}
