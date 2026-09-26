import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { CURRENT_TERMS_VERSION } from '@realaddr/domain';

const eventEnvironment: NodeJS.ProcessEnv = {
  APP_ENV: 'event',
  GCP_PROJECT_ID: 'realaddr-fixture',
  RESOURCE_PREFIX: 'realaddr-event',
  FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_',
  FIRESTORE_DATABASE_ID: '(default)',
  PUBLIC_ORIGIN: 'https://address.chain.tokyo',
  TERMS_VERSION: CURRENT_TERMS_VERSION,
  RATE_LIMIT_HMAC_KEY: 'a'.repeat(64),
};

test('event API requires explicit shared database and application namespace', () => {
  const config = loadConfig(eventEnvironment);
  assert.equal(config.databaseId, '(default)');
  assert.equal(config.pricing, null);
  for (const [key, value, message] of [
    ['RESOURCE_PREFIX', undefined, 'invalid_resource_prefix'],
    ['RESOURCE_PREFIX', 'other', 'invalid_resource_prefix'],
    ['FIRESTORE_COLLECTION_PREFIX', undefined, 'invalid_collection_prefix'],
    ['FIRESTORE_COLLECTION_PREFIX', 'other_', 'invalid_collection_prefix'],
    ['FIRESTORE_DATABASE_ID', undefined, 'invalid_firestore_database'],
    ['FIRESTORE_DATABASE_ID', 'other', 'invalid_firestore_database'],
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

test('local API retains emulator defaults and cannot select another database', () => {
  const local = { APP_ENV: 'local', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' };
  const config = loadConfig(local);
  assert.equal(config.projectId, 'demo-realaddr-local');
  assert.equal(config.collectionPrefix, 'realaddr_event_');
  assert.equal(config.databaseId, '(default)');
  assert.throws(() => loadConfig({ ...local, FIRESTORE_DATABASE_ID: 'other' }), { message: 'invalid_firestore_database' });
  assert.throws(() => loadConfig({ APP_ENV: 'local' }), { message: 'firestore_emulator_required_for_local_execution' });
});
