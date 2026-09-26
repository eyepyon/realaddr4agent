# Integration guide

This English guide explains the integration boundaries. The Japanese [integration contract](../integrations.md), [requirements](../../.kiro/specs/realaddr/requirements.md), and integration-specific documents remain authoritative. Integration records are collected in [implementation status](../implementation-status.md). This guide does not translate or replace the adopted [terms](../terms.md), version `realaddr-v1`.

## Networks and payment boundaries

x402 payments use **Base Sepolia** (`eip155:84532`). ENSv2 and LeaseRegistry use **Ethereum Sepolia** (`eip155:11155111`). There is no bridge or additional payment chain. LeaseRegistry records represent operator-issued address-use rights, not real-estate ownership or an independent cross-chain payment proof.

| Product | Testnet/dev price | Future mainnet price |
| --- | ---: | ---: |
| Address purchase or renewal, 30 days | 0.55 USDC | 55 USDC |
| One-time ENS standard-name add-on | 0.10 USDC | 10 USDC |
| One-time ENS custom-name add-on | 0.30 USDC | 30 USDC |

USDC must have six verified decimals. Custom pricing replaces the standard tier; the two fees are not added together. Mainnet prices are configuration contracts for future operation and do not authorize mainnet payments. See [pricing](../pricing.md) for atomic amounts, renewal periods, and refund conditions.

## x402 and Intercepta

The intended x402 v2 flow fixes the order, origin, network, token, recipient, amount, expiry, and authorization before payment. Reserve and screen checks precede settlement. Official v2 headers are `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and `PAYMENT-RESPONSE`; legacy v1 headers must not be mixed in. The facilitator, token, receipts, finality, and retry behavior require live verification before enabling sale.

Purchase and renewal repository logic persists uncertain outcomes and holds. A confirmed receipt activates at most one order; an unknown result must be reconciled before retrying an external effect. Quote expiry alone does not release an uncertain payment reservation. Public purchase, renewal, add-on, and pay mutations remain closed with HTTP 503.

The Intercepta server-only Quick Scan client and internal purchase/renewal screening gate use the provider response schema. The current policy returns `hold/provider_policy_unconfirmed`, denies known directly dangerous traits, and holds other results. Zero score or empty traits do not establish safety.

With protected `INTERCEPTA_API_KEY` and a reviewed public EOA supplied through `INTERCEPTA_SCAN_ADDRESS`, the existing diagnostic is:

Windows PowerShell:

```powershell
pnpm intercepta:scan --address "$env:INTERCEPTA_SCAN_ADDRESS" --json
```

WSL bash / macOS zsh or bash:

```sh
pnpm intercepta:scan --address "$INTERCEPTA_SCAN_ADDRESS" --json
```

Prepare OS-local protected configuration separately; see the [cross-OS development guide](development.md). Node helper commands elsewhere in this guide have the same syntax on Windows, WSL, and macOS; their protected file references must resolve within the selected environment.

It scans only; it does not sign, settle, or modify an order. Missing, malformed, unknown, expired, or unavailable security results hold the action. Before integration completion, both the buyer's recipient and the seller's verified payer need live checks. See [Intercepta setup](../intercepta.md) for policy, limits, exit codes, and remaining gates.

## World and human mail approval

The backend uses Authorization Code with PKCE S256 against the fixed World sandbox issuer. It verifies signatures, issuer, audience, nonce, subject, expiry, and fresh authentication time. Owner-wallet proof and a browser session bind the human to the lease; OIDC login alone never grants consent.

World support includes explicit consent persistence, destination versioning, encryption, and the human-only form. The event uses sandbox/mock proof and must not be described as legal KYC or production Orb verification.

`WORLD_ENABLED` defaults to `false`. Enabling it requires the exact HTTPS callback and four web-only protected settings: `WORLD_CLIENT_ID`, `WORLD_CLIENT_SECRET`, `WORLD_SESSION_KEY`, and `MAIL_ENCRYPTION_KEY`. Session and mail encryption use separate keys. Follow [World setup](../world.md) and [deployment configuration](../deployment-configuration.md); do not put values in prompts, bundles, or logs.

A pending approval is short lived and bound to owner proof, World human, agent, lease version, policy, nonce, expiry, and destination version. Applied consent has no time limit for an unchanged destination. Lease expiry stops effective eligibility while preserving consent; confirmed paid renewal of the same lease can restore it. Human disable and security suspension continue to block it. Destination changes require fresh explicit approval. Human consent never changes the paid lease period.

Mail scope is only approval, an enabled indicator, and a human-entered destination form. Agent credentials cannot approve, read, or write the full forwarding address. There is no physical mail handling, shipping, or postage payment.

## LeaseRegistry and MultiBaas

LeaseRegistry records address-use rights on Ethereum Sepolia. MultiBaas provides contract linkage and reads. Database/outbox identity preparation and finalized-block readback tie chain state to the current lease version.

`REGISTRY_READBACK_ENABLED` defaults to `false`. Enabling readback requires reviewed contract/version/code pins, RPC, MultiBaas deployment/key, and finalized policy. RPC and MultiBaas must agree on the record and canonical block. Readback neither signs nor submits a transaction. Use [LeaseRegistry setup](../lease-registry.md) for artifact export, human deployment, permissions, and verification; internal port names are application interfaces, not invented vendor SDK methods.

## ENSv2 namespace and optional add-on

The real hierarchy is controlled parent name → upper UserRegistry → location label and location UserRegistry → purchased lease name and dedicated resolver. Standard names are `f00042.<location-slug>.<parent>.eth`; custom labels use the same location namespace. Slots are virtual and range from 1 to 65535.

Address purchase alone creates no ENS entitlement or resolver job. A paid add-on fixes the canonical name and price, reserves uniqueness atomically, and activates entitlement once. Unknown payment outcomes retain the name reservation. Paid names are never reused for another lease; v1 provides no post-purchase rename or second name. Address renewal includes maintenance of the already purchased name without another add-on charge.

Readiness requires exact registration, hierarchy, controller binding, active lease/version/expiry, and finalized external verification. A text record alone is insufficient. Forwarding destinations and World identifiers stay off ENS. The customer can edit only the dedicated resolver's description, not entitlement records, transfers, or registry expiry.

Location setup uses the five-stage helper below. ENS sales remain closed while `namespaceReady=false`.

The location helper runs with `node scripts/ens-location-serve.mjs` after a reviewed protected plan is prepared. Its configuration uses `ENS_LOCATION_PLAN_FILE`, `ENS_LOCATION_PLAN_HASH`, `ENS_LOCATION_STATE_FILE`, `ENS_LOCATION_WRAPPER_POLICY_FILE`, `ENS_LOCATION_WRAPPER_POLICY_HASH`, and optional `ENS_LOCATION_PORT`. Each stage requires a separate human wallet approval:

1. Create the dedicated location UserRegistry.
2. Set its reverse parent information.
3. Grant the controller register/unregister/renew permissions.
4. Register the location label in the upper registry.
5. Bind the persistent building key, slug, and registry in the controller.

The helper rechecks pinned code, ownership, hierarchy, permissions, canonical receipts, and finality before advancing. Unknown results stop resubmission. It uses separate state from parent, upper-registry, and controller setup; it receives no wallet private key. Completing a helper stage alone does not open sale. See [ENSv2 design and setup](../ensv2.md) for the complete planner, helper, receipt, and resolution gates.
