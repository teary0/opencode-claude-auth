import { rmSync, copyFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

const root = new URL("../", import.meta.url)
rmSync(new URL("dist/", root), { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc"],
  {
    cwd: root,
    stdio: "inherit",
  },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
copyFileSync(
  new URL("src/anthropic-prompt.txt", root),
  new URL("dist/anthropic-prompt.txt", root),
)
