# Development and operations guide

This English guide covers practical workflow and operational boundaries. Japanese [operations](../operations.md), [infrastructure](../infrastructure.md), [deployment configuration](../deployment-configuration.md), and [admin specification](../admin.md) remain authoritative. Execution records are collected in [implementation status](../implementation-status.md). The adopted [terms](../terms.md), `realaddr-v1`, remain the legal text; this guide is not an English terms translation or adoption.

## Local development

Use the [Windows, WSL, and macOS development guide](development.md) for the complete OS-specific setup. The following first block uses Windows PowerShell; the pnpm/Node/Git commands themselves are common to all three environments.

The tested toolchain is Node.js 22.21.0, pnpm 11.19.0, Java 21, and Firestore Emulator 1.22.0. The workspace uses strict TypeScript and pinned dependencies. Install from the lockfile, preserve an existing local `.env`, and keep secrets and credentials untracked.

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:VITE_APP_ENV = 'local'
$env:VITE_TERMS_VERSION = 'event-demo-1'
pnpm typecheck
pnpm build
pnpm dev
```

WSL bash / macOS zsh or bash:

```sh
pnpm install --frozen-lockfile
test -e .env || cp .env.example .env
export VITE_APP_ENV=local
export VITE_TERMS_VERSION=event-demo-1
pnpm typecheck
pnpm build
pnpm dev
```

First obtain and verify the official emulator JAR using the checksum in [README](../../README.md#ローカル起動と検証). Set `FIRESTORE_EMULATOR_JAR` to its protected local reference and run it in another terminal:

```powershell
Get-FileHash -Algorithm SHA256 -Path $env:FIRESTORE_EMULATOR_JAR
java -jar $env:FIRESTORE_EMULATOR_JAR --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

WSL uses `sha256sum "$FIRESTORE_EMULATOR_JAR"`; macOS uses `shasum -a 256 "$FIRESTORE_EMULATOR_JAR"`. Both start Java with `java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true`. Configure that reference within the selected OS.

`pnpm dev` serves the API at `http://localhost:8080`. `/health` checks the process; `/ready` checks database readiness. Local `event-demo-1` authentication is not consent to formal `realaddr-v1` terms.

```powershell
node packages/agent-cli/dist/index.js health --json
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
pnpm --filter @realaddr/db test:emulator
pnpm test
```

For WSL/macOS, replace the PowerShell emulator assignment with `export FIRESTORE_EMULATOR_HOST=127.0.0.1:8085` before the same Node/pnpm commands.

Database checks are skipped if the emulator variable is absent. Build the CLI before using its `dist` entry. Use the direct Node entry when consuming JSON and exit codes; `pnpm agent` can add wrapper output or alter process exit handling. See the [API guide](api.md) for supported commands.

## Configuration and secrets

Use `.env.example` as the local non-secret configuration contract and the Japanese [deployment configuration](../deployment-configuration.md) for protected event inputs. Never invent provider endpoints, token addresses, SDK methods, finality, or deployment identities. Missing or mismatched payment/security settings keep sale disabled.

| Boundary | Required contract |
| --- | --- |
| Event storage | `FIRESTORE_DATABASE_ID=realaddr`, `FIRESTORE_COLLECTION_PREFIX=realaddr_event_` |
| Dedicated resource names | `RESOURCE_PREFIX=realaddr-event` |
| Public origin | `PUBLIC_ORIGIN=https://address.chain.tokyo` |
| Event terms/build | `TERMS_VERSION=realaddr-v1`, `VITE_APP_ENV=event`, `VITE_TERMS_VERSION=realaddr-v1` |
| Payment profile | Reviewed Base Sepolia token, six decimals, fixed price, recipient, facilitator, and receipt/finality configuration |
| Human/operator support | Explicit enable flags, separate callbacks, sessions, and web-only secret references |

The named `realaddr` database must exist and be reachable. Never fall back to `(default)`. Every business, admin, guard, and outbox collection uses the prefix mapper; a collection prefix is not an IAM security boundary. Event/production must reject emulator configuration. Secret payloads do not belong in Terraform variables, state, plans, browser `VITE_` variables, or ordinary logs. Retain encryption-key versions required by existing ciphertext and rollback.

## Shared GCP and deployment

The infrastructure separates web, worker, Cloud Tasks invoker, and Scheduler invoker identities. It uses dedicated resources, repository-restricted WIF, immutable images, and Cloud Run with minimum instances zero. Default service accounts and service account keys are not fallbacks. Scale to zero reduces cost; it does not guarantee a zero bill.

Before changes, inventory live ownership, names, database placement, IAM, Rules, indexes, and effective deploy permissions. Manage only this application's named database, deny-all client Rules, prefixed indexes, and owned resources. Enable database delete protection and Terraform `prevent_destroy`. Do not import or manage shared `(default)` resources, replace project IAM, or manage project APIs/budgets wholesale.

Select the existing deploy account through protected `DEPLOY_SERVICE_ACCOUNT`. Its lifecycle remains outside this Terraform state. Preserve other bindings and add only reviewed resource-scoped grants and the narrow WIF impersonation member. Runtime IAM tests and client Rules denial are separate gates: server SDK access bypasses Rules.

Use [infra procedures](../../infra/README.md) for `infra/bootstrap`, `infra/app`, protected state, and the manual event workflow. Ordinary deploy applies one immutable digest to worker and web and verifies both afterward; partial deployment requires deliberate recovery or rollback. `image-only` builds/pushes an image and does not deploy it. Domain/DNS configuration belongs to the user.

The event uses public HTTPS web, a private worker, and the dedicated named database. Cloud Tasks dispatch remains disabled and Scheduler paused. Provider activation is controlled separately from image publication.

## Operators and locations

Operators use `/admin`, Google OIDC, a dedicated session, and an active Firestore operator principal. Agent tokens and World human sessions grant no admin access. See the [admin OpenAPI](../admin-openapi.json) for the sole admin HTTP schema and [admin setup](../admin.md) for protected bootstrap.

The event operator login and paused-location creation have been confirmed. Location creation always starts paused, fixes slots at 1..65535, and derives the plan server-side. Operators enter authorized location information through the form; actual addresses are not repository seeds. Editing uses version checks, idempotency, reasons, and atomic audit records. Resuming requires explicit publication confirmation and ready address/payment dependencies. Current missing payment/risk integration prevents resumption. ENS namespace readiness gates the optional add-on separately.

The admin UI provides bounded summaries of locations, payments, subscriptions, operations, and audit entries. It cannot expose forwarding destinations, approve human consent, manually mark payment successful, or force ENS verification. Read reconciliation execution remains unavailable. Do not clear uncertain holds or retry payments merely to remove a pending indicator.

## Verification and repository hygiene

Use task IDs from [tasks](../../.kiro/specs/realaddr/tasks.md) and the [minimum acceptance gate](../acceptance.md). A-01..A-49 is a scenario catalog, not a requirement to automate every case. Code changes need build/typecheck and relevant focused checks; document-only edits need text-format and diff review. Record test commands and manual operations with their results. The submission demo uses connected services.

All text is UTF-8 without BOM and uses LF. Preserve existing hooks by integrating rather than replacing their checks, then enable the tracked hook where appropriate:

```sh
git config core.hooksPath .githooks
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

Check the actual staged content before committing. Never put external account identifiers, deployment identities, private paths, secrets, raw authentication/payment evidence, or forwarding destinations in repository documents, comments, examples, or commit messages.
