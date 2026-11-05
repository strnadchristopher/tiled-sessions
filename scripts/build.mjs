// Inline src/engine.mjs into src/plugin.src.mjs → desktop/plugin.js.
// `node scripts/build.mjs --check` exits 1 when desktop/plugin.js is stale.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const engine = readFileSync(join(root, 'src/engine.mjs'), 'utf8')
  .replace(/^export (const|function) /gm, '$1 ')
  .trimEnd()
const shell = readFileSync(join(root, 'src/plugin.src.mjs'), 'utf8')
const marker = /\/\* ENGINE:BEGIN \*\/[\s\S]*?\/\* ENGINE:END \*\//

if (!marker.test(shell)) {
  console.error('ENGINE markers missing in src/plugin.src.mjs')
  process.exit(1)
}

const out = shell.replace(marker, () => `/* ENGINE:BEGIN */\n${engine}\n/* ENGINE:END */`)
const target = join(root, 'desktop/plugin.js')

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {}
  if (current !== out) {
    console.error('desktop/plugin.js is stale: run `node scripts/build.mjs`')
    process.exit(1)
  }
  console.log('desktop/plugin.js is up to date')
} else {
  writeFileSync(target, out)
  console.log(`wrote desktop/plugin.js (${out.length} bytes)`)
}
