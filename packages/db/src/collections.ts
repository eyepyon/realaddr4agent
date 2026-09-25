import type { Firestore, CollectionReference, DocumentReference } from '@google-cloud/firestore';
import { DomainError } from '@realaddr/domain';

export const LOGICAL_COLLECTIONS = [
  'tenants', 'agents', 'api_credentials', 'wallet_challenges', 'buildings',
  'slots', 'leases', 'orders', 'payments', 'idempotency_keys', 'risk_assessments',
  'human_bindings', 'approvals', 'approval_heads', 'oidc_sessions', 'browser_sessions',
  'mail_profiles', 'refunds', 'outbox', 'admin_operations', 'ens_namespaces',
  'ens_bindings', 'ens_entitlements', 'chain_cursors', 'audit_events', 'uniques',
  'slot_shards', 'wallet_hold_quotas', 'rate_limits', 'daily_purchase_budgets',
  'signer_nonces', 'chain_submissions', 'admin_principals', 'admin_sessions',
  'admin_oidc_sessions', 'ops_metrics',
] as const;
export type LogicalCollection = typeof LOGICAL_COLLECTIONS[number];
const ALLOWED = new Set<string>(LOGICAL_COLLECTIONS);

export function validateCollectionPrefix(prefix: string | undefined): string {
  if (!prefix || !/^realaddr_[a-z0-9_]+_$/.test(prefix) || prefix !== 'realaddr_event_') {
    throw new DomainError('invalid_collection_prefix', 503);
  }
  return prefix;
}

export class CollectionMapper {
  readonly prefix: string;
  constructor(private readonly db: Firestore, prefix: string | undefined) {
    this.prefix = validateCollectionPrefix(prefix);
    if (db.databaseId !== '(default)') throw new DomainError('invalid_firestore_database', 503);
  }
  name(logical: LogicalCollection): string {
    if (!ALLOWED.has(logical) || logical.startsWith(this.prefix)) throw new DomainError('invalid_collection', 503);
    return `${this.prefix}${logical}`;
  }
  collection(logical: LogicalCollection): CollectionReference {
    return this.db.collection(this.name(logical));
  }
  doc(logical: LogicalCollection, id: string): DocumentReference {
    if (!id || id.includes('/') || id === '.' || id === '..') throw new DomainError('invalid_document_id', 422);
    return this.collection(logical).doc(id);
  }
}

export function createCollectionMapper(db: Firestore, prefix: string | undefined): CollectionMapper {
  return new CollectionMapper(db, prefix);
}
