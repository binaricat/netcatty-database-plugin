import { packPlugin, validateTarget, checkPluginCompatibility } from '@netcatty/plugin-cli';
import { writeFile } from 'node:fs/promises';
const stage = await validateTarget('dist/package');
const supported = ['ai.model-invocation', 'database.host-live-ssh-pg.fixture.v1', 'views.host-drawn', 'views.vault-pages', 'database.sqlite-fixture.v1', 'database.sqlite-file-fixture.v1', 'database.sqlite-fd-identity.fixture.v1', 'database.sqlite-wal-readonly.fixture.v1', 'database.sqlite-wal-concurrent.fixture.v1', 'database.sqlite-wal-checkpoint.fixture.v1', 'database.sqlite-wal-capture.fixture.v1', 'database.sqlite-malformed-reject.fixture.v1', 'database.sqlite-wal-session-refresh.fixture.v1', 'database.saved-connections.v1', 'database.tunnel-test.synthetic.v1', 'database.host-port-probe.v1'];
for (const features of [supported, supported.filter((f) => f !== "database.sqlite-wal-session-refresh.fixture.v1"), supported.filter((f) => f !== "database.sqlite-malformed-reject.fixture.v1"), supported.filter((f) => f !== "database.sqlite-wal-capture.fixture.v1"), supported.filter((f) => f !== "database.sqlite-wal-checkpoint.fixture.v1"), supported.filter((f) => f !== "database.sqlite-wal-concurrent.fixture.v1"), supported.filter((f) => f !== "ai.model-invocation"), supported.filter((f) => f !== "database.sqlite-wal-readonly.fixture.v1"), supported.filter((f) => f !== "database.sqlite-file-fixture.v1"), supported.filter((f) => !f.startsWith("database."))]) {
  const result = checkPluginCompatibility(stage.manifest, { netcattyVersion: '0.0.0', apiVersion: '0.1.0-internal.1', features });
  if (!result.compatible) throw new Error(result.errors.join('\n'));
}
const result = await packPlugin('dist/package', 'dist/netcatty-database-0.1.0-alpha.1.ncpkg');
await validateTarget(result.outputPath);
await writeFile('dist/SHA256SUMS', `${result.sha256}  netcatty-database-0.1.0-alpha.1.ncpkg\n`);
console.log(`Validated ${result.fileCount} files: ${result.outputPath}\nSHA256 ${result.sha256}`);
