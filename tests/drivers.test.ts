import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { drivers, filterDrivers, driverById } from '../src/driverRegistry';
import { translator, type Message } from '../src/i18n';
import { defaultQuery, selectObject, buildPrompt } from '../src/domain';

test('domestic variants are typed, explicit and preserve distinct transports and catalog ownership', () => {
  const gauss = driverById('gaussdb');
  assert.equal(gauss.variants?.find(v => v.id === 'gaussdb-dws')?.defaultPort, 8000);
  assert.equal(gauss.variants?.find(v => v.id === 'gaussdb-mysql')?.wireFamily, 'mysql');
  assert.equal(driverById('kingbase').variants?.find(v => v.id === 'kingbase-pg')?.metadata, 'sys');
  assert.ok(driverById('gbase8c').variants?.every(v => v.wireFamily === 'unpackaged'));
  const source = readFileSync('src/index.tsx', 'utf8');
  assert.match(source, /aria-label=\{t\("Product variant"\)\}/);
  assert.match(source, /Vendor compatibility is unverified/);
});

test('typed registry matches the shipped contract and separates aliases from packaged engines', () => {
  assert.deepEqual(drivers, JSON.parse(readFileSync('node_modules/@netcatty/plugin-contract/schema/database-drivers.json', 'utf8')));
  assert.equal(driverById('goldendb').wireFamily, 'mysql');
  assert.equal(driverById('goldendb').defaultPort, 3306);
  assert.equal(driverById('kingbase').defaultPort, 54321);
  assert.equal(driverById('gbase8c').wireFamily, 'unpackaged');
  assert.equal(filterDrivers('domestic', 'golden')[0].id, 'goldendb');
  assert.equal(filterDrivers('lightweight', '').length, 1);
  assert.equal(filterDrivers('analytics', 'unknown').length, 0);
  for (const driver of drivers) {
    assert.doesNotMatch(driver.label, /\p{N}/u);
    assert.ok(driver.source.length);
    if (driver.icon) for (const theme of ['light', 'dark']) assert.ok(readFileSync(`assets/icons/${driver.icon}-${theme}.png`).length);
  }
});

test('connection copy is digitless in both languages, including legacy advanced diagnostics', () => {
  const source = readFileSync('src/index.tsx', 'utf8').split('function ConnectionDialog')[1].split('function SchemaTree')[0];
  const keys = [...source.matchAll(/t\("([^"]+)"/g)].map(match => match[1] as Message);
  for (const key of keys) for (const locale of ['en', 'zh-CN']) assert.doesNotMatch(translator(locale)(key), /\p{N}/u, key);
  for (const key of ['Choose database', 'Configure connection', 'Available', 'Protocol alias', 'Driver not packaged'] as Message[]) for (const locale of ['en', 'zh-CN']) assert.doesNotMatch(translator(locale)(key), /\p{N}/u);
  assert.doesNotMatch(source, /Step \d|step-number|\['all', 'All databases', '\d'/);
});

test('engine rasters and sources match licensed ledger hashes and retain actual brand colors', () => {
  const ledger: Array<{ file: string; sourceFile: string; sha256: string; sourceSha256: string; license: string }> = JSON.parse(readFileSync('assets/brand-icon-ledger.json', 'utf8'));
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const entry of ledger) {
    assert.equal(hash(entry.file), entry.sha256);
    assert.equal(hash(entry.sourceFile), entry.sourceSha256);
    assert.match(entry.license, /CC0|Apache/);
    const source = readFileSync(entry.sourceFile, 'utf8');
    assert.doesNotMatch(source, /currentColor|grayscale/);
    assert.match(source, /#[a-fA-F\d]{6}/);
  }
  const css = readFileSync('src/style.css', 'utf8');
  assert.match(css, /\.engine-mark,\.engine-icon,\.engine-fallback \{ border: 0; background: transparent; border-radius: 0; box-shadow: none; opacity: 1; filter: none;/);
});

test('queries quote identifiers by active engine and AI receives the actual dialect without execution', () => {
  assert.equal(selectObject('a`b', 'mysql'), 'SELECT * FROM `a``b`');
  assert.equal(selectObject('a"b', 'postgres'), 'SELECT * FROM "a""b"');
  assert.equal(defaultQuery({tables:[{name:'inventory',columns:[]}]},'postgres').sql,'SELECT * FROM "inventory"');
  const prompt = buildPrompt('generate', {tables:[{name:'inventory',columns:[]}]}, '', 'read', 'Loopback', 'postgres', 'opengauss');
  assert.match(prompt, /"engine":"postgres","dialect":"opengauss"/);
  assert.match(prompt, /Never execute anything/);
});
