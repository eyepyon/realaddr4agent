import { CURRENT_TERMS_VERSION, type PricingConfig } from '@realaddr/domain';
import { randomBytes } from 'node:crypto';
import { secretKey } from './world-crypto.js';
import { validateNamespaceConfig, type NamespaceConfig } from '@realaddr/ens';

export interface ApiConfig {
  appEnv: 'local' | 'event' | 'production';
  port: number;
  origin: string;
  projectId: string;
  databaseId: 'realaddr';
  collectionPrefix: string;
  termsVersion: string;
  rateLimitKey: Buffer;
  pricing: PricingConfig | null;
  world?: { clientId: string; clientSecret: string; redirectUri: string; sessionKey: Buffer; mailKey: Buffer };
  admin?: { clientId: string; clientSecret: string; redirectUri: string; sessionKey: Buffer };
  ens?: { rpcUrl: string; namespaces: Record<string, NamespaceConfig>; maxGasAtomic?: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const appEnv = env.APP_ENV ?? 'local';
  if (appEnv !== 'local' && appEnv !== 'event' && appEnv !== 'production') throw new Error('invalid_app_env');
  const local = appEnv === 'local';
  if (env.NODE_ENV && !['development', 'test', 'production'].includes(env.NODE_ENV)) throw new Error('invalid_node_env');
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  if ((local && env.RESOURCE_PREFIX && env.RESOURCE_PREFIX !== 'realaddr-event') || (!local && env.RESOURCE_PREFIX !== 'realaddr-event')) throw new Error('invalid_resource_prefix');
  const collectionPrefix = env.FIRESTORE_COLLECTION_PREFIX ?? (local ? 'realaddr_event_' : '');
  if (collectionPrefix !== 'realaddr_event_') throw new Error('invalid_collection_prefix');
  const databaseId = env.FIRESTORE_DATABASE_ID;
  if (databaseId !== 'realaddr') throw new Error('invalid_firestore_database');
  const origin = env.PUBLIC_ORIGIN ?? (local ? `http://localhost:${port}` : '');
  if (!origin || (!local && origin !== 'https://address.chain.tokyo')) throw new Error('invalid_public_origin');
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || (!local && parsedOrigin.protocol !== 'https:') || (local && !['localhost', '127.0.0.1'].includes(parsedOrigin.hostname))) throw new Error('invalid_public_origin');
  const projectId = env.GCP_PROJECT_ID ?? (local ? 'demo-realaddr-local' : '');
  if (!projectId) throw new Error('missing_project_id');
  if (local && (!projectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST)) {
    throw new Error('firestore_emulator_required_for_local_execution');
  }
  if (!local && env.FIRESTORE_EMULATOR_HOST) throw new Error('emulator_disallowed_outside_local');
  if (!local) {
    if (projectId.startsWith('demo-') || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error('invalid_event_project');
    if (env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_CREDENTIALS || env.GOOGLE_CLOUD_KEYFILE_JSON || env.GCLOUD_KEYFILE_JSON) throw new Error('key_credentials_disallowed');
  }
  if (env.PRICE_PROFILE && env.PRICE_PROFILE !== 'testnet') throw new Error('mainnet_disabled');
  if (env.PAYMENT_NETWORK && env.PAYMENT_NETWORK !== 'eip155:84532') throw new Error('payment_network_disabled');
  const termsVersion = env.TERMS_VERSION ?? (local ? 'event-demo-1' : '');
  if (!termsVersion || termsVersion.length > 64) throw new Error('invalid_terms_version');
  if (!local && termsVersion !== CURRENT_TERMS_VERSION) throw new Error('invalid_terms_version');
  if (!local && !/^[a-fA-F0-9]{64}$/.test(env.RATE_LIMIT_HMAC_KEY ?? '')) throw new Error('invalid_rate_limit_key');
  const rateLimitKey = env.RATE_LIMIT_HMAC_KEY ? Buffer.from(env.RATE_LIMIT_HMAC_KEY, 'hex') : randomBytes(32);
  if (rateLimitKey.length !== 32) throw new Error('invalid_rate_limit_key');
  const pricingReady = Boolean(env.PAYMENT_ASSET && env.PAYMENT_PAY_TO && env.LEASE_PRICE_TESTNET_ATOMIC && env.ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC && env.ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC && env.PAYMENT_DECIMALS && env.PRICING_VERSION);
  const pricing = pricingReady ? {
    profile: 'testnet' as const,
    network: 'eip155:84532',
    asset: env.PAYMENT_ASSET!,
    payTo: env.PAYMENT_PAY_TO!,
    decimals: Number(env.PAYMENT_DECIMALS),
    pricingVersion: env.PRICING_VERSION!,
    addressAmountAtomic: env.LEASE_PRICE_TESTNET_ATOMIC!,
    ensFloorAmountAtomic: env.ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC!,
    ensCustomAmountAtomic: env.ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC!,
  } satisfies PricingConfig : null;
  if (env.WORLD_ENABLED && !['true', 'false'].includes(env.WORLD_ENABLED)) throw new Error('invalid_world_enabled');
  let world: ApiConfig['world'];
  if (env.WORLD_ENABLED === 'true') {
    if (appEnv === 'production') throw new Error('world_sandbox_only');
    if (!env.WORLD_CLIENT_ID?.trim() || !env.WORLD_CLIENT_SECRET?.trim()) throw new Error('world_configuration_incomplete');
    const redirectUri = `${origin}/auth/world/callback`;
    if (parsedOrigin.protocol !== 'https:') throw new Error('world_https_required');
    if (env.WORLD_REDIRECT_URI !== redirectUri) throw new Error('invalid_world_redirect_uri');
    world = { clientId: env.WORLD_CLIENT_ID, clientSecret: env.WORLD_CLIENT_SECRET, redirectUri, sessionKey: secretKey(env.WORLD_SESSION_KEY), mailKey: secretKey(env.MAIL_ENCRYPTION_KEY) };
  }
  if (env.ADMIN_ENABLED && !['true', 'false'].includes(env.ADMIN_ENABLED)) throw new Error('invalid_admin_enabled');
  let admin: ApiConfig['admin'];
  if (env.ADMIN_ENABLED === 'true') {
    if (!env.ADMIN_GOOGLE_CLIENT_ID?.trim() || !env.ADMIN_GOOGLE_CLIENT_SECRET?.trim() || /[\r\n]/.test(env.ADMIN_GOOGLE_CLIENT_ID + env.ADMIN_GOOGLE_CLIENT_SECRET)) throw new Error('admin_configuration_incomplete');
    const redirectUri = `${origin}/auth/admin/callback`;
    if (parsedOrigin.protocol !== 'https:' || env.ADMIN_OIDC_REDIRECT_URI !== redirectUri) throw new Error('invalid_admin_redirect_uri');
    let sessionKey: Buffer;
    try { sessionKey = secretKey(env.ADMIN_SESSION_SECRET); } catch { throw new Error('invalid_admin_session_secret'); }
    admin = { clientId: env.ADMIN_GOOGLE_CLIENT_ID, clientSecret: env.ADMIN_GOOGLE_CLIENT_SECRET, redirectUri, sessionKey };
  }
  if (env.ENS_READ_ENABLED && !['true', 'false'].includes(env.ENS_READ_ENABLED)) throw new Error('invalid_ens_enabled');
  let ens: ApiConfig['ens'];
  if (env.ENS_READ_ENABLED === 'true') {
    if (appEnv === 'production') throw new Error('ens_testnet_only');
    try {
      const rpc = new URL(env.ENS_RPC_URL ?? '');
      if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash) throw new Error();
      const namespaces: unknown = JSON.parse(env.ENS_NAMESPACES_JSON ?? '');
      if (!namespaces || typeof namespaces !== 'object' || Array.isArray(namespaces) || !Object.keys(namespaces).length) throw new Error();
      for (const [id, value] of Object.entries(namespaces)) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) || !value || typeof value !== 'object' || value.chainId !== 11155111 || value.serviceOrigin !== origin) throw new Error();
        validateNamespaceConfig(value as NamespaceConfig);
      }
      if (env.ENS_DESCRIPTION_MAX_GAS_ATOMIC && !/^[1-9][0-9]{0,6}$/.test(env.ENS_DESCRIPTION_MAX_GAS_ATOMIC)) throw new Error();
      ens = { rpcUrl: rpc.href, namespaces: namespaces as Record<string, NamespaceConfig>, ...(env.ENS_DESCRIPTION_MAX_GAS_ATOMIC ? { maxGasAtomic: env.ENS_DESCRIPTION_MAX_GAS_ATOMIC } : {}) };
    } catch { throw new Error('invalid_ens_configuration'); }
  }
  return { appEnv, port, origin, projectId, databaseId, collectionPrefix, termsVersion, rateLimitKey, pricing, ...(admin ? { admin } : {}), ...(world ? { world } : {}), ...(ens ? { ens } : {}) };
}
