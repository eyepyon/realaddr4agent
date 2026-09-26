# Development on Windows, WSL, and macOS

Japanese source: [development guide](../development.md). These instructions describe existing commands, not new implementation or evidence of live integrations. See [implementation status](../implementation-status.md) for Windows verification. **Manual execution of these local procedures on WSL/macOS remains unverified; Linux CI verification is separate.** [Operations](../operations.md), [deployment configuration](../deployment-configuration.md), and [infrastructure](../infrastructure.md) define the operational contracts.

## Tools and workspace

The tested toolchain is Node.js 22.21.0, pnpm 11.19.0, Java 21, and Firestore Emulator 1.22.0. Contract work uses Foundry 1.7.1, Solidity 0.8.30, and OpenZeppelin Contracts 5.4.0. Infrastructure uses Terraform 1.14.6 and Google provider 8.4.0. Prepare tools for the target OS and install dependencies from the lockfile; do not guess SDK methods or unverified versions.

Run from the repository root in Windows PowerShell, WSL bash, or macOS zsh/bash. In WSL, use a Linux-side clone and Linux Node/Java/pnpm; do not share Windows `node_modules`. Install dependencies independently on macOS too. Prepare keys, credentials, and protected manifests separately with appropriate permissions. WSL does not assume access to Windows protected credentials. File/key/JAR references must resolve in the selected OS; keep actual paths and values out of repository documents.

## Dependencies, configuration, and build

Common to Windows, WSL, and macOS:

```sh
pnpm install --frozen-lockfile
```

Windows PowerShell, preserving an existing `.env`:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:VITE_APP_ENV = 'local'
$env:VITE_TERMS_VERSION = 'event-demo-1'
pnpm typecheck
pnpm build
```

WSL bash / macOS zsh or bash:

```sh
test -e .env || cp .env.example .env
export VITE_APP_ENV=local
export VITE_TERMS_VERSION=event-demo-1
pnpm typecheck
pnpm build
```

Keep `.env` untracked; `.env.example` defines non-secret local settings. Local demo terms acceptance does not establish acceptance of adopted `realaddr-v1`. Event configuration separately requires formal terms, HTTPS origin, the dedicated named database, and protected inputs. Never inject secrets into `VITE_` variables.

## Firestore Emulator and startup

Obtain the official emulator JAR separately and set `FIRESTORE_EMULATOR_JAR` to an OS-local reference. The verified 1.22.0 SHA-256 is `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`. Check it before starting the emulator in another terminal.

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -Path $env:FIRESTORE_EMULATOR_JAR
java -jar $env:FIRESTORE_EMULATOR_JAR --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

WSL bash:

```sh
sha256sum "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

macOS zsh or bash:

```sh
shasum -a 256 "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

In another terminal, common to all three OS environments:

```sh
pnpm dev
```

The API runs at `http://localhost:8080`; run the emulator within the same OS environment at `127.0.0.1:8085`. `/health` checks the process and `/ready` checks database readiness. Neither proves sponsor integration or sale readiness. After building, use the direct CLI entry for JSON and exit-code consumption on all three OS environments:

```sh
node packages/agent-cli/dist/index.js health --json
```

## Focused checks and text format

Common to Windows, WSL, and macOS:

```sh
pnpm typecheck
pnpm build
pnpm test
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

Start the emulator before database checks. Without the emulator variable, those checks are skipped.

Windows PowerShell:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
pnpm --filter @realaddr/db test:emulator
```

WSL bash / macOS zsh or bash:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @realaddr/db test:emulator
```

All text must be UTF-8 without BOM and use LF. Integrate the check with existing hooks instead of overwriting them, then use `git config core.hooksPath .githooks` on each clone (same command on all three OS environments). WSL/macOS may also need `chmod +x .githooks/pre-commit`. Check actual staged content before committing. Follow the [minimum acceptance gate](../acceptance.md), recording actual checks, deferred coverage, and blockers in [implementation status](../implementation-status.md).

## Contracts, CLI, and operational scripts

Prepare Foundry for the target OS. Windows PowerShell:

```powershell
Push-Location contracts
forge build
forge test
Pop-Location
node scripts/export-lease-registry.mjs
```

WSL bash / macOS zsh or bash:

```sh
(cd contracts && forge build && forge test) && node scripts/export-lease-registry.mjs
```

Build/export does not prove deployment. Follow [LeaseRegistry](../lease-registry.md) and [ENSv2](../ensv2.md) for chain, artifact, human signing, and independent verification gates. CLI and Node helper commands have the same syntax across the three OS environments; prepare their arguments and environment references independently. PowerShell uses `$env:KEY = 'value'`; WSL/macOS use `export KEY=value`. Inject secrets through protected mechanisms rather than shell history.

`scripts/gcp-inventory.ps1` has been execution-verified on Windows. WSL/macOS require PowerShell 7 (`pwsh`), native `gcloud`, and separate checks of OS-local authentication, protected paths, and permissions. Those procedures have not been executed, and no equivalent POSIX script exists. Follow the OS-specific read-only invocation examples and protected-input requirements in the [inventory guide](../gcp-inventory.md). Other PowerShell-only instructions also require PowerShell 7; apparent executability is not verified success. Check platform checksums and protected-backend requirements in [infra README](../../infra/README.md), and do not assume unverified macOS packages or successful live apply.
