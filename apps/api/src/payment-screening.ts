import type { AgentPrincipal, OwnerReadRepository, RealAddrRepository, VerifiedPurchaseAuthorization, VerifiedRiskAssessment } from '@realaddr/db';
import { DomainError, normalizeWallet } from '@realaddr/domain';
import { assertRiskAllowsPayment, type InterceptaPort, type RiskAssessment } from '@realaddr/intercepta';

type Preparation = Awaited<ReturnType<RealAddrRepository['preparePurchaseSettlement']>>;
export type ScreeningPreparation = { decision: 'allow'; preparation: Preparation } | { decision: 'deny' | 'hold'; reasonCodes: string[] };
export interface ScreeningDependencies {
  orders: Pick<OwnerReadRepository, 'getOrder'>;
  repository: Pick<RealAddrRepository, 'preparePurchaseSettlement' | 'prepareRenewalSettlement'>;
  intercepta: InterceptaPort;
  now?: () => Date;
}

// Internal verified-adapter boundary only. This does not expose or verify x402 HTTP payloads.
export async function prepareScreenedAddressSettlement(dependencies: ScreeningDependencies, request: {
  kind: 'purchase' | 'renew'; orderId: string; principal: AgentPrincipal; authorization: VerifiedPurchaseAuthorization;
}): Promise<ScreeningPreparation> {
  const input = structuredClone(request);
  const { authorization, principal } = input;
  const order = await dependencies.orders.getOrder(principal, input.orderId);
  if (['settling', 'fulfilled', 'reconciling', 'manual_review'].includes(order.status)) return { decision: 'hold', reasonCodes: ['existing_payment_requires_reconciliation'] };
  const startedAt = (dependencies.now ?? (() => new Date()))();
  if (order.status !== 'awaiting_payment' || new Date(order.expiresAt) <= startedAt
    || !(authorization.validBefore instanceof Date) || !Number.isFinite(authorization.validBefore.getTime())
    || authorization.validBefore <= startedAt) return { decision: 'hold', reasonCodes: ['payment_order_closed'] };
  if (input.kind !== order.kind || authorization.verified !== true || order.network !== 'eip155:84532'
    || principal.walletChain !== order.network || authorization.network !== order.network
    || normalizeWallet(authorization.payer) !== normalizeWallet(principal.walletAddress)
    || normalizeWallet(authorization.payTo) !== normalizeWallet(order.payTo)
    || normalizeWallet(authorization.asset) !== normalizeWallet(order.asset)
    || authorization.amountAtomic !== order.amountAtomic
    || !(authorization.validBefore instanceof Date) || !Number.isFinite(authorization.validBefore.getTime())
    || authorization.validBefore > new Date(order.expiresAt)) throw new DomainError('payment_authorization_mismatch', 409);

  // Both calls finish before the repository opens its retried Firestore transaction.
  let payTo: RiskAssessment;
  let payer: RiskAssessment;
  try {
    payTo = await dependencies.intercepta.assessAddress(order.payTo);
    payer = await dependencies.intercepta.assessAddress(authorization.payer);
  } catch {
    return { decision: 'hold', reasonCodes: ['screening_unavailable'] };
  }
  const assessments = [payTo, payer];
  if (assessments.some(assessment => assessment.decision === 'deny')) {
    return { decision: 'deny', reasonCodes: safeReasons(assessments.filter(assessment => assessment.decision === 'deny')) };
  }
  if (assessments.some(assessment => assessment.decision !== 'allow')) return { decision: 'hold', reasonCodes: safeReasons(assessments) };
  const now = (dependencies.now ?? (() => new Date()))();
  try {
    assertRiskAllowsPayment(payTo, { subjectAddress: order.payTo, paymentNetwork: 'eip155:84532' }, now);
    assertRiskAllowsPayment(payer, { subjectAddress: authorization.payer, paymentNetwork: 'eip155:84532' }, now);
  } catch {
    return { decision: 'hold', reasonCodes: ['fresh_matching_screening_required'] };
  }
  const evidence = (assessment: RiskAssessment): VerifiedRiskAssessment => ({
    verified: true, decision: 'allow', subjectAddress: assessment.subjectAddress,
    paymentNetwork: assessment.paymentNetwork, riskNetwork: assessment.riskNetwork,
    checkedAt: assessment.checkedAt, expiresAt: assessment.expiresAt,
    policyVersion: assessment.policyVersion, responseHash: assessment.responseHash,
  });
  const preparationInput = { orderId: input.orderId, principal, authorization, risk: { payTo: evidence(payTo), payer: evidence(payer) } };
  const preparation = input.kind === 'purchase'
    ? await dependencies.repository.preparePurchaseSettlement(preparationInput)
    : await dependencies.repository.prepareRenewalSettlement(preparationInput);
  return { decision: 'allow', preparation };
}

function safeReasons(assessments: RiskAssessment[]): string[] {
  const reasons = [...new Set(assessments.flatMap(assessment => assessment.reasonCodes).filter(reason => /^[a-z][a-z0-9_]{0,79}$/.test(reason)))].slice(0, 12);
  return reasons.length ? reasons : ['screening_not_allowed'];
}
