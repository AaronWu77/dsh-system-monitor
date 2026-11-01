/** Independent Host ESM, private Worker, and DSH browser factory artifacts. */
import { readFile } from 'node:fs/promises'
import { dirname, resolve, basename } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
const platform = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'])
export default defineConfig([
  { entry: { index: 'src/host/index.ts', 'collector-worker': 'src/host/collector-worker.ts' }, outDir: 'lib', platform: 'node', format: 'esm', target: 'es2024', fixedExtension: false, clean: false, dts: false, deps: { neverBundle: [/^@deepseek-ai\//, 'koffi', 'zod'] } },
  { entry: { client: 'src/client/index.ts' }, outDir: 'lib', platform: 'browser', format: 'cjs', clean: false, dts: false, sourcemap: true,
    deps: { neverBundle: source => platform.has(source), alwaysBundle: source => !platform.has(source) },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [{ name: 'owned-monitor-css', resolveId(source, importer) {
      if (source.endsWith('.module.css') && importer) return '\0monitor-css:' + resolve(dirname(importer), source) + '.mjs'
      return null
    }, async load(id) {
      if (!id.startsWith('\0monitor-css:')) return null
      const file = id.slice('\0monitor-css:'.length, -4)
      this.addWatchFile(file)
      const result = transform({ filename: basename(file), code: Buffer.from(await readFile(file)), cssModules: { pattern: 'sm_[local]_[hash]' }, minify: true })
      const names = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
      return 'export default ' + JSON.stringify(names) + ';export const cssText=' + JSON.stringify(Buffer.from(result.code).toString('utf8')) + ';'
    } }, { name: 'monitor-client-imports', resolveId(source) {
      if (source.startsWith('@deepseek-ai/') && !platform.has(source)) throw new Error('System monitor browser value import is not a platform module: ' + source)
      if (source.startsWith('node:') || source === 'koffi') throw new Error('Host-only import in monitor browser bundle: ' + source)
      return null
    } }],
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({id:"dsh-system-monitor",factory:(require)=>{', intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});' },
  },
])
