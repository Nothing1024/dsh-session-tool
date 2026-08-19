import { defineConfig } from 'tsdown'

/** Vendor session-tags: ESM entries matching the unpublished official package. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    types: 'src/types.ts',
    client: 'src/client.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: false,
  external: ['cordis', 'schemastery', 'zod', /^@deepseek-ai\//],
})
