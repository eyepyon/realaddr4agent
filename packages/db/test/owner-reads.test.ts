import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256 } from '@realaddr/domain';
import { OwnerReadRepository, type AgentPrincipal } from '../src/index.js';

test('owner reads isolate principals, allowlist fields, expire without writes and paginate ties', {skip: !process.env.FIRESTORE_EMULATOR_HOST}, async () => {
  const db = new Firestore({projectId: `demo-realaddr-${randomUUID()}`});
  const now = new Date('2026-09-26T00:00:00Z');
  const repo = new OwnerReadRepository(db, 'realaddr_event_', {now: () => now});
  const p: AgentPrincipal = {tenantId: randomUUID(), agentId: randomUUID(), walletAddress: `0x${'a'.repeat(40)}`, walletChain: 'eip155:84532', credentialId: randomUUID()};
  const ids = [randomUUID(),randomUUID(),randomUUID()].sort().reverse(); const locationId = randomUUID();
  for (const id of ids) {
    await repo.collections.doc('orders', id).set({schemaVersion:1,id,tenantId:p.tenantId,agentId:p.agentId,ownerWallet:p.walletAddress,kind:'purchase',status:'awaiting_payment',locationId,floor:42,amountAtomic:'550000',network:'eip155:84532',asset:`0x${'1'.repeat(40)}`,payTo:`0x${'2'.repeat(40)}`,expiresAt:new Date(now.getTime()+60000),createdAt:now,encryptedPayload:{ciphertext:'private'},authorizationNonce:'private',responseHash:'private'});
  }
  const leaseId = ids[0]!;
  const lease = {schemaVersion:1,id:leaseId,tenantId:p.tenantId,agentId:p.agentId,ownerWallet:p.walletAddress,buildingId:locationId,slotNumber:42,addressSnapshot:{postalCode:'1000001',address:'Test address'},status:'active',startsAt:new Date(now.getTime()-86400000),expiresAt:now,version:1,chainSyncStatus:'pending',updatedAt:now};
  await repo.collections.doc('leases',leaseId).set(lease);
  await repo.collections.doc('mail_profiles',leaseId).set({schemaVersion:1,leaseId,status:'disabled',destinationConfigured:true,grantExpiresAt:null,encryptedDestination:'private',worldSubject:'private'});
  const unseen = (e: unknown) => e instanceof DomainError && e.status === 404;
  for (const principal of [{...p,tenantId:randomUUID()},{...p,agentId:randomUUID()},{...p,walletAddress:`0x${'b'.repeat(40)}`}]) {
    await assert.rejects(repo.getOrder(principal,leaseId),unseen); await assert.rejects(repo.getSubscription(principal,leaseId),unseen);
  }
  assert.deepEqual((await repo.listOrders({...p,agentId:randomUUID()},{limit:2})).items,[]);
  const first = await repo.listOrders(p,{limit:2}); assert.deepEqual(first.items.map(x=>x.id),ids.slice(0,2)); assert.ok(first.nextCursor);
  const second = await repo.listOrders(p,{limit:2,cursor:first.nextCursor}); assert.deepEqual(second.items.map(x=>x.id),ids.slice(2)); assert.equal(second.nextCursor,null);
  const order = await repo.getOrder(p,leaseId); assert.equal(order.riskAssessments.length,0); assert.ok(!JSON.stringify(order).includes('private'));
  const dto = await repo.getSubscription(p,leaseId); assert.equal(dto.status,'expired'); assert.match(dto.displayAddress,/V00042$/); assert.equal(dto.mail.destinationConfigured,true); assert.deepEqual(dto.ens,{status:'not_purchased',network:'eip155:11155111'}); assert.ok(!JSON.stringify(dto).includes('private'));
  assert.equal((await repo.collections.doc('leases',leaseId).get()).data()?.status,'active');
  await repo.collections.doc('mail_profiles',leaseId).update({status:'enabled'}); await assert.rejects(repo.getSubscription(p,leaseId),(e: unknown)=>e instanceof DomainError && e.status===503);
  await db.terminate();
});

test('owner projections require confirmed payment evidence and never trust stored ENS ready', {skip: !process.env.FIRESTORE_EMULATOR_HOST}, async () => {
  const db = new Firestore({projectId: `demo-realaddr-${randomUUID()}`});
  try {
    const now = new Date('2026-09-26T00:00:00Z'); const repo = new OwnerReadRepository(db,'realaddr_event_',{now:()=>now});
    const id=randomUUID(), locationId=randomUUID(); const p: AgentPrincipal={tenantId:randomUUID(),agentId:randomUUID(),walletAddress:`0x${'a'.repeat(40)}`,walletChain:'eip155:84532',credentialId:randomUUID()};
    const order={schemaVersion:1,id,tenantId:p.tenantId,agentId:p.agentId,ownerWallet:p.walletAddress,kind:'purchase',status:'fulfilled',leaseId:id,locationId,floor:42,amountAtomic:'550000',network:'eip155:84532',asset:`0x${'1'.repeat(40)}`,payTo:`0x${'2'.repeat(40)}`,expiresAt:now,createdAt:now};
    await repo.collections.doc('orders',id).set(order);
    const payment={schemaVersion:1,id,orderId:id,status:'confirmed',network:order.network,asset:order.asset,amountAtomic:order.amountAtomic,payer:p.walletAddress,payTo:order.payTo,txHash:`0x${'3'.repeat(64)}`,confirmedAt:now,transferLogIndex:0,evidenceHash:'a'.repeat(64),settlementEvidence:{finalityVerified:true,evidenceHash:'a'.repeat(64)},authorizationNonce:'private'};
    await repo.collections.doc('payments',id).set(payment);
    for(const side of ['payTo','payer']) await repo.collections.doc('risk_assessments',sha256(JSON.stringify([id,side,'settlement']))).set({schemaVersion:1,orderId:id,side,subjectAddress:side==='payTo'?order.payTo:p.walletAddress,paymentNetwork:order.network,riskNetwork:order.network,decision:'allow',checkedAt:now,responseHash:'private'});
    const dto=await repo.getOrder(p,id); assert.equal(dto.receipt?.paymentId,id); assert.ok(!JSON.stringify(dto).includes('private')); assert.deepEqual(dto.riskAssessments.map(r=>[r.side,r.reasonCodes]),[['seller',[]],['buyer',[]]]);
    const addonId=randomUUID(); await repo.collections.doc('orders',addonId).set({...order,id:addonId,kind:'ens_addon',status:'awaiting_payment',subscriptionId:id,pricingVersion:'test-v1',ensNameSnapshot:{nameType:'floor',label:'f00042',normalizedName:'f00042.test.example.eth',namePolicyVersion:'test-v1'}});
    const addon=await repo.getOrder(p,addonId); assert.deepEqual([addon.nameType,addon.label,addon.fqdn,addon.pricingVersion],['floor','f00042','f00042.test.example.eth','test-v1']);
    const unavailable=(e: unknown)=>e instanceof DomainError && e.status===503;
    await repo.collections.doc('payments',id).update({'settlementEvidence.finalityVerified':false}); await assert.rejects(repo.getOrder(p,id),unavailable);
    await repo.collections.doc('payments',id).set({...payment,amountAtomic:'1'}); await assert.rejects(repo.getOrder(p,id),unavailable);
    await repo.collections.doc('leases',id).set({schemaVersion:1,id,tenantId:p.tenantId,agentId:p.agentId,ownerWallet:p.walletAddress,buildingId:locationId,slotNumber:42,addressSnapshot:{postalCode:'1000001',address:'Test address'},status:'active',startsAt:now,expiresAt:new Date(now.getTime()+60000),version:1,chainSyncStatus:'pending',updatedAt:now});
    await repo.collections.doc('mail_profiles',id).set({schemaVersion:1,leaseId:id,status:'disabled',destinationConfigured:false,grantExpiresAt:null});
    await repo.collections.doc('ens_bindings',id).set({status:'ready',textRecords:{'realaddr.status':'active'}});
    const entitlement={schemaVersion:1,leaseId:id,state:'pending_payment'}; await repo.collections.doc('ens_entitlements',id).set(entitlement);
    assert.equal((await repo.getEns(p,id)).status,'not_purchased'); await repo.collections.doc('ens_entitlements',id).update({state:'paid'}); assert.equal((await repo.getEns(p,id)).status,'pending');
    await repo.collections.doc('ens_entitlements',id).update({state:'refunded'}); assert.deepEqual(await repo.getEns(p,id),{status:'disabled',network:'eip155:11155111',lastErrorCode:'ens_refunded'});
    await repo.collections.doc('ens_entitlements',id).update({leaseId:randomUUID()}); await assert.rejects(repo.getEns(p,id),unavailable);
  } finally { await db.terminate(); }
});
