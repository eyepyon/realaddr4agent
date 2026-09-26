export type Lookup = {
  status: "verified" | "pending" | "invalid" | "blocked";
  reasonCode: string;
  normalizedName?: string;
  checkedAt?: string;
  expiresAt?: string;
  verifiedBlock?: string;
  reference?: Record<string, string>;
};
const address = /^0x[0-9a-fA-F]{40}$/;
const key = /^0x[0-9a-fA-F]{64}$/;
export function parseEnsLookup(value: unknown, expectedName: string): Lookup {
  if (!value || typeof value !== "object") throw new Error();
  const data = value as Record<string, unknown>;
  if (!["verified", "pending", "invalid"].includes(String(data.status)) || typeof data.normalizedName !== "string" || data.normalizedName !== expectedName || data.normalizedName.length > 255 || typeof data.reasonCode !== "string" || !/^[a-z0-9_]{1,100}$/.test(data.reasonCode) || typeof data.checkedAt !== "string" || !Number.isFinite(Date.parse(data.checkedAt))) throw new Error();
  const result: Lookup = { status: data.status as Lookup["status"], normalizedName: data.normalizedName, reasonCode: data.reasonCode, checkedAt: data.checkedAt };
  if (data.status === "verified") {
    if (data.reasonCode !== "ens_binding_verified") throw new Error();
    const ref = data.reference as Record<string, unknown> | undefined;
    if (!ref || ref.network !== "eip155:11155111" || !["leaseRegistry", "controller", "resolver", "ownerWallet"].every(field => typeof ref[field] === "string" && address.test(ref[field] as string)) || typeof ref.leaseKey !== "string" || !key.test(ref.leaseKey) || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt)) || typeof data.verifiedBlock !== "string" || !/^[0-9]+$/.test(data.verifiedBlock)) throw new Error();
    result.reference = Object.fromEntries(["network", "leaseRegistry", "leaseKey", "controller", "resolver", "ownerWallet"].map(field => [field, ref[field] as string]));
    result.expiresAt = data.expiresAt;
    result.verifiedBlock = data.verifiedBlock;
  }
  return result;
}
