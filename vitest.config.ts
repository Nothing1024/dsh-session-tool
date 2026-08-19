import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Test-lane resolution for the session-tool monorepo (npm-based).
 * This project's own packages resolve to their TypeScript sources so tests
 * run the code under test. Platform `@deepseek-ai/*` and `@deepseek-ai/cordis`
 * resolve from the hoisted node_modules (pinned 0.1.0-rc.7 / 4.0.1).
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^session-marks$/, replacement: fileURLToPath(new URL('./packages/session-marks/src/index.ts', import.meta.url)) },
      { find: /^session-tool$/, replacement: fileURLToPath(new URL('./packages/session-tool/src/index.ts', import.meta.url)) },
      { find: /^session-tool-local$/, replacement: fileURLToPath(new URL('./packages/session-tool-local/src/index.ts', import.meta.url)) },
      { find: /^tool-session$/, replacement: fileURLToPath(new URL('./packages/tool-session/src/index.ts', import.meta.url)) },
      { find: /^session-tool-cli$/, replacement: fileURLToPath(new URL('./packages/session-tool-cli/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts'],
  },
})
