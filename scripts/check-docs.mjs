#!/usr/bin/env node
/** Offline documentation checks using the consuming host's actual bundle validator. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COLLECTION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = ['README.md', 'SPECIFICATION.md'];
const BUNDLE_MARKER = /^\s*<!--\s*aervox-bundle-file:\s*(\S+)\s*-->\s*$/;
const encoder = new TextEncoder();

function issue(file, line, code, message) {
  return { file, line, code, message };
}

function inferredBundleFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.kind === 'PluginManifest' || ('metadata' in value && 'spec' in value)) return 'plugin.manifest.json';
  if (value.kind === 'PluginConfigSchema' || ('fields' in value && 'schemaVersion' in value)) return 'config.schema.json';
}

/** Mark each complete example resource; validate even unmarked manifest/config examples. */
export function extractBundleExamples(text, file) {
  const files = Object.create(null);
  const issues = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const prose = [...lines];
  let pending;
  let block;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (block) {
      prose[index] = '';
      const close = /^ {0,3}([\x60~]{3,})\s*$/.exec(line);
      if (close && close[1][0] === block.fence[0] && close[1].length >= block.fence.length) {
        const content = block.lines.join('\n') + '\n';
        let filename = block.filename;
        if (block.language === 'json') {
          try {
            const value = JSON.parse(content);
            const inferred = inferredBundleFile(value);
            if (!filename && inferred) {
              filename = inferred;
              issues.push(issue(file, block.line, 'EXAMPLE_MARKER', 'Complete bundle JSON needs an aervox-bundle-file marker: ' + inferred));
            }
          } catch (error) {
            issues.push(issue(file, block.line, 'EXAMPLE_JSON', error.message));
          }
        }
        if (filename) {
          if (Object.hasOwn(files, filename)) issues.push(issue(file, block.line, 'EXAMPLE_DUPLICATE', 'Repeated bundle resource: ' + filename));
          else files[filename] = encoder.encode(content);
        }
        block = undefined;
      } else block.lines.push(line);
      continue;
    }
    const marker = BUNDLE_MARKER.exec(line);
    if (marker) {
      prose[index] = '';
      if (pending) issues.push(issue(file, pending.line, 'EXAMPLE_MARKER', 'Bundle marker has no fenced resource'));
      pending = { filename: marker[1], line: index + 1 };
      continue;
    }
    const opening = /^ {0,3}(\x60{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (opening) {
      prose[index] = '';
      block = { fence: opening[1], language: opening[2].trim().split(/\s/, 1)[0].toLowerCase(), filename: pending?.filename, line: index + 1, lines: [] };
      pending = undefined;
    } else if (pending && line.trim()) {
      issues.push(issue(file, pending.line, 'EXAMPLE_MARKER', 'Bundle marker must directly precede a fenced resource'));
      pending = undefined;
    }
  }
  if (block) issues.push(issue(file, block.line, 'EXAMPLE_FENCE', 'Unclosed fenced resource'));
  if (pending) issues.push(issue(file, pending.line, 'EXAMPLE_MARKER', 'Bundle marker has no fenced resource'));
  return { files, issues, prose: prose.join('\n') };
}

function slug(heading) {
  return heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[\x60*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
}

function anchors(text) {
  const result = new Set();
  const counts = new Map();
  for (const line of extractBundleExamples(text, '').prose.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const count = counts.get(base) ?? 0;
      result.add(count ? base + '-' + count : base);
      counts.set(base, count + 1);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) result.add(match[1]);
  }
  return result;
}

function localLinkIssues(root, file, prose) {
  const issues = [];
  const check = (raw, line) => {
    let target = raw.trim();
    target = target.startsWith('<') ? target.slice(1, target.indexOf('>')) : target.replace(/\s+["'].*$/, '');
    // External links are out of scope: this checker never performs network I/O.
    if (!target || /^(?:https?:|mailto:)/i.test(target) || target.startsWith('//')) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      issues.push(issue(file, line, 'LINK_SCHEME', 'Unsupported link scheme: ' + target));
      return;
    }
    let rawPath, fragment;
    try {
      const hash = target.indexOf('#');
      rawPath = decodeURIComponent((hash < 0 ? target : target.slice(0, hash)).split('?', 1)[0]);
      fragment = hash < 0 ? '' : decodeURIComponent(target.slice(hash + 1));
    } catch {
      issues.push(issue(file, line, 'LINK_ENCODING', 'Invalid link encoding: ' + target));
      return;
    }
    const absolute = rawPath ? path.resolve(root, path.dirname(file), rawPath) : path.resolve(root, file);
    if (!fs.existsSync(absolute)) issues.push(issue(file, line, 'LINK_MISSING', 'Missing local link: ' + target));
    else if (fragment && path.extname(absolute).toLowerCase() === '.md' && fs.statSync(absolute).isFile()
      && !anchors(fs.readFileSync(absolute, 'utf8')).has(fragment)) {
      issues.push(issue(file, line, 'LINK_ANCHOR', 'Missing local anchor: ' + target));
    }
  };
  const text = prose.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ''));
  for (const [index, line] of text.split('\n').entries()) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) check(match[1], index + 1);
    const reference = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*(.+)$/.exec(line);
    if (reference) check(reference[1], index + 1);
    for (const tag of line.matchAll(/<[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      for (const attribute of tag[0].matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/gi)) {
        check(attribute[1] ?? attribute[2] ?? attribute[3], index + 1);
      }
    }
  }
  return issues;
}

export async function checkDocs({ root = COLLECTION_ROOT, hostRoot = path.resolve(COLLECTION_ROOT, '..') } = {}) {
  let validatePluginBundleFiles;
  try {
    ({ validatePluginBundleFiles } = await import(pathToFileURL(path.join(hostRoot, 'packages/contracts/dist/plugin-validation.js')).href));
  } catch (error) {
    throw new Error('Build the consuming host contracts first: mise exec -- pnpm --filter @aervox/contracts build', { cause: error });
  }
  const issues = [];
  let examples = 0;
  for (const file of DOCUMENTS) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) {
      issues.push(issue(file, 1, 'DOCUMENT_MISSING', 'Required document does not exist'));
      continue;
    }
    const extracted = extractBundleExamples(fs.readFileSync(absolute, 'utf8'), file);
    issues.push(...extracted.issues, ...localLinkIssues(root, file, extracted.prose));
    if (Object.keys(extracted.files).length) {
      examples++;
      for (const problem of validatePluginBundleFiles(extracted.files).issues) {
        issues.push(issue(file, 1, problem.code, problem.path + ': ' + problem.message));
      }
    }
  }
  if (!examples) issues.push(issue('SPECIFICATION.md', 1, 'EXAMPLE_MISSING', 'Document at least one complete, host-valid bundle example'));
  return { documents: DOCUMENTS.length, examples, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkDocs().then(report => {
    for (const problem of report.issues) console.error(problem.file + ':' + problem.line + ' [' + problem.code + '] ' + problem.message);
    console.log('[plugin-docs] ' + report.documents + ' documents, ' + report.examples + ' bundles, ' + report.issues.length + ' issues');
    process.exitCode = report.issues.length ? 1 : 0;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
