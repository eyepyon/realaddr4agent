#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { privateKeyToAccount } from 'viem/accounts';

type Json = Record<string, unknown>;
for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
  if (existsSync(candidate)) { loadEnvFile(candidate); break; }
}
const args = process.argv.slice(2).filter(arg => arg !== '--json' && arg !== '--');
const origin = process.env.AGENT_API_ORIGIN ?? 'http://localhost:8080';
const credentialFile = process.env.AGENT_CREDENTIAL_FILE;
const apiUrl = new URL(origin);
if (apiUrl.origin !== origin || (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(apiUrl.hostname)))) {
  result({ error: 'invalid_origin', message: 'API origin must be HTTPS or local loopback' }, 2);
}

function result(value: Json, exitCode = 0): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(exitCode);
}
function inputError(message: string): never { return result({ error: 'invalid_input', message }, 2); }
function option(name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
function requireOption(name: string): string { return option(name) ?? inputError(`Missing ${name}`); }
async function token(): Promise<string> {
  if (process.env.AGENT_API_TOKEN) return process.env.AGENT_API_TOKEN;
  if (!credentialFile) inputError('Set AGENT_CREDENTIAL_FILE or AGENT_API_TOKEN');
  try {
    const saved = JSON.parse(await readFile(credentialFile!, 'utf8')) as Json;
    if (typeof saved.token === 'string') return saved.token;
  } catch { /* A missing or invalid local credential remains unauthenticated. */ }
  return result({ error: 'unauthorized', message: 'No saved agent credential' }, 3);
}
function exitFor(error: string, status: number): number {
  if (status === 401 || error === 'unauthorized') return 3;
  if (error === 'human_approval_required') return 4;
  if (status === 403) return 5;
  if (status === 429) return 7;
  if (status === 409) return 8;
  if (status === 422 || status === 400) return 2;
  return 6;
}
async function call(path: string, init: RequestInit = {}, authenticated = true): Promise<Json> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (authenticated) headers.set('Authorization', `Bearer ${await token()}`);
  let response: Response;
  try { response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { return result({ error: 'api_unavailable', message: 'API unavailable', retryable: true }, 6); }
  if (!response.headers.get('content-type')?.startsWith('application/json') || Number(response.headers.get('content-length') ?? 0) > 65_536) {
    return result({ error: 'invalid_api_response', message: 'API response content is invalid' }, 6);
  }
  let data: Json;
  try {
    const body = await response.text();
    if (body.length > 65_536) throw new Error('response_too_large');
    data = JSON.parse(body) as Json;
  }
  catch { return result({ error: 'invalid_api_response', message: 'API returned invalid JSON', retryable: true }, 6); }
  if (!response.ok) return result(data, exitFor(String(data.error ?? 'api_error'), response.status));
  return data;
}
async function main(): Promise<never> {
  const [group, action] = args;
  if (group === 'health' && !action) return result(await call('/health', {}, false));
  if (group === 'auth' && action === 'login') {
    const keyRef = process.env.AGENT_SIGNER_KEY_REF;
    if (!keyRef || !credentialFile) inputError('Set AGENT_SIGNER_KEY_REF and AGENT_CREDENTIAL_FILE');
    const key = (await readFile(keyRef!, 'utf8')).trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) inputError('Signer key file is invalid');
    const account = privateKeyToAccount(key as `0x${string}`);
    const challenge = await call('/v1/auth/challenges', {
      method: 'POST', body: JSON.stringify({ walletAddress: account.address, network: 'eip155:84532', termsVersion: process.env.TERMS_VERSION ?? 'event-demo-1' }),
    }, false);
    if (typeof challenge.message !== 'string' || typeof challenge.challengeId !== 'string' || typeof challenge.expiresAt !== 'string') return result({ error: 'invalid_api_response', message: 'Challenge response invalid' }, 6);
    const lines = challenge.message.split('\n');
    const expiry = Date.parse(challenge.expiresAt);
    const expectedTerms = process.env.TERMS_VERSION ?? 'event-demo-1';
    if (lines.length !== 6 || lines[0] !== `${apiUrl.hostname} wants you to sign in to RealAddr for Agents` ||
        lines[1]?.toLowerCase() !== `wallet: ${account.address}`.toLowerCase() || lines[2] !== 'Chain: eip155:84532' ||
        !/^Nonce: [A-Za-z0-9_-]{40,60}$/.test(lines[3] ?? '') || lines[4] !== `Expires: ${challenge.expiresAt}` ||
        lines[5] !== `Terms: ${expectedTerms}` || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 5 * 60_000) {
      return result({ error: 'invalid_challenge', message: 'Challenge did not match the requested login' }, 6);
    }
    const signature = await account.signMessage({ message: challenge.message });
    const session = await call('/v1/auth/sessions', { method: 'POST', body: JSON.stringify({ challengeId: challenge.challengeId, signature }) }, false);
    if (typeof session.token !== 'string') return result({ error: 'invalid_api_response', message: 'Session response invalid' }, 6);
    await writeFile(credentialFile!, JSON.stringify({ token: session.token, expiresAt: session.expiresAt }), { mode: 0o600, flag: 'w' });
    return result({ agentId: session.agentId, expiresAt: session.expiresAt, credentialStored: true });
  }
  if (group === 'locations' && action === 'list') return result(await call('/v1/locations'));
  if (group === 'lease' && action === 'status') {
    const name = option('--name'), id = option('--subscription');
    if ((!name && !id) || (name && id)) inputError('Specify exactly one of --subscription or --name');
    return result(await call(name ? '/v1/subscriptions/by-ens?name=' + encodeURIComponent(name) : '/v1/subscriptions/' + encodeURIComponent(id!)));
  }
  if (group === 'mail' && action === 'status') {
    const id = requireOption('--subscription');
    const data = await call(`/v1/subscriptions/${encodeURIComponent(id)}`);
    const mail = data.mail as Json | undefined;
    if (!mail || typeof mail.status !== 'string' || typeof mail.destinationConfigured !== 'boolean') return result({ error: 'invalid_api_response', message: 'Mail status is unavailable' }, 6);
    return result({ subscriptionId: id, status: mail.status, destinationConfigured: mail.destinationConfigured });
  }
  if (group === 'intent' && action === 'status') {
    const id = requireOption('--intent');
    return result(await call(`/v1/payment-intents/${encodeURIComponent(id)}`));
  }

  if (group === 'ens' && action === 'purchase') {
    const subscriptionId = requireOption('--subscription');
    const customLabel = option('--name');
    const nameType = option('--name-type') ?? (customLabel ? 'custom' : 'floor');
    if (!['floor','custom'].includes(nameType) || (nameType === 'custom' && !customLabel) || (nameType === 'floor' && customLabel)) inputError('Use floor or custom with --name');
    const idempotencyKey = requireOption('--idempotency-key');
    return result(await call('/v1/payment-intents', { method: 'POST', headers: {'Idempotency-Key': idempotencyKey}, body: JSON.stringify({kind:'ens_addon',subscriptionId,nameType,...(customLabel?{customLabel}:{})}) }));
  }
  if (group === 'ens' && action === 'describe') {
    const subscriptionId = requireOption('--subscription'), text = requireOption('--text');
    if (!args.includes('--prepare-only')) inputError('Use --prepare-only; the ENS transaction signer is unavailable');
    if (Array.from(text).length > 280) inputError('Description must contain at most 280 characters');
    const expectedLeaseVersion = Number(requireOption('--expected-version'));
    if (!Number.isSafeInteger(expectedLeaseVersion) || expectedLeaseVersion < 1) inputError('Expected version must be a positive integer');
    const idempotencyKey = requireOption('--idempotency-key');
    return result(await call('/v1/subscriptions/'+encodeURIComponent(subscriptionId)+'/ens-description-transaction', { method: 'POST', headers: {'Idempotency-Key': idempotencyKey}, body: JSON.stringify({description:text,expectedLeaseVersion}) }));
  }
  if (group === 'ens' && action === 'status') {
    const id = requireOption('--subscription');
    return result(await call(`/v1/subscriptions/${encodeURIComponent(id)}/ens`));
  }
  if (group === 'ens' && action === 'resolve') {
    const name = requireOption('--name');
    return result(await call(`/v1/ens/resolve?name=${encodeURIComponent(name)}`, {}, false));
  }
  return inputError('Unsupported command');
}
void main().catch(() => result({ error: 'cli_failure', message: 'CLI failed' }, 6));
