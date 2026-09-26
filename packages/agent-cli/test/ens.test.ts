import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { resolve } from 'node:path';
function run(args: string[], origin: string): Promise<{
    code: number | null;
    data: Record<string, unknown>;
}> { return new Promise((resolveResult, reject) => { const child = spawn(process.execPath, ['--import', 'tsx', resolve('packages/agent-cli/src/index.ts'), ...args], { env: { ...process.env, AGENT_API_ORIGIN: origin, AGENT_API_TOKEN: 'local-test-token' }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', errors = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk); child.on('error', reject); child.on('close', code => { try {
    resolveResult({ code, data: JSON.parse(output) });
}
catch {
    reject(new Error(errors || output));
} }); }); }
test('ENS CLI quotes and description prepare use explicit wire contracts and preserve sale denial', async () => {
    const requests: Array<{
        path: string;
        method: string;
        body: Record<string, unknown>;
        key: string | undefined;
        auth: string | undefined;
    }> = [];
    const server = createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : {}, key: req.headers['idempotency-key'] as string | undefined, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); if (req.url === '/v1/payment-intents') {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'ens_sale_unavailable', retryable: false }));
    }
    else
        res.end(JSON.stringify({ status: 'pending' })); }); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    try {
        const quote = await run(['ens', 'purchase', '--subscription', 'lease-test', '--name', 'my-agent', '--idempotency-key', 'quote-test-key'], origin);
        assert.equal(quote.code, 6);
        assert.equal(quote.data.error, 'ens_sale_unavailable');
        assert.deepEqual(requests[0]?.body, { kind: 'ens_addon', subscriptionId: 'lease-test', nameType: 'custom', customLabel: 'my-agent' });
        assert.equal(requests[0]?.key, 'quote-test-key');
        assert.equal(requests[0]?.auth, 'Bearer local-test-token');
        const lookup = await run(['lease', 'status', '--name', 'my-agent.example.eth'], origin);
        assert.equal(lookup.code, 0);
        assert.equal(requests[1]?.path, '/v1/subscriptions/by-ens?name=my-agent.example.eth');
        const refused = await run(['ens', 'describe', '--subscription', 'lease-test', '--text', 'Agent'], origin);
        assert.equal(refused.code, 2);
        assert.equal(requests.length, 2);
        const prepared = await run(['ens', 'describe', '--subscription', 'lease-test', '--text', 'Agent', '--expected-version', '2', '--idempotency-key', 'describe-test-key', '--prepare-only'], origin);
        assert.equal(prepared.code, 0);
        assert.deepEqual(requests[2]?.body, { description: 'Agent', expectedLeaseVersion: 2 });
        assert.equal(requests[2]?.path, '/v1/subscriptions/lease-test/ens-description-transaction');
    }
    finally {
        await new Promise<void>((r, j) => server.close(error => error ? j(error) : r()));
    }
});
