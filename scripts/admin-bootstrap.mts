import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Firestore } = require('@google-cloud/firestore');
import { AdminRepository } from '../packages/db/src/admin.js';

const env = process.env;
if (process.argv.slice(2).join(' ') !== '--apply') throw new Error('explicit_apply_required');
if (!['local', 'event'].includes(env.APP_ENV ?? '') || env.FIRESTORE_DATABASE_ID !== 'realaddr' || env.FIRESTORE_COLLECTION_PREFIX !== 'realaddr_event_') throw new Error('invalid_admin_bootstrap_target');
const projectId = env.GCP_PROJECT_ID ?? '';
if (env.APP_ENV === 'local' ? !projectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST : !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-') || !!env.FIRESTORE_EMULATOR_HOST) throw new Error('invalid_admin_bootstrap_target');
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS', 'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON']) if (env[key]) throw new Error('key_credentials_disallowed');
const emails = (env.ADMIN_ALLOWED_EMAILS ?? '').split(',').map(value => value.trim()).filter(Boolean);
if (emails.length < 1 || emails.length > 100) throw new Error('admin_allowlist_required');
const db = new Firestore({ projectId, databaseId: 'realaddr' });
try {
  await new AdminRepository(db, env.FIRESTORE_COLLECTION_PREFIX, null).bootstrapPrincipals(emails);
  console.log(JSON.stringify({ status: 'bootstrap_completed', requestedCount: new Set(emails.map(value => value.toLowerCase())).size, existingBindingsAndRevocationsPreserved: true }));
} catch {
  throw new Error('admin_bootstrap_failed');
} finally {
  await db.terminate();
}
