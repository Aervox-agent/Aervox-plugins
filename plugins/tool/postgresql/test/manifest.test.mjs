import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkPluginHostCompatibility, pluginManifestSchema } from '../../../../../packages/contracts/dist/index.js';

test('PostgreSQL is optional and carries no ordinary connection configuration', () => {
  const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(new URL('../plugin.manifest.json', import.meta.url), 'utf8')));
  assert.equal(manifest.metadata.id, 'ap-tool-postgresql');
  assert.equal(manifest.metadata.installation, 'optional');
  assert.equal(manifest.spec.config, undefined);
  assert.equal(manifest.spec.tools, undefined);
  assert.equal(manifest.spec.skill, 'SKILL.md');
  const guide = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(guide, /name: ap-tool-postgresql/);
  for (const command of ['status', 'migrate --source', 'activate --receipt', 'recover', 'abort --source']) {
    assert.ok(guide.includes(`./aervox database ${command}`));
  }
  assert.match(guide, /AERVOX_POSTGRESQL_URL/);
  assert.equal(checkPluginHostCompatibility(manifest).compatible, true);
  assert.equal(checkPluginHostCompatibility(manifest, '1.1.0').compatible, false);
});
