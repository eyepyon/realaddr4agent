# Agent and human API guide

This English guide explains how to use the existing API and CLI and how planned flows differ from available behavior. The Japanese [API contract](../api.md) remains authoritative. [Public OpenAPI](../openapi.json) is the sole public HTTP schema; [admin OpenAPI](../admin-openapi.json) separately defines operator HTTP shapes. This guide intentionally does not duplicate their request/response schemas. For live evidence, use [implementation status](../implementation-status.md).

The adopted [terms](../terms.md) are version `realaddr-v1`. This guide does not translate or replace them. The user or authorized agent must review and accept the adopted text before signing the matching terms version; an earlier local demo login is not formal acceptance.

## Identity and terminology

An Agent authenticates by signing a wallet challenge and receives a Bearer token. Human mail operations instead require an owner-wallet-proven, World-authenticated browser session and explicit consent. Operators use a third, separate Google OIDC session. None of these credentials substitutes for another.

Public `location`, `floor`, `payment intent`, and `subscription` correspond to internal building, slot, order, and lease. `floor` means a **virtual slot** from 1 to 65535, never a physical building floor. Zero is invalid. An availability read is a current observation, not a reservation promise.

Owner reads are bound to both tenant and agent. An ENS name does not bypass ownership. Responses are constructed from public field allowlists and exclude forwarding destinations, ciphertext, World identifiers, authorization nonces, and raw signatures.

## Available and gated operations

| Surface | Current behavior |
| --- | --- |
| Process health and wallet authentication | Implemented; health does not verify external providers |
| Location/slot reads | Implemented behind Agent authorization; available locations depend on sale state |
| Payment-intent and subscription list/detail | Implemented owner reads with opaque pagination |
| Owner ENS status | Implemented; external verification is required before `ready` |
| Public ENS resolution and owner lookup by name | Implemented only with explicitly validated namespace/code-pin configuration; unavailable in the current event configuration |
| ENS description transaction preparation | Implemented behind verified ready binding and explicit configuration; returns an unsigned transaction, not a completed write |
| Public purchase, renewal, ENS add-on, and pay | Closed with HTTP 503; internal database processing is not public payment availability |
| Human approval and destination form | Implemented and event-configured; live World exchange and approval for a real paid lease remain unverified |
| Admin | Separate session and schema; no manual paid/consent override |

Consult [integration guide](integrations.md) before interpreting a sandbox setup or pending chain state as a completed connected flow.

## Existing CLI

Build first with `pnpm build`. Set `AGENT_API_ORIGIN` to the intended HTTPS origin (loopback HTTP is allowed locally), `AGENT_CREDENTIAL_FILE` to an untracked local credential file, and `AGENT_SIGNER_KEY_REF` to an untracked signing-key reference. Never put keys into command arguments or agent prompts. After reviewing formal terms, explicitly set `TERMS_VERSION=realaddr-v1` for event authentication.

The built entry emits one JSON result and avoids pnpm wrapper output:

These Node commands are common to Windows PowerShell, WSL bash, and macOS zsh/bash. WSL/macOS execution is unverified; see the [development guide](development.md) for OS-local tools, paths, and environment settings.

```sh
node packages/agent-cli/dist/index.js health --json
node packages/agent-cli/dist/index.js auth login --json
node packages/agent-cli/dist/index.js locations list --json
node packages/agent-cli/dist/index.js lease status --subscription '<subscription-id>' --json
node packages/agent-cli/dist/index.js intent status --intent '<intent-id>' --json
node packages/agent-cli/dist/index.js mail status --subscription '<subscription-id>' --json
node packages/agent-cli/dist/index.js ens status --subscription '<subscription-id>' --json
```

Quoted placeholders must be replaced with IDs returned by the API; quotes prevent angle brackets from becoming shell syntax. Set non-secret event terms with `$env:TERMS_VERSION = 'realaddr-v1'` in Windows PowerShell or `export TERMS_VERSION=realaddr-v1` in WSL/macOS. Inject credentials and key references through protected OS-local configuration, rather than pasting secrets into shell history. Authentication signs a login challenge; it does not sign a payment. `mail status` returns status and destination-configured information, never the full address.

Implemented ENS commands also include `ens resolve --name`, `lease status --name`, and `ens purchase`. The purchase command requests an intent; it does not provide a connected payment signer, and the current public API rejects sale. It requires `--subscription` and `--idempotency-key`; custom names additionally use `--name-type custom --name <label>`.

`ens describe` currently requires `--subscription`, `--text`, `--expected-version`, `--idempotency-key`, and **`--prepare-only`**. Preparation is not transaction submission or receipt/readback success. Do not infer an automated signer from the intended API design.

`lease purchase`, `lease renew`, and `mail enable` appear in the planned Japanese CLI contract but are not implemented commands in the current CLI. Automatic payment, polling, and payment signing are also incomplete. Do not invoke them as if they were available.

Current CLI exit codes are 0 for success, 2 for input, 3 for authentication, 4 for human approval required, 5 for forbidden, 6 for dependency/other failure, 7 for rate limiting, and 8 for conflict. Read the JSON machine error as well as the exit code; code 5 alone does not establish a provider risk verdict.

## HTTP usage and retry handling

Use the exact paths and body shapes in [OpenAPI](../openapi.json). Common API behavior includes JSON, UUID identifiers, UTC ISO8601 timestamps, integer-string token amounts, rejection of unknown request fields, and a stable machine-readable error code. Do not make authorization decisions from the human-readable message.

Owner intent/subscription lists use limit 1..100 (default 20) and signed opaque cursors bound to owner, endpoint, sort, and limit. Reuse the returned cursor without interpreting it; restart pagination after changing those parameters. Responses include `X-Trace-Id`, and flat errors include `error`, `message`, and `retryable` with trace/resource references where defined.

Agent mutations require `Idempotency-Key` of 8..128 characters. The same key with a different body conflicts. Future connected payment clients must use an intent's returned `payPath` and preserve its fixed quote; 402 is permitted only for a valid payable intent. Verify/screen/reserve checks precede settle. Unknown outcomes use the existing intent and reconciliation, never a new nonce or a second charge.

HTTP 202 means processing, not fulfillment. HTTP 503 means dependency or sale unavailability, not an invitation to bypass policy. HTTP 409 means conflict; 401/403 concern authentication/authorization; 404 can hide an inaccessible resource. Full status/error details live in OpenAPI and the Japanese API contract.

## Human workflow

The intended connected journey is address payment → paid subscription → optional separately paid ENS add-on → request a human approval URL → owner-wallet proof and fresh World login → explicit consent → human destination entry → Agent status check. Basic address rental requires no World approval. ENS is optional for rental, although its connected demo remains a submission requirement.

The browser handles protected human operations with a Secure/HttpOnly session, same-origin checks, CSRF, and version checks. Agents can present the approval URL and observe status; they cannot approve, fill the forwarding address, or retrieve it. World authentication alone does not apply consent. Applied consent survives unchanged-destination lease expiry, while effective mail eligibility remains blocked until same-lease confirmed paid renewal and all other gates pass. Destination changes need a new explicit human approval.

Only approval, an enabled indicator, and human-entered destination storage are in scope. There is no shipment endpoint, postage order, or claim of legal KYC from World login. See [World setup](../world.md), [pricing](../pricing.md), and [admin boundaries](../admin.md) for the corresponding server-enforced rules.
