import { defineConfig } from 'tsdown'

/**
 * The dsh-session CLI ships two entries: the command implementation and the
 * `bin` referenced by package.json `bin` (a shebang entry that calls it).
 * cordis and every @deepseek-ai/* import resolve from the worktree checkout
 * through the `link:` node_modules entries; never bundled.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  external: ['cordis', 'cosmokit', 'schemastery', 'session-marks', 'session-tool', /^@deepseek-ai\//],
})
