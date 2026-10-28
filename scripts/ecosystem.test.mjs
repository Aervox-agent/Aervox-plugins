import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { buildRegistry, verifyReleaseAssets } from './build-registry.mjs';
import { hostContracts, packaging } from './ecosystem-common.mjs';
import { lintPlugins } from './lint-plugins.mjs';

const manifest = () => ({ apiVersion: 'aervox.dev/v1', kind: 'PluginManifest', metadata: {
  id: 'ap-tool-example', displayName: 'Example', publisher: 'example-author', version: '1.0.0', category: 'tool', tags: ['example'], breaking: false,
}, requires: { hostApiVersion: { min: '1.1.0', maxExclusive: '2.0.0' } }, spec: {} });
function releaseFixture(value = manifest(), resources = {}) {
  const bytes = zipSync({ 'plugin.manifest.json': strToU8(JSON.stringify(value)), ...resources });
  const name = `${value.metadata.id}-v${value.metadata.version}.aervox-plugin`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const release = { tag_name: `${value.metadata.id}@v${value.metadata.version}`, draft: false, published_at: '2026-10-29T00:00:00Z',
    assets: [{ name, size: bytes.length, browser_download_url: `https://github.com/Aervox-agent/Aervox-plugins/releases/download/${encodeURIComponent(`${value.metadata.id}@v${value.metadata.version}`)}/${name}` }, { name: name + '.sha256' }] };
  return { bytes, release, text: `${sha256}  ${name}\n` };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-ecosystem-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('published bundle, tag, checksum and size must agree before indexing', async () => {
  const fixture = releaseFixture();
  const record = await verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text);
  assert.equal(record.id, 'ap-tool-example');
  await assert.rejects(verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text.replace(/^[a-f0-9]/, 'x')), /checksum/);
  await assert.rejects(verifyReleaseAssets({ ...fixture.release, tag_name: 'ap-tool-other@v1.0.0' }, fixture.bytes, fixture.text), /Missing|manifest/);
  await assert.rejects(verifyReleaseAssets({ ...fixture.release, draft: true }, fixture.bytes, fixture.text), /Unpublished/);
});

test('registry is empty before publication, reproducible after verified publication and immutable per version', async t => {
  const root = await temporary(t);
  assert.deepEqual((await buildRegistry({ root })).plugins, []);
  const fixture = releaseFixture();
  const record = await verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text);
  const result = await buildRegistry({ root, releases: [record] });
  assert.equal(result.plugins.length, 1);
  assert.deepEqual(result.plugins[0].tags, ['example']);
  assert.equal(result.plugins[0].icon, undefined);
  const first = await fs.readFile(path.join(root, 'registry/catalog.json'), 'utf8');
  await buildRegistry({ root, releases: [record] });
  assert.equal(await fs.readFile(path.join(root, 'registry/catalog.json'), 'utf8'), first);
  await assert.rejects(buildRegistry({ root, releases: [{ ...record, sha256: '0'.repeat(64) }] }), /Immutable/);
});

test('registry icons reflect verified SVG or PNG assets and omit absent icons', async t => {
  for (const iconPath of ['icon.svg', 'icon.png', undefined]) {
    await t.test(iconPath ?? 'no icon', async subtest => {
      const root = await temporary(subtest);
      const fixture = releaseFixture(manifest(), iconPath ? { [iconPath]: strToU8(iconPath === 'icon.svg' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : 'PNG fixture') } : {});
      const record = await verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text);
      assert.equal(record.iconPath, iconPath);
      const catalog = await buildRegistry({ root, releases: [record] });
      assert.equal(catalog.plugins[0].icon, iconPath
        ? `https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/ap-tool-example%40v1.0.0/plugins/tool/example/${iconPath}` : undefined);
    });
  }
});

test('published ecosystem bundles require the declared category and truthful minimum host API', async () => {
  const value = manifest();
  delete value.metadata.category;
  let fixture = releaseFixture(value);
  await assert.rejects(verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text), /primary category/);
  value.metadata.category = 'tool';
  value.requires.hostApiVersion.min = '1.0.0';
  fixture = releaseFixture(value);
  await assert.rejects(verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text), /Host API/);
});

test('history file ownership and structural breaking declarations cannot be forged by the generator input', async t => {
  const root = await temporary(t);
  const oldValue = manifest();
  oldValue.spec.tools = [{ name: 'example_read', safetyLevel: 'read_only', inputSchema: { type: 'object' } }];
  const previous = releaseFixture(oldValue);
  const record = await verifyReleaseAssets(previous.release, previous.bytes, previous.text);
  await buildRegistry({ root, releases: [record] });
  const nextValue = manifest();
  nextValue.metadata.version = '2.0.0';
  const next = releaseFixture(nextValue);
  const nextRecord = await verifyReleaseAssets(next.release, next.bytes, next.text);
  await assert.rejects(buildRegistry({ root, releases: [nextRecord] }), /breaking=true/);
  const historyFile = path.join(root, 'registry/plugins/ap-tool-example.json');
  await fs.rename(historyFile, path.join(root, 'registry/plugins/ap-tool-other.json'));
  await assert.rejects(buildRegistry({ root }), /filename and identity/);
});

test('published version cannot silently replace Skill or Page resource bytes', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'plugins/tool/example');
  await fs.mkdir(path.join(directory, 'test'), { recursive: true });
  for (const [file, contents] of Object.entries({
    'plugin.manifest.json': JSON.stringify(manifest()), 'README.md': '# Example', 'LICENSE': 'AGPL-3.0-or-later',
    'CHANGELOG.md': '## 1.0.0\nInitial release', 'test/manifest.test.mjs': '/* fixture */', 'SKILL.md': '# Original skill',
  })) await fs.writeFile(path.join(directory, file), contents);
  const { exportPluginDirectory } = await packaging();
  const packed = await exportPluginDirectory(directory, { distDir: path.join(root, 'original-release') });
  const history = { version: 1, id: packed.id, versions: [{
    version: packed.version, tag: `${packed.id}@v${packed.version}`, downloadUrl: `https://github.com/Aervox-agent/Aervox-plugins/releases/download/example/${packed.filename}`,
    sha256: packed.checksum, size: packed.size, breaking: false, requires: packed.manifest.requires, manifest: packed.manifest,
  }] };
  await fs.mkdir(path.join(root, 'registry/plugins'), { recursive: true });
  await fs.writeFile(path.join(root, 'registry/plugins', `${packed.id}.json`), JSON.stringify(history));
  assert.equal((await lintPlugins({ root })).length, 1);
  await fs.writeFile(path.join(directory, 'SKILL.md'), '# Replaced skill at the same version');
  await assert.rejects(lintPlugins({ root }), /published bundle changed without a new version/);
});

test('source standard rejects a directory/category/identity mismatch', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'plugins/bot/example');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'plugin.manifest.json'), JSON.stringify(manifest()));
  await assert.rejects(lintPlugins({ root }), /directory, category and identity/);
});

test('stable release selection ignores hyphens inside SemVer build metadata', async t => {
  const root = await temporary(t);
  const versions = [];
  for (const version of ['1.0.0+build-1', '1.1.0-rc.1']) {
    const value = manifest();
    value.metadata.version = version;
    const fixture = releaseFixture(value);
    versions.push(await verifyReleaseAssets(fixture.release, fixture.bytes, fixture.text));
  }
  const catalog = await buildRegistry({ root, releases: versions });
  assert.equal(catalog.plugins[0].latestVersion, '1.0.0+build-1');
});

test('author naming rules reject legacy-readable Page, tool and nested Config names', async t => {
  const cases = [
    { kind: 'tool', expected: /snake_case/ },
    { kind: 'page', expected: /Page IDs must be lowercase/ },
    { kind: 'config', expected: /camelCase/ },
  ];
  for (const entry of cases) await t.test(entry.kind, async subtest => {
    const root = await temporary(subtest);
    const directory = path.join(root, 'plugins/tool/example');
    await fs.mkdir(path.join(directory, 'test'), { recursive: true });
    const value = manifest();
    if (entry.kind === 'tool') value.spec.tools = [{ name: 'Not_Snake', inputSchema: { type: 'object' } }];
    if (entry.kind === 'page') value.spec.pages = [{ id: 'Dashboard', title: 'Dashboard', entry: 'pages/Dashboard/index.html' }];
    if (entry.kind === 'config') value.spec.config = { schemaVersion: 1, entry: 'config.schema.json' };
    for (const [name, contents] of Object.entries({ 'plugin.manifest.json': JSON.stringify(value),
      'README.md': '# Fixture', 'LICENSE': 'AGPL-3.0-or-later', 'CHANGELOG.md': '## 1.0.0', 'test/manifest.test.mjs': '/* fixture */' })) {
      await fs.writeFile(path.join(directory, name), contents);
    }
    if (entry.kind === 'config') await fs.writeFile(path.join(directory, 'config.schema.json'), JSON.stringify({
      apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
      fields: [{ key: 'items', type: 'array', label: 'Items', items: { key: 'item', type: 'object', label: 'Item', children: [{ key: 'snake_key', type: 'string', label: 'Value' }] } }],
    }));
    await assert.rejects(lintPlugins({ root }), entry.expected);
  });
});

test('shared packer omits source and rejects unknown files and linked distribution resources', async t => {
  const root = await temporary(t);
  const output = path.join(root, 'output');
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'plugin.manifest.json'), JSON.stringify(manifest()));
  await fs.writeFile(path.join(source, 'src/private.ts'), 'do not distribute');
  const { exportPluginDirectory } = await packaging();
  const first = await exportPluginDirectory(source, { distDir: output });
  assert.equal(first.filename, 'ap-tool-example-v1.0.0.aervox-plugin');
  assert.equal(first.filesCount, 1);
  await fs.writeFile(path.join(source, 'unclassified.txt'), 'must fail');
  await assert.rejects(exportPluginDirectory(source, { distDir: output }), /unclassified/);
  await fs.rm(path.join(source, 'unclassified.txt'));
  await fs.link(path.join(source, 'plugin.manifest.json'), path.join(source, 'icon.svg'));
  await assert.rejects(exportPluginDirectory(source, { distDir: output }), /Hard-linked/);
});

test('templates contain complete bundles accepted by the actual shared validator', async () => {
  const contracts = await hostContracts();
  const { exportPluginDirectory } = await packaging();
  for (const template of ['basic-tool', 'ui-page', 'proactive-sensor']) {
    const source = fileURLToPath(new URL(`../templates/${template}/`, import.meta.url));
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-template-'));
    try {
      const packed = await exportPluginDirectory(source, { distDir: output });
      assert.ok(contracts.isStandardPluginId(packed.id));
    } finally { await fs.rm(output, { recursive: true, force: true }); }
  }
});

test('Page template waits for the host Bridge initialization before reading config', async () => {
  const source = await fs.readFile(fileURLToPath(new URL('../templates/ui-page/pages/settings/app.js', import.meta.url)), 'utf8');
  const message = { textContent: '正在读取配置…' };
  let initialize;
  let reads = 0;
  const ready = new Promise(resolve => { initialize = resolve; });
  const bridge = { ready: () => ready, getConfig: async () => { reads++; return { values: { message: '<literal user text>' } }; } };
  vm.runInNewContext(source, { document: { getElementById: () => message }, window: { AervoxPluginPageBridge: bridge } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(message.textContent, '<literal user text>');
});


test('actual collection gate blocks a breaking minor release and accepts a declared major', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'plugins/tool/example');
  await fs.mkdir(path.join(directory, 'test'), { recursive: true });
  const previousManifest = manifest();
  previousManifest.spec.config = { schemaVersion: 1, entry: 'config.schema.json' };
  const previousConfig = { apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
    fields: [{ key: 'message', type: 'string', label: 'Message' }] };
  const currentManifest = structuredClone(previousManifest);
  currentManifest.metadata.version = '1.1.0';
  const currentConfig = structuredClone(previousConfig);
  currentConfig.fields[0].type = 'integer';
  for (const [file, contents] of Object.entries({ 'README.md': '# Example', 'LICENSE': 'AGPL-3.0-or-later', 'CHANGELOG.md': '# Changes', 'test/contract.test.mjs': '/* fixture */' })) {
    await fs.writeFile(path.join(directory, file), contents);
  }
  await fs.writeFile(path.join(directory, 'plugin.manifest.json'), JSON.stringify(currentManifest));
  await fs.writeFile(path.join(directory, 'config.schema.json'), JSON.stringify(currentConfig));
  await fs.mkdir(path.join(root, 'registry/plugins'), { recursive: true });
  await fs.writeFile(path.join(root, 'registry/plugins/ap-tool-example.json'), JSON.stringify({ version: 1, id: 'ap-tool-example', versions: [{
    version: '1.0.0', tag: 'ap-tool-example@v1.0.0', downloadUrl: 'https://example.org/ap-tool-example-v1.0.0.aervox-plugin', sha256: 'a'.repeat(64), size: 100,
    breaking: false, requires: previousManifest.requires, manifest: previousManifest, config: previousConfig,
  }] }));
  await assert.rejects(lintPlugins({ root }), /MAJOR|major|breaking/i);
  currentManifest.metadata.version = '2.0.0';
  currentManifest.metadata.breaking = true;
  await fs.writeFile(path.join(directory, 'plugin.manifest.json'), JSON.stringify(currentManifest));
  await fs.writeFile(path.join(directory, 'CHANGELOG.md'), '## 1.0.0\n[BREAKING] belongs to an older version');
  await assert.rejects(lintPlugins({ root }), /own 2.0.0 CHANGELOG section/);
  await fs.writeFile(path.join(directory, 'CHANGELOG.md'), '## 2.0.0\n[BREAKING] message changed from string to integer');
  assert.equal((await lintPlugins({ root })).length, 1);
});


test('PR baseline identity discovery survives directory moves and blocks an unbumped new capability', async t => {
  const root = await temporary(t);
  const oldDirectory = path.join(root, 'legacy/location');
  await fs.mkdir(oldDirectory, { recursive: true });
  await fs.writeFile(path.join(oldDirectory, 'plugin.manifest.json'), JSON.stringify(manifest()));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD').trim();
  await fs.rm(path.join(root, 'legacy'), { recursive: true });
  const directory = path.join(root, 'plugins/tool/example');
  await fs.mkdir(path.join(directory, 'test'), { recursive: true });
  const next = manifest();
  next.metadata.version = '1.0.1';
  next.spec.tools = [{ name: 'example_lookup', description: 'Read-only lookup', category: 'plugin', safetyLevel: 'read_only', requiredPermissions: [], inputSchema: { type: 'object' } }];
  for (const [file, value] of Object.entries({ 'README.md': '# Example', 'LICENSE': 'AGPL-3.0-or-later', 'CHANGELOG.md': '## 1.0.1', 'test/contract.test.mjs': '/* fixture */', 'plugin.manifest.json': JSON.stringify(next) })) {
    await fs.writeFile(path.join(directory, file), value);
  }
  await assert.rejects(lintPlugins({ root, base }), /MINOR/);
  next.metadata.version = '1.1.0';
  await fs.writeFile(path.join(directory, 'plugin.manifest.json'), JSON.stringify(next));
  assert.equal((await lintPlugins({ root, base })).length, 1);
});

test('documentation changes after a declared breaking release do not require another major release', async t => {
  const root = await temporary(t);
  const directory = path.join(root, 'plugins/tool/example');
  await fs.mkdir(path.join(directory, 'test'), { recursive: true });
  const value = manifest();
  value.metadata.version = '2.0.0';
  value.metadata.breaking = true;
  for (const [file, contents] of Object.entries({
    'plugin.manifest.json': JSON.stringify(value), 'README.md': '# Example', 'LICENSE': 'AGPL-3.0-or-later',
    'CHANGELOG.md': '## 2.0.0\n[BREAKING] Initial v2 contract', 'test/manifest.test.mjs': '/* fixture */',
  })) await fs.writeFile(path.join(directory, file), contents);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', '[BREAKING] release v2');
  const base = git('rev-parse', 'HEAD').trim();
  await fs.writeFile(path.join(root, 'README.md'), '# Collection authoring clarification');
  assert.equal((await lintPlugins({ root, base })).length, 1);
});
