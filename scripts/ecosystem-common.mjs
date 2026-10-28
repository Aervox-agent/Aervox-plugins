import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const collectionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hostRoot = path.resolve(collectionRoot, '..');
export async function hostContracts() {
  return import(pathToFileURL(path.join(hostRoot, 'packages/contracts/dist/index.js')).href);
}
export async function packaging() {
  return import(pathToFileURL(path.join(hostRoot, 'scripts/export-plugins.mjs')).href);
}
export function argument(name, args = process.argv.slice(2)) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
export function isMain(url) { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url); }
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
