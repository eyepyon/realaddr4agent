import { createHash } from 'node:crypto';

export type RiskDecision = 'allow' | 'deny' | 'hold';
export const INTERCEPTA_POLICY_VERSION = 'intercepta-address-v1-pending-review';
export interface RiskAssessment {
  provider: 'intercepta';
  subjectAddress: string;
  paymentNetwork: 'eip155:84532';
  riskNetwork: string;
  decision: RiskDecision;
  reasonCodes: string[];
  checkedAt: Date;
  expiresAt: Date;
  policyVersion: string;
  responseHash: string;
}
export class RiskGateError extends Error {
  constructor() { super('Fresh matching allowed security assessment required'); this.name = 'RiskGateError'; }
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function assertRiskAllowsPayment(assessment: RiskAssessment, expected: { subjectAddress: string; paymentNetwork: 'eip155:84532' }, now = new Date()): void {
  if (!(assessment.checkedAt instanceof Date) || !(assessment.expiresAt instanceof Date) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RiskGateError();
  const checked = assessment.checkedAt.getTime();
  const expires = assessment.expiresAt.getTime();
  if (!ADDRESS.test(expected.subjectAddress) || assessment.provider !== 'intercepta' || assessment.decision !== 'allow'
    || assessment.subjectAddress.toLowerCase() !== expected.subjectAddress.toLowerCase()
    || expected.paymentNetwork !== 'eip155:84532' || assessment.paymentNetwork !== expected.paymentNetwork || assessment.riskNetwork !== 'eip155:1'
    || !assessment.policyVersion || !/^[0-9a-f]{64}$/.test(assessment.responseHash)
    || !Number.isFinite(checked) || !Number.isFinite(expires) || checked > now.getTime()
    || expires <= now.getTime() || expires <= checked || expires - checked > 60_000 || now.getTime() - checked > 60_000) throw new RiskGateError();
}
const TRAITS = new Set(['known_scammer', 'initiator_scam_transactions', 'sanction_address_communication', 'suspicious_dex_pair_deployer', 'suspicious_deployer', 'attack_money_target', 'zero_address_risk', 'sanction_address', 'fake_phishing_transfer', 'non_kyc_transfers', 'mixer_transfers', 'fake_phishing_contract_communication', 'rug_pull', 'rug_pull_trader', 'blacklist']);
const PROHIBITED = new Set(['known_scammer', 'sanction_address', 'blacklist']);
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function interpretQuickScan(value: unknown): { decision: RiskDecision; reasonCodes: string[] } {
  if (!object(value) || typeof value.toxicScore !== 'number' || !Number.isFinite(value.toxicScore) || !Array.isArray(value.traits)) return { decision: 'hold', reasonCodes: ['invalid_provider_schema'] };
  const names: string[] = [];
  for (const trait of value.traits) {
    if (!object(trait) || typeof trait.name !== 'string' || !TRAITS.has(trait.name) || typeof trait.risk !== 'number' || !Number.isFinite(trait.risk) || typeof trait.txsCount !== 'number' || !Number.isFinite(trait.txsCount) || typeof trait.description !== 'string') return { decision: 'hold', reasonCodes: ['invalid_provider_schema'] };
    names.push(trait.name);
  }
  const denied = names.filter(name => PROHIBITED.has(name));
  if (denied.length) return { decision: 'deny', reasonCodes: [...new Set(denied)].map(name => `prohibited_${name}`) };
  return { decision: 'hold', reasonCodes: ['provider_policy_unconfirmed'] };
}
export interface InterceptaPort { assessAddress(address: string): Promise<RiskAssessment>; }
export interface InterceptaOptions { apiKey: string; fetch?: typeof globalThis.fetch; }
export class InterceptaClient implements InterceptaPort {
  readonly #options: InterceptaOptions;
  #requestsAttempted = 0;
  get requestsAttempted(): number { return this.#requestsAttempted; }
  constructor(options: InterceptaOptions) { this.#options = options; }
  async assessAddress(address: string): Promise<RiskAssessment> {
    if (!ADDRESS.test(address)) throw new Error('Invalid screening address');
    const checkedAt = new Date();
    const base = { provider: 'intercepta' as const, subjectAddress: address.toLowerCase(), paymentNetwork: 'eip155:84532' as const, riskNetwork: 'unknown', checkedAt, expiresAt: new Date(checkedAt.getTime() + 60_000), policyVersion: INTERCEPTA_POLICY_VERSION };
    const hold = (reason: string, hash = ''): RiskAssessment => ({ ...base, decision: 'hold', reasonCodes: [reason], responseHash: hash });
    if (!this.#options.apiKey.trim() || /\s/.test(this.#options.apiKey)) return hold('missing_configuration');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let attempt = 0;
    try {
      while (true) {
        this.#requestsAttempted++;
        const response = await (this.#options.fetch ?? globalThis.fetch)(`https://api.web3antivirus.io/api/public/v2/extension/account/${address}/quick-scan`, { headers: { 'X-API-KEY': this.#options.apiKey, Accept: 'application/json' }, redirect: 'error', signal: controller.signal });
        if (response.status === 429) {
          const raw = response.headers.get('retry-after');
          const delay = raw === null ? NaN : /^\d+$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - Date.now();
          await response.body?.cancel();
          if (attempt++ > 0 || !Number.isFinite(delay) || delay < 0 || delay > 500) return hold('rate_limited');
          await new Promise<void>((resolve, reject) => { const id = setTimeout(resolve, delay); controller.signal.addEventListener('abort', () => { clearTimeout(id); reject(new Error('aborted')); }, { once: true }); });
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); return hold('provider_http_error'); }
        if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); return hold('invalid_provider_content_type'); }
        if (!response.body) return hold('empty_provider_response');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 65_536) return hold('provider_response_too_large');
            chunks.push(part.value);
          }
        } finally { await reader.cancel(); }
        if (controller.signal.aborted) return hold('provider_timeout');
        const bytes = Buffer.concat(chunks);
        const responseHash = createHash('sha256').update(bytes).digest('hex');
        let value: unknown;
        try { value = JSON.parse(bytes.toString('utf8')); } catch { return hold('invalid_provider_json', responseHash); }
        return { ...base, ...interpretQuickScan(value), responseHash };
      }
    } catch { return hold(controller.signal.aborted ? 'provider_timeout' : 'provider_unavailable'); }
    finally { clearTimeout(timer); }
  }
}
