# Windows・WSL・macOSの開発手順

英語版: [Development guide](en/development.md)。これは既存commandのOS別利用案内であり、新しい実装や外部接続成功を意味しない。Windowsでの実施記録は[実装状況](implementation-status.md)を参照。**このローカル手順のWSL/macOSでの手動実行は未検証であり、Linux CIの検証とは別である。** 外部連携・公開・管理の設定契約は[運用](operations.md)、[event設定](deployment-configuration.md)、[インフラ](infrastructure.md)を正本とする。

## ツールと作業領域

検証済みtoolchainはNode.js 22.21.0、pnpm 11.19.0、Java 21、Firestore Emulator 1.22.0。contract作業にはFoundry 1.7.1、Solidity 0.8.30、OpenZeppelin Contracts 5.4.0、インフラ作業にはTerraform 1.14.6、Google provider 8.4.0を使用する。runtime/toolは対象OS向けに準備し、依存はlockfileから取得する。SDK methodや未確認versionを推測しない。

WindowsはPowerShell、WSLはLinux内のbash、macOSはzsh/bashでrepository rootから実行する。WSLではLinux側のcloneとNode/Java/pnpmを使い、Windowsの`node_modules`を共有しない。macOSでもその環境で依存を導入する。鍵・credential・保護manifestは環境ごとに権限を確認して別途用意し、WSLからWindowsの保護credentialを流用する前提にしない。下記の`*_FILE`・`*_KEY_REF`・JAR参照は、そのOSで利用できるローカル参照へ設定する。実pathや値をrepositoryへ書かない。

## 依存・設定・build

Windows/WSL/macOS共通:

```sh
pnpm install --frozen-lockfile
```

Windows PowerShell（既存`.env`を保持）:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:VITE_APP_ENV = 'local'
$env:VITE_TERMS_VERSION = 'event-demo-1'
pnpm typecheck
pnpm build
```

WSL bash / macOS zsh・bash:

```sh
test -e .env || cp .env.example .env
export VITE_APP_ENV=local
export VITE_TERMS_VERSION=event-demo-1
pnpm typecheck
pnpm build
```

`.env.example`は秘密なしのlocal設定契約。`.env`は未追跡のまま保持する。local demo規約versionは正式`realaddr-v1`同意へ読み替えない。eventでは正式version、HTTPS origin、専用named DBと保護設定を別途要求する。secretを`VITE_`変数へ渡さない。

## Firestore Emulatorと起動

公式Emulator JARを別途取得し、`FIRESTORE_EMULATOR_JAR`へOS固有の参照を設定する。検証済み1.22.0のSHA-256は`9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`。照合してから別terminalで起動する。

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

macOS zsh・bash:

```sh
shasum -a 256 "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

別terminalでWindows/WSL/macOS共通:

```sh
pnpm dev
```

APIは`http://localhost:8080`。同じOS内でEmulatorを`127.0.0.1:8085`へ起動する。`/health`はprocess、`/ready`はDB準備の確認で、スポンサー接続や販売可否を保証しない。build済みCLIのJSON/終了codeを直接読む場合は共通commandを使う:

```sh
node packages/agent-cli/dist/index.js health --json
```

## 最小チェックとテキスト形式

Windows/WSL/macOS共通:

```sh
pnpm typecheck
pnpm build
pnpm test
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

DB重点チェックはEmulatorを起動してから実行する。変数未設定時はDBチェックがskipされる。

Windows PowerShell:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
pnpm --filter @realaddr/db test:emulator
```

WSL bash / macOS zsh・bash:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @realaddr/db test:emulator
```

textはUTF-8/BOMなし/LF。既存hookを上書きせずcheckを統合し、cloneごとに`git config core.hooksPath .githooks`を設定する（3 OS共通）。WSL/macOSでは必要に応じ`chmod +x .githooks/pre-commit`も行う。実staged内容の検査を省略しない。実施・未実施とblockerは[実装状況](implementation-status.md)、最小gateは[受入](acceptance.md)へ従う。

## Contract・CLI・運用script

contract build/test/exportは対象OSのFoundryを準備して実行する。Windows PowerShell:

```powershell
Push-Location contracts
forge build
forge test
Pop-Location
node scripts/export-lease-registry.mjs
```

WSL bash / macOS zsh・bash:

```sh
(cd contracts && forge build && forge test) && node scripts/export-lease-registry.mjs
```

build/exportはdeploy証拠ではない。[LeaseRegistry](lease-registry.md)・[ENS](ensv2.md)のchain・artifact・人間署名・独立照合gateを守る。CLI/Node helperのcommand自体は3 OS共通だが、引数/環境変数の値は環境ごとに準備する。PowerShellは`$env:KEY = 'value'`、WSL/macOSは`export KEY=value`。secret値をshell履歴に書かず保護された注入方式を使う。

`scripts/gcp-inventory.ps1`の実行検証済み環境はWindows。WSL/macOSではPowerShell 7 (`pwsh`)とnative `gcloud`を準備し、対象OSの認証・保護path・権限を別途確認する必要がある。これらの環境での手順は未実行であり、同等POSIX scriptはない。[inventory手順](gcp-inventory.md)のOS別読み取り呼出例と保護入力の条件に従う。その他PowerShell手順をそのまま実行する場合もPowerShell 7が必要で、実行可能性だけを検証成功とは扱わない。Terraformの対象platform/checksum・protected backend条件は[infra README](../infra/README.md)を確認し、未検証macOS packageやlive apply成功を仮定しない。
