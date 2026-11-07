import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const ledger = JSON.parse(await readFile('assets/icon-ledger.json', 'utf8'));
for (const entry of ledger) {
  const svg = await readFile(entry.file, 'utf8');
  if (/<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(svg)) throw new Error(`Unsafe SVG: ${entry.file}`);
  if (createHash('sha256').update(svg).digest('hex') !== entry.sha256) throw new Error(`Asset drift: ${entry.file}`);
}
console.log(`Validated ${ledger.length} licensed, resource-free SVGs`);

const { inspectPluginBrandIcon } = await import('@netcatty/plugin-contract');
const rasters = JSON.parse(await readFile('assets/brand-icon-ledger.json', 'utf8'));
for (const entry of rasters) {
  const png = await readFile(entry.file);
  const source = await readFile(entry.sourceFile);
  if (createHash('sha256').update(png).digest('hex') !== entry.sha256 || createHash('sha256').update(source).digest('hex') !== entry.sourceSha256) throw new Error(`Raster provenance drift: ${entry.file}`);
  const { width, height } = inspectPluginBrandIcon(png, entry.file);
  if (width !== 128 || height !== 128) throw new Error('Engine mark dimensions changed');
}
console.log(`Validated ${rasters.length} static brand PNGs with metadata.brand-icon contract and source hashes`);
