import { Firestore } from '@google-cloud/firestore';
import { DispatchRepository, OutboxRepository, RealAddrRepository, RegistryRepository } from '@realaddr/db';
import { createWorkerApp } from './worker-app.js';
import { loadWorkerConfig } from './config.js';
import { createWorkerRunner } from './runner.js';
import { createDispatcher } from './dispatcher.js';
import { createRegistryReader } from './registry-reader.js';

const config = loadWorkerConfig();
const db = new Firestore({ projectId: config.projectId, databaseId: config.databaseId });
const outbox = new OutboxRepository(db, config.collectionPrefix);
const repository = new RealAddrRepository(db, config.collectionPrefix, null);
const registry = config.registryReadback ? {
  repository: new RegistryRepository(db, config.collectionPrefix, { registryAddress: config.registryReadback.registryAddress }),
  reader: createRegistryReader(config.registryReadback),
} : undefined;
const runner = createWorkerRunner(outbox, repository, undefined, registry);
const dispatcher = createDispatcher(config, new DispatchRepository(db, config.collectionPrefix));
const app = createWorkerApp(config, runner, undefined, dispatcher);

const stop = async () => { await app.close(); await db.terminate(); };
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
await app.listen({ host: config.appEnv === 'local' ? '127.0.0.1' : '0.0.0.0', port: config.port });
