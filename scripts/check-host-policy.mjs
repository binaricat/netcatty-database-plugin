import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { validatePluginStylesheet } = createRequire(import.meta.url)('../vendor/host-policy/pluginViewStylePolicy.cjs');
validatePluginStylesheet(await readFile('src/style.css', 'utf8'));
console.log('Pinned Netcatty host stylesheet policy passed');
