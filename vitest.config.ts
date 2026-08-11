import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Test-lane resolution for the session-tool monorepo.
 *
 * - This project's own packages resolve to their TypeScript sources, so tests
 *   run the code under test, never stale lib output.
 * - Host-side `@deepseek-ai/*` value imports resolve through the `link:`
 *   node_modules entries to each worktree package's built node-half lib
 *   (plain ESM, node-runnable) — the worktree `pnpm run build:lib:host`
 *   produces those.
 * - cordis/cosmokit/schemastery resolve to the worktree's vendored sources
 *   (file: installs of the vendor dirs fight peer-resolution; the alias keeps
 *   the test lane on the sources).
 */
const WORKTREE = fileURLToPath(new URL('../plugin-dev/session-tool-env', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^session-tool$/, replacement: fileURLToPath(new URL('./packages/session-tool/src/index.ts', import.meta.url)) },
      { find: /^session-tool-local$/, replacement: fileURLToPath(new URL('./packages/session-tool-local/src/index.ts', import.meta.url)) },
      { find: /^tool-session$/, replacement: fileURLToPath(new URL('./packages/tool-session/src/index.ts', import.meta.url)) },
      { find: /^session-tool-cli$/, replacement: fileURLToPath(new URL('./packages/session-tool-cli/src/index.ts', import.meta.url)) },
      { find: /^cordis$/, replacement: `${WORKTREE}/vendor/cordis/src/index.ts` },
      { find: /^cosmokit$/, replacement: `${WORKTREE}/vendor/cosmokit/src/index.ts` },
      { find: /^schemastery$/, replacement: `${WORKTREE}/vendor/schemastery/src/index.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts'],
  },
})
