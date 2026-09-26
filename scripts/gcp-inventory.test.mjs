import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve('scripts/gcp-inventory.ps1');
function fixture(fail = false) {
  const root = mkdtempSync(join(tmpdir(), 'inventory-fixture-'));
  const executable = join(root, 'gcloud.cmd');
  const log = join(root, 'commands.txt');
  writeFileSync(executable, `@echo off\n echo %* prompt=%CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API%>>"${log}"\n${fail ? 'echo forbidden diagnostic 1>&2\nexit /b 7' : 'echo []\nexit /b 0'}\n`);
  return { root, executable, log, output: join(root, 'evidence') };
}
function run(f, extra = [], account = 'sample-deployer@sample-project.iam.gserviceaccount.com') {
  return spawnSync('pwsh', ['-NoProfile', '-File', script, '-ProjectId', 'sample-project',
    '-DeployServiceAccount', account,
    '-GcloudPath', f.executable, '-OutputDirectory', f.output, ...extra], { encoding: 'utf8' });
}
test('successful read fixtures retain empty JSON arrays and explicit read-only scope', () => {
  const f = fixture();
  try {
    const result = run(f, ['-Region', 'us-central1']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.output, 'secrets-metadata.json'))), []);
    const summary = JSON.parse(readFileSync(join(f.output, 'summary.json')));
    assert.ok(summary.entries.every(entry => entry.status === 'read'));
    const commands = readFileSync(f.log, 'utf8').trim().split(/\r?\n/);
    assert.ok(commands.every(line => line.includes('--project=sample-project') && line.includes('--quiet')));
    assert.ok(commands.every(line => line.includes('prompt=false') && line.includes('--no-log-http')));
    assert.ok(commands.every(line => !/\b(create|update|delete|enable|access|set-iam-policy)\b/.test(line)));
    assert.ok(commands.some(line => line.includes('secrets list') && !line.includes('versions')));
    assert.ok(!result.stdout.includes('sample-project'));
    const assetSearch = commands.find(line => line.includes('asset search-all-resources'));
    assert.ok(assetSearch && !assetSearch.includes('cloudscheduler.googleapis.com/Job'));
    assert.ok(commands.some(line => line.includes('scheduler jobs list') && line.includes('--location=us-central1')));
    assert.ok(summary.manualPending.some(item => item.includes('Cloud Scheduler jobs outside the selected region')));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('rejects a deploy account from another project before executing commands', () => {
  const f = fixture();
  try {
    const result = run(f, [], 'sample-deployer@other-project.iam.gserviceaccount.com');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('explicit project'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('permission-like failures remain incomplete and hide diagnostic content', () => {
  const f = fixture(true);
  try {
    const result = run(f, ['-Region', 'us-central1']);
    assert.equal(result.status, 2);
    const summary = JSON.parse(readFileSync(join(f.output, 'summary.json')));
    assert.ok(summary.entries.every(entry => entry.status === 'incomplete'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('forbidden diagnostic'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
test('missing verified placement stays pending instead of inventing a region', () => {
  const f = fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 2);
    const summary = JSON.parse(readFileSync(join(f.output, 'summary.json')));
    assert.ok(summary.entries.some(entry => entry.name === 'regional-service-inventory' && entry.status === 'incomplete'));
    assert.ok(!readFileSync(f.log, 'utf8').includes('--region='));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
