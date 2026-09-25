#!/usr/bin/env node

// No dependencies: run in any Git checkout with Node.js installed.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

const staged = process.argv.includes('--staged');
if (process.argv.length !== (staged ? 3 : 2)) {
  console.error('Usage: node scripts/check-text-format.mjs [--staged]');
  process.exit(2);
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result.stdout;
}

const textExtensions = new Set([
  '.bat', '.c', '.cc', '.cfg', '.cjs', '.cmd', '.conf', '.cpp', '.css', '.csv',
  '.env', '.go', '.graphql', '.h', '.html', '.htm', '.ini', '.java', '.js',
  '.json', '.jsonc', '.jsonl', '.jsx', '.kt', '.less', '.lock', '.md', '.mdx', '.mjs',
  '.php', '.properties', '.ps1', '.py', '.rb', '.rs', '.scss', '.sh', '.sol',
  '.sql', '.svg', '.toml', '.ts', '.tsv', '.tsx', '.txt', '.vue', '.xml', '.yaml',
  '.yml',
]);
const textNames = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc',
  'Dockerfile', 'Makefile', 'LICENSE', 'NOTICE', 'pnpm-lock.yaml',
]);
const binaryExtensions = new Set([
  '.7z', '.avif', '.bin', '.bmp', '.class', '.db', '.dll', '.doc', '.docx',
  '.eot', '.exe', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg', '.mp3', '.mp4',
  '.otf', '.pdf', '.png', '.sqlite', '.tar', '.tgz', '.ttf', '.wasm', '.webp',
  '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);

function isText(path, bytes) {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  const extension = extname(name).toLowerCase();
  // Explicit text names/extensions win over binary heuristics, including NUL.
  if (textNames.has(name) || textExtensions.has(extension) ||
      name.startsWith('.env.') || name.startsWith('Dockerfile.') ||
      normalized.startsWith('.githooks/')) return true;
  const attr = git([...(staged ? ['check-attr', '--cached'] : ['check-attr']), '-z', 'text', '--', path]);
  const fields = attr.toString('utf8').split('\0');
  const value = fields[2];
  if (value === 'set' || value === 'input') return true;
  if (value === 'unset' || binaryExtensions.has(extension)) return false;
  if (hasBom(bytes)) return true;
  // With text=auto, Git's NUL heuristic keeps unknown binary formats out.
  return !bytes.includes(0);
}

function hasBom(bytes) {
  return (
    bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])) ||
    bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))
  );
}

function problems(bytes) {
  const result = [];
  if (hasBom(bytes)) result.push('BOM');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    result.push('invalid UTF-8');
  }
  if (bytes.includes(0)) result.push('NUL byte (possible UTF-16 or binary)');
  if (bytes.includes(13)) result.push('CR/CRLF');
  return result;
}

try {
  // --staged inspects every current index entry, not only changed paths. It
  // validates the indexed blob rather than the potentially different worktree.
  const list = git(staged
    ? ['ls-files', '--cached', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const paths = [...new Set(list.toString('utf8').split('\0').filter(Boolean))];
  let failures = 0;
  for (const path of paths) {
    let bytes;
    if (staged) {
      bytes = git(['show', `:${path}`]);
    } else {
      try {
        if (!lstatSync(path).isFile()) continue;
        bytes = readFileSync(path);
      } catch (error) {
        if (error.code === 'ENOENT') continue; // Deleted in the worktree.
        throw error;
      }
    }
    if (!isText(path, bytes)) continue;
    const issues = problems(bytes);
    if (issues.length) {
      console.error(`${path}: ${issues.join(', ')}`);
      failures++;
    }
  }
  if (failures) {
    console.error(`${failures} text file(s) failed UTF-8 without BOM / LF validation.`);
    process.exitCode = 1;
  } else {
    console.log(`Checked ${paths.length} ${staged ? 'indexed' : 'workspace'} path(s): text format OK.`);
  }
} catch (error) {
  console.error(`Text format check failed: ${error.message}`);
  process.exitCode = 2;
}
