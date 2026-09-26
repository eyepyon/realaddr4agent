import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@realaddr/domain';
import type { AgentPrincipal, OwnerReadCursor } from '@realaddr/db';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Kind = 'orders' | 'subscriptions';
export function ownerCursor(key: Buffer, kind: Kind, principal: AgentPrincipal, limit: number) {
  const sign = (payload: string) => createHmac('sha256', key).update('realaddr:owner-read:cursor:v1\0').update(payload).digest();
  const scope = { v: 1, kind, tenantId: principal.tenantId, agentId: principal.agentId, limit, sort: kind === 'orders' ? 'createdAt_desc_id_desc' : 'updatedAt_desc_id_desc' };
  return {
    encode(cursor: OwnerReadCursor): string {
      const payload = Buffer.from(JSON.stringify({ ...scope, at: cursor.at.toISOString(), id: cursor.id })).toString('base64url');
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    decode(value: unknown): OwnerReadCursor | undefined {
      if (value === undefined) return undefined;
      try {
        if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
        const [payload, mac] = value.split('.') as [string, string];
        const bytes = Buffer.from(payload, 'base64url');
        const signature = Buffer.from(mac, 'base64url');
        if (bytes.toString('base64url') !== payload || signature.toString('base64url') !== mac || !timingSafeEqual(sign(payload), signature)) throw new Error();
        const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 8 || Object.entries(scope).some(([k, v]) => parsed[k] !== v) || typeof parsed.at !== 'string' || typeof parsed.id !== 'string' || !uuidPattern.test(parsed.id)) throw new Error();
        const at = new Date(parsed.at);
        if (!Number.isFinite(at.getTime()) || at.toISOString() !== parsed.at) throw new Error();
        return { at, id: parsed.id };
      } catch { throw new DomainError('invalid_cursor', 422); }
    },
  };
}
