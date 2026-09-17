import { defineConfig } from 'tsdown'

/** Pure Node library: no cordis, no platform peers. */
export default defineConfig({
  entry: { index: 'src/index.ts', project: 'src/project.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: false,
})
