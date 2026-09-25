import { Firestore } from '@google-cloud/firestore';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { RealAddrRepository } from '@realaddr/db';
import { loadConfig } from './config.js';
import { createApp } from './server.js';
import { repoRoot } from './paths.js';

const localEnv = resolve(repoRoot(), '.env');
if (existsSync(localEnv)) loadEnvFile(localEnv);
const config = loadConfig();
const db = new Firestore({ projectId: config.projectId });
const repository = new RealAddrRepository(db, config.collectionPrefix, config.pricing, { authDomain: new URL(config.origin).hostname as 'address.chain.tokyo' | 'localhost' | '127.0.0.1' });
const app = createApp(config, repository, db);
const stop = async () => {
  await app.close();
  if (db) await db.terminate();
};
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
await app.listen({ port: config.port, host: config.appEnv === 'local' ? '127.0.0.1' : '0.0.0.0' });
