import { packPlugin, validateTarget, checkPluginCompatibility } from '@netcatty/plugin-cli';
import { writeFile } from 'node:fs/promises';
const stage = await validateTarget('dist/package');
// Minimum actually used from main. No experimental database service is assumed.
for (const features of [['views.host-drawn','views.vault-pages','metadata.brand-icon','ai.model-invocation','ai.agent-sessions','vault.host-actions','host.interactions']]) {
  const result = checkPluginCompatibility(stage.manifest, {netcattyVersion:'0.0.0',apiVersion:'0.1.0-internal.1',features});
  if (!result.compatible) throw new Error(result.errors.join('\n'));
}
const result=await packPlugin('dist/package','dist/netcatty-database-0.1.0-alpha.10.ncpkg');
await validateTarget(result.outputPath);
await writeFile('dist/SHA256SUMS',`${result.sha256}  netcatty-database-0.1.0-alpha.10.ncpkg\n`);
console.log(`Validated ${result.fileCount} files: ${result.outputPath}\nSHA256 ${result.sha256}`);
