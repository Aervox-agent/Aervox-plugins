import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const startName = 'Start isolated PostgreSQL 16 for host integration tests';
const stopName = 'Stop isolated PostgreSQL';

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function script(name) {
  const body = step(name).split('        run: |\n')[1];
  assert.ok(body, `Expected shell block: ${name}`);
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

function fixture(t, failure = '') {
  const directory = mkdtempSync(path.join(tmpdir(), 'aervox-pg-ci-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const runner = path.join(directory, 'runner');
  const envFile = path.join(directory, 'github-env');
  const logFile = path.join(directory, 'commands.jsonl');
  mkdirSync(bin); mkdirSync(runner); writeFileSync(envFile, ''); writeFileSync(logFile, '');
  const prelude = `import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.CI_PG_TEST_LOG, JSON.stringify({command: path.basename(process.argv[1]), args}) + '\\n');
const data = args[args.indexOf('-D') + 1];
`;
  const executable = (name, source) => {
    const file = path.join(bin, name);
    writeFileSync(file, `#!${process.execPath}\n${prelude}${source}`);
    chmodSync(file, 0o755);
  };
  // Fake only the external commands. The actual YAML shell blocks, private
  // mktemp/mkdir and GITHUB_ENV handoff execute unchanged apart from bin paths.
  executable('sudo', 'process.exit(0);\n');
  executable('initdb', `if (process.env.CI_PG_TEST_FAILURE === 'initdb') process.exit(17);
mkdirSync(data, {recursive: true, mode: 0o700});\n`);
  executable('pg_ctl', `if (args.at(-1) === 'start') {
  writeFileSync(path.join(data, 'postmaster.pid'), 'fake-private-postmaster\\n');
  if (process.env.CI_PG_TEST_FAILURE === 'start') process.exit(19);
} else if (args.at(-1) === 'stop') {
  rmSync(path.join(data, 'postmaster.pid'));
} else process.exit(23);\n`);
  const environment = {
    ...process.env,
    RUNNER_TEMP: runner,
    GITHUB_ENV: envFile,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CI_PG_TEST_LOG: logFile,
    CI_PG_TEST_FAILURE: failure,
  };
  const values = () => Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n')
    .filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const run = (name, extra = {}) => {
    const file = path.join(directory, name === startName ? 'start.sh' : 'stop.sh');
    writeFileSync(file, script(name).replaceAll('/usr/lib/postgresql/16/bin', bin));
    execFileSync('bash', ['-e', '-o', 'pipefail', file], { env: {...environment, ...extra}, stdio: 'pipe' });
  };
  return { directory, runner, values, run, commands: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

test('PG16 runs on the pinned runner before full CI and its regression is actually selected', () => {
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(step('Verify collection workspace and task coverage'), /node --test plugins\/scripts\/host-integration-postgresql\.test\.mjs/);
  assert.ok(workflow.indexOf(`      - name: ${startName}`) < workflow.indexOf('      - name: Validate host and collection'));
  assert.match(step('Validate host and collection'), /run: \.\/aervox ci all/);
  assert.match(step(stopName), /if: always\(\) && env\.AERVOX_CI_PG_ROOT != ''/);
  assert.match(step(startName), /working-directory: host/);
  assert.match(step(stopName), /working-directory: host/);
  assert.match(script(startName), /apt-get install -y postgresql-16/);
  assert.match(script(startName), /\/usr\/lib\/postgresql\/16\/bin\/initdb/);
});

test('actual provisioning shell hands both suites the same private socket URL and cleanup stops only that cluster', t => {
  const f = fixture(t);
  f.run(startName);
  const values = f.values();
  assert.ok(values.AERVOX_CI_PG_ROOT.startsWith(`${f.runner}${path.sep}`));
  assert.equal(statSync(values.AERVOX_CI_PG_ROOT).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(values.AERVOX_CI_PG_ROOT, 'socket')).mode & 0o777, 0o700);
  assert.ok(values.AERVOX_PG_TEST_URL);
  assert.equal(values.AERVOX_PG_TEST_URL, values.AERVOX_TEST_POSTGRES_URL);
  const url = new URL(values.AERVOX_PG_TEST_URL);
  assert.equal(url.searchParams.get('host'), path.join(values.AERVOX_CI_PG_ROOT, 'socket'));
  assert.equal(url.searchParams.get('port'), '65439');
  const init = f.commands().find(item => item.command === 'initdb');
  assert.ok(init.args.includes('--encoding=UTF8'));
  assert.ok(init.args.includes('--auth-local=trust'));
  assert.ok(init.args.includes('--auth-host=reject'));
  const started = f.commands().find(item => item.command === 'pg_ctl');
  assert.equal(started.args[started.args.indexOf('-o') + 1], `-k ${values.AERVOX_CI_PG_ROOT}/socket -p 65439 -h ''`);
  f.run(stopName, values);
  const stopped = f.commands().filter(item => item.command === 'pg_ctl').at(-1);
  assert.equal(stopped.args[stopped.args.indexOf('-D') + 1], path.join(values.AERVOX_CI_PG_ROOT, 'data'));
  assert.equal(stopped.args.at(-1), 'stop');
  assert.equal(existsSync(path.join(values.AERVOX_CI_PG_ROOT, 'data/postmaster.pid')), false);
});

test('initialization failure still records its owned root, emits no test URL and safely skips an unstarted postmaster', t => {
  const f = fixture(t, 'initdb');
  assert.throws(() => f.run(startName));
  const values = f.values();
  assert.ok(values.AERVOX_CI_PG_ROOT);
  assert.equal(values.AERVOX_PG_TEST_URL, undefined);
  assert.equal(values.AERVOX_TEST_POSTGRES_URL, undefined);
  f.run(stopName, values);
  assert.equal(f.commands().some(item => item.command === 'pg_ctl'), false);
});

test('a postmaster that starts before startup reports failure is stopped by the always-cleanup block', t => {
  const f = fixture(t, 'start');
  assert.throws(() => f.run(startName));
  const values = f.values();
  assert.ok(values.AERVOX_CI_PG_ROOT);
  assert.equal(values.AERVOX_PG_TEST_URL, undefined);
  f.run(stopName, values);
  assert.equal(f.commands().filter(item => item.command === 'pg_ctl').at(-1).args.at(-1), 'stop');
  assert.equal(existsSync(path.join(values.AERVOX_CI_PG_ROOT, 'data/postmaster.pid')), false);
});
