import { mkdtempSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = fileURLToPath(new URL("../", import.meta.url))
const results = join(root, "test-results")
mkdirSync(results, { recursive: true })
const sandbox = mkdtempSync(join(results, "isolated-"))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^(XDG_|CLAUDE_|OPENCODE_|ANTHROPIC_|NODE_OPTIONS$)/.test(key))
    delete env[key]
}
for (const [key, dir] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  CLAUDE_CONFIG_DIR: "home/.claude",
  APPDATA: "roaming",
  LOCALAPPDATA: "local",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  XDG_RUNTIME_DIR: "runtime",
  TMP: "tmp",
  TEMP: "tmp",
  TMPDIR: "tmp",
  OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR: "locks",
})) {
  env[key] = join(sandbox, dir)
  mkdirSync(env[key], { recursive: true })
}
env.OPENCODE_CLAUDE_AUTH_TEST_SANDBOX = sandbox
const args = process.argv.slice(2)
const files = args.length
  ? args
  : ["src", "scripts"].flatMap((dir) =>
      readdirSync(join(root, dir))
        .filter((name) => name.endsWith(".test.ts"))
        .map((name) => join(dir, name)),
    )
console.log(
  "Isolated HOME/USERPROFILE/CLAUDE_CONFIG_DIR/APPDATA/LOCALAPPDATA/XDG/TMP:",
  sandbox,
)
try {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      new URL("test-guard.mjs", import.meta.url).href,
      "--test",
      "--test-reporter=tap",
      "--experimental-strip-types",
      ...files,
    ],
    { cwd: root, env, stdio: "inherit" },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
