# RealAddr for Agents

[日本語](README.md) · [English documentation](docs/en/README.md)

RealAddr lets an AI agent rent a virtual slot at an operator-provided real address, optionally purchase an ENSv2 name for its lease, and ask its owner to approve a mail-forwarding configuration through World authentication. Slots are numbered 1–65,535; they are service allocations, never physical floors. The hackathon scope ends at human approval, an enabled indicator, and a human-entered destination form. It does not include receiving or shipping mail, postage payments, property ownership, or NFT trading.

## Features

- **Agent address contracts:** a shared CLI/HTTP interface, wallet authentication and owner-scoped state reads.
- **ENSv2 lease references:** registry hierarchy, per-lease resolvers, add-on name reservations and binding logic.
- **Human-controlled forwarding configuration:** owner-wallet proof, World sandbox authentication, explicit consent, destination versions and a human-only form.
- **Persistent state and operations:** Firestore transactions, payment idempotency/recovery, a Google OIDC operator screen and crawlable public HTML.

Address purchases, renewals and ENS add-ons are currently closed. Implementation details and connection records are collected in [implementation status](docs/en/implementation-status.md).

Japanese requirements and design remain authoritative. This English guide is a reader-facing companion, not a second specification. Public and operator HTTP shapes are defined by [public OpenAPI](docs/openapi.json) and [admin OpenAPI](docs/admin-openapi.json). Detailed specifications not yet translated are linked with a Japanese label.

Screens default to English and offer an “English / 日本語” switch. An explicit `?lang=en` or `?lang=ja` takes priority; otherwise the browser restores the saved preference after hydration. Switching language in place preserves form input and authentication state. The adopted terms remain in their Japanese original, clearly identified on English screens. See the [frontend contract (Japanese)](docs/frontend.md).

## Product flow and boundaries

The intended flow is screening and reservation checks → confirmed x402 payment → persistent address lease → Sepolia lease attestation. ENS is an optional, separately paid, one-time add-on: address purchase alone must not register a name. Its hierarchy is an actual parent registry → location registry → purchased name, with a dedicated resolver per add-on. A text record alone is not proof of entitlement.

Payments use **Base Sepolia** (`eip155:84532`). ENSv2 and lease attestations use **Ethereum Sepolia** (`eip155:11155111`). There is no bridge or additional payment chain. Mainnet operation is not authorized.

| Item | Testnet/dev | Future mainnet pricing |
| --- | ---: | ---: |
| Address purchase or renewal, 30 days | 0.55 USDC | 55 USDC |
| Standard ENS name, one-time add-on | 0.10 USDC | 10 USDC |
| Custom ENS name, one-time add-on | 0.30 USDC | 30 USDC |

USDC must have 6 decimals; network, asset, and price profile must agree. Custom pricing replaces the standard tier rather than adding to it. Purchased ENS maintenance is included in address renewals; retries and same-lease recovery do not charge again. Missing or mismatched settings close sales. Standard names follow `f00042.<location-slug>.<parent>.eth`; v1 does not offer post-purchase renames. See [pricing (Japanese)](docs/pricing.md).

Basic address rental does not require World approval. World OIDC authentication alone is neither consent nor legal KYC. Human approval binds a specific request to the owner-wallet proof, World human, agent, lease version, policy, nonce, destination version, and short request expiry. Applied consent has no time limit for the unchanged destination. Lease expiry suspends effective eligibility while retaining consent; a confirmed paid renewal/revival of the same lease restores eligibility. Destination changes need fresh explicit approval, and renewal never overrides human disable or a security suspension. Agents cannot approve human actions or read/write the full destination; operators cannot substitute for consent or manually mark a payment successful.

One confirmed payment activates at most one order, and one slot has at most one current lease/hold. Unknown security or payment outcomes remain on hold. Business state, uniqueness guards, and retry jobs persist in Firestore; external effects do not run inside retried transaction callbacks.

## Implementation and deployment

The pnpm workspace uses strict TypeScript, React/Vite, Fastify, Firestore, and a shared agent CLI. Cloud Run serves the web/API and a private HTTP worker; Cloud Tasks dispatches work and Scheduler drives recovery. Dependencies are pinned in package manifests and the lockfile. [Architecture](docs/en/architecture.md) explains the package and trust boundaries.

The configured public origin is [https://address.chain.tokyo](https://address.chain.tokyo). The public web service is served over HTTPS, with a separate private worker. The user manages domain/DNS configuration. The GCP project is shared: dedicated resources use `RESOURCE_PREFIX=realaddr-event`, every logical collection uses `FIRESTORE_COLLECTION_PREFIX=realaddr_event_`, and runtime uses the named `realaddr` database. It must fail closed when that database is unavailable, with no `(default)` fallback. A collection prefix is not an IAM boundary.

## Demo flow

The demo is structured around Intercepta screening, a Base Sepolia address payment, LeaseRegistry/MultiBaas reads, a separately paid ENS add-on and Sepolia issuance/resolution, World sandbox approval, and a human destination save/read. Firestore preserves contracts and operation state, with transaction and authorization rules designed to prevent duplicate charges, slot conflicts and forwarding configuration without human approval.

## Run locally

Recorded toolchain: Node.js 22.21.0, pnpm 11.19.0, Java 21, Firestore Emulator 1.22.0. Install the official emulator JAR and set `FIRESTORE_EMULATOR_JAR` outside tracked files. Its recorded SHA-256 is `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`; verify it before use.

The following commands cover Windows PowerShell, WSL bash and macOS zsh/bash. Use each OS's native toolchain. In WSL, use Linux Node.js, pnpm, Java and, for contract work, forge. Use a separate Linux checkout/dependency installation; do not reuse Windows `node_modules` or mix Windows and Linux executables.

Windows PowerShell: start the emulator in one terminal:

```powershell
Get-FileHash -Algorithm SHA256 -Path $env:FIRESTORE_EMULATOR_JAR
java -jar $env:FIRESTORE_EMULATOR_JAR --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

In another Windows PowerShell terminal:

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:VITE_APP_ENV = 'local'
$env:VITE_TERMS_VERSION = 'event-demo-1'
pnpm typecheck
pnpm build
pnpm dev
```

WSL bash: verify and start the emulator in one terminal:

```bash
sha256sum "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

macOS zsh/bash: verify and start the emulator in one terminal:

```sh
shasum -a 256 "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

In another WSL bash or macOS zsh/bash terminal:

```sh
pnpm install --frozen-lockfile
test -e .env || cp .env.example .env
export VITE_APP_ENV=local
export VITE_TERMS_VERSION=event-demo-1
pnpm typecheck
pnpm build
pnpm dev
```

Keep existing local configuration intact. `.env.example` describes the configuration contract; payments require valid network, asset and destination settings. `pnpm dev` starts the API on loopback port 8080. `/health` checks the process; `/ready` checks database connectivity. After building, `node packages/agent-cli/dist/index.js health --json` gives direct CLI JSON/exit-code output. `pnpm agent` is convenient interactively, but pnpm can add output and change exit-code handling.

The existing focused checks on Windows PowerShell are:

```powershell
pnpm test
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
pnpm --filter @realaddr/db test:emulator
node scripts/check-text-format.mjs
```

WSL bash / macOS zsh/bash:

```sh
pnpm test
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @realaddr/db test:emulator
node scripts/check-text-format.mjs
```

Database checks skip when the emulator host is not set. Follow [acceptance (Japanese)](docs/acceptance.md) for the submission gate: focused database and authorization checks, one connected sponsor/ENS happy path, representative denials, persistence recovery, and short common-CLI checks from Codex, Claude Code, and Kiro. A-01–A-49 are a scenario catalog, not a requirement to automate every case.

All text files use UTF-8 without BOM and LF. Enable `.githooks` after cloning, preserving an existing hook setup by integrating the check. Before committing, run both `node scripts/check-text-format.mjs` and `node scripts/check-text-format.mjs --staged`.

Common commands for Windows PowerShell, WSL bash and macOS zsh/bash:

```text
git config core.hooksPath .githooks
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

On WSL/macOS, use `chmod +x .githooks/pre-commit` if the hook is not executable.

## Read next

- [English guide index](docs/en/README.md), [architecture](docs/en/architecture.md), and [implementation status](docs/en/implementation-status.md)
- [Requirements (Japanese)](.kiro/specs/realaddr/requirements.md), [design (Japanese)](.kiro/specs/realaddr/design.md), and [task IDs (Japanese)](.kiro/specs/realaddr/tasks.md)
- [API (Japanese)](docs/api.md), [integrations (Japanese)](docs/integrations.md), [ENSv2 (Japanese)](docs/ensv2.md), and [World (Japanese)](docs/world.md)
- [Infrastructure (Japanese)](docs/infrastructure.md), [operations (Japanese)](docs/operations.md), [operator authorization (Japanese)](docs/admin.md), and [open items (Japanese)](docs/open-items.md)

Codex, Claude Code, and Kiro share `AGENTS.md`, the specifications, and the same CLI/HTTP contract. Follow task dependencies and the hackathon acceptance gate when implementing the next task.
