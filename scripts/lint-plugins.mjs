import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { argument, canonical, collectionRoot, hostRoot, hostContracts, isMain, packaging } from './ecosystem-common.mjs';

async function releaseSnapshot(directory, manifest) {
  const config = manifest.spec.config?.entry;
  return { manifest, config: config ? JSON.parse(await fs.readFile(path.join(directory, config), 'utf8')) : undefined };
}

function gitRead(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function baseSnapshots(root, base) {
  const snapshots = new Map();
  const paths = gitRead(root, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(file => file.endsWith('/plugin.manifest.json') && !file.startsWith('templates/'));
  for (const filename of paths) {
    const manifest = JSON.parse(gitRead(root, ['show', `${base}:${filename}`]));
    if (snapshots.has(manifest.metadata.id)) throw new Error(`Duplicate baseline identity ${manifest.metadata.id}`);
    const entry = manifest.spec.config?.entry;
    const config = entry ? JSON.parse(gitRead(root, ['show', `${base}:${path.posix.dirname(filename)}/${entry}`])) : undefined;
    snapshots.set(manifest.metadata.id, { manifest, config });
  }
  return snapshots;
}
function assertBreakingNote(id, version, changelog) {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?v?${escape(version)}\\]?(?:\\s|$)`, 'm');
  const match = heading.exec(changelog);
  const section = match ? changelog.slice(match.index + match[0].length).split(/^##\s+/m, 1)[0] : '';
  if (!section.includes('[BREAKING]')) throw new Error(`${id}: breaking release needs [BREAKING] in its own ${version} CHANGELOG section`);
}

/** Collection standard is stricter than the compatible v1 runtime reader. */
export async function lintPlugins({ root = collectionRoot, base } = {}) {
  const contracts = await hostContracts();
  const { discoverPluginDirectories, exportPluginDirectory } = await packaging();
  const directories = await discoverPluginDirectories(root);
  if (!directories.length) throw new Error('No ecosystem plugins discovered');
  const baseline = base ? baseSnapshots(root, base) : new Map();
  const { PLUGIN_IDENTITY_MIGRATIONS } = base ? await import(pathToFileURL(path.join(hostRoot, 'packages/repositories/dist/migration/plugin-identities.js')).href) : { PLUGIN_IDENTITY_MIGRATIONS: {} };
  const ids = new Set();
  const results = [];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-plugin-lint-'));
  try {
    for (const directory of directories) {
      const manifest = contracts.pluginManifestSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'plugin.manifest.json'), 'utf8')));
      const { id, category, version } = manifest.metadata;
      contracts.pluginEcosystemIdSchema.parse(id);
      const match = /^ap-([a-z]+)-(.+)$/.exec(id);
      if (match[1] !== category || path.relative(root, directory).split(path.sep).join('/') !== `plugins/${category}/${match[2]}`) {
        throw new Error(`${id}: directory, category and identity must agree`);
      }
      if (ids.has(id)) throw new Error(`Duplicate identity: ${id}`);
      ids.add(id);
      for (const tool of manifest.spec.tools ?? []) if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(tool.name)) {
        throw new Error(`${id}: tool names require lowercase snake_case`);
      }
      for (const page of manifest.spec.pages ?? []) if (!/^[a-z0-9_-]+$/.test(page.id)) {
        throw new Error(`${id}: new ecosystem Page IDs must be lowercase`);
      }
      if (!contracts.parsePluginReleaseTag(contracts.pluginReleaseTag(id, version))) throw new Error(`${id}: invalid release version`);
      for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
        const stat = await fs.lstat(path.join(directory, file));
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`${id}: missing source obligation ${file}`);
      }
      const tests = await fs.readdir(path.join(directory, 'test'));
      if (!tests.some(file => /\.test\.[cm]?[jt]s$/.test(file))) throw new Error(`${id}: source tests required`);
      if (contracts.comparePluginVersions(manifest.requires?.hostApiVersion.min ?? '1.0.0', '1.1.0') === -1) throw new Error(`${id}: ecosystem releases require Host API >=1.1.0`);
      const snapshot = await releaseSnapshot(directory, manifest);
      const nestedKeys = field => {
        if (field.children) checkKeys(field.children);
        if (field.items) nestedKeys(field.items);
      };
      const checkKeys = fields => {
        for (const field of fields) {
          if (!/^[a-z][A-Za-z0-9]*$/.test(field.key)) throw new Error(`${id}: Config keys require camelCase`);
          nestedKeys(field);
        }
      };
      checkKeys(snapshot.config?.fields ?? []);
      const changelog = await fs.readFile(path.join(directory, 'CHANGELOG.md'), 'utf8');
      if (manifest.metadata.breaking) assertBreakingNote(id, version, changelog);
      let history;
      try { history = contracts.pluginVersionHistorySchema.parse(JSON.parse(await fs.readFile(path.join(root, 'registry/plugins', `${id}.json`), 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const released = history?.versions.find(entry => entry.version === version);
      if (released && (canonical(released.manifest) !== canonical(manifest) || canonical(released.config) !== canonical(snapshot.config))) {
        throw new Error(`${id}: published contract changed without a new version`);
      }
      if (history?.versions.some(entry => contracts.comparePluginVersions(entry.version, version) === 1)) throw new Error(`${id}: source version is behind a published release`);
      const previous = history?.versions.filter(entry => contracts.comparePluginVersions(entry.version, version) === -1).sort((a, b) => contracts.comparePluginVersions(b.version, a.version))[0];
      if (previous) {
        const comparison = contracts.comparePluginReleaseChanges({ previousManifest: previous.manifest, nextManifest: manifest,
          previousConfig: previous.config, nextConfig: snapshot.config });
        if (!comparison.validVersionBump || comparison.issues.length) throw new Error(`${id}: ${comparison.issues.join('; ')}`);
        if (comparison.breaking && !manifest.metadata.breaking) throw new Error(`${id}: structural breaking release must declare metadata.breaking=true`);
        if (comparison.breaking) assertBreakingNote(id, version, changelog);
      }
      if (base) {
        const old = baseline.get(id);
        if (old) {
          const comparison = contracts.comparePluginReleaseChanges({ previousManifest: old.manifest, nextManifest: manifest, previousConfig: old.config, nextConfig: snapshot.config });
          if (!comparison.validVersionBump || comparison.issues.length) throw new Error(`${id}: ${comparison.issues.join('; ')}`);
          if (comparison.breaking) {
            assertBreakingNote(id, version, changelog);
            if (!gitRead(root, ['log', '--format=%B', `${base}..HEAD`]).includes('[BREAKING]')) throw new Error(`${id}: breaking PR needs [BREAKING] in commit description`);
          }
        } else {
          const legacy = Object.entries(PLUGIN_IDENTITY_MIGRATIONS).find(([from, to]) => to === id && baseline.has(from));
          if (legacy) console.log(`[plugin-standard] ${legacy[0]} -> ${id}: explicit offline identity transition`);
        }
      }
      const first = await exportPluginDirectory(directory, { distDir: path.join(temporary, 'first') });
      const second = await exportPluginDirectory(directory, { distDir: path.join(temporary, 'second') });
      if (first.checksum !== second.checksum || !Buffer.from(first.bytes).equals(second.bytes)) throw new Error(`${id}: nondeterministic package`);
      if (released && (first.checksum !== released.sha256 || first.size !== released.size)) throw new Error(`${id}: published bundle changed without a new version`);
      results.push({ id, version, sha256: first.checksum, size: first.size });
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return results;
}
if (isMain(import.meta.url)) lintPlugins({ base: argument('--base') }).then(results => {
  console.log(`[plugin-standard] ${results.length} identities, schemas, resources and reproducible packages verified`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
