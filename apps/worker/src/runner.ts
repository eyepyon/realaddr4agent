import { randomUUID } from 'node:crypto';
import type { OutboxRepository, RealAddrRepository } from '@realaddr/db';

export interface WorkerRunner { run(outboxId: string): Promise<{ status: 'fulfilled' | 'completed' | 'superseded' | 'missing' | 'not_claimed' | 'retry' | 'manual_review'; retryable: boolean }> }
type OutboxPort = Pick<OutboxRepository, 'claim' | 'retry' | 'getDeliveryState'>;
type RecoveryPort = Pick<RealAddrRepository, 'recoverConfirmedPurchaseFromOutbox' | 'recoverConfirmedRenewalFromOutbox'>;

export function createWorkerRunner(outbox: OutboxPort, repository: RecoveryPort, owner: string = randomUUID()): WorkerRunner {
  return {
    async run(outboxId) {
      const claim = await outbox.claim(outboxId, owner);
      if (!claim) {
        const state = await outbox.getDeliveryState(outboxId);
        if (state !== 'pending') return { status: state, retryable: false };
        return { status: 'not_claimed', retryable: true };
      }
      let reason: 'handler_unavailable' | 'issuance_inconsistent' | 'processing_failed' = 'handler_unavailable';
      if (claim.eventType === 'payment.issuance_recovery_requested' || claim.eventType === 'payment.renewal_recovery_requested') {
        try {
          const result = claim.eventType === 'payment.renewal_recovery_requested'
            ? await repository.recoverConfirmedRenewalFromOutbox(claim)
            : await repository.recoverConfirmedPurchaseFromOutbox(claim);
          if (result.status === 'fulfilled') return { status: 'fulfilled', retryable: false };
          reason = 'issuance_inconsistent';
        } catch {
          // Keep the outbox durable and bounded. The claim fence controls the retry.
          reason = 'processing_failed';
        }
      }
      const state = await outbox.retry(claim, reason);
      return { status: state === 'manual_review' ? 'manual_review' : 'retry', retryable: state !== 'manual_review' };
    },
  };
}
