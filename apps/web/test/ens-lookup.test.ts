import assert from "node:assert/strict";
import test from "node:test";
import { parseEnsLookup } from "../src/ens-lookup-result";

const name = "f00042.demo.example.eth";
const base = { normalizedName: name, checkedAt: "2026-09-27T00:00:00Z" };
const fixture = {
  ...base, status: "verified", reasonCode: "ens_binding_verified", expiresAt: "2026-10-27T00:00:00Z", verifiedBlock: "123",
  reference: { network: "eip155:11155111", leaseRegistry: `0x${"1".repeat(40)}`, leaseKey: `0x${"2".repeat(64)}`, controller: `0x${"3".repeat(40)}`, resolver: `0x${"4".repeat(40)}`, ownerWallet: `0x${"5".repeat(40)}` },
};
test("unverified statuses remain unverified and cannot expose references", () => {
  for (const status of ["pending", "invalid"]) {
    const result = parseEnsLookup({ ...fixture, status, reasonCode: "ens_registration_pending" }, name);
    assert.equal(result.status, status);
    assert.equal(result.reference, undefined);
  }
});
test("unknown, malformed and mismatched responses cannot become verified", () => {
  for (const value of [null, { ...fixture, status: "ready" }, { ...fixture, reference: undefined }, { ...fixture, reasonCode: "ens_read_unavailable" }, { ...fixture, verifiedBlock: "no" }, { ...fixture, checkedAt: "no" }, { ...fixture, normalizedName: "different.demo.example.eth" }, { ...fixture, reference: { ...fixture.reference, network: "eip155:1" } }]) assert.throws(() => parseEnsLookup(value, name));
});
test("verified response retains only the public contract fields", () => {
  const result = parseEnsLookup({ ...fixture, forwardingAddress: "private fixture", worldSubject: "private fixture", reference: { ...fixture.reference, forwardingAddress: "private fixture" } }, name);
  assert.equal(result.status, "verified");
  assert.deepEqual(result.reference, fixture.reference);
  assert.equal(JSON.stringify(result).includes("private fixture"), false);
});
