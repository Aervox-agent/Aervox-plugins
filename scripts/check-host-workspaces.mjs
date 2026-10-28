import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TASKS = ['build', 'typecheck', 'test'];
const collectionDirectory = fileURLToPath(new URL('..', import.meta.url));

function runJson(command, args, cwd) {
  return JSON.parse(execFileSync(command, args, {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

/** Read Git's manifest inventory independently of the host workspace patterns. */
export function readCollectionPackages(collectionRoot = collectionDirectory) {
  const files = execFileSync('git', [
    'ls-files', '-z', '--', 'package.json', '**/package.json',
  ], { cwd: collectionRoot, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!files.length) throw new Error('The collection has no tracked package.json files');
  return files.map(file => {
    const manifest = JSON.parse(readFileSync(path.join(collectionRoot, file), 'utf8'));
    if (!manifest.name) throw new Error(`Missing package name: ${file}`);
    return {
      name: manifest.name,
      directory: realpathSync(path.dirname(path.join(collectionRoot, file))),
      tasks: TASKS.filter(task => typeof manifest.scripts?.[task] === 'string'),
    };
  });
}

/** Verify real pnpm and Turbo results, including paths to reject old host copies. */
export function assertHostCoverage(packages, inventory, graph, hostRoot) {
  const problems = [];
  for (const pkg of packages) {
    const workspace = inventory.find(entry => entry.name === pkg.name
      && realpathSync(entry.path) === pkg.directory);
    if (!workspace) problems.push(`${pkg.name}: missing host workspace ${pkg.directory}`);
    for (const task of pkg.tasks) {
      const selected = graph.tasks.find(entry => entry.taskId === `${pkg.name}#${task}`
        && realpathSync(path.resolve(hostRoot, entry.directory)) === pkg.directory);
      if (!selected) problems.push(`${pkg.name}#${task}: collection directory not selected by Turbo`);
    }
  }
  if (problems.length) throw new Error(`Collection workspace coverage failed:\n${problems.join('\n')}`);
}

export function checkHostWorkspaces({
  hostRoot = process.cwd(), collectionRoot = collectionDirectory,
} = {}) {
  const packages = readCollectionPackages(collectionRoot);
  const inventory = runJson('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], hostRoot);
  const turbo = path.join(hostRoot, 'node_modules', '.bin', 'turbo');
  const graph = runJson(turbo, ['run', ...TASKS, '--dry=json'], hostRoot);
  assertHostCoverage(packages, inventory, graph, hostRoot);
  return packages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const packages = checkHostWorkspaces();
    const taskCount = packages.reduce((sum, pkg) => sum + pkg.tasks.length, 0);
    console.log(`Host workspace coverage: ${packages.length} collection packages, ${taskCount} tasks checked`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
