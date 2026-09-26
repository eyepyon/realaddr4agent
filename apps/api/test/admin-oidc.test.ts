import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AdminOidcClient, AdminOidcError, GOOGLE_ISSUER, createPkce } from '../src/admin-oidc.js';
import { adminHash } from '../src/admin.js';
const now = new Date('2026-09-27T00:00:00Z'), seconds = now.getTime()/1000;
const pair = await generateKeyPair('RS256');
const publicKey = { ...await exportJWK(pair.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
 return new SignJWT({ sub:'operator', nonce:'nonce', email:'operator@example.invalid', email_verified:true, ...claims }).setProtectedHeader({alg:'RS256',kid:'fixture',...header}).setIssuer(GOOGLE_ISSUER).setAudience('client').setIssuedAt(seconds).setExpirationTime(seconds+300).sign(pair.privateKey);
}
function fixture(value:string) {
 const calls:string[]=[];
 const request:typeof fetch=async(url, init)=>{calls.push(String(url));assert.equal(init?.redirect,'error');return Response.json(String(url)==='https://oauth2.googleapis.com/token'?{id_token:value}:{keys:[publicKey]});};
 return {calls,client:new AdminOidcClient({clientId:'client',clientSecret:'secret',redirectUri:'https://service.example/auth/admin/callback',fetch:request,now:()=>now})};
}
const input={code:'code',verifier:'a'.repeat(43),nonceHash:adminHash('nonce')};
test('Google confidential PKCE flow uses fixed endpoints and verifies signed email identity',async()=>{
 const {client,calls}=fixture(await token());
 const url=new URL(client.authorizationUrl({state:'state',nonce:'nonce',codeChallenge:createPkce().codeChallenge}));assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.deepEqual(await client.exchangeAndVerify(input),{issuer:GOOGLE_ISSUER,subject:'operator',email:'operator@example.invalid',displayName:'Operator'});
 assert.deepEqual(calls,['https://oauth2.googleapis.com/token','https://www.googleapis.com/oauth2/v3/certs']);
});
test('nonce, email verification, authorized party, token source and signature are mandatory',async()=>{
 for(const claims of [{nonce:'other'},{email_verified:false},{email_verified:'true'},{email:undefined},{sub:''},{azp:'other'}])await assert.rejects(fixture(await token(claims)).client.exchangeAndVerify(input),AdminOidcError);
 await assert.rejects(fixture(await token({}, {jku:'https://untrusted.example/keys'})).client.exchangeAndVerify(input),AdminOidcError);
 const wrong = await new SignJWT({nonce:'nonce',email:'operator@example.invalid',email_verified:true}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setSubject('operator').setIssuer('https://wrong.example').setAudience('client').setIssuedAt(seconds).setExpirationTime(seconds+300).sign(pair.privateKey);
 await assert.rejects(fixture(wrong).client.exchangeAndVerify(input),AdminOidcError);
});
