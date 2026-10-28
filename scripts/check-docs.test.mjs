import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocs } from './check-docs.mjs';

const HOST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fence = String.fromCharCode(96).repeat(3);
function resource(filename, value, language = 'json') {
  return '<!-- aervox-bundle-file: ' + filename + ' -->\n\n' + fence + language + '\n'
    + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n' + fence + '\n';
}
function fixture(t, mutate = () => {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aervox-plugin-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = {
    apiVersion: 'aervox.dev/v1', kind: 'PluginManifest',
    metadata: { id: 'example-tool', displayName: 'Example', publisher: 'Example', version: '1.0.0' },
    requires: { hostApiVersion: { min: '1.0.0', maxExclusive: '2.0.0' } },
    spec: { config: { schemaVersion: 1, entry: 'config.schema.json' } },
  };
  const config = {
    apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
    fields: [{ key: 'message', type: 'string', label: 'Message', default: 'hello' }],
  };
  mutate(manifest, config);
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  put('README.md', '# Example\n\n[Specification](SPECIFICATION.md#manifest)\n');
  put('SPECIFICATION.md', '# Manifest\n\n' + resource('plugin.manifest.json', manifest) + '\n## Configuration\n\n' + resource('config.schema.json', config));
  return { root, put, check: () => checkDocs({ root, hostRoot: HOST_ROOT }) };
}

test('complete document examples pass the actual consuming host bundle validator', async t => {
  const { check } = fixture(t);
  assert.deepEqual(await check(), { documents: 2, examples: 1, issues: [] });
});

test('host validation rejects unsupported metadata, unsafe Skill names and config defaults', async t => {
  const cases = [
    { name: 'unsupported metadata', mutate: manifest => { manifest.metadata.category = 'tool'; }, code: 'MANIFEST_UNKNOWN' },
    { name: 'colon Skill', mutate: manifest => { manifest.spec.skills = [{ name: 'example:skill', content: 'Instructions' }]; }, code: 'SKILL_NAME' },
    { name: 'invalid config default', mutate: (_manifest, config) => { config.fields[0].default = 42; }, code: 'CONFIG_DEFAULT' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async subtest => {
      const { check } = fixture(subtest, entry.mutate);
      assert.ok((await check()).issues.some(problem => problem.code === entry.code), entry.name);
    });
  }
});

test('resources outside the host allowlist fail even when embedded in a marked document', async t => {
  const { root, put, check } = fixture(t);
  put('SPECIFICATION.md', readFileSync(path.join(root, 'SPECIFICATION.md'), 'utf8') + '\n' + resource('icon.svg', '<svg/>', 'svg'));
  assert.ok((await check()).issues.some(problem => problem.code === 'BUNDLE_ENTRY' && problem.message.includes('icon.svg')));
});

test('complete unmarked manifest/config JSON is still host validated and cannot evade the example gate', async t => {
  const { root, put, check } = fixture(t, manifest => { manifest.metadata.category = 'tool'; });
  put('SPECIFICATION.md', readFileSync(path.join(root, 'SPECIFICATION.md'), 'utf8').replace(/<!-- aervox-bundle-file: [^>]+ -->/g, ''));
  const report = await check();
  assert.equal(report.issues.filter(problem => problem.code === 'EXAMPLE_MARKER').length, 2);
  assert.ok(report.issues.some(problem => problem.code === 'MANIFEST_UNKNOWN' && problem.message.includes('metadata.category')));
});

test('malformed JSON, missing examples and unclosed fences fail visibly', async t => {
  for (const [name, text, code] of [
    ['JSON', '# Manifest\n' + resource('plugin.manifest.json', '{"kind":'), 'EXAMPLE_JSON'],
    ['missing', '# Manifest\n', 'EXAMPLE_MISSING'],
    ['fence', '# Manifest\n' + fence + 'json\n{}', 'EXAMPLE_FENCE'],
  ]) {
    await t.test(name, async subtest => {
      const { put, check } = fixture(subtest);
      put('SPECIFICATION.md', text);
      assert.ok((await check()).issues.some(problem => problem.code === code));
    });
  }
});

test('local files and anchors are checked offline, including reference and HTML links', async t => {
  const { put, check } = fixture(t);
  put('README.md', '# Example\n[broken](missing.md)\n[anchor](SPECIFICATION.md#missing)\n[manual]: absent.md\n<img src="missing.svg">\n');
  const issues = (await check()).issues;
  assert.equal(issues.filter(problem => problem.code === 'LINK_MISSING').length, 3);
  assert.equal(issues.filter(problem => problem.code === 'LINK_ANCHOR').length, 1);
});

test('duplicate heading anchors, explicit anchors and external links stay valid without network access', async t => {
  const { root, put, check } = fixture(t);
  put('SPECIFICATION.md', readFileSync(path.join(root, 'SPECIFICATION.md'), 'utf8') + '\n## 重复\n## 重复\n<a id="explicit-anchor"></a>\n');
  put('README.md', '# Example\n[duplicate](SPECIFICATION.md#重复-1)\n[explicit](SPECIFICATION.md#explicit-anchor)\n[external](https://example.invalid/unreachable#external)\n\n' + fence + 'text\n[not a link](missing.md)\n' + fence + '\n');
  assert.deepEqual((await check()).issues, []);
});
