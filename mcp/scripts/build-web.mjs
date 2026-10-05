import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

await build({
  entryPoints: ['src/web/explorer.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/web/explorer.js',
  plugins: [
    {
      name: 'browser-schema-validation',
      setup(builder) {
        builder.onResolve({ filter: /\/ajv-provider\.js$/ }, () => ({
          path: resolve('src/web/schema-validator.ts')
        }))
      }
    }
  ]
})

const bundle = await readFile('dist/web/explorer.js', 'utf8')
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(bundle)) {
  throw new Error('The browser bundle must not contain runtime JavaScript code generation')
}
