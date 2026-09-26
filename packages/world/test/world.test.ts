import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { WorldClient, WorldError, WORLD_ISSUER, createPkce } from '../src/index.js';

const now = new Date('2026-09-26T00:00:00Z');
const timestamp = now.getTime() / 1000;
const pair = await generateKeyPair('RS256');
const publicKey = { ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  return new SignJWT({ sub: 'human', nonce: 'nonce', auth_time: timestamp, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture', ...header }).setIssuer(WORLD_ISSUER)
    .setAudience('client').setIssuedAt(timestamp).setExpirationTime(timestamp + 300).sign(pair.privateKey);
}
function fixture(idToken: string, keys = [publicKey]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(String(url).endsWith('/token') ? { id_token: idToken } : { keys });
  };
  return { calls, client: new WorldClient({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://service.example/auth/world/callback', fetch: request, now: () => now }) };
}
const input = { code: 'code', verifier: 'a'.repeat(43), nonce: 'nonce', startedAt: now };
test('PKCE and authorization enforce fresh confidential code flow', () => {
  const { verifier, codeChallenge } = createPkce();
  assert.equal(verifier.length, 43);
  const { client } = fixture('unused');
  const url = new URL(client.authorizationUrl({ state: 'state', nonce: 'nonce', codeChallenge }));
  assert.equal(url.searchParams.get('max_age'), '0');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
});
test('real RSA signature verifies and token request uses Basic and bounded redirect policy', async () => {
  const { client, calls } = fixture(await token());
  assert.deepEqual(await client.exchangeAndVerify(input), { issuer: WORLD_ISSUER, subject: 'human', authTime: now });
  assert.equal(calls[0]?.init?.redirect, 'error');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Basic Y2xpZW50OnNlY3JldA==');
  assert.ok(calls[0]?.init?.signal);
});
test('nonce, freshness, azp and private JWT key headers fail closed', async () => {
  for (const claims of [{ nonce: 'other' }, { auth_time: timestamp - 301 }, { auth_time: timestamp + 31 }, { auth_time: undefined }, { azp: 'other' }, { sub: '' }]) {
    await assert.rejects(fixture(await token(claims)).client.exchangeAndVerify(input), WorldError);
  }
  await assert.rejects(fixture(await token({}, { jku: 'https://attacker.example/keys' })).client.exchangeAndVerify(input), WorldError);
});
test('wrong audience, issuer, signature and algorithm rejected', async () => {
  for (const value of [
    await new SignJWT({ nonce: 'nonce', auth_time: timestamp }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(WORLD_ISSUER).setSubject('human').setAudience('wrong').setIssuedAt(timestamp).setExpirationTime(timestamp + 300).sign(pair.privateKey),
    await new SignJWT({ nonce: 'nonce', auth_time: timestamp }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://wrong.example').setSubject('human').setAudience('client').setIssuedAt(timestamp).setExpirationTime(timestamp + 300).sign(pair.privateKey),
    await new SignJWT({ nonce: 'nonce', auth_time: timestamp }).setProtectedHeader({ alg: 'HS256', kid: 'fixture' }).setIssuer(WORLD_ISSUER).setSubject('human').setAudience('client').setIssuedAt(timestamp).setExpirationTime(timestamp + 300).sign(new Uint8Array(32)),
  ]) await assert.rejects(fixture(value).client.exchangeAndVerify(input), WorldError);
  const wrong = await generateKeyPair('RS256');
  await assert.rejects(fixture(await token(), [{ ...await exportJWK(wrong.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }]).client.exchangeAndVerify(input), WorldError);
});
test('unknown kid refreshes at most once', async () => {
  const { client, calls } = fixture(await token({}, { kid: 'unknown' }));
  await assert.rejects(client.exchangeAndVerify(input), WorldError);
  assert.equal(calls.filter(call => call.url.endsWith('jwks.json')).length, 2);
});
test('unknown kid rotation recovers once and cache avoids repeated JWKS requests', async () => {
  let keyRequests = 0;
  let idToken = await token();
  const request: typeof fetch = async url => {
    if (String(url).endsWith('/token')) return Response.json({ id_token: idToken });
    keyRequests++;
    return Response.json({ keys: [{ ...publicKey, kid: keyRequests === 1 ? 'fixture' : 'rotated' }] });
  };
  const client = new WorldClient({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://service.example/callback', fetch: request, now: () => now });
  await client.exchangeAndVerify(input);
  await client.exchangeAndVerify(input);
  assert.equal(keyRequests, 1);
  idToken = await token({}, { kid: 'rotated' });
  assert.equal((await client.exchangeAndVerify(input)).subject, 'human');
  assert.equal(keyRequests, 2);
});
test('oversized responses and redirects rejected without leaking response', async () => {
  for (const response of [new Response('x'.repeat(65537)), new Response('secret-token', { status: 302, headers: { location: 'https://other.example' } })]) {
    const client = new WorldClient({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://service.example/callback', fetch: async () => response, now: () => now });
    await assert.rejects(client.exchangeAndVerify(input), error => error instanceof WorldError && error.message === 'world_authentication_failed');
  }
});
