import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { validateUpperManifest } from './ens-upper-flow.mjs';
import { validateWrapperPolicy } from './ens-parent-wrapper.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const planFile = process.env.ENS_UPPER_PLAN_FILE, stateFile = process.env.ENS_UPPER_STATE_FILE;
const expectedHash = process.env.ENS_UPPER_PLAN_HASH, requestedPort = process.env.ENS_UPPER_PORT;
const policyFile = process.env.ENS_UPPER_WRAPPER_POLICY_FILE, expectedPolicyHash = process.env.ENS_UPPER_WRAPPER_POLICY_HASH;
if (requestedPort !== undefined && (!/^[0-9]+$/.test(requestedPort) || Number(requestedPort) < 1 || Number(requestedPort) > 65535)) throw new Error('invalid_helper_port');
if (!planFile || !stateFile || !/^[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new Error('helper_configuration_missing');
if (!policyFile || !/^[0-9a-f]{64}$/.test(expectedPolicyHash ?? '')) throw new Error('wrapper_policy_configuration_missing');
if (resolve(planFile) === resolve(stateFile) || resolve(policyFile) === resolve(stateFile)) throw new Error('state_file_conflict');
const raw = await readFile(planFile), policyRaw = await readFile(policyFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestHash = hash(raw), wrapperPolicyHash = hash(policyRaw);
if (!timingSafeEqual(Buffer.from(manifestHash), Buffer.from(expectedHash))) throw new Error('manifest_hash_mismatch');
if (!timingSafeEqual(Buffer.from(wrapperPolicyHash), Buffer.from(expectedPolicyHash))) throw new Error('wrapper_policy_hash_mismatch');
const manifest = JSON.parse(raw.toString('utf8')), wrapperPolicy = JSON.parse(policyRaw.toString('utf8'));
validateUpperManifest(manifest); validateWrapperPolicy(wrapperPolicy);
const actions = new Set(['deploy_upper', 'set_upper_parent', 'attach_upper']);
function validState(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next) || !next.steps || typeof next.steps !== 'object' || Array.isArray(next.steps) || typeof next.unknown !== 'boolean' || next.namespaceReady === true || (next.finalized !== undefined && typeof next.finalized !== 'boolean')) return false;
  return Object.entries(next.steps).every(([action, step]) => actions.has(action) && step && typeof step === 'object' && !Array.isArray(step) && (step.hash === undefined || /^0x[0-9a-fA-F]{64}$/.test(step.hash)) && ['started', 'confirmed', 'rejected', 'finalized'].every(key => step[key] === undefined || typeof step[key] === 'boolean'));
}
const token = randomBytes(32).toString('hex');
const clientBuild = await build({ entryPoints: [resolve('scripts/ens-upper-client.mjs')], bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, nodePaths: [resolve('apps/api/node_modules')] });
const client = clientBuild.outputFiles[0].contents;
let state, revision = 0, writeTail = Promise.resolve();
try {
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  if (saved.manifestHash !== manifestHash) throw new Error('state_manifest_mismatch');
  if (saved.wrapperPolicyHash !== wrapperPolicyHash) throw new Error('state_wrapper_policy_mismatch');
  if (!validState(saved.state) || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('invalid_saved_state');
  state = saved.state; revision = saved.revision;
} catch (error) { if (error.code !== 'ENOENT') throw error; state = { steps: {}, unknown: false }; }
let origin;
const server = createServer(async (request, response) => {
  const send = (code, body, type = 'application/json') => { response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }); response.end(body); };
  try {
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(403, '{}');
    if (request.method === 'GET' && request.url === '/') return send(200, '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ENS upper — Sepolia</title><link rel="stylesheet" href="/style.css"><main><h1>ENSv2 上位Registry接続 — Sepolia testnet</h1><p>取得済みの親名と新しい上位Registryを接続します。各送信を人間がMetaMaskで承認します。不明結果では再送しません。</p><p>この接続だけでは拠点namespaceは完成しません。ENS販売・住所販売は有効になりません。</p><pre id="details"></pre><div id="controls"></div><pre id="status" role="status"></pre></main><script type="module" src="/client.mjs"></script></html>', 'text/html; charset=utf-8');
    if (request.method === 'GET' && request.url === '/style.css') return send(200, 'body{background:#f4f6f8;color:#142640;font-family:system-ui;margin:0}main{max-width:960px;margin:32px auto;background:white;padding:28px;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:18px}button{padding:12px;margin:5px;border:0;border-radius:5px;background:#1767c4;color:white}button:disabled{opacity:.5}', 'text/css');
    if (request.method === 'GET' && request.url === '/client.mjs') return send(200, client, 'text/javascript');
    if (request.method === 'GET' && request.url === '/plan') return send(200, JSON.stringify({ manifest, manifestHash, token, wrapperPolicy, wrapperPolicyHash }));
    if (request.method === 'GET' && request.url === '/state') return send(200, JSON.stringify({ state, revision }));
    if (request.method === 'POST' && request.url === '/state') {
      if (request.headers.origin !== origin || request.headers['x-ens-helper-token'] !== token || request.headers['content-type'] !== 'application/json') return send(403, '{}');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 32768) return send(413, '{}'); chunks.push(chunk); }
      let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, '{}'); }
      const next = payload?.state;
      if (!validState(next) || !Number.isSafeInteger(payload.revision) || payload.revision < 0) return send(400, '{}');
      const operation = writeTail.then(async () => {
        if (payload.revision !== revision) return send(409, '{}');
        for (const [action, prior] of Object.entries(state.steps)) {
          const later = [...actions].slice([...actions].indexOf(action) + 1);
          const rejectedReset = !state.unknown && !next.unknown && prior.rejected === true && !prior.hash && !prior.receipt && !prior.confirmed && !prior.finalized && !Object.hasOwn(next.steps, action) && later.every(key => !Object.hasOwn(state.steps, key) && !Object.hasOwn(next.steps, key)) && Object.entries(state.steps).filter(([key]) => key !== action).every(([key, value]) => JSON.stringify(next.steps[key]) === JSON.stringify(value)) && Object.keys(next.steps).length === Object.keys(state.steps).length - 1;
          if (rejectedReset) continue;
          if ((prior.hash && next.steps[action]?.hash !== prior.hash) || (prior.started && next.steps[action]?.started !== true) || (prior.confirmed && next.steps[action]?.confirmed !== true) || (prior.finalized && next.steps[action]?.finalized !== true)) return send(409, '{}');
        }
        if ((state.unknown && !next.unknown) || (state.finalized && !next.finalized)) return send(409, '{}');
        await mkdir(dirname(resolve(stateFile)), { recursive: true });
        const temporary = `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify({ manifestHash, wrapperPolicyHash, revision: revision + 1, state: next }, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
        await rename(temporary, stateFile);
        state = next; revision++; return send(200, JSON.stringify({ revision }));
      });
      writeTail = operation.catch(() => {}); await operation; return;
    }
    return send(404, '{}');
  } catch { return send(500, '{}'); }
});
server.listen(requestedPort === undefined ? 0 : Number(requestedPort), '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; console.log(JSON.stringify({ origin, manifestHash, wrapperPolicyHash, environment: 'testnet', namespaceReady: false })); });
