import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256 } from '@realaddr/domain';
import { DispatchRepository, OutboxRepository } from '../src/index.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const prefix = 'realaddr_event_';
const lost = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
async function job(db: Firestore, id: string, now: Date): Promise<void> {
  await db.collection(`${prefix}outbox`).doc(id).create({ state: 'pending', availableAt: now, attempts: 0, eventType: 'payment.settlement_requested', aggregateId: id, version: 1, payload: { orderId: id } });
}
function fixture() {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
  let clock = Date.parse('2026-09-26T00:00:00Z');
  return { db, dispatch: new DispatchRepository(db, prefix, { now: () => new Date(clock) }), now: () => new Date(clock), advance: (milliseconds = 61_000) => { clock += milliseconds; } };
}
test('dispatch claims are exclusive, unknown outcomes retain identity, and missing tasks rotate with fencing', { skip: !emulator }, async () => {
  const { db, dispatch, now, advance } = fixture();
  try {
    await job(db, 'one', now());
    const claims = await Promise.all([dispatch.claimDispatch('one', 'a'), dispatch.claimDispatch('one', 'b')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean)!;
    await dispatch.finishDispatch(first, 'unknown');
    assert.equal(await dispatch.claimDispatch('one', 'early'), null);
    advance(5_000);
    const second = await dispatch.claimDispatch('one', 'c');
    assert.ok(second);
    assert.equal(second.taskId, first.taskId);
    await dispatch.finishDispatch(second, 'confirmed');
    advance(10_000);
    const third = await dispatch.claimDispatch('one', 'd');
    assert.ok(third?.taskConfirmed);
    advance();
    const fourth = await dispatch.claimDispatch('one', 'e');
    assert.ok(fourth);
    await assert.rejects(dispatch.finishDispatch(third, 'missing'), lost('dispatch_claim_lost'));
    await dispatch.finishDispatch(fourth, 'missing');
    advance(40_000);
    const fifth = await dispatch.claimDispatch('one', 'f');
    assert.ok(fifth);
    assert.notEqual(fifth.taskId, first.taskId);
    assert.equal(fifth.taskGeneration, 1);
    assert.equal(fifth.taskConfirmed, false);
    assert.equal((await db.collection(`${prefix}outbox`).doc('one').get()).data()?.availableAt.toDate().getTime(), Date.parse('2026-09-26T00:00:00Z'));
  } finally { await db.terminate(); }
});
test('sweep cursor advances beyond a blocked first page and expired sweeps cannot finish', { skip: !emulator }, async () => {
  const { db, dispatch, now, advance } = fixture();
  try {
    await Promise.all(Array.from({ length: 25 }, (_, n) => job(db, `job-${String(n).padStart(2, '0')}`, now())));
    const claims = await Promise.all([dispatch.acquireSweep('a'), dispatch.acquireSweep('b')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean)!;
    const page = await dispatch.listSweepPage(first);
    assert.equal(page.ids.length, 20);
    assert.ok(page.cursor);
    await dispatch.finishSweep(first, page.cursor);
    advance(1_000);
    await job(db, 'new-due', now());
    const second = await dispatch.acquireSweep('c');
    assert.ok(second);
    const tail = await dispatch.listSweepPage(second);
    assert.deepEqual(tail.ids, ['job-20', 'job-21', 'job-22', 'job-23', 'job-24']);
    assert.equal(tail.cursor, null);
    advance();
    await assert.rejects(dispatch.finishSweep(second, null), lost('sweep_claim_lost'));
    const recovered = await dispatch.acquireSweep('d');
    assert.ok(recovered);
    await dispatch.finishSweep(recovered, null);
    const reset = await dispatch.acquireSweep('e');
    assert.ok(reset);
    assert.equal(reset.through.getTime(), now().getTime());
    assert.equal((await dispatch.listSweepPage(reset)).ids.length, 20);
    const resetPage = await dispatch.listSweepPage(reset);
    await dispatch.finishSweep(reset, resetPage.cursor);
    const resetTail = await dispatch.acquireSweep('f');
    assert.ok(resetTail);
    assert.ok((await dispatch.listSweepPage(resetTail)).ids.includes('new-due'));
  } finally { await db.terminate(); }
});
test('cumulative dispatch cap parks matching projection without mutating payment and delivery states fail closed', { skip: !emulator }, async () => {
  const { db, dispatch, now, advance } = fixture();
  try {
    await job(db, 'cap', now());
    const operationId = sha256(JSON.stringify(['payment', 'cap']));
    await db.collection(`${prefix}admin_operations`).doc(operationId).create({ kind: 'payment', targetId: 'cap', operationId, version: 1, status: 'pending' });
    await db.collection(`${prefix}payments`).doc('cap').create({ status: 'outcome_unknown' });
    for (let i = 0; i < 10; i++) {
      const claim = await dispatch.claimDispatch('cap', 'worker');
      assert.ok(claim);
      await dispatch.finishDispatch(claim, 'unknown');
      advance(300_000);
    }
    assert.equal(await dispatch.claimDispatch('cap', 'worker'), null);
    assert.equal((await db.collection(`${prefix}outbox`).doc('cap').get()).data()?.state, 'manual_review');
    assert.equal((await db.collection(`${prefix}admin_operations`).doc(operationId).get()).data()?.status, 'manual_review');
    assert.equal((await db.collection(`${prefix}payments`).doc('cap').get()).data()?.status, 'outcome_unknown');
    const outbox = new OutboxRepository(db, prefix);
    assert.equal(await outbox.getDeliveryState('cap'), 'manual_review');
    assert.equal(await outbox.getDeliveryState('absent'), 'missing');
    for (const state of ['completed', 'superseded', 'pending', 'processing']) {
      await db.collection(`${prefix}outbox`).doc('cap').update({ state });
      assert.equal(await outbox.getDeliveryState('cap'), state === 'processing' ? 'pending' : state);
    }
    await db.collection(`${prefix}outbox`).doc('cap').update({ state: 'invalid' });
    await assert.rejects(outbox.getDeliveryState('cap'), lost('invalid_outbox_state'));
  } finally { await db.terminate(); }
});
