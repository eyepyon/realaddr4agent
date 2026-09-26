import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { FieldValue, Firestore } from '@google-cloud/firestore';
import { DomainError, sha256 } from '@realaddr/domain';
import { RegistryRepository, OutboxRepository, type RegistryChange, type RegistryReadbackEvidence } from '../src/index.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const prefix = 'realaddr_event_';
const address = `0x${'1'.repeat(40)}`;
const hash = `0x${'2'.repeat(64)}` as const;
const wallet = `0x${'3'.repeat(40)}`;
const now = new Date('2026-09-26T00:00:00Z');
const expiry = new Date(now.getTime() + 30 * 86_400_000);
const id = 'lease';
const guard = (...parts: string[]) => sha256(JSON.stringify(parts));
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
const evidence = (change: RegistryChange): RegistryReadbackEvidence => ({ change, chainId: 11155111, registryAddress: address as `0x${string}`, blockNumber: '123', blockHash: hash, finalityVerified: true });

async function setup() {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
  const doc = (collection: string, key: string) => db.collection(prefix + collection).doc(key);
  await Promise.all([
    doc('buildings', 'building').create({ id: 'building' }),
    doc('leases', id).create({ id, tenantId: 'tenant', agentId: 'agent', buildingId: 'building', slotNumber: 42, ownerWallet: wallet, status: 'active', version: 1, expiresAt: expiry, chainSyncStatus: 'pending', registryPaymentOrderId: id }),
    doc('slots', 'building_42').create({ leaseId: id, state: 'leased' }),
  ]);
  async function paid(orderId: string, version: number) {
    const txHash = `0x${String(version).repeat(64)}`;
    const common = { tenantId: 'tenant', agentId: 'agent', ownerWallet: wallet, buildingId: 'building', slotNumber: 42, leaseId: id, network: 'eip155:84532', asset: address, payTo: address, amountAtomic: '550000' };
    await Promise.all([
      doc('orders', orderId).create({ ...common, kind: version === 1 ? 'purchase' : 'renew', status: 'fulfilled', leaseVersion: version - 1, previousExpiresAt: expiry }),
      doc('payments', orderId).create({ ...common, orderId, status: 'confirmed', payer: wallet, txHash, transferLogIndex: 0, confirmedAt: now, evidenceHash: 'a'.repeat(64), settlementEvidence: { evidenceHash: 'a'.repeat(64), finalityVerified: true } }),
      doc('uniques', guard('payment_transfer', common.network, txHash, '0')).create({ orderId, paymentId: orderId }),
      doc('outbox', `job${version}`).create({ aggregateId: id, eventType: 'lease.registry_sync_requested', version, payload: { leaseId: id, leaseVersion: version }, state: 'pending', availableAt: now, attempts: 0 }),
      doc('admin_operations', guard('registry', id)).set({ operationId: guard('registry', id), kind: 'registry', targetId: id, status: 'pending_readback', version }),
    ]);
  }
  await paid(id, 1);
  return { db, doc, paid, registry: new RegistryRepository(db, prefix, { registryAddress: address, now: () => now }), outbox: new OutboxRepository(db, prefix, { now: () => now }) };
}

test('registry identities persist across retry and paid renewal; old confirmation is superseded', { skip: !emulator }, async () => {
  const s = await setup();
  try {
    const first = await s.outbox.claim('job1', 'worker'); assert.ok(first);
    const initial = await s.registry.prepare(first); assert.equal(initial.status, 'ready'); if (initial.status !== 'ready') return;
    assert.deepEqual(await s.registry.prepare(first), initial);
    await s.paid('renewal', 2);
    await s.doc('leases', id).update({ version: 2, registryPaymentOrderId: 'renewal', expiresAt: new Date(expiry.getTime() + 30 * 86_400_000) });
    assert.equal(await s.registry.confirm(first, evidence(initial.change)), 'superseded');
    assert.equal((await s.doc('admin_operations', guard('registry', id)).get()).data()?.status, 'pending_readback');
    const second = await s.outbox.claim('job2', 'worker'); assert.ok(second);
    const renewal = await s.registry.prepare(second); assert.equal(renewal.status, 'ready'); if (renewal.status !== 'ready') return;
    assert.equal(renewal.change.leaseKey, initial.change.leaseKey);
    assert.equal(renewal.change.buildingKey, initial.change.buildingKey);
    assert.equal(renewal.change.holderCommitment, initial.change.holderCommitment);
    assert.equal(await s.registry.confirm(second, evidence(renewal.change)), 'confirmed');
    assert.equal((await s.doc('leases', id).get()).data()?.expiresAt.toDate().getTime(), expiry.getTime() + 30 * 86_400_000);
  } finally { await s.db.terminate(); }
});

test('registry mismatched evidence and stale claims cannot mark synchronization successful', { skip: !emulator }, async () => {
  const s = await setup();
  try {
    const claim = await s.outbox.claim('job1', 'worker'); assert.ok(claim);
    const result = await s.registry.prepare(claim); if (result.status !== 'ready') throw new Error('missing prepared change');
    await assert.rejects(s.registry.confirm(claim, evidence({ ...result.change, slot: 43 })), code('registry_evidence_mismatch'));
    await assert.rejects(s.registry.confirm(claim, { ...evidence(result.change), registryAddress: wallet as `0x${string}` }), code('registry_evidence_invalid'));
    await s.doc('outbox', 'job1').update({ claimGeneration: claim.claimGeneration + 1 });
    await assert.rejects(s.registry.confirm(claim, evidence(result.change)), code('outbox_claim_lost'));
    assert.equal((await s.doc('leases', id).get()).data()?.chainSyncStatus, 'pending');
  } finally { await s.db.terminate(); }
});

test('registry rejects altered paid expiry, slot ownership and partial identities', { skip: !emulator }, async () => {
  const s = await setup();
  try {
    const claim = await s.outbox.claim('job1', 'worker'); assert.ok(claim);
    await s.doc('leases', id).update({ expiresAt: new Date(expiry.getTime() + 1_000) });
    await assert.rejects(s.registry.prepare(claim), code('registry_paid_provenance_invalid'));
    await s.doc('leases', id).update({ expiresAt: expiry });
    await s.doc('slots', 'building_42').update({ leaseId: 'another' });
    await assert.rejects(s.registry.prepare(claim), code('registry_state_inconsistent'));
    await s.doc('slots', 'building_42').update({ leaseId: id });
    await s.doc('leases', id).update({ leaseKey: hash });
    await assert.rejects(s.registry.prepare(claim), code('registry_identity_invalid'));
    assert.equal((await s.doc('leases', id).get()).data()?.holderSalt, undefined);
    await s.doc('leases', id).update({ leaseKey: FieldValue.delete() });
    const prepared = await s.registry.prepare(claim); assert.equal(prepared.status, 'ready');
    const building = (await s.doc('buildings', 'building').get()).data()!;
    await s.doc('buildings', 'building').update({ buildingKey: FieldValue.delete() });
    await assert.rejects(s.registry.prepare(claim), code('registry_identity_invalid'));
    await s.doc('buildings', 'building').update({ buildingKey: building.buildingKey });
    await s.doc('leases', id).update({ leaseKey: FieldValue.delete(), holderSalt: FieldValue.delete(), holderCommitment: FieldValue.delete(), registryEvidence: { finalityVerified: true } });
    await assert.rejects(s.registry.prepare(claim), code('registry_identity_invalid'));
  } finally { await s.db.terminate(); }
});
