import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('mail request emits only human handoff and keeps denial redacted', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const requests: { path: string; key: string | undefined; auth: string | undefined; body: unknown }[] = [];
  let origin = '', mode = 'success';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      requests.push({ path: req.url!, key: req.headers['idempotency-key'] as string | undefined, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      if (mode === 'deny') { res.statusCode = 403; res.end(JSON.stringify({ error: 'lease_inactive', message: 'sensitive-provider-body', subject: 'private' })); }
      else if (mode === 'reused') res.end(JSON.stringify({ status: 'enabled', destinationConfigured: true, physicalForwardingAvailable: false }));
      else res.end(JSON.stringify({ approvalId: id, status: mode === 'invalid' ? 'untrusted' : mode === 'applied' ? 'applied' : mode === 'denied' ? 'denied' : 'pending', expiresAt: mode === 'applied' ? null : new Date(Date.now() + (mode === 'expired' ? -60_000 : 600_000)).toISOString(), approvalUrl: `${mode === 'origin' ? 'https://untrusted.example' : origin}/approve/${id}`, secret: 'private' }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const run = () => new Promise<{ code: number | null; data: Record<string, unknown> }>((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'mail', 'request', '--subscription', id, '--idempotency-key', 'world-request-key', '--force-reauth', '--json'], { env: { ...process.env, AGENT_API_ORIGIN: origin, AGENT_API_TOKEN: 'local-test-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('close', code => { try { done({ code, data: JSON.parse(output) }); } catch (error) { reject(error); } });
  });
  try {
    const success = await run();
    assert.equal(success.code, 0);
    assert.equal(success.data.humanActionRequired, true);
    assert.equal(success.data.approvalUrl, `${origin}/approve/${id}`);
    assert.equal(success.data.secret, undefined);
    assert.deepEqual(requests[0], { path: `/v1/subscriptions/${id}/mail-approval`, key: 'world-request-key', auth: 'Bearer local-test-token', body: { forceReauth: true } });
    mode = 'deny';
    const denial = await run();
    assert.equal(denial.code, 5);
    assert.deepEqual(denial.data, { error: 'lease_inactive', retryable: false });
    for (const scenario of ['origin', 'invalid']) {
      mode = scenario;
      assert.deepEqual(await run(), { code: 6, data: { error: 'invalid_api_response' } });
    }
    for (const scenario of ['expired', 'denied']) {
      mode = scenario;
      const ended = await run();
      assert.equal(ended.data.status, scenario);
      assert.equal(ended.data.humanActionRequired, false);
      assert.equal(ended.data.approvalUrl, undefined);
    }
    mode = 'reused';
    const reused = await run();
    assert.equal(reused.data.status, 'enabled');
    assert.equal(reused.data.humanActionRequired, false);
    assert.equal(reused.data.approvalUrl, undefined);
    mode = 'applied';
    const applied = await run();
    assert.equal(applied.data.expiresAt, null);
    assert.equal(applied.data.humanActionRequired, true);
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
