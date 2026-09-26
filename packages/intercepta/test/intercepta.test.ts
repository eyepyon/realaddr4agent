import assert from 'node:assert/strict';
import test from 'node:test';
import { InterceptaClient, interpretQuickScan, assertRiskAllowsPayment, type RiskAssessment } from '../src/index.js';

const address = `0x${'1'.repeat(40)}`;
const trait = (name: string) => ({ name, risk: 1, txsCount: 1, description: 'untrusted provider text' });

test('documented response structure does not establish a safe verdict', () => {
  assert.equal(interpretQuickScan({ toxicScore: 0, traits: [] }).decision, 'hold');
  assert.equal(interpretQuickScan({ toxicScore: 1, traits: [trait('sanction_address')] }).decision, 'deny');
  assert.equal(interpretQuickScan({ toxicScore: 1, traits: [trait('unknown')] }).decision, 'hold');
  assert.equal(interpretQuickScan({ toxicScore: 1, traits: [{ name: 'blacklist' }] }).decision, 'hold');
});
test('fixed endpoint, header and safe response normalization', async () => {
  const client = new InterceptaClient({ apiKey: 'synthetic-test-key', fetch: async (url, init) => {
    assert.equal(url, `https://api.web3antivirus.io/api/public/v2/extension/account/${address}/quick-scan`);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('X-API-KEY'), 'synthetic-test-key');
    return Response.json({ toxicScore: 1, traits: [trait('known_scammer')] });
  } });
  const result = await client.assessAddress(address);
  assert.equal(result.decision, 'deny');
  assert.equal(result.riskNetwork, 'unknown');
  assert.match(result.responseHash, /^[a-f0-9]{64}$/);
  assert.equal(client.requestsAttempted, 1);
  assert.ok(!JSON.stringify(result).includes('untrusted provider text'));
});
test('missing key, HTTP, malformed, oversized and network failure hold', async () => {
  const missing = new InterceptaClient({ apiKey: '' });
  assert.equal((await missing.assessAddress(address)).decision, 'hold');
  assert.equal(missing.requestsAttempted, 0);
  for (const fetcher of [async () => new Response('', { status: 500 }), async () => new Response('{', { headers: { 'Content-Type': 'application/json' } }), async () => new Response('x'.repeat(65_537), { headers: { 'Content-Type': 'application/json' } }), async () => { throw new Error('private error body'); }]) {
    assert.equal((await new InterceptaClient({ apiKey: 'synthetic', fetch: fetcher }).assessAddress(address)).decision, 'hold');
  }
});
test('429 permits one short retry and rejects long or missing Retry-After', async () => {
  let calls = 0;
  const client = new InterceptaClient({ apiKey: 'synthetic', fetch: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
  } });
  assert.equal((await client.assessAddress(address)).decision, 'hold');
  assert.equal(calls, 2);
  for (const headers of [{ 'Retry-After': '1' }, { 'Retry-After': '60' }, {}]) {
    let count = 0;
    await new InterceptaClient({ apiKey: 'synthetic', fetch: async () => { count++; return new Response('', { status: 429, headers }); } }).assessAddress(address);
    assert.equal(count, 1);
  }
});
test('gate uses explicitly synthetic allow evidence for freshness and identity checks', () => {
  const now = new Date();
  const fixture: RiskAssessment = { provider: 'intercepta', subjectAddress: address, paymentNetwork: 'eip155:84532', riskNetwork: 'eip155:1', decision: 'allow', reasonCodes: [], checkedAt: now, expiresAt: new Date(now.getTime() + 60_000), policyVersion: 'synthetic-gate-only', responseHash: 'a'.repeat(64) };
  const expected = { subjectAddress: address, paymentNetwork: 'eip155:84532' as const };
  assert.doesNotThrow(() => assertRiskAllowsPayment(fixture, expected, now));
  for (const bad of [{ ...fixture, decision: 'hold' as const }, { ...fixture, riskNetwork: 'unknown' }, { ...fixture, riskNetwork: '' }, { ...fixture, expiresAt: now }, { ...fixture, checkedAt: new Date(now.getTime() + 1) }, { ...fixture, subjectAddress: `0x${'2'.repeat(40)}` }]) {
    assert.throws(() => assertRiskAllowsPayment(bad, expected, now));
  }
});
