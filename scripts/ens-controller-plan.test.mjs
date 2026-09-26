import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, namehash } from 'viem';
import { controllerImmutableLayout, planControllerDeployment } from './ens-controller-plan.mjs';
import { validateControllerManifest } from './ens-controller-flow.mjs';
import { makeControllerFixture } from './ens-controller.test-fixture.mjs';

test('controller plan freezes eight exact constructor arguments and all immutable bytes',()=>{
  const f=makeControllerFixture(),m=f.manifest;
  assert.equal(validateControllerManifest(m),true);
  const args=decodeAbiParameters(f.artifact.abi[0].inputs,`0x${m.transaction.data.slice(f.artifact.bytecode.object.length)}`);
  assert.deepEqual(args.map((value,index)=>index===7?value:value.toLowerCase()),[f.owner,f.owner,...['leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation'].map(key=>f.pins[key].address),f.parentLabel]);
  assert.equal(m.immutableValues.PARENT_NODE,namehash(`${f.parentLabel}.eth`));
  assert.equal(m.namespaceReady,false);assert.equal(m.livePreflightRequired,true);assert.equal(m.transaction.to,undefined);
  for(const entry of m.artifact.immutableLayout)for(const range of entry.ranges)assert.equal(`0x${m.expectedRuntime.slice(2+range.start*2,2+(range.start+32)*2)}`,m.immutableValues[entry.name]);
});
test('planner rejects untrusted AST ranges, types, runtime and upper proof',()=>{
  for(const change of [f=>f.ast.nodes[0].nodes[0].id=99,f=>f.ast.nodes[0].nodes[0].typeDescriptions.typeString='address',f=>f.artifact.deployedBytecode.immutableReferences['2'][0].start=2,f=>f.artifact.deployedBytecode.immutableReferences['1'][0].start=99999,f=>f.artifact.deployedBytecode.object=f.artifact.deployedBytecode.object.replace('600000','600001'),f=>f.simulationRuntime='0x6001',f=>f.upperProof.timestamp=-1n,f=>f.upperProof.rootRoles=1n,f=>f.pins.factory.address=f.pins.ethRegistry.address,f=>f.artifact.metadata.settings.optimizer.runs=1]){
    const f=makeControllerFixture();change(f);assert.throws(()=>planControllerDeployment(f));
  }
  const f=makeControllerFixture();assert.equal(controllerImmutableLayout(f.artifact,f.ast).length,7);
});
test('manifest validation rejects modified transactions, duplicate pins and runtime',()=>{
  for(const change of [m=>m.transaction.to=m.owner,m=>m.transaction.data+='00',m=>m.expectedRuntime='0x6000',m=>m.constructor.publisher=m.pins.factory.address,m=>m.pins.proxyLogic.address=m.pins.factory.address,m=>m.evidence.blockNumber='-1']){const m=makeControllerFixture().manifest;change(m);assert.throws(()=>validateControllerManifest(m));}
});
