import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateParentManifest } from './ens-parent-flow.mjs';
import { validateWrapperPolicy, validateWrapperPolicyUpgrade } from './ens-parent-wrapper.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const planFile = process.env.ENS_PARENT_PLAN_FILE;
const stateFile = process.env.ENS_PARENT_STATE_FILE;
const expectedHash = process.env.ENS_PARENT_PLAN_HASH;
const requestedPort=process.env.ENS_PARENT_PORT;
if(requestedPort!==undefined && (!/^[0-9]+$/.test(requestedPort) || Number(requestedPort)<1 || Number(requestedPort)>65535)) throw new Error('invalid_helper_port');
if (!planFile || !stateFile || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new Error('helper_configuration_missing');
const raw = await readFile(planFile);
const manifestHash = createHash('sha256').update(raw).digest('hex');
if (!timingSafeEqual(Buffer.from(manifestHash), Buffer.from(expectedHash))) throw new Error('manifest_hash_mismatch');
const manifest = JSON.parse(raw.toString('utf8'));
validateParentManifest(manifest);
let wrapperPolicy; let wrapperPolicyHash;
if(process.env.ENS_PARENT_WRAPPER_POLICY_FILE || process.env.ENS_PARENT_WRAPPER_POLICY_HASH) {
  if(!process.env.ENS_PARENT_WRAPPER_POLICY_FILE || !/^[0-9a-f]{64}$/.test(process.env.ENS_PARENT_WRAPPER_POLICY_HASH??'')) throw new Error('wrapper_policy_configuration_missing');
  const policyRaw=await readFile(process.env.ENS_PARENT_WRAPPER_POLICY_FILE);
  wrapperPolicyHash=createHash('sha256').update(policyRaw).digest('hex');
  if(!timingSafeEqual(Buffer.from(wrapperPolicyHash),Buffer.from(process.env.ENS_PARENT_WRAPPER_POLICY_HASH))) throw new Error('wrapper_policy_hash_mismatch');
  wrapperPolicy=JSON.parse(policyRaw.toString('utf8')); validateWrapperPolicy(wrapperPolicy);
}
const token = randomBytes(32).toString('hex');
const clientBuild = await build({ entryPoints: [resolve('scripts/ens-parent-client.mjs')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, nodePaths: [resolve('apps/api/node_modules')] });
const client = clientBuild.outputFiles[0].contents;
let state; let revision = 0; let writeTail = Promise.resolve();
try {
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  if (saved.manifestHash !== manifestHash) throw new Error('state_manifest_mismatch');
  if(saved.wrapperPolicyHash && saved.wrapperPolicyHash!==wrapperPolicyHash) {
    const previousFile=process.env.ENS_PARENT_PREVIOUS_WRAPPER_POLICY_FILE;
    if(!previousFile || !wrapperPolicy) throw new Error('state_wrapper_policy_mismatch');
    const previousRaw=await readFile(previousFile);
    if(createHash('sha256').update(previousRaw).digest('hex')!==saved.wrapperPolicyHash) throw new Error('previous_wrapper_policy_hash_mismatch');
    validateWrapperPolicyUpgrade(JSON.parse(previousRaw.toString('utf8')),wrapperPolicy);
  }
  state = saved.state;
  if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('invalid_state_revision');
  revision = saved.revision;
} catch (error) { if (error.code !== 'ENOENT') throw error; state = { steps: {}, unknown: false }; }
let origin;
const server = createServer(async (request, response) => {
  const send = (code, body, type = 'application/json') => { response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" }); response.end(body); };
  try {
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(403, '{}');
    if (request.method === 'GET' && request.url === '/') return send(200, '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ENS parent — Sepolia</title><link rel="stylesheet" href="/style.css"><main><h1>ENSv2 親名取得 — Sepolia testnet</h1><p>公式test tokenのみ。各送信を人間がMetaMaskで承認します。不明結果では再送しません。</p><pre id="details"></pre><div id="controls"></div><pre id="status"></pre></main><script type="module" src="/client.mjs"></script></html>', 'text/html; charset=utf-8');
    if (request.method === 'GET' && request.url === '/style.css') return send(200, 'body{background:#f4f6f8;color:#142640;font-family:system-ui;margin:0}main{max-width:960px;margin:32px auto;background:white;padding:28px;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:18px}button{padding:12px;margin:5px;border:0;border-radius:5px;background:#1767c4;color:white}button:disabled{opacity:.5}', 'text/css');
    if (request.method === 'GET' && request.url === '/client.mjs') return send(200, client, 'text/javascript');
    if (request.method === 'GET' && request.url === '/plan') return send(200, JSON.stringify({ manifest, manifestHash, token, wrapperPolicy, wrapperPolicyHash }));
    if (request.method === 'GET' && request.url === '/state') return send(200, JSON.stringify({ state, revision }));
    if (request.method === 'POST' && request.url === '/state') {
      if (request.headers.origin !== origin || request.headers['x-ens-helper-token'] !== token || request.headers['content-type'] !== 'application/json') return send(403, '{}');
      let data = ''; for await (const chunk of request) { data += chunk; if (data.length > 32768) return send(413, '{}'); }
      const payload = JSON.parse(data); const next = payload.state;
      if (!next || typeof next.steps !== 'object' || typeof next.unknown !== 'boolean' || !Number.isSafeInteger(payload.revision)) return send(400, '{}');
      const operation = writeTail.then(async () => {
        if (payload.revision !== revision) return send(409, '{}');
        for (const [action, prior] of Object.entries(state.steps)) {
          if ((prior.hash && next.steps[action]?.hash !== prior.hash) || (prior.started && next.steps[action]?.started !== true)) return send(409, '{}');
        }
        if (state.unknown && !next.unknown) return send(409, '{}');
        await mkdir(dirname(resolve(stateFile)), { recursive: true });
        const temporary = `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify({ manifestHash, wrapperPolicyHash, revision: revision + 1, state: next }, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
        await rename(temporary, stateFile);
        state = next; revision++; return send(200, JSON.stringify({ revision }));
      });
      writeTail = operation.catch(() => {});
      await operation; return;
    }
    return send(404, '{}');
  } catch { return send(500, '{}'); }
});
server.listen(requestedPort===undefined?0:Number(requestedPort), '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; console.log(JSON.stringify({ origin, manifestHash, environment: 'testnet' })); });
