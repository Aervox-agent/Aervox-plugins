import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { strFromU8 } from 'fflate';
import { pathToFileURL } from 'node:url';
import { canonical, collectionRoot, hostRoot, hostContracts, isMain } from './ecosystem-common.mjs';

const REPOSITORY = 'Aervox-agent/Aervox-plugins';
/** The index records only assets retrieved from an actual GitHub Release. */
export async function verifyReleaseAssets(release, archive, checksumText) {
  const contracts = await hostContracts();
  const parsed = contracts.parsePluginReleaseTag(release.tag_name);
  if (!parsed || release.draft || !release.published_at) throw new Error('Unpublished or invalid release');
  const filename = contracts.pluginReleaseAssetName(parsed.id, parsed.version);
  const asset = release.assets.find(entry => entry.name === filename);
  const checksumAsset = release.assets.find(entry => entry.name === filename + '.sha256');
  if (!asset || !checksumAsset || archive.length !== asset.size || archive.length > 20 * 1024 * 1024) throw new Error('Missing, mismatched or oversized release asset');
  const checksum = createHash('sha256').update(archive).digest('hex');
  if (checksumText.trim() !== `${checksum}  ${filename}`) throw new Error('Release checksum does not match asset');
  const { executeArchive, ARCHIVE_LIMITS, isSafeArchivePath } = await import(pathToFileURL(path.join(hostRoot, 'packages/host-runtime/dist/shared/archive-worker.js')).href);
  const files = await executeArchive({ kind: 'unpack', input: new Uint8Array(archive), limits: ARCHIVE_LIMITS, isSafePath: isSafeArchivePath });
  const validation = contracts.validatePluginBundleFiles(files);
  if (validation.issues.length) throw new Error(validation.issues.map(issue => issue.message).join('; '));
  const manifest = contracts.pluginManifestSchema.parse(JSON.parse(strFromU8(files['plugin.manifest.json'])));
  if (manifest.metadata.id !== parsed.id || manifest.metadata.version !== parsed.version) throw new Error('Release tag and bundle manifest disagree');
  if (!manifest.metadata.category || !parsed.id.startsWith(`ap-${manifest.metadata.category}-`)
    || contracts.comparePluginVersions(manifest.requires?.hostApiVersion.min ?? '1.0.0', '1.1.0') === -1) {
    throw new Error('Published ecosystem bundle requires its primary category and Host API >=1.1.0');
  }
  const downloadUrl = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(release.tag_name)}/${filename}`;
  const actualUrl = new URL(asset.browser_download_url);
  if (actualUrl.origin !== 'https://github.com' || actualUrl.username || actualUrl.password || actualUrl.search || actualUrl.hash
    || decodeURIComponent(actualUrl.pathname) !== `/Aervox-agent/Aervox-plugins/releases/download/${release.tag_name}/${filename}`) throw new Error('Unexpected release asset origin');
  const config = manifest.spec.config?.entry ? JSON.parse(strFromU8(files[manifest.spec.config.entry])) : undefined;
  const iconPath = files['icon.svg'] ? 'icon.svg' : files['icon.png'] ? 'icon.png' : undefined;
  return { publishedAt: release.published_at, id: parsed.id, version: parsed.version, tag: release.tag_name,
    downloadUrl, sha256: checksum, size: archive.length, breaking: manifest.metadata.breaking ?? false,
    requires: manifest.requires, manifest, ...(iconPath ? { iconPath } : {}), ...(config ? { config } : {}) };
}

export async function buildRegistry({ root = collectionRoot, releases = [] } = {}) {
  const contracts = await hostContracts();
  const output = path.join(root, 'registry');
  const directory = path.join(output, 'plugins');
  await fs.mkdir(directory, { recursive: true });
  const histories = new Map();
  for (const file of await fs.readdir(directory)) {
    if (!file.endsWith('.json')) continue;
    const stat = await fs.lstat(path.join(directory, file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe version history file');
    const history = contracts.pluginVersionHistorySchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), 'utf8')));
    if (file !== `${history.id}.json` || histories.has(history.id)) throw new Error('Version history filename and identity disagree');
    history.versions.sort((a, b) => contracts.comparePluginVersions(b.version, a.version));
    histories.set(history.id, history);
  }
  let timestamp = '1970-01-01T00:00:00.000Z';
  try { timestamp = contracts.pluginCatalogSchema.parse(JSON.parse(await fs.readFile(path.join(output, 'catalog.json'), 'utf8'))).updatedAt; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const release of releases) {
    const { publishedAt, id, ...version } = release;
    if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Release publication date is invalid');
    const history = histories.get(id) ?? { version: 1, id, versions: [] };
    const existing = history.versions.find(entry => entry.version === version.version);
    if (existing && canonical(existing) !== canonical(version)) throw new Error(`Immutable release ${id}@${version.version} changed`);
    if (!existing) history.versions.push(version);
    history.versions.sort((a, b) => contracts.comparePluginVersions(b.version, a.version));
    contracts.pluginVersionHistorySchema.parse(history);
    histories.set(id, history);
    if (Date.parse(publishedAt) > Date.parse(timestamp)) timestamp = publishedAt;
  }
  const plugins = [];
  const writes = [];
  for (const [id, history] of [...histories].sort(([a], [b]) => a.localeCompare(b))) {
    for (let index = history.versions.length - 2; index >= 0; index--) {
      const next = history.versions[index], previous = history.versions[index + 1];
      const comparison = contracts.comparePluginReleaseChanges({ previousManifest: previous.manifest, nextManifest: next.manifest, previousConfig: previous.config, nextConfig: next.config });
      if (!comparison.validVersionBump || comparison.issues.length) throw new Error(`${id}: invalid published transition ${comparison.issues.join('; ')}`);
      if (comparison.breaking && !next.breaking) throw new Error(`${id}: published structural breaking change must declare breaking=true`);
    }
    const latest = history.versions.find(entry => !entry.version.includes('-')) ?? history.versions[0];
    if (!latest) continue;
    const { metadata, spec } = latest.manifest;
    plugins.push({ id, displayName: metadata.displayName, category: metadata.category,
      latestVersion: latest.version, description: metadata.description ?? '', publisher: metadata.publisher,
      tags: metadata.tags,
      license: metadata.license,
      ...(latest.iconPath ? { icon: `https://raw.githubusercontent.com/${REPOSITORY}/${encodeURIComponent(latest.tag)}/plugins/${metadata.category}/${id.slice(`ap-${metadata.category}-`.length)}/${latest.iconPath}` } : {}),
      breaking: latest.breaking, requires: latest.requires, downloadUrl: latest.downloadUrl, sha256: latest.sha256, size: latest.size,
      capabilities: { hasConfig: Boolean(spec.config), toolsCount: spec.tools?.length ?? 0, skillsCount: spec.skills?.length ?? 0,
        pagesCount: spec.pages?.length ?? 0, sensorsCount: spec.proactive?.sensors?.length ?? 0, triggersCount: spec.proactive?.triggers?.length ?? 0 } });
    writes.push([path.join(directory, `${id}.json`), JSON.stringify(history, null, 2) + '\n']);
  }
  const catalog = contracts.pluginCatalogSchema.parse({ version: 1, updatedAt: timestamp, plugins });
  for (const [file, contents] of writes) await fs.writeFile(file, contents);
  await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}

async function githubReleases() {
  const listings = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).flat();
  if (listings.length > 1000) throw new Error('Release inventory exceeds audited limit');
  const contracts = await hostContracts();
  const verified = [];
  for (const release of listings) {
    if (release.draft || !contracts.parsePluginReleaseTag(release.tag_name)) continue;
    const parsed = contracts.parsePluginReleaseTag(release.tag_name);
    const filename = contracts.pluginReleaseAssetName(parsed.id, parsed.version);
    const archiveAsset = release.assets.find(asset => asset.name === filename);
    const checksumAsset = release.assets.find(asset => asset.name === `${filename}.sha256`);
    if (!archiveAsset || !checksumAsset || !Number.isSafeInteger(archiveAsset.size) || archiveAsset.size <= 0
      || archiveAsset.size > 20 * 1024 * 1024 || !Number.isSafeInteger(checksumAsset.size)
      || checksumAsset.size <= 0 || checksumAsset.size > 1024) throw new Error('Published assets exceed download limits');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-release-'));
    try {
      execFileSync('gh', ['release', 'download', release.tag_name, '--repo', REPOSITORY, '--dir', temporary,
        '--pattern', filename, '--pattern', `${filename}.sha256`], { stdio: 'pipe' });
      verified.push(await verifyReleaseAssets(release, await fs.readFile(path.join(temporary, filename)), await fs.readFile(path.join(temporary, `${filename}.sha256`), 'utf8')));
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  return verified;
}
if (isMain(import.meta.url)) {
  const fromGitHub = process.argv.includes('--github');
  (async () => {
    const releases = fromGitHub ? await githubReleases() : [];
    const catalog = await buildRegistry({ releases });
    console.log(`[registry] ${catalog.plugins.length} published plugins indexed`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
