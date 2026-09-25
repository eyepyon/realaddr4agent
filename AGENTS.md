# Project instructions

## Scope and source of truth

Build RealAddr for Agents from the shared specification. This repository initially contains specifications only; do not claim that the product already runs.

Read `README.md`, then `.kiro/specs/realaddr/requirements.md`, `design.md`, and `tasks.md`. Read the relevant files in `docs/` before implementing an integration or API. ENSv2 and address-binding details are in `docs/ensv2.md`. GCP infrastructure, Firestore transactions, scale-to-zero execution and cost limits are defined in `docs/infrastructure.md`. Frontend conventions are in `docs/frontend.md`, operator authorization in `docs/admin.md` and `docs/admin-openapi.json`, and public discovery/AEO in `docs/aeo.md`. The requirements define behavior; the design defines implementation; `docs/openapi.json` defines public HTTP shapes. Resolve contradictions explicitly and update all affected files together.

When consulting user-designated private reference implementations, keep their names, local paths, URLs, account identifiers and provenance out of repository documents, source comments, examples and commit messages. Record only the adopted behavior and this project's own configuration; do not copy secrets or deployment identities.

## Non-negotiable invariants

- A building has virtual slots 1..65535; zero is invalid. Never present them as physical floors.
- A confirmed payment activates at most one order. A slot belongs to at most one current lease/hold.
- Do not settle payment before screening and reserve checks. Basic address rental does not require World approval.
- World OIDC authentication is not consent or legal KYC by itself. Bind mail.enable approval to the owner-wallet proof, World human, agent, lease version, policy, nonce, and expiry.
- Never replace live sponsor calls with fake successes. Missing or unknown security verdicts hold the action.
- Never put private keys, World secrets, API keys, identity documents, or mail contents in prompts, client bundles, chain events, or ordinary logs.
- Business state and retry jobs must persist in Firestore. Use atomic transactions and deterministic uniqueness guards. Never execute external effects inside a retried transaction callback; reconcile uncertain outcomes before retrying.
- The GCP project is shared. Use `RESOURCE_PREFIX=realaddr-event` for dedicated resource names and `FIRESTORE_COLLECTION_PREFIX=realaddr_event_` for every logical collection, including admin, guard, and outbox collections. A Firestore name prefix is not an IAM boundary. Reuse an existing `(default)` database only as a shared reference when needed; do not import it into this app's Terraform state or manage its database, rules, indexes, project IAM, project APIs, or budgets wholesale. Narrow additive IAM grants for this app's dedicated service accounts are allowed; do not replace shared policy bindings or remove other principals' grants. Never overwrite or delete shared resources. Index changes may target only this app's prefixed collection groups. Confirm live ownership and inventory before using any apparently unused name.
- Implement server-side authorization; prompts, client UI and agent instructions are not security controls.

- Address purchase and renewal cost 55 USDC per 30 days on future mainnet and 0.55 USDC on testnet/dev; validate 6 decimals and network/price-profile consistency. This does not authorize mainnet operation. Read `docs/pricing.md`.
- ENSv2 is an optional, separately paid, one-time add-on per lease. Standard floor names cost 10 USDC on future mainnet and 0.10 USDC on testnet/dev; custom names cost 30 and 0.30 USDC respectively, not the sum of both tiers. Do not register names on address purchase alone. Missing or mismatched configuration disables sale. After purchase, ENS maintenance is included in address renewals; retries and same-lease recovery never incur another add-on charge. The ENS feature remains required for the submission demo.
- ENS names use `f00042.<location-slug>.<parent>.eth` by default, or an eligible custom label under the same location namespace. Build the actual parent/location/name registry hierarchy. Reserve canonical names atomically with the quote, freeze the selected name and price, and retain reservations during uncertain payments. Never reuse paid names for another lease or offer post-purchase renames in v1.
- ENSv2 runs on Sepolia and uses a dedicated resolver per purchased ENS add-on. Keep forwarding destinations and World identifiers off ENS. Validate exact registration, controller binding, lease state and expiry; a text record alone proves no entitlement.
- Hackathon mail scope is only human approval, an enabled indicator, and a human-entered destination form. Do not build physical mail handling, shipping, or postage payments.
- Agent credentials must never approve human actions or write/read the full forwarding address.
- Admin access is a separate operator session. It cannot substitute for World consent, expose forwarding destinations, or manually mark payments successful.
- Use https://address.chain.tokyo as the planned public origin. The user manages domain/DNS configuration; do not change DNS or claim deployment without evidence.
- Use a conventional white/light-gray SaaS UI with restrained blue accents. Serve public informational pages as crawlable HTML; never include private account/admin data in AEO assets.

## Model routing and delegation

User preference: delegate work that does not require Astra to Sol, Luna, Terra, or another suitable lower-cost model. Apply this policy to future work in this repository. Delegation is explicitly authorized; do not request permission for each assignment.

- Luna: bounded searches, extraction, formatting, simple documentation updates, and routine checks.
- Sol: ordinary implementation, debugging, tests, technical research, and integration work with clear requirements.
- Terra: straightforward analysis, specification organization, and routine reviews when suitable.
- Astra: complex architecture, difficult unresolved problems, security-critical judgment, and integration decisions that need its capabilities. Do not use Astra for routine execution merely because it is the parent model.
- Give each delegate a concrete scope, relevant context, owned files, and acceptance criteria. Specify an available model explicitly rather than inheriting Astra. Use focused context when a model override requires it.
- Parallelize independent work when useful; avoid overlapping edits and redundant agents. Check delegated evidence before accepting the result. Escalate only when complexity, failures, or risk justify it.
- Follow the host's delegation constraints. If model selection or delegation is unavailable, disclose that limitation rather than claiming another model performed the work. This file does not change the selected model or global settings of other conversations.

## Delivery workflow

Use the task IDs in `.kiro/specs/realaddr/tasks.md`. Check a task only after evidence for its implemented behavior exists; the A-01..A-49 list is a scenario catalog, not a requirement to automate or execute every case before the hackathon submission. Follow the minimum gate in `docs/acceptance.md`, then add targeted checks when a change introduces a concrete risk. Record tests actually run, deferred coverage and unresolved blockers in `docs/implementation-status.md` when implementation starts. Keep sandbox, testnet and production labels visible. Do not silently broaden scope into NFT trading or automated legal adjudication. Authorized chain split: Base Sepolia for x402 payments, Ethereum Sepolia for ENSv2 and lease attestations; no bridge or additional payment chain.

Use TypeScript strict mode and a pnpm workspace as specified. Pin tested dependency versions at bootstrap; never invent a version or provider SDK method. The commands in the specification are target command contracts until implemented. Keep automated checks small: build/typecheck and focused database checks for slot uniqueness, payment retry/unknown outcomes, and human-only mail approval/access. For submission, run one connected sponsor/ENS happy path and representative denial, with brief CLI smoke checks from all three tools. Record manual steps and real external responses; do not replace a required live connection with a mock.

All text files must use UTF-8 without BOM and LF line endings. Follow `.editorconfig` and `.gitattributes`; binary assets are exempt. Before committing, run `node scripts/check-text-format.mjs` for working files and `node scripts/check-text-format.mjs --staged` for the actual staged content. Do not bypass failed checks or silently transcode unknown encodings. Enable the tracked pre-commit hook with `git config core.hooksPath .githooks` on each clone, preserving any existing hook setup by integrating the check instead of overwriting it. These checks also apply when generating or updating documentation and configuration.

Japanese is the primary specification language; identifiers and machine contracts use English. Preserve requirement/test/task IDs when editing. Do not create duplicated specifications for different coding tools. Use ordinary files, not symlinks, for Windows compatibility.
