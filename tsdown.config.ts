import { defineConfig } from 'tsdown'

const ID = '@jackdu/dsh-hermes-workspace'
const EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-typert-protocol']

export default defineConfig([
  {
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: false,
    clean: true,
    deps: {
      neverBundle: EXTERNALS,
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    minify: false,
    sourcemap: false,
    clean: false,
    deps: {
      neverBundle: ['react', 'react/jsx-runtime'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
