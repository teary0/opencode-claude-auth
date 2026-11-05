import { rmSync, copyFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
// Worktree validation can keep every generated artifact under test-results.
const output = new URL(
  process.env.OPENCODE_CLAUDE_AUTH_ISOLATED_BUILD === "1"
    ? "test-results/build/"
    : "dist/",
  root,
)
rmSync(output, { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "--outDir", fileURLToPath(output)],
  {
    cwd: root,
    stdio: "inherit",
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
copyFileSync(
  new URL("src/anthropic-prompt.txt", root),
  new URL("anthropic-prompt.txt", output),
)
