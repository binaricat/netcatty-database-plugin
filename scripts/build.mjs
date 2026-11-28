import { build } from 'esbuild';
import * as csstree from 'css-tree';
import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';

await rm('dist/package', { recursive: true, force: true });
await mkdir('dist/package', { recursive: true });
await build({
  entryPoints: { browser: 'src/index.tsx' },
  outdir: 'dist/package',
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  plugins: [
    {
      name: 'minify-plugin-css',
      setup(b) {
        b.onLoad({ filter: /\.css$/ }, async (args) => {
          const raw = await readFile(args.path, 'utf8');
          const minified = csstree.generate(csstree.parse(raw, { parseCustomProperty: true, positions: false }));
          return { contents: minified, loader: 'text' };
        });
      },
    },
    {
      name: 'sqlite-browser-only',
      setup(b) {
        b.onResolve({ filter: /^node:(?:fs|crypto)$/ }, (args) =>
          /[\\/]sql-asm\.js$/.test(args.importer) ? { path: args.path, namespace: 'sqlite-no-node' } : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: 'sqlite-no-node' }, () => ({
          contents: 'throw new Error("Node APIs are unavailable in the SQLite browser engine");',
          loader: 'js',
        }));
      },
    },
  ],
  metafile: true,
}).then(async ({ metafile }) => writeFile('dist/build-inputs.json', JSON.stringify(metafile, null, 2)));

for (const file of ['netcatty.plugin.json', 'LICENSE', 'NOTICE', 'README.md']) await cp(file, `dist/package/${file}`);
await cp('assets', 'dist/package/assets', { recursive: true });
await cp('licenses', 'dist/package/licenses', { recursive: true });

async function checkNoDynamicEval(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await checkNoDynamicEval(full);
    } else if (entry.name.endsWith('.js')) {
      const code = await readFile(full, 'utf8');
      if (/\b(?:eval|new Function)\(/.test(code)) {
        throw new Error(`Dynamic evaluation in plugin bundle: ${full}`);
      }
    }
  }
}
await checkNoDynamicEval('dist/package');
