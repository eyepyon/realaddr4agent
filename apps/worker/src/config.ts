export interface WorkerConfig {
  appEnv: 'local' | 'event';
  port: number;
  projectId: string;
  databaseId: '(default)';
  collectionPrefix: 'realaddr_event_';
  audience: string;
  tasksAccount: string;
  schedulerAccount: string;
  dispatchEnabled?: boolean;
  region?: string;
  queue?: string;
}

function dedicatedAccount(value: string | undefined, role: 'tasks' | 'sched', projectId: string): string {
  if (!value || value !== `realaddr-event-${role}@${projectId}.iam.gserviceaccount.com`) throw new Error('invalid_worker_invoker');
  return value;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const appEnv = env.APP_ENV ?? 'local';
  if (appEnv !== 'local' && appEnv !== 'event') throw new Error('worker_environment_disabled');
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  if (env.RESOURCE_PREFIX !== 'realaddr-event') throw new Error('invalid_resource_prefix');
  if (env.FIRESTORE_COLLECTION_PREFIX !== 'realaddr_event_') throw new Error('invalid_collection_prefix');
  if (env.FIRESTORE_DATABASE_ID !== '(default)') throw new Error('invalid_firestore_database');
  const projectId = env.GCP_PROJECT_ID;
  if (!projectId) throw new Error('missing_project_id');
  if (appEnv === 'local') {
    if (!projectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST) throw new Error('firestore_emulator_required_for_local_execution');
  } else {
    if (env.FIRESTORE_EMULATOR_HOST) throw new Error('emulator_disallowed_outside_local');
    if (projectId.startsWith('demo-') || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('invalid_event_project');
    if (env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_CREDENTIALS || env.GOOGLE_CLOUD_KEYFILE_JSON || env.GCLOUD_KEYFILE_JSON) throw new Error('key_credentials_disallowed');
  }
  if (env.PRICE_PROFILE && env.PRICE_PROFILE !== 'testnet') throw new Error('mainnet_disabled');
  if (env.PAYMENT_NETWORK && env.PAYMENT_NETWORK !== 'eip155:84532') throw new Error('payment_network_disabled');
  const audience = env.WORKER_URL;
  if (!audience) throw new Error('missing_worker_audience');
  const url = new URL(audience);
  if (url.origin !== audience || url.username || url.password || url.search || url.hash || (appEnv === 'event' && url.protocol !== 'https:') || (appEnv === 'local' && (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('invalid_worker_audience');
  const tasksAccount = dedicatedAccount(env.TASK_INVOKER_SA, 'tasks', projectId);
  const schedulerAccount = dedicatedAccount(env.SCHEDULER_INVOKER_SA, 'sched', projectId);
  if (tasksAccount === schedulerAccount) throw new Error('worker_invokers_must_differ');
  const dispatchEnabled = env.CLOUD_TASKS_DISPATCH_ENABLED === 'true';
  if (env.CLOUD_TASKS_DISPATCH_ENABLED && !['true', 'false'].includes(env.CLOUD_TASKS_DISPATCH_ENABLED)) throw new Error('invalid_dispatch_enabled');
  if (dispatchEnabled) {
    if (appEnv !== 'event') throw new Error('dispatch_requires_event');
    if (!env.GCP_REGION || !/^[a-z]+-[a-z]+[0-9]+$/.test(env.GCP_REGION)) throw new Error('invalid_tasks_region');
    if (env.TASKS_QUEUE !== 'realaddr-event-jobs') throw new Error('invalid_tasks_queue');
  }
  return { appEnv, port, projectId, databaseId: '(default)', collectionPrefix: 'realaddr_event_', audience, tasksAccount, schedulerAccount, ...(dispatchEnabled ? { dispatchEnabled, region: env.GCP_REGION!, queue: env.TASKS_QUEUE! } : {}) };
}
