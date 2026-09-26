import test from 'node:test';
import assert from 'node:assert/strict';
import { installControllerClient, createControllerStateSaver, controllerResultMessage, detectControllerMetaMask } from './ens-controller-client.mjs';
const metadata = { manifestHash: 'hash', token: 'csrf', manifest: { parentLabel: 'example', owner: 'owner', controller: { address: 'controller' } } };
function storageFixture() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function documentFixture() { const controls = { nodes: [], append(node) { this.nodes.push(node); }, querySelectorAll() { return this.nodes; } }, status = {}, details = {}; return { controls, status, querySelector: selector => ({ '#controls': controls, '#status': status, '#details': details })[selector], createElement: () => ({ addEventListener(type, callback) { this.click = callback; } }) }; }
test('controller client holds conflicting state and never sends automatically', async () => {
  const document = documentFixture(), storage = storageFixture(), calls = [];
  storage.setItem('ens-controller-hash', JSON.stringify({ revision: 1, state: { steps: { deploy_controller: { started: true } }, unknown: false } }));
  let state;
  await installControllerClient({ document, storage, provider: {}, fetcher: async path => Response.json(path === '/plan' ? metadata : { revision: 0, state: { steps: {}, unknown: false } }), flowFactory: options => { state = options.state; return { execute: async () => calls.push('send') }; } });
  assert.deepEqual(calls, []); assert.equal(state.unknown, true); assert.equal(document.controls.nodes[1].disabled, true);
  await document.controls.nodes[1].click(); assert.deepEqual(calls, []); assert.match(document.status.textContent, /再送禁止/);
});
test('controller saves browser evidence before server CAS and retains it on conflict', async () => {
  const storage = storageFixture();
  const save = createControllerStateSaver({ storage, browserKey: 'key', metadata, revision: 4, fetcher: async (path, init) => { assert.equal(JSON.parse(storage.getItem('key')).revision, 5); assert.equal(JSON.parse(init.body).revision, 4); return Response.json({}, { status: 409 }); } });
  await assert.rejects(save({ steps: { deploy_controller: { started: true } }, unknown: false }), /do_not_resend/);
  assert.equal(JSON.parse(storage.getItem('key')).state.steps.deploy_controller.started, true);
});
test('definite wallet rejection requires separate reset and retry clicks', async () => {
  const document = documentFixture(), calls = []; let state;
  await installControllerClient({ document, storage: storageFixture(), provider: {}, fetcher: async path => Response.json(path === '/plan' ? metadata : { revision: 0, state: { steps: {}, unknown: false } }), flowFactory: options => { state = options.state; return { execute: async () => { calls.push('send'); state.steps.deploy_controller = { started: true, rejected: true }; throw { code: 4001 }; }, resetRejected: async () => { calls.push('reset'); delete state.steps.deploy_controller; return { rejectedStepReset: 'deploy_controller' }; } }; } });
  assert.equal(document.controls.nodes[2].hidden, true); await document.controls.nodes[1].click(); assert.equal(document.controls.nodes[1].disabled, true); assert.equal(document.controls.nodes[2].hidden, false);
  await document.controls.nodes[2].click(); assert.deepEqual(calls, ['send', 'reset']); assert.equal(document.controls.nodes[1].disabled, false);
});
test('browser storage readback failure blocks server mutation', async () => {
  let sent = false;
  const save = createControllerStateSaver({ storage: { setItem() {}, getItem: () => null }, browserKey: 'key', metadata, revision: 0, fetcher: async () => { sent = true; } });
  await assert.rejects(save({ steps: {}, unknown: false }), /browser_state_persistence_failed_do_not_resend/);
  assert.equal(sent, false);
});
test('pending receipt message shows fresh observations and never claims completed deployment', () => {
  const result = { pendingAction: 'deploy_controller', receiptFinalized: false, receiptConfirmed: true, receiptBlockNumber: '101', receiptBlockTime: '2026-01-01T00:01:00Z', finalizedBlockNumber: '100', finalizedBlockTime: '2026-01-01T00:00:00Z', latestBlockNumber: '180', latestBlockTime: '2026-01-01T00:02:00Z', checkedAt: '2026-01-01T00:03:00Z', transactionHash: '0x' + '1'.repeat(64) };
  const message = controllerResultMessage(result); assert.match(message, /09:01:00 JST/); assert.match(message, /成功した取引/); assert.match(message, /今回の確認時刻/); assert.match(message, /取引hash/); assert.doesNotMatch(message, /完了です/);
  assert.match(controllerResultMessage({ ...result, receiptConfirmed: false }), /今回の照会ではまだ確認できません/);
});
test('EIP6963 MetaMask is preferred over injected fallback', async () => {
  const provider = {}, listeners = new Map();
  const window = { ethereum: { isMetaMask: true }, Event: class { constructor(type) { this.type = type; } }, setTimeout: callback => callback(), addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type), dispatchEvent: () => listeners.get('eip6963:announceProvider')({ detail: { info: { rdns: 'io.metamask' }, provider } }) };
  assert.equal(await detectControllerMetaMask(window), provider); assert.equal(listeners.size, 0);
});
