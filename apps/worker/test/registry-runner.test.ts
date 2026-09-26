import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboxClaim, RegistryChange, RegistryReadbackEvidence } from '@realaddr/db';
import { loadWorkerConfig } from '../src/config.js';
import { createWorkerRunner, type RegistryReconciliation } from '../src/runner.js';

const env = { APP_ENV: 'local', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: 'realaddr', GCP_PROJECT_ID: 'demo-realaddr-local', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', WORKER_URL: 'http://localhost:8081', TASK_INVOKER_SA: 'realaddr-event-tasks@demo-realaddr-local.iam.gserviceaccount.com', SCHEDULER_INVOKER_SA: 'realaddr-event-sched@demo-realaddr-local.iam.gserviceaccount.com' };
const enabled = { ...env, REGISTRY_READBACK_ENABLED: 'true', REGISTRY_CHAIN_ID: '11155111', REGISTRY_ADDRESS: `0x${'1'.repeat(40)}`, REGISTRY_RUNTIME_CODE_HASH: `0x${'2'.repeat(64)}`, REGISTRY_CONTRACT_LABEL: 'lease-registry', REGISTRY_CONTRACT_VERSION: '1.0.0', MULTIBAAS_URL: 'https://unit-test.multibaas.com', MULTIBAAS_API_KEY: 'unit-test-only', MULTIBAAS_CHAIN_LABEL: 'ethereum', REGISTRY_RPC_URL: 'https://rpc.example', REGISTRY_FINALITY_POLICY: 'finalized' };

test('readback is disabled by default and opt-in configuration is exact', () => {
  assert.equal(loadWorkerConfig(env).registryReadback, undefined);
  assert.equal(loadWorkerConfig(enabled).registryReadback?.chainId, 11155111);
  assert.throws(() => loadWorkerConfig({ ...enabled, REGISTRY_RPC_URL: 'invalid url with private value' }), /^Error: invalid_registry_readback_url$/);
  for (const [key, value] of Object.entries({ REGISTRY_CHAIN_ID: '1', MULTIBAAS_CHAIN_LABEL: 'base', REGISTRY_ADDRESS: '', REGISTRY_CONTRACT_VERSION: '', MULTIBAAS_API_KEY: '', REGISTRY_RUNTIME_CODE_HASH: '', REGISTRY_RPC_URL: 'http://rpc.example', MULTIBAAS_URL: 'https://user:secret@multibaas.example', REGISTRY_FINALITY_POLICY: 'latest', REGISTRY_READBACK_ENABLED: 'yes' })) {
    assert.throws(() => loadWorkerConfig({ ...enabled, [key]: value }));
  }
  for (const url of ['https://multibaas.example', 'https://nested.unit-test.multibaas.com', 'https://unit-test.multibaas.com:8443', 'https://unit-test.multibaas.com/other', 'https://unit-test.multibaas.com/?secret=value']) {
    assert.throws(() => loadWorkerConfig({ ...enabled, MULTIBAAS_URL: url }));
  }
  assert.throws(() => loadWorkerConfig({ ...enabled, REGISTRY_CONTRACT_LABEL: 'LeaseRegistry' }));
  assert.throws(() => loadWorkerConfig({ ...enabled, REGISTRY_CONTRACT_VERSION: '1.0' }));
  assert.throws(() => loadWorkerConfig({ ...enabled, MULTIBAAS_API_KEY: 'unit test' }));
  for (const path of ['/api/v0', '/api/v0/']) assert.ok(loadWorkerConfig({ ...enabled, MULTIBAAS_URL: `https://unit-test.multibaas.com${path}` }).registryReadback);
});

const claim: OutboxClaim = { id: 'a'.repeat(64), eventType: 'lease.registry_sync_requested', aggregateId: 'lease', version: 1, payload: { leaseId: 'lease', leaseVersion: 1 }, claimOwner: 'owner', claimGeneration: 1, claimUntil: new Date(Date.now() + 60_000), reconciliationOnly: true };
const change: RegistryChange = { kind: 'record', leaseKey: `0x${'1'.repeat(64)}`, buildingKey: `0x${'2'.repeat(64)}`, holderCommitment: `0x${'3'.repeat(64)}`, slot: 42, expiresAt: '1800000000', version: 1 };
const evidence: RegistryReadbackEvidence = { change, chainId: 11155111, registryAddress: `0x${'1'.repeat(40)}`, blockNumber: '100', blockHash: `0x${'4'.repeat(64)}`, finalityVerified: true };

test('unit adapters reconcile only matching readback and current claims', async () => {
  const reasons: string[] = [];
  const outbox = { claim: async () => claim, getDeliveryState: async () => 'pending' as const, retry: async (_claim: OutboxClaim, reason = 'processing_failed') => { reasons.push(reason); return 'pending' as const; } };
  const recovery = { recoverConfirmedPurchaseFromOutbox: async () => { throw new Error('unexpected'); }, recoverConfirmedRenewalFromOutbox: async () => { throw new Error('unexpected'); } };
  let reads = 0;
  let confirms = 0;
  let result: RegistryReadbackEvidence | null = evidence;
  let superseded = false;
  let lostClaim = false;
  const registry: RegistryReconciliation = {
    repository: {
      prepare: async input => { assert.strictEqual(input, claim); return superseded ? { status: 'superseded' } : { status: 'ready', change }; },
      confirm: async (input, proof) => { assert.strictEqual(input, claim); assert.strictEqual(proof, evidence); confirms += 1; if (lostClaim) throw new Error('outbox_claim_lost'); return 'confirmed'; },
    },
    reader: { read: async input => { assert.strictEqual(input, change); reads += 1; return result; } },
  };
  assert.deepEqual(await createWorkerRunner(outbox, recovery, 'owner').run(claim.id), { status: 'retry', retryable: true });
  assert.equal(reads, 0);
  const runner = createWorkerRunner(outbox, recovery, 'owner', registry);
  assert.deepEqual(await runner.run(claim.id), { status: 'completed', retryable: false });
  assert.equal(confirms, 1);
  result = null;
  assert.deepEqual(await runner.run(claim.id), { status: 'retry', retryable: true });
  assert.equal(confirms, 1);
  result = evidence;
  lostClaim = true;
  assert.deepEqual(await runner.run(claim.id), { status: 'retry', retryable: true });
  superseded = true;
  assert.deepEqual(await runner.run(claim.id), { status: 'superseded', retryable: false });
  assert.equal(reads, 3);
  assert.deepEqual(reasons, ['handler_unavailable', 'registry_readback_unconfirmed', 'registry_readback_failed']);
});

test('unavailable readback remains bounded by durable outbox retry', async () => {
  let confirmed = false;
  const outbox = { claim: async () => claim, getDeliveryState: async () => 'pending' as const, retry: async () => 'manual_review' as const };
  const recovery = { recoverConfirmedPurchaseFromOutbox: async () => { throw new Error('unexpected'); }, recoverConfirmedRenewalFromOutbox: async () => { throw new Error('unexpected'); } };
  const registry: RegistryReconciliation = { repository: { prepare: async () => ({ status: 'ready', change }), confirm: async () => { confirmed = true; return 'confirmed'; } }, reader: { read: async () => { throw new Error('provider unavailable'); } } };
  assert.deepEqual(await createWorkerRunner(outbox, recovery, 'owner', registry).run(claim.id), { status: 'manual_review', retryable: false });
  assert.equal(confirmed, false);
});
