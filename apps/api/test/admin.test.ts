import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { DomainError } from '@realaddr/domain';
import type { AdminRepository, RealAddrRepository } from '@realaddr/db';
import { registerAdminRoutes, adminHash, adminCsrf } from '../src/admin.js';
import { seal } from '../src/world-crypto.js';
import { AdminOidcClient, GOOGLE_ISSUER } from '../src/admin-oidc.js';
import { createApp } from '../src/server.js';
import type { ApiConfig } from '../src/config.js';
const token='a'.repeat(43),key=Buffer.alloc(32,1);
const config:ApiConfig={appEnv:'event',origin:'https://service.example',port:8080,projectId:'fixture',databaseId:'realaddr',collectionPrefix:'realaddr_event_',termsVersion:'fixture',rateLimitKey:key,pricing:null,admin:{clientId:'client',clientSecret:'secret',redirectUri:'https://service.example/auth/admin/callback',sessionKey:key}};
function fixture() {
 const calls:string[]=[];const app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof DomainError?error.status:503).send({error:error instanceof DomainError?error.code:'dependency_unavailable'}));
 const admin={authenticateSession:async(hash:string)=>{assert.equal(hash,adminHash(token));return {displayName:'Operator',expiresAt:'2026-09-27T01:00:00Z',csrfHash:adminHash(adminCsrf(key,token))};},createLocation:async(_tokenHash:string,input:Record<string,unknown>)=>{assert.equal(input.status,'paused');calls.push('create');return {id:'location'};},revokeSession:async(hash:string)=>{assert.equal(hash,adminHash(token));calls.push('revoke');},consumeLogin:async()=>{calls.push('consume');throw new DomainError('invalid_admin_login',403);}} as unknown as AdminRepository;
 const repository={consumeRateLimit:async()=>{}} as unknown as RealAddrRepository;
 registerAdminRoutes(app,config,admin,repository);return {app,calls};
}
test('operator endpoints reject Agent, human cookie and absent session',async()=>{
 const {app}=fixture();for(const headers of [{authorization:'Bearer agent'},{cookie:'__Host-realaddr_session='+token},{}])assert.equal((await app.inject({url:'/v1/admin/session',headers})).statusCode,401);await app.close();
});
test('location writes require exact Origin, JSON, session CSRF and idempotency',async()=>{
 const {app,calls}=fixture(),headers={cookie:'realaddr_admin_session='+token,origin:config.origin,'content-type':'application/json','x-csrf-token':adminCsrf(key,token),'idempotency-key':'fixture-key'};
 for(const overrides of [{origin:'https://other.example'},{'x-csrf-token':'b'.repeat(43)},{'idempotency-key':'bad'}])assert.ok((await app.inject({method:'POST',url:'/v1/admin/locations',headers:{...headers,...overrides},payload:{}})).statusCode>=400);
 assert.equal((await app.inject({method:'POST',url:'/v1/admin/locations',headers,payload:{slug:'fixture',status:'available'}})).statusCode,422);assert.deepEqual(calls,[]);assert.equal((await app.inject({method:'POST',url:'/v1/admin/locations',headers,payload:{slug:'fixture',status:'paused'}})).statusCode,201);assert.deepEqual(calls,['create']);await app.close();
});
test('callback consumes bound state before token exchange and rejects missing browser cookie',async()=>{
 const {app,calls}=fixture();assert.equal((await app.inject({url:'/auth/admin/callback?state='+token+'&code=code'})).statusCode,401);
 assert.equal((await app.inject({url:'/auth/admin/callback?state=bad&code=code',headers:{cookie:'__Host-realaddr_admin_login='+token}})).statusCode,403);assert.deepEqual(calls,[]);
 assert.equal((await app.inject({url:'/auth/admin/callback?state='+token+'&code=code',headers:{cookie:'__Host-realaddr_admin_login='+token}})).statusCode,403);assert.deepEqual(calls,['consume']);await app.close();
});

test('logout requires CSRF, revokes session and clears cookie with empty JSON object',async()=>{
 const {app,calls}=fixture(),headers={cookie:'realaddr_admin_session='+token,origin:config.origin,'content-type':'application/json','idempotency-key':'logout-key'};
 assert.equal((await app.inject({method:'DELETE',url:'/v1/admin/session',headers,payload:'{}'})).statusCode,403);assert.deepEqual(calls,[]);
 const response=await app.inject({method:'DELETE',url:'/v1/admin/session',headers:{...headers,'x-csrf-token':adminCsrf(key,token)},payload:'{}'});
 assert.equal(response.statusCode,204);assert.deepEqual(calls,['revoke']);assert.match(String(response.headers['set-cookie']),/realaddr_admin_session=;.*Max-Age=0/);await app.close();
});
test('server exposes only validated currentVersion for admin version conflict',async()=>{
 const app=createApp(config,null,null);
 for(const [path,currentVersion] of [['/v1/admin/conflict',7],['/v1/admin/malformed','private'],['/v1/public-conflict',7]] as const)app.get(path,async()=>{const error=Object.assign(new DomainError('version_conflict',409),{currentVersion,privateValue:'hidden'});throw error;});
 const response=await app.inject({url:'/v1/admin/conflict'});assert.equal(response.statusCode,409);assert.equal(response.json().currentVersion,7);assert.equal(response.json().privateValue,undefined);
 for(const path of ['/v1/admin/malformed','/v1/public-conflict'])assert.equal((await app.inject({url:path})).json().currentVersion,undefined);await app.close();
});

function callbackFixture() {
 const app=Fastify(),calls:string[]=[];
 app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof DomainError?error.status:503).send({error:error instanceof DomainError?error.code:'dependency_unavailable'}));
 const admin={consumeLogin:async(stateHash:string,cookieHash:string)=>{assert.equal(stateHash,adminHash(token));assert.equal(cookieHash,adminHash(token));calls.push('consume');return {nonceHash:adminHash('nonce'),encryptedVerifier:seal(key,'admin-pkce',stateHash,'v'.repeat(43))};},bindAndIssueSession:async(claims:Record<string,unknown>)=>{assert.equal(claims.issuer,GOOGLE_ISSUER);calls.push('bind');return {displayName:'Operator',expiresAt:'2026-09-27T01:00:00Z',principalId:'principal'};}} as unknown as AdminRepository;
 const client={exchangeAndVerify:async(input:{code:string;verifier:string;nonceHash:string})=>{assert.equal(input.code,'code');assert.equal(input.verifier,'v'.repeat(43));assert.equal(input.nonceHash,adminHash('nonce'));calls.push('exchange');return {issuer:GOOGLE_ISSUER,subject:'operator',email:'operator@example.invalid',displayName:'Operator'};}} as unknown as AdminOidcClient;
 registerAdminRoutes(app,config,admin,{consumeRateLimit:async()=>{}} as unknown as RealAddrRepository,client);return {app,calls};
}
test('Google callback accepts exact optional response issuer and informational metadata',async()=>{
 for(const suffix of ['', '&iss='+encodeURIComponent(GOOGLE_ISSUER), '&iss='+encodeURIComponent(GOOGLE_ISSUER)+'&scope=openid%20email%20profile&authuser=0&prompt=consent&hd=example.invalid']){
  const {app,calls}=callbackFixture();const response=await app.inject({url:'/auth/admin/callback?state='+token+'&code=code'+suffix,headers:{cookie:'__Host-realaddr_admin_login='+token}});
  assert.equal(response.statusCode,302);assert.equal(response.headers.location,'/admin');assert.deepEqual(calls,['consume','exchange','bind']);assert.match(String(response.headers['set-cookie']),/realaddr_admin_session=/);await app.close();
 }
});
test('Google callback rejects mismatched or duplicate issuer and duplicate parameters before exchange',async()=>{
 for(const suffix of ['&iss=https%3A%2F%2Fother.example','&iss=accounts.google.com','&iss=', '&iss='+encodeURIComponent(GOOGLE_ISSUER)+'&iss='+encodeURIComponent(GOOGLE_ISSUER),'&iss='+encodeURIComponent(GOOGLE_ISSUER)+'&iss=https%3A%2F%2Fother.example','&hd=one&hd=two','&state='+token]){
  const {app,calls}=callbackFixture();assert.equal((await app.inject({url:'/auth/admin/callback?state='+token+'&code=code'+suffix,headers:{cookie:'__Host-realaddr_admin_login='+token}})).statusCode,403);assert.deepEqual(calls,[]);await app.close();
 }
});
