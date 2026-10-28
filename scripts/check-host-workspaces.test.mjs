import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertHostCoverage, checkHostWorkspaces, readCollectionPackages } from './check-host-workspaces.mjs';

const installedHost = fileURLToPath(new URL('../..', import.meta.url));
const { packageManager } = JSON.parse(readFileSync(path.join(installedHost, 'package.json'), 'utf8'));
const pluginNames = ['bot-onebot', 'bot-weixin', 'focus-mode'];
const surfaceNames = ['companion-ui', 'panels-ui', 'proactive-ui', 'workbench-ui'];

function fixture(t, oldLayout = false) {
  const hostRoot = mkdtempSync(path.join(tmpdir(), 'aervox-collection-coverage-'));
  t.after(() => rmSync(hostRoot, { recursive: true, force: true }));
  const collectionRoot = path.join(hostRoot, 'plugins');
  mkdirSync(collectionRoot);
  writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({
    name: 'coverage-host', private: true, packageManager,
  }));
  writeFileSync(path.join(hostRoot, 'turbo.json'), JSON.stringify({
    tasks: { build: {}, typecheck: {}, test: {} },
  }));
  writeFileSync(path.join(hostRoot, 'pnpm-workspace.yaml'),
    `packages:\n  - 'plugins/plugins/*/*'\n  - '${oldLayout ? 'surfaces/*' : 'plugins/surfaces/*'}'\n`);
  symlinkSync(path.join(installedHost, 'node_modules'), path.join(hostRoot, 'node_modules'), 'dir');
  const importers = ['.'];
  const writePackage = (directory, name) => {
    mkdirSync(path.join(hostRoot, directory), { recursive: true });
    writeFileSync(path.join(hostRoot, directory, 'package.json'), JSON.stringify({
      name: `@aervox/plugin-${name}`, private: true, version: '0.1.0',
      scripts: { build: 'node -e ""', typecheck: 'node -e ""', test: 'node -e ""' },
    }));
    importers.push(directory);
  };
  for (const name of pluginNames) writePackage(`plugins/plugins/${name.startsWith('bot-') ? 'bot' : 'ui'}/${name}`, name);
  for (const name of surfaceNames) {
    writePackage(`plugins/surfaces/${name}`, name);
    // The old host still has packages with the same names at its original paths.
    if (oldLayout) writePackage(`surfaces/${name}`, name);
  }
  writeFileSync(path.join(hostRoot, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\nimporters:\n${importers.map(dir => `  ${dir}: {}`).join('\n')}\n`);
  execFileSync('git', ['init', '--quiet'], { cwd: collectionRoot });
  execFileSync('git', ['add', '.'], { cwd: collectionRoot });
  return { hostRoot, collectionRoot };
}

test('new host layout includes all seven tracked collection packages and 21 actual Turbo tasks', t => {
  const directories = fixture(t);
  const packages = checkHostWorkspaces(directories);
  assert.equal(packages.length, 7);
  assert.equal(packages.reduce((sum, pkg) => sum + pkg.tasks.length, 0), 21);
});

test('old host copies with the same UI names cannot hide missing nested collection workspaces', t => {
  const directories = fixture(t, true);
  assert.throws(() => checkHostWorkspaces(directories), error => {
    for (const name of surfaceNames) {
      assert.match(error.message, new RegExp(`${name}: missing host workspace`));
      assert.match(error.message, new RegExp(`${name}#test: collection directory not selected`));
    }
    return true;
  });
});

test('a real Turbo dry run filtered to direct plugins fails coverage of nested UI tasks', t => {
  const { hostRoot, collectionRoot } = fixture(t);
  const inventory = JSON.parse(execFileSync('pnpm', [
    'list', '--recursive', '--depth', '-1', '--json',
  ], { cwd: hostRoot, encoding: 'utf8' }));
  const graph = JSON.parse(execFileSync(path.join(hostRoot, 'node_modules', '.bin', 'turbo'), [
    'run', 'build', 'typecheck', 'test', '--filter=./plugins/plugins/*/*', '--dry=json',
  ], { cwd: hostRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(inventory.filter(pkg => pkg.name?.startsWith('@aervox/')).length, 7);
  assert.throws(() => assertHostCoverage(readCollectionPackages(collectionRoot), inventory, graph, hostRoot),
    /companion-ui#build: collection directory not selected by Turbo/);
});
