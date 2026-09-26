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
  registryReadback?: RegistryReadbackConfig;
}

export interface RegistryReadbackConfig {
  chainId: 11155111;
  registryAddress: `0x${string}`;
  contractLabel: string;
  contractVersion: string;
  multibaasUrl: string;
  multibaasApiKey: string;
  runtimeCodeHash: `0x${string}`;
  multiBaasChainLabel: 'ethereum';
  rpcUrl: string;
  finalityPolicy: 'finalized';
}

function secureUrl(value: string | undefined): string {
  if (!value) throw new Error('missing_registry_readback_config');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid_registry_readback_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_registry_readback_url');
  return value;
}

function multibaasUrl(value: string | undefined): string {
  const validated = secureUrl(value);
  const url = new URL(validated);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.multibaas\.com$/.test(url.hostname) || url.port || !['/', '/api/v0', '/api/v0/'].includes(url.pathname)) throw new Error('invalid_registry_readback_url');
  return validated;
}

function registryConfig(env: NodeJS.ProcessEnv): RegistryReadbackConfig | undefined {
  if (env.REGISTRY_READBACK_ENABLED && !['true', 'false'].includes(env.REGISTRY_READBACK_ENABLED)) throw new Error('invalid_registry_readback_enabled');
  if (env.REGISTRY_READBACK_ENABLED !== 'true') return undefined;
  if (env.REGISTRY_CHAIN_ID !== '11155111' || env.MULTIBAAS_CHAIN_LABEL !== 'ethereum' || env.REGISTRY_FINALITY_POLICY !== 'finalized') throw new Error('invalid_registry_readback_network');
  if (!env.REGISTRY_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(env.REGISTRY_ADDRESS) || /^0x0{40}$/i.test(env.REGISTRY_ADDRESS)) throw new Error('invalid_registry_address');
  if (!env.REGISTRY_RUNTIME_CODE_HASH || !/^0x[0-9a-fA-F]{64}$/.test(env.REGISTRY_RUNTIME_CODE_HASH) || /^0x0{64}$/i.test(env.REGISTRY_RUNTIME_CODE_HASH)) throw new Error('invalid_registry_runtime_code_hash');
  if (!env.REGISTRY_CONTRACT_LABEL || !/^[a-z0-9_-]{1,128}$/.test(env.REGISTRY_CONTRACT_LABEL) || !env.REGISTRY_CONTRACT_VERSION || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(env.REGISTRY_CONTRACT_VERSION) || !env.MULTIBAAS_API_KEY || /\s/.test(env.MULTIBAAS_API_KEY)) throw new Error('missing_registry_readback_config');
  return { chainId: 11155111, registryAddress: env.REGISTRY_ADDRESS as `0x${string}`, runtimeCodeHash: env.REGISTRY_RUNTIME_CODE_HASH as `0x${string}`, contractLabel: env.REGISTRY_CONTRACT_LABEL, contractVersion: env.REGISTRY_CONTRACT_VERSION, multibaasUrl: multibaasUrl(env.MULTIBAAS_URL), multibaasApiKey: env.MULTIBAAS_API_KEY, multiBaasChainLabel: 'ethereum', rpcUrl: secureUrl(env.REGISTRY_RPC_URL), finalityPolicy: 'finalized' };
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
  const registryReadback = registryConfig(env);
  return { appEnv, port, projectId, databaseId: '(default)', collectionPrefix: 'realaddr_event_', audience, tasksAccount, schedulerAccount, ...(dispatchEnabled ? { dispatchEnabled, region: env.GCP_REGION!, queue: env.TASKS_QUEUE! } : {}), ...(registryReadback ? { registryReadback } : {}) };
}
