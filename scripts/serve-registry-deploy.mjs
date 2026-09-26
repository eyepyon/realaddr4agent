import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, open, rename } from 'node:fs/promises';
import { unlinkSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--wallet' || args[2] !== '--port') throw new Error('Usage: --wallet <address> --port <port>');
const wallet = args[1], port = Number(args[3]);
if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid wallet or port');
const require = createRequire(resolve(root, 'contracts/package.json'));
const { keccak_256 } = require('@noble/hashes/sha3');
const lower = wallet.slice(2).toLowerCase();
const checksumHash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
const checksum = `0x${[...lower].map((char, index) => parseInt(checksumHash[index], 16) >= 8 ? char.toUpperCase() : char).join('')}`;
if (wallet !== checksum) throw new Error('Checksum wallet required');
const build = spawnSync(process.execPath, [resolve(root, 'scripts/export-lease-registry.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) throw new Error('Artifact export failed');
const artifact = JSON.parse(await readFile(resolve(root, 'contracts/dist/LeaseRegistry.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(root, 'contracts/dist/deployment-manifest.json'), 'utf8'));
const digest = hex => createHash('sha256').update(Buffer.from(hex.replace(/^0x/, ''), 'hex')).digest('hex');
const creation = artifact.bytecode.object, runtime = artifact.deployedBytecode.object;
if (manifest.chainId !== 11155111 || JSON.stringify(manifest.constructor) !== JSON.stringify([{ name: 'admin', type: 'address' }, { name: 'writer', type: 'address' }]) || digest(creation) !== manifest.hashes.creationBytecode || digest(runtime) !== manifest.hashes.runtimeBytecode) throw new Error('Artifact mismatch');
const origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
const config = { wallet, data: creation + lower.padStart(64, '0').repeat(2), runtime, creationHash: manifest.hashes.creationBytecode, runtimeHash: manifest.hashes.runtimeBytecode, token };
const identity = createHash('sha256').update(config.data).digest('hex');
const temporary = resolve(root, '.tmp');
await mkdir(temporary, { recursive: true });
const lockPath = resolve(temporary, `registry-deploy-${identity}.json`);
const serverLockPath = resolve(temporary, `registry-deploy-server-${identity}.json`);
let serverLock;
try {
  serverLock = openSync(serverLockPath, 'wx');
  writeFileSync(serverLock, JSON.stringify({ identity, pid: process.pid }) + '\n');
} catch {
  if (serverLock !== undefined) { closeSync(serverLock); unlinkSync(serverLockPath); }
  throw new Error('Helper already running or lifetime lock unavailable; review the local lock manually.');
}
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  closeSync(serverLock);
  unlinkSync(serverLockPath);
};
process.once('exit', cleanup);
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
const resultPath = resolve(temporary, 'registry-deploy-result.json');
const client = await readFile(resolve(root, 'scripts/registry-deploy-client.mjs'));
const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LeaseRegistry — Sepolia</title><link rel="stylesheet" href="/style.css"><main><h1>LeaseRegistry のデプロイ</h1><p>Ethereum Sepolia testnet限定。adminとwriterは指定walletと同一です。実行は人間のMetaMask承認が必要です。</p><pre id="details"></pre><button id="connect">1. MetaMask接続・Sepoliaへ切替</button><button id="estimate">2. Gas見積・内容確認</button><button id="send">3. MetaMaskでデプロイを承認</button><button id="receipt">Receiptとruntimeを確認（再送信なし）</button><pre id="status">registered_library_only — 未デプロイ</pre><p>不明な結果では再送信しません。walletの履歴で確認してください。pending状態は成功を意味しません。</p></main><script type="module" src="/client.mjs"></script></html>`;
const css = 'body{font-family:system-ui;background:#f4f6f8;color:#15253d;margin:0}main{max-width:900px;margin:40px auto;background:white;padding:32px;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:16px}button{background:#1767c4;color:white;border:0;border-radius:6px;padding:14px;margin:5px;cursor:pointer}button:disabled{opacity:.5}';
let serialized = Promise.resolve();
const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, type, body) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
  if (request.headers.host !== `127.0.0.1:${port}`) return send(403, 'text/plain', 'Forbidden');
  if (request.method === 'GET') {
    let attempt;
    if (request.url === '/config') {
      try { attempt = JSON.parse(await readFile(lockPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') return send(409, 'text/plain', 'Attempt state unreadable'); }
    }
    const routes = { '/': ['text/html; charset=utf-8', html], '/style.css': ['text/css', css], '/client.mjs': ['text/javascript', client], '/config': ['application/json', JSON.stringify({ ...config, attempt })] };
    const route = routes[request.url]; return route ? send(200, ...route) : send(404, 'text/plain', 'Not found');
  }
  if (request.method !== 'POST' || !['/attempt', '/result'].includes(request.url) || request.headers.origin !== origin || request.headers['x-session-token'] !== token || request.headers['content-type'] !== 'application/json') return send(403, 'text/plain', 'Forbidden');
  try {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4096) throw new Error('Too large'); }
    const value = JSON.parse(body);
    const work = async () => {
      if (request.url === '/attempt') {
        if (value.action === 'begin') {
          let file;
          try { file = await open(lockPath, 'wx'); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const state = JSON.parse(await readFile(lockPath, 'utf8'));
            if (state.identity !== identity || state.status !== 'rejected') throw new Error('Existing attempt');
            await rename(lockPath, `${lockPath}.rejected-${randomBytes(8).toString('hex')}`);
            file = await open(lockPath, 'wx');
          }
          try { await file.writeFile(JSON.stringify({ identity, status: 'pending_unknown' }) + '\n'); } finally { await file.close(); }
        } else if (value.action === 'rejected') {
          const state = JSON.parse(await readFile(lockPath, 'utf8'));
          if (state.status !== 'pending_unknown') throw new Error('Not pending');
          // Retain a rejection record; only explicit wallet rejection unlocks a new attempt.
          await writeFile(lockPath, JSON.stringify({ identity, status: 'rejected' }) + '\n');
        } else throw new Error('Invalid action');
      } else {
        if (!['pending', 'verified'].includes(value.status) || !/^0x[0-9a-f]{64}$/i.test(value.transactionHash ?? '')) throw new Error('Invalid result');
        const existing = JSON.parse(await readFile(lockPath, 'utf8'));
        if (existing.identity !== identity || !['pending_unknown', 'pending', 'verified'].includes(existing.status) || existing.transactionHash && existing.transactionHash.toLowerCase() !== value.transactionHash.toLowerCase() || existing.status === 'verified' && value.status !== 'verified') throw new Error('Attempt mismatch');
        const result = { identity, chainId: 11155111, wallet, creationHash: config.creationHash, runtimeHash: config.runtimeHash, status: value.status, transactionHash: value.transactionHash };
        result.verificationSource = 'human_wallet_client';
        if (value.status === 'verified') {
          if (!/^0x[0-9a-f]{40}$/i.test(value.contractAddress ?? '') || !/^0x[0-9a-f]+$/i.test(value.blockNumber ?? '')) throw new Error('Invalid receipt');
          result.contractAddress = value.contractAddress; result.blockNumber = value.blockNumber;
        }
        await writeFile(lockPath, JSON.stringify(result) + '\n');
        await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
      }
    };
    const current = serialized.then(work); serialized = current.catch(() => {}); await current;
    send(200, 'application/json', '{"saved":true}');
  } catch { send(409, 'text/plain', 'Blocked; review existing attempt'); }
});
server.once('error', () => {
  process.stderr.write('Helper could not listen; no transaction sent.\n');
  process.exitCode = 1;
  cleanup();
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Human wallet approval page: ${origin}\nNo transaction has been sent by this server.\n`));
