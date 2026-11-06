import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const ledger = JSON.parse(await readFile('assets/icon-ledger.json', 'utf8'));
for (const entry of ledger) {
  const svg = await readFile(entry.file, 'utf8');
  if (/<(?:script|image|foreignObject|use|style)\b|(?:href|on\w+)\s*=|url\(/i.test(svg)) throw new Error(`Unsafe SVG: ${entry.file}`);
  if (createHash('sha256').update(svg).digest('hex') !== entry.sha256) throw new Error(`Asset drift: ${entry.file}`);
}
console.log(`Validated ${ledger.length} licensed, resource-free SVGs`);
