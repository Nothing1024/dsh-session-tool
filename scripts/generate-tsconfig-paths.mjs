/**
 * Generate tsconfig.paths.json: one paths entry per linked worktree package
 * whose built declarations exist, pointing at the BUILT lib/types (the
 * artifact plane). Type-checking against declarations (skipLibCheck skips
 * checking them) keeps this project's tsc out of the worktree's source and
 * vendor trees, whose own tsconfigs differ from this project's flags.
 *
 * Re-run after the worktree adds a package this project imports:
 *   node scripts/generate-tsconfig-paths.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKTREE = join(ROOT, '..', 'plugin-dev/session-tool-env')

const paths = {}

const rel = (target) => `./${relative(ROOT, target)}`

function addPackage(name, dir) {
  const index = join(dir, 'lib', 'types', 'index.d.ts')
  if (!existsSync(index)) return
  paths[name] = [rel(index)]
  const siblings = readdirSync(join(dir, 'lib', 'types'))
    .filter(file => file.endsWith('.d.ts') && file !== 'index.d.ts')
  if (siblings.length > 0) {
    paths[`${name}/*`] = [rel(join(dir, 'lib', 'types', '*.d.ts'))]
  }
}

for (const group of readdirSync(join(WORKTREE, 'packages'))) {
  const groupDir = join(WORKTREE, 'packages', group)
  if (!existsSync(groupDir) || !statSync(groupDir).isDirectory()) continue
  for (const pkg of readdirSync(groupDir)) {
    const dir = join(WORKTREE, 'packages', group, pkg)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@deepseek-ai/')) {
      addPackage(manifest.name, dir)
    }
  }
}

for (const pkg of readdirSync(join(WORKTREE, 'vendor'))) {
  const dir = join(WORKTREE, 'vendor', pkg)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = manifest.name
  if (typeof name === 'string'
    && (name === 'cordis' || name === 'cosmokit' || name === 'schemastery' || name.startsWith('@cordisjs/'))) {
    addPackage(name, dir)
  }
}

// This project's own packages resolve to their TypeScript sources (they are
// not built yet when type-checking, and their own flags match this base).
for (const pkg of ['session-tool', 'session-tool-local', 'tool-session', 'session-tool-cli']) {
  paths[pkg] = [rel(join(ROOT, 'packages', pkg, 'src', 'index.ts'))]
}

writeFileSync(
  join(ROOT, 'tsconfig.paths.json'),
  `${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`,
)
console.log(`generated ${Object.keys(paths).length} path entries`)
