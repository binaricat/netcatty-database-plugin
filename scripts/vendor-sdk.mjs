// Explicit maintainer operation. Normal install/build uses only committed tarballs.
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const host = process.argv[2];
if (!host || !path.isAbsolute(host)) throw new Error('Usage: node scripts/vendor-sdk.mjs /absolute/approved/host');
const temporary = await mkdtemp(path.join(tmpdir(), 'netcatty-sdk-snapshot-'));
try {
  for (const name of ['plugin-contract', 'plugin-sdk', 'plugin-cli']) {
    const destination = path.join(temporary, name); await mkdir(destination);
    for (const file of ['src', 'dist', 'schema', 'view', 'tsconfig.build.json', 'package.json']) {
      await cp(path.join(host, 'packages', name, file), path.join(destination, file), { recursive: true }).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
    await cp(path.join(host, 'LICENSE'), path.join(destination, 'LICENSE'));
    const packageFile = path.join(destination, 'package.json'); const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    pkg.files = [...new Set([...pkg.files, 'src', 'tsconfig.build.json', 'LICENSE'])];
    await writeFile(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    execFileSync('npm', ['pack', '--pack-destination', path.resolve('vendor')], { cwd: destination, stdio: 'pipe' });
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
console.log('SDK snapshots refreshed. Update lockfile integrity and vendor/SHA256SUMS; rerun checks.');
