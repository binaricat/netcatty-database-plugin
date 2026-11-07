import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/package', { recursive: true });
await build({ entryPoints: ['src/index.tsx'], outfile: 'dist/package/browser.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof', plugins: [{ name: 'sqlite-browser-only', setup(b) { b.onResolve({ filter: /^node:(?:fs|crypto)$/ }, args => args.importer.endsWith('/sql-asm.js') ? { path: args.path, namespace: 'sqlite-no-node' } : undefined); b.onLoad({ filter: /.*/, namespace: 'sqlite-no-node' }, () => ({ contents: 'throw new Error("Node APIs are unavailable in the SQLite browser engine");', loader: 'js' })); } }], metafile: true }).then(async ({ metafile }) => writeFile('dist/build-inputs.json', JSON.stringify(metafile, null, 2)));
for (const file of ['netcatty.plugin.json', 'LICENSE', 'NOTICE', 'README.md']) await cp(file, `dist/package/${file}`);
await cp('assets', 'dist/package/assets', { recursive: true });
await cp('licenses', 'dist/package/licenses', { recursive: true });
const code = await readFile('dist/package/browser.js', 'utf8');
if (/\b(?:eval|new Function)\(/.test(code)) throw new Error('Dynamic evaluation in plugin bundle');
