import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inspectPluginBrandIcon } from '@netcatty/plugin-contract';

/**
 * Rasterizes an SVG file to a 128x128 transparent static PNG using rsvg-convert.
 * Verifies the resulting PNG against @netcatty/plugin-contract's inspectPluginBrandIcon.
 */
export function rasterizeSvgToPng(svgPath, pngPath, size = 128) {
  const pngBytes = execFileSync('rsvg-convert', [
    '-w', String(size),
    '-h', String(size),
    '-f', 'png',
    svgPath,
  ]);
  const info = inspectPluginBrandIcon(pngBytes, pngPath);
  if (info.width !== size || info.height !== size || info.mimeType !== 'image/png') {
    throw new Error(`Unexpected PNG output for ${pngPath}: ${JSON.stringify(info)}`);
  }
  writeFileSync(pngPath, pngBytes);
  return createHash('sha256').update(pngBytes).digest('hex');
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// CLI mode: rasterize all entries in assets/brand-icon-ledger.json and verify/update hashes if --update
if (import.meta.url === `file://${process.argv[1]}`) {
  const update = process.argv.includes('--update');
  const iconLedgerPath = 'assets/icon-ledger.json';
  const brandLedgerPath = 'assets/brand-icon-ledger.json';
  const iconLedger = JSON.parse(readFileSync(iconLedgerPath, 'utf8'));
  const brandLedger = JSON.parse(readFileSync(brandLedgerPath, 'utf8'));

  for (const entry of iconLedger) {
    if (!existsSync(entry.file)) throw new Error(`Missing SVG: ${entry.file}`);
    const hash = sha256File(entry.file);
    if (update) entry.sha256 = hash;
    else if (hash !== entry.sha256) throw new Error(`SVG hash mismatch: ${entry.file}`);
  }

  for (const entry of brandLedger) {
    const srcHash = sha256File(entry.sourceFile);
    const pngHash = rasterizeSvgToPng(entry.sourceFile, entry.file, 128);
    if (update) {
      entry.sourceSha256 = srcHash;
      entry.sha256 = pngHash;
    } else if (pngHash !== entry.sha256 || srcHash !== entry.sourceSha256) {
      throw new Error(`Raster drift for ${entry.file}`);
    }
  }

  if (update) {
    writeFileSync(iconLedgerPath, JSON.stringify(iconLedger, null, 2) + '\n');
    writeFileSync(brandLedgerPath, JSON.stringify(brandLedger, null, 2) + '\n');
    console.log(`Updated ${iconLedger.length} SVG hashes and rasterized ${brandLedger.length} brand PNGs`);
  } else {
    console.log(`Verified ${brandLedger.length} rasterized brand PNGs`);
  }
}
