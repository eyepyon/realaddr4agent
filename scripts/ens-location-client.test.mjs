import test from 'node:test';
import assert from 'node:assert/strict';
import { installLocationClient, createLocationStateSaver, locationResultMessage, detectLocationMetaMask } from './ens-location-client.mjs';
const metadata = { manifestHash: 'hash', wrapperPolicyHash: 'policy', wrapperPolicy: {}, token: 'csrf', manifest: { parentName: 'example.eth', locationSlug: 'demo-place', owner: 'owner', calls: ['deploy_location','set_location_parent','grant_location_controller','register_location','configure_location_namespace'].map(action => ({action})) } };
function storageFixture() { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; }
function documentFixture() { const controls = { nodes: [], append(node) { this.nodes.push(node); }, querySelectorAll() { return this.nodes; } }, status = {}, details = {}; return { controls, status, querySelector: selector => ({ '#controls': controls, '#status': status, '#details': details })[selector], createElement: () => ({ addEventListener(type, callback) { this.click = callback; } }) }; }
test('location client holds conflicting state and never sends automatically', async () => {
  const document = documentFixture(), storage = storageFixture(), calls = [];
  storage.setItem('ens-location-hash-policy', JSON.stringify({ revision: 1, state: { steps: { deploy_location: { started: true } }, unknown: false } }));
  let state;
  await installLocationClient({ document, storage, provider: {}, fetcher: async path => Response.json(path === '/plan' ? metadata : { revision: 0, state: { steps: {}, unknown: false } }), flowFactory: options => { state = options.state; return { execute: async () => calls.push('send') }; } });
  assert.deepEqual(calls, []); assert.equal(state.unknown, true); assert.equal(document.controls.nodes[1].disabled, true);
  await document.controls.nodes[1].click(); assert.deepEqual(calls, []); assert.match(document.status.textContent, /再送禁止/);
});
test('location saves browser evidence before server CAS and retains it on conflict', async () => {
  const storage = storageFixture();
  const save = createLocationStateSaver({ storage, browserKey: 'key', metadata, revision: 4, fetcher: async (path, init) => { assert.equal(JSON.parse(storage.getItem('key')).revision, 5); assert.equal(JSON.parse(init.body).revision, 4); return Response.json({}, { status: 409 }); } });
  await assert.rejects(save({ steps: { deploy_location: { started: true } }, unknown: false }), /do_not_resend/);
  assert.equal(JSON.parse(storage.getItem('key')).state.steps.deploy_location.started, true);
});
test('definite wallet rejection requires separate reset and retry clicks', async () => {
  const document = documentFixture(), calls = []; let state;
  await installLocationClient({ document, storage: storageFixture(), provider: {}, fetcher: async path => Response.json(path === '/plan' ? metadata : { revision: 0, state: { steps: {}, unknown: false } }), flowFactory: options => { state = options.state; return { execute: async () => { calls.push('send'); state.steps.deploy_location = { started: true, rejected: true }; throw { code: 4001 }; }, resetRejected: async () => { calls.push('reset'); delete state.steps.deploy_location; return { rejectedStepReset: 'deploy_location' }; } }; } });
  assert.equal(document.controls.nodes[2].hidden, true); await document.controls.nodes[1].click(); assert.equal(document.controls.nodes[1].disabled, true); assert.equal(document.controls.nodes[2].hidden, false);
  await document.controls.nodes[2].click(); assert.deepEqual(calls, ['send', 'reset']); assert.equal(document.controls.nodes[1].disabled, false);
});
test('browser storage readback failure blocks server mutation', async () => {
  let sent = false;
  const save = createLocationStateSaver({ storage: { setItem() {}, getItem: () => null }, browserKey: 'key', metadata, revision: 0, fetcher: async () => { sent = true; } });
  await assert.rejects(save({ steps: {}, unknown: false }), /browser_state_persistence_failed_do_not_resend/);
  assert.equal(sent, false);
});
test('location actions require each previous finalized step and fresh human clicks', async () => {
  const document = documentFixture(), calls = []; let state;
  await installLocationClient({ document, storage: storageFixture(), provider: {}, fetcher: async path => Response.json(path === '/plan' ? metadata : { revision: 0, state: { steps: {}, unknown: false } }), flowFactory: options => { state = options.state; return { execute: async action => { calls.push(action); state.steps[action] = { started: true, hash: '0x' + '1'.repeat(64) }; return { action, hash: state.steps[action].hash }; }, verify: async () => { state.steps.deploy_location.finalized = true; return { locationConnected: false, completedSteps: 1 }; } }; } });
  assert.deepEqual(calls, []); assert.equal(document.controls.nodes[3].disabled, true);
  await document.controls.nodes[1].click(); assert.equal(document.controls.nodes[1].disabled, true); assert.equal(document.controls.nodes[3].disabled, true);
  await document.controls.nodes[3].click(); assert.deepEqual(calls, ['deploy_location']);
  await document.controls.nodes.at(-1).click(); assert.equal(document.controls.nodes[3].disabled, false); assert.deepEqual(calls, ['deploy_location']);
  await document.controls.nodes[3].click(); assert.deepEqual(calls, ['deploy_location', 'set_location_parent']);
});
test('pending receipt message shows fresh observations and never claims completed deployment', () => {
  const result = { pendingAction: 'deploy_location', receiptFinalized: false, receiptConfirmed: true, receiptBlockNumber: '101', receiptBlockTime: '2026-01-01T00:01:00Z', finalizedBlockNumber: '100', finalizedBlockTime: '2026-01-01T00:00:00Z', latestBlockNumber: '180', latestBlockTime: '2026-01-01T00:02:00Z', checkedAt: '2026-01-01T00:03:00Z', transactionHash: '0x' + '1'.repeat(64) };
  const message = locationResultMessage(result); assert.match(message, /09:01:00 JST/); assert.match(message, /成功した取引/); assert.match(message, /今回の確認時刻/); assert.match(message, /取引hash/); assert.doesNotMatch(message, /完了です/);
  assert.match(locationResultMessage({ ...result, receiptConfirmed: false }), /今回の照会ではまだ確認できません/);
});
test('location completion does not claim app configuration or public resolution ready', () => {
  const message = locationResultMessage({ locationConnected: true, receiptFinalized: true, completedSteps: 5, namespaceReady: false });
  assert.match(message, /操作2〜6の最終確定/); assert.match(message, /名前解決とアプリ設定の検証は別作業/); assert.match(message, /ENS販売はまだ有効になりません/);
  assert.doesNotMatch(locationResultMessage({ locationConnected: true, receiptFinalized: false }), /接続を確認しました/);
});
test('EIP6963 MetaMask is preferred over injected fallback', async () => {
  const provider = {}, listeners = new Map();
  const window = { ethereum: { isMetaMask: true }, Event: class { constructor(type) { this.type = type; } }, setTimeout: callback => callback(), addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type), dispatchEvent: () => listeners.get('eip6963:announceProvider')({ detail: { info: { rdns: 'io.metamask' }, provider } }) };
  assert.equal(await detectLocationMetaMask(window), provider); assert.equal(listeners.size, 0);
});
