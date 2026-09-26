import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CURRENT_TERMS_VERSION } from '@realaddr/domain';
import type { NamespaceConfig } from '@realaddr/ens';

const eventEnvironment: NodeJS.ProcessEnv = {
  APP_ENV: 'event',
  GCP_PROJECT_ID: 'realaddr-fixture',
  RESOURCE_PREFIX: 'realaddr-event',
  FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_',
  FIRESTORE_DATABASE_ID: 'realaddr',
  PUBLIC_ORIGIN: 'https://address.chain.tokyo',
  TERMS_VERSION: CURRENT_TERMS_VERSION,
  RATE_LIMIT_HMAC_KEY: 'a'.repeat(64),
};

test('event API requires explicit named database and application namespace', () => {
  const config = loadConfig(eventEnvironment);
  assert.equal(config.databaseId, 'realaddr');
  assert.equal(config.pricing, null);
  for (const [key, value, message] of [
    ['RESOURCE_PREFIX', undefined, 'invalid_resource_prefix'],
    ['RESOURCE_PREFIX', 'other', 'invalid_resource_prefix'],
    ['FIRESTORE_COLLECTION_PREFIX', undefined, 'invalid_collection_prefix'],
    ['FIRESTORE_COLLECTION_PREFIX', 'other_', 'invalid_collection_prefix'],
    ['FIRESTORE_DATABASE_ID', undefined, 'invalid_firestore_database'],
    ['FIRESTORE_DATABASE_ID', 'other', 'invalid_firestore_database'],
    ['FIRESTORE_DATABASE_ID', '(default)', 'invalid_firestore_database'],
    ['GCP_PROJECT_ID', 'demo-local', 'invalid_event_project'],
    ['GCP_PROJECT_ID', 'invalid/project', 'invalid_event_project'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8085', 'emulator_disallowed_outside_local'],
    ['TERMS_VERSION', 'event-demo-1', 'invalid_terms_version'],
    ['TERMS_VERSION', 'realaddr-event-draft-1', 'invalid_terms_version'],
    ['TERMS_VERSION', 'unapproved-version', 'invalid_terms_version'],
  ] as const) {
    assert.throws(() => loadConfig({ ...eventEnvironment, [key]: value }), { message });
  }
});

test('event API rejects key credential overrides without exposing their contents', () => {
  for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS', 'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON']) {
    assert.throws(() => loadConfig({ ...eventEnvironment, [key]: 'PRIVATE_CREDENTIAL_MARKER' }), { message: 'key_credentials_disallowed' });
  }
});

test('local API requires the named emulator database without a default fallback', () => {
  const local = { APP_ENV: 'local', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', FIRESTORE_DATABASE_ID: 'realaddr' };
  const config = loadConfig(local);
  assert.equal(config.projectId, 'demo-realaddr-local');
  assert.equal(config.collectionPrefix, 'realaddr_event_');
  assert.equal(config.databaseId, 'realaddr');
  assert.throws(() => loadConfig({ ...local, FIRESTORE_DATABASE_ID: 'other' }), { message: 'invalid_firestore_database' });
  assert.throws(() => loadConfig({ ...local, FIRESTORE_DATABASE_ID: '(default)' }), { message: 'invalid_firestore_database' });
  assert.throws(() => loadConfig({ ...local, FIRESTORE_DATABASE_ID: undefined }), { message: 'invalid_firestore_database' });
  assert.throws(() => loadConfig({ APP_ENV: 'local', FIRESTORE_DATABASE_ID: 'realaddr' }), { message: 'firestore_emulator_required_for_local_execution' });
});

test('World stays disabled by default and enabled configuration fails closed', () => {
  assert.equal(loadConfig(eventEnvironment).world, undefined);
  assert.throws(() => loadConfig({ ...eventEnvironment, WORLD_ENABLED: 'yes' }), { message: 'invalid_world_enabled' });
  assert.throws(() => loadConfig({ ...eventEnvironment, WORLD_ENABLED: 'true' }), { message: 'world_configuration_incomplete' });
  const configured = { ...eventEnvironment, WORLD_ENABLED: 'true', WORLD_CLIENT_ID: 'fixture-client', WORLD_CLIENT_SECRET: 'fixture-secret', WORLD_REDIRECT_URI: 'https://address.chain.tokyo/auth/world/callback', WORLD_SESSION_KEY: Buffer.alloc(32, 1).toString('base64'), MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') };
  assert.ok(loadConfig(configured).world);
  assert.throws(() => loadConfig({ ...configured, WORLD_REDIRECT_URI: 'https://example.invalid/callback' }), { message: 'invalid_world_redirect_uri' });
  assert.throws(() => loadConfig({ ...configured, MAIL_ENCRYPTION_KEY: 'invalid' }), { message: 'invalid_world_encryption_key' });
});

test('ENS boot validates every namespace pin and canonical configuration',()=>{
 const pin={address:('0x'+'1'.repeat(40)) as NamespaceConfig['parentOwner'],codeHash:('0x'+'a'.repeat(64)) as NamespaceConfig['proxyLogic']['codeHash']};
 const namespace:NamespaceConfig={chainId:11155111,parentName:'example.eth',locationSlug:'tokyo',parentOwner:pin.address,locationOwner:pin.address,serviceOrigin:'https://address.chain.tokyo',universalResolver:pin,rootRegistry:pin,ethRegistry:pin,upperRegistry:pin,locationRegistry:pin,factory:pin,resolverImplementation:pin,userRegistryImplementation:pin,proxyLogic:pin,nameController:pin,leaseRegistry:pin};
 const id='11111111-1111-1111-1111-111111111111',env={...eventEnvironment,ENS_READ_ENABLED:'true',ENS_RPC_URL:'https://example.invalid',ENS_NAMESPACES_JSON:JSON.stringify({[id]:namespace})};assert.ok(loadConfig(env).ens);
 for(const changes of [{parentName:'OTHER.eth'},{locationSlug:'invalid.slug'},{userRegistryImplementation:{address:pin.address,codeHash:'bad'}},{proxyLogic:{address:pin.address,codeHash:'bad'}},{universalResolver:{address:'0x'+'0'.repeat(40),codeHash:pin.codeHash}}])assert.throws(()=>loadConfig({...env,ENS_NAMESPACES_JSON:JSON.stringify({[id]:{...namespace,...changes}})}),{message:'invalid_ens_configuration'});
});

test('Admin configuration is opt-in, uses exact HTTPS callback and independent session key', () => {
  assert.equal(loadConfig(eventEnvironment).admin, undefined);
  assert.throws(() => loadConfig({ ...eventEnvironment, ADMIN_ENABLED: 'yes' }), { message: 'invalid_admin_enabled' });
  assert.throws(() => loadConfig({ ...eventEnvironment, ADMIN_ENABLED: 'true' }), { message: 'admin_configuration_incomplete' });
  const configured = { ...eventEnvironment, ADMIN_ENABLED: 'true', ADMIN_GOOGLE_CLIENT_ID: 'fixture-client', ADMIN_GOOGLE_CLIENT_SECRET: 'fixture-secret', ADMIN_OIDC_REDIRECT_URI: 'https://address.chain.tokyo/auth/admin/callback', ADMIN_SESSION_SECRET: Buffer.alloc(32, 3).toString('base64') };
  assert.ok(loadConfig(configured).admin);
  assert.throws(() => loadConfig({ ...configured, ADMIN_OIDC_REDIRECT_URI: 'https://other.invalid/callback' }), { message: 'invalid_admin_redirect_uri' });
  assert.throws(() => loadConfig({ ...configured, ADMIN_SESSION_SECRET: 'invalid' }), { message: 'invalid_admin_session_secret' });
});

test('complete pricing is validated at configuration load while partial settings stay disabled', () => {
  const configured = { ...eventEnvironment, PRICE_PROFILE: 'testnet', PAYMENT_NETWORK: 'eip155:84532', PAYMENT_ASSET: '0x'+'1'.repeat(40), PAYMENT_PAY_TO: '0x'+'2'.repeat(40), PAYMENT_DECIMALS: '6', PRICING_VERSION: 'testnet-fixture-v1', LEASE_PRICE_TESTNET_ATOMIC: '550000', ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC: '100000', ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC: '300000', LEASE_PERIOD_DAYS: '30' };
  const config=loadConfig(configured);assert.equal(config.pricing?.addressAmountAtomic,'550000');assert.equal(config.pricing?.network,'eip155:84532');assert.equal(config.pricing?.decimals,6);assert.ok(Object.isFrozen(config.pricing));
  for(const key of ['PAYMENT_ASSET','PAYMENT_PAY_TO','PAYMENT_DECIMALS','PRICING_VERSION','LEASE_PRICE_TESTNET_ATOMIC','ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC','ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC'])assert.equal(loadConfig({...configured,[key]:undefined}).pricing,null);
  for(const [key,value] of [['PAYMENT_DECIMALS','18'],['LEASE_PRICE_TESTNET_ATOMIC','55000000'],['ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC','0'],['ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC','400000'],['PAYMENT_ASSET','invalid'],['PAYMENT_PAY_TO','invalid'],['PAYMENT_ASSET','0x'+'0'.repeat(40)],['PAYMENT_PAY_TO','0x'+'0'.repeat(40)],['PRICING_VERSION','   ']] as const)assert.throws(()=>loadConfig({...configured,[key]:value}),{message:'pricing_unavailable'});
  assert.throws(()=>loadConfig({...configured,PRICE_PROFILE:'mainnet'}),{message:'mainnet_disabled'});assert.throws(()=>loadConfig({...configured,PAYMENT_NETWORK:'eip155:1'}),{message:'payment_network_disabled'});
  for(const days of ['29','31','030','', '30.0'])assert.throws(()=>loadConfig({...configured,LEASE_PERIOD_DAYS:days}),{message:'invalid_lease_period_days'});
  assert.equal(loadConfig({...eventEnvironment,LEASE_PERIOD_DAYS:'30'}).pricing,null);
});
