import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pluginManifestSchema } from '../../../../../packages/contracts/dist/plugin-config-schemas.js';
test('declaration satisfies the consuming host contract', () => {
  assert.equal(pluginManifestSchema.safeParse(JSON.parse(readFileSync(new URL('../plugin.manifest.json', import.meta.url), 'utf8'))).success, true);
});
