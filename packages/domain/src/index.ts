import { createHash, randomBytes } from 'node:crypto';
import { ens_normalize } from '@adraffy/ens-normalize';

export const SCHEMA_VERSION = 1;
export const SLOT_CAPACITY = 65_535;
export const SHARD_COUNT = 64;
export const BITS_PER_SHARD = 1_024;
export const HOLD_MS = 10 * 60_000;

export type PriceProfile = 'testnet' | 'mainnet';
export type ProductKind = 'address' | 'ens_floor' | 'ens_custom';
export interface PricingConfig {
  profile: PriceProfile;
  network: string;
  asset: string;
  payTo: string;
  decimals: number;
  pricingVersion: string;
  addressAmountAtomic: string;
  ensFloorAmountAtomic: string;
  ensCustomAmountAtomic: string;
}

const EXPECTED: Record<PriceProfile, Record<ProductKind, string>> = {
  testnet: { address: '550000', ens_floor: '100000', ens_custom: '300000' },
  mainnet: { address: '55000000', ens_floor: '10000000', ens_custom: '30000000' },
};

export class DomainError extends Error {
  constructor(public readonly code: string, public readonly status: number, message = code, public readonly retryable = false) {
    super(message);
    this.name = 'DomainError';
  }
}

export function validateFloor(floor: unknown): number {
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 1 || floor > SLOT_CAPACITY) {
    throw new DomainError('invalid_floor', 422);
  }
  return floor;
}

export function shardForFloor(floor: number): { shard: number; bit: number } {
  validateFloor(floor);
  return { shard: Math.floor((floor - 1) / BITS_PER_SHARD), bit: (floor - 1) % BITS_PER_SHARD };
}

export function shardCapacity(shard: number): number {
  if (!Number.isInteger(shard) || shard < 0 || shard >= SHARD_COUNT) throw new DomainError('invalid_shard', 422);
  return shard === 63 ? 1_023 : BITS_PER_SHARD;
}

export function validatePricing(config: PricingConfig): Readonly<PricingConfig> {
  if (config.decimals !== 6 || !config.network || !config.asset || !config.payTo || !config.pricingVersion) {
    throw new DomainError('pricing_unavailable', 503);
  }
  if (config.profile === 'mainnet' || config.network !== 'eip155:84532' || config.profile !== 'testnet') {
    throw new DomainError('pricing_unavailable', 503);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(config.asset) || !/^0x[a-fA-F0-9]{40}$/.test(config.payTo)) {
    throw new DomainError('pricing_unavailable', 503);
  }
  const expected = EXPECTED[config.profile];
  if (config.addressAmountAtomic !== expected.address || config.ensFloorAmountAtomic !== expected.ens_floor || config.ensCustomAmountAtomic !== expected.ens_custom) {
    throw new DomainError('pricing_unavailable', 503);
  }
  return Object.freeze({ ...config });
}

export function amountFor(config: PricingConfig, kind: ProductKind): string {
  validatePricing(config);
  return EXPECTED[config.profile][kind];
}

export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[\x21-\x7E]+$/.test(value)) {
    throw new DomainError('invalid_idempotency_key', 422);
  }
  return value;
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function newOpaqueToken(): string { return randomBytes(32).toString('base64url'); }
export function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

export function normalizeWallet(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new DomainError('invalid_wallet', 422);
  return address.toLowerCase();
}

export function normalizePostalCode(value: string): string {
  const digits = value.replace('-', '');
  if (!/^\d{7}$/.test(digits) || (value.includes('-') && !/^\d{3}-\d{4}$/.test(value))) throw new DomainError('invalid_postal_code', 422);
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function normalizeSlug(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new DomainError('invalid_slug', 422);
  try {
    if (ens_normalize(value) !== value) throw new DomainError('invalid_slug', 422);
  } catch {
    throw new DomainError('invalid_slug', 422);
  }
  return value;
}

export function requiredText(value: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) throw new DomainError('invalid_text', 422);
  return text;
}

export function bitmapEmpty(): string { return '0'.repeat(256); }
export function bitmapHas(hex: string, bit: number): boolean { return (BigInt(`0x${hex}`) & (1n << BigInt(bit))) !== 0n; }
export function bitmapSet(hex: string, bit: number): string { return (BigInt(`0x${hex}`) | (1n << BigInt(bit))).toString(16).padStart(256, '0'); }
export function bitmapClear(hex: string, bit: number): string { return (BigInt(`0x${hex}`) & ~(1n << BigInt(bit))).toString(16).padStart(256, '0'); }
