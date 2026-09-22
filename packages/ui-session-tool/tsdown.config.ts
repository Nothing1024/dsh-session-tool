import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib', format: 'esm', platform: 'node', target: 'es2024',
    fixedExtension: false, dts: true, clean: false,
    external: ['session-tool', /^@deepseek-ai\//],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib', format: 'cjs', platform: 'browser', target: 'es2022',
    dts: false, clean: false,
    external: ['react', 'react/jsx-runtime', /^@deepseek-ai\//],
    noExternal: [/^session-marks(\/|$)/],
    outputOptions: {
      entryFileNames: 'client.js', inlineDynamicImports: true,
      banner: 'window.__ModuleLoader__.load({ id: "ui-session-tool", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
