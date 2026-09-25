import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-text-format.mjs', import.meta.url));

function command(cwd, program, args) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  return result;
}

test('workspace and staged checks inspect text, binary, and the actual index', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'realaddr-text-check-'));
  try {
    assert.equal(command(cwd, 'git', ['init', '-q']).status, 0);
    const run = (...args) => command(cwd, process.execPath, [checker, ...args]);
    const put = (name, bytes) => writeFileSync(join(cwd, name), bytes);

    put('valid.md', '日本語\n');
    put('asset.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
    assert.equal(run().status, 0, 'valid UTF-8 LF and a binary asset pass');

    put('invalid.md', Buffer.from([0xc3, 0x28]));
    put('bom.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
    put('crlf.json', '{\r\n}\r\n');
    put('utf16.ts', Buffer.from([0x61, 0, 0x62, 0]));
    put('unknown', Buffer.from([0xff, 0xfe, 0x61, 0]));
    const bad = run();
    assert.equal(bad.status, 1);
    for (const name of ['invalid.md', 'bom.txt', 'crlf.json', 'utf16.ts', 'unknown']) {
      assert.match(bad.stderr, new RegExp(name.replace('.', '\\.')));
    }
    assert.match(bad.stderr, /invalid UTF-8/);
    assert.match(bad.stderr, /BOM/);
    assert.match(bad.stderr, /CR\/CRLF/);
    assert.match(bad.stderr, /NUL byte/);
    assert.doesNotMatch(bad.stderr, /asset\.png/);

    put('invalid.md', 'fixed\n');
    put('bom.txt', 'fixed\n');
    put('crlf.json', '{}\n');
    put('utf16.ts', 'fixed\n');
    put('unknown', 'fixed\n');
    assert.equal(command(cwd, 'git', ['add', '.']).status, 0);
    put('valid.md', 'changed\r\n');
    assert.equal(run('--staged').status, 0, 'index remains valid when worktree is invalid');
    assert.equal(run().status, 1, 'worktree check sees the new CRLF');

    put('valid.md', '日本語\n');
    put('bom.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    assert.equal(command(cwd, 'git', ['add', 'bom.txt']).status, 0);
    put('bom.txt', 'fixed\n');
    assert.equal(run().status, 0, 'worktree is valid after repair');
    const indexedBad = run('--staged');
    assert.equal(indexedBad.status, 1, 'staged BOM is still rejected');
    assert.match(indexedBad.stderr, /bom\.txt: BOM/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
