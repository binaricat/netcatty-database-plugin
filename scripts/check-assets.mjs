import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const ledger = JSON.parse(await readFile('assets/icon-ledger.json', 'utf8'));
for (const entry of ledger) {
  const svg = await readFile(entry.file, 'utf8');
  if (/<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(svg.replace(/url\(#[a-zA-Z0-9_-]+\)/g, 'local-gradient'))) throw new Error(`Unsafe SVG: ${entry.file}`);
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
const domestic = JSON.parse(await readFile('assets/domestic-icon-ledger.json', 'utf8'));
for (const entry of domestic) {
  if (!entry.distributionBasis.includes('NOT_CLEARED_FOR_GENERAL_DISTRIBUTION')) throw new Error('Missing domestic usage boundary');
  if (createHash('sha256').update(await readFile(entry.sourceFile)).digest('hex') !== entry.sourceSha256) throw new Error('Domestic source drift');
  if (createHash('sha256').update(await readFile(entry.renderFile)).digest('hex') !== entry.renderSha256) throw new Error('Domestic render source drift');
  for (const file of new Set([entry.sourceFile, entry.renderFile])) if (file.endsWith('.svg')) {
    const svg = await readFile(file, 'utf8');
    if (/<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(svg.replace(/url\(#[a-zA-Z0-9_-]+\)/g, 'local-gradient'))) throw new Error(`Unsafe domestic SVG: ${file}`);
  }
  for (const output of entry.outputs) {
    const png = await readFile(output.file);
    if (createHash('sha256').update(png).digest('hex') !== output.sha256) throw new Error('Domestic PNG drift');
    inspectPluginBrandIcon(png, output.file);
  }
}
console.log(`Validated ${domestic.length} domestic marks, local noncommercial use only`);

const uiIcons = JSON.parse(await readFile('assets/ui-icon-ledger.json', 'utf8'));
for (const entry of uiIcons) {
  const svg = await readFile(entry.file, 'utf8');
  if (createHash('sha256').update(svg).digest('hex') !== entry.sha256) throw new Error(`UI icon drift: ${entry.file}`);
  if (/<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(svg)) throw new Error(`Unsafe UI icon: ${entry.file}`);
}
console.log(`Validated ${uiIcons.length} static ISC UI icons`);
