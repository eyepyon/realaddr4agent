import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN, createController, transaction, validateWallet } from './registry-deploy-client.mjs';
const wallet = `0x${'12'.repeat(20)}`;
const hash = `0x${'34'.repeat(32)}`;
const config = { wallet, data: '0x1234', runtime: '0x5678', creationHash: 'local-test' };
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
const provider = send => ({ request: async ({ method, params }) => {
  if (method === 'eth_chainId') return CHAIN;
  if (method === 'eth_accounts') return [wallet];
  if (method === 'eth_sendTransaction') return send(params[0]);
  if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, contractAddress: wallet, blockNumber: '0x1' };
  if (method === 'eth_getTransactionByHash') return { from: wallet, to: null, input: config.data, value: '0x0', chainId: CHAIN };
  if (method === 'eth_getCode') return config.runtime;
  throw new Error(method);
} });
test('wrong chain and wallet are denied', async () => {
  for (const method of ['eth_chainId', 'eth_accounts']) {
    const p = provider(() => hash), original = p.request;
    p.request = args => args.method === method ? Promise.resolve(method === 'eth_chainId' ? '0x1' : []) : original(args);
    await assert.rejects(validateWallet(p, wallet));
  }
});
test('creation transaction is exact, zero value, explicit Sepolia, no recipient', () => {
  assert.deepEqual(transaction(config), { from: wallet, chainId: CHAIN, data: config.data, value: '0x0' });
});
test('duplicate clicks and unknown outcome remain locked across reload', async () => {
  let finish; const s = storage();
  const p = provider(() => new Promise(resolve => { finish = resolve; }));
  const controller = createController(p, config, s);
  const first = controller.send();
  await assert.rejects(controller.send());
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(hash); await first;
  await assert.rejects(createController(p, config, s).send());
  const unknown = createController(provider(() => { throw new Error('disconnected'); }), config, storage());
  await assert.rejects(unknown.send()); await assert.rejects(unknown.send());
});
test('explicit 4001 rejection allows retry', async () => {
  let count = 0;
  const controller = createController(provider(() => { if (++count === 1) throw Object.assign(new Error('rejected'), { code: 4001 }); return hash; }), config, storage());
  await assert.rejects(controller.send());
  assert.equal((await controller.send()).transactionHash, hash);
});
test('known pending transaction is verified without resend', async () => {
  let sends = 0; const s = storage(), p = provider(() => { sends++; return hash; });
  await createController(p, config, s).send();
  assert.equal((await createController(p, config, s).receipt()).status, 'verified');
  assert.equal(sends, 1);
});
test('storage failure prevents send', async () => {
  let sends = 0;
  const controller = createController(provider(() => { sends++; return hash; }), config, { getItem: () => null, setItem: () => { throw new Error('storage'); } });
  await assert.rejects(controller.send()); assert.equal(sends, 0);
});
