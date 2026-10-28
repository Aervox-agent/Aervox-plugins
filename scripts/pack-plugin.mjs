import fs from 'node:fs/promises';
import path from 'node:path';
import { argument, collectionRoot, hostContracts, hostRoot, isMain, packaging } from './ecosystem-common.mjs';

export async function packPlugin({ id, output = path.join(hostRoot, 'dist/plugins'), tag } = {}) {
  const contracts = await hostContracts();
  const release = tag ? contracts.parsePluginReleaseTag(tag) : undefined;
  if (tag && !release) throw new Error('Release tag must be <standard-id>@v<SemVer>');
  id = release?.id ?? id;
  if (!id) throw new Error('--id or --tag is required');
  contracts.pluginEcosystemIdSchema.parse(id);
  const { discoverPluginDirectories, exportPluginDirectory } = await packaging();
  let selected;
  for (const directory of await discoverPluginDirectories(collectionRoot)) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'plugin.manifest.json'), 'utf8'));
    if (manifest.metadata.id === id) {
      if (selected) throw new Error('Duplicate identity');
      selected = { directory, manifest };
    }
  }
  if (!selected) throw new Error(`Unknown plugin ${id}`);
  if (release && selected.manifest.metadata.version !== release.version) throw new Error('Tag and manifest version disagree');
  const result = await exportPluginDirectory(selected.directory, { distDir: output });
  await fs.writeFile(path.join(output, `${result.filename}.sha256`), `${result.checksum}  ${result.filename}\n`);
  return result;
}
if (isMain(import.meta.url)) packPlugin({ id: argument('--id'), tag: argument('--tag'), output: argument('--output') }).then(result => {
  console.log(`[pack-plugin] ${result.filename} ${result.checksum}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
