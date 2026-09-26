# RealAddr for Agents

AIエージェントがx402で実住所の利用区画を契約し、ENSv2名で住所契約を参照し、World IDによる人間承認後に郵便転送設定を有効化するサービス。

## 特徴

- **Agentから使う住所契約**: 共通CLIとHTTP API、wallet認証、所有者向け状態取得を実装しています。
- **ENSv2で契約を参照**: 親名・拠点・契約名のregistry階層、契約別Resolver、初回add-onの名前予約とbindingを設計・実装しています。
- **人間が管理する転送設定**: owner walletとWorld sandbox認証、明示同意、宛先version管理、人間専用フォームを実装しています。
- **永続化と運営画面**: Firestore transaction、決済の冪等性・復旧、Google OIDC管理画面、公開HTMLを備えます。

住所購入・更新・ENS add-onは現在受付を停止しています。郵便のデモは人間承認、有効表示、宛先フォームまでで、実郵便の受領・発送は扱いません。

実装の詳細と接続記録は[実装状況](docs/implementation-status.md)を参照してください。

日本語が仕様の正本です。[ドキュメント案内](docs/README.md)、[English overview](README.en.md)、[English documentation guide](docs/en/README.md)から目的別の資料を参照できます。現況更新: 2026-09-27。

画面は英語を既定とし、「English / 日本語」で切り替えられます。`?lang=en` / `?lang=ja` の明示指定を優先し、指定がない場合はブラウザに保存した選好を表示開始後に復元します。通常の言語切替では入力や認証状態を維持します。採用済み規約の全文は日本語原本を保持し、英語画面でもその旨を案内します。詳細は[フロントエンド仕様](docs/frontend.md)を参照してください。

## 読む順序

1. [要件・受入条件](.kiro/specs/realaddr/requirements.md)
2. [設計・状態遷移・データモデル](.kiro/specs/realaddr/design.md)
3. [外部連携仕様](docs/integrations.md)
4. [API契約](docs/api.md) / [OpenAPI](docs/openapi.json)
5. [実装タスク](.kiro/specs/realaddr/tasks.md)
6. [受入テスト・デモ](docs/acceptance.md)
7. [運用・設定](docs/operations.md) / [開発項目一覧](docs/open-items.md)
8. [一次資料と確認状況](docs/sources.md)
9. [ENSv2連携・住所契約の紐づけ](docs/ensv2.md)
10. [GCP構成・Firestore設計・低コスト運用](docs/infrastructure.md)
11. [画面構成・標準SaaSデザイン](docs/frontend.md)
12. [管理画面・運用者権限](docs/admin.md) / [管理API](docs/admin-openapi.json)
13. [公開ページ・AEO仕様](docs/aeo.md)
14. [料金・ENS追加購入](docs/pricing.md)
15. [event環境の設定値・GitHub Actions投入先](docs/deployment-configuration.md)
16. [利用規約バージョン1](docs/terms.md)（`realaddr-v1`）/ [採用記録と提供準備](docs/terms-review.md)

## 3つの開発エージェントから使う

| ツール | 入口 | 共通の仕様本体 |
| --- | --- | --- |
| Codex | `AGENTS.md` | `.kiro/specs/realaddr/` と `docs/` |
| Claude Code | `CLAUDE.md`から`AGENTS.md`を読み込み | 同上 |
| Kiro | `AGENTS.md`、`.kiro/steering/project.md`、Specs | 同上 |

各ツールに次を渡してください。

```text
AGENTS.mdとREADME.mdから仕様を読み、.kiro/specs/realaddr/tasks.mdの
依存関係に沿って次のタスクを実装してください。
docs/acceptance.mdのハッカソン最小チェックに従い、変更と結果を実装状況へ記録してください。
```

仕様の自動読み込みと、実サービスを利用するエージェントの接続は別です。実装後は3ツールとも同じCLI/HTTP APIを使用し、Worldの公式プラグインが使えないクライアントでもブラウザ承認URLを介して利用できます。

## 公開URLと画面方針

公開originは **https://address.chain.tokyo**。ドメイン/DNS設定はユーザーが担当します。Cloud Runのweb公開とworker非公開を確認済みで、独自ドメインのTLS発行とHTTPS応答も確認済みです。公開サイト、利用者画面、人間承認画面、管理画面は白〜薄いグレーと控えめな青の標準的なSaaSデザインを使用します。公開説明は検索/AI向けにも初期HTMLで配信します。

## スコープ

- Cloud Run（最小instance数0）、Firestore、Cloud Storage、GitHub Actions。非同期処理はCloud Tasks、回復はScheduler。無料枠中心の運用を設計し、完全0円は保証しない。
- 共有GCP projectでは `RESOURCE_PREFIX=realaddr-event` と `FIRESTORE_COLLECTION_PREFIX=realaddr_event_` を使う。`(default)` DB等は共有参照に限定し、Terraform stateへimport・一括管理しない。デプロイ用service accountは保護された設定の`DEPLOY_SERVICE_ACCOUNT`で指定し、所有者・binding・実効権限を事前に確認する。そのaccountの作成・import・削除は本アプリのTerraform対象外とし、限定的なIAM追加は[インフラ仕様](docs/infrastructure.md)に従う。Cloud Run runtime/invoker等のservice accountは専用とする。prefixはIAM境界ではなく、project全体で無料枠/予算を評価する。基盤とCloud Runは独自ドメインHTTPSで公開しています。
- 1拠点につき1〜65,535の仮想区画。住所表記は実際の建物階数と区別する。
- 住所契約は30日ごとにmainnet想定55 USDC、testnet/dev 0.55 USDC（USDC 6 decimalsでそれぞれ55,000,000 / 550,000 atomic）。purchase/renew共通。今回mainnet決済は無効で、test価格をmainnetへ流用しない。
- 安全性判定 → x402決済 → 期間付き住所利用契約の永続保存 → オンチェーン記録。
- World再認証と人間の明示承認 → 「郵便転送可」表示 → 人間が転送先住所を入力・保存。
- 住所利用期間は確定支払いだけで決まり、人間承認では延長しない。宛先を変えない適用済み同意に期限はなく、支払済み契約の期限切れでは利用を停止し、同じ契約の確定更新で再承認なく復帰する。宛先変更には新しい承認が必要で、人間取消・security suspensionを更新で解除しない。
- 今回、実郵便の受領・発送・送料決済は行わない。
- ENS名は希望者が別の明示的な初回ENS add-on決済で購入する。標準名 `f00042.<拠点slug>.<parent>.eth` はmainnet想定10 USDC / testnet-dev 0.10 USDC、custom名 `<customLabel>.<拠点slug>.<parent>.eth` は30 / 0.30 USDC。住所決済では自動付与せず、未購入でも住所利用できる。価格設定欠落やnetwork不整合は販売を拒否する。名前空きと確定見積はCLIで作成するintentが正本。購入済みENSは住所renew料金に期間同期を含む。
- World、Intercepta、MultiBaas、ENSv2の接続結果と失敗経路を画面・監査ログに表示。
- 管理者専用の拠点・契約・決済・同期状況・監査画面。人間の承認や宛先閲覧権限とは分離する。
- 公開HTML、FAQ、開発者向け案内、robots/sitemap/llms.txtと正確な構造化データ。

公開APIは `/v1/locations`、`/v1/payment-intents`、`/v1/subscriptions` を使用します。購入時の `floor` は仮想区画の指定で、省略時は自動割当です。認証・金額・状態遷移を含む正確な契約は[API仕様](docs/api.md)と[OpenAPI](docs/openapi.json)に従います。

料金の金額・購入順序・ENS add-onの制約は[料金仕様](docs/pricing.md)を参照してください。

Curvegridは**Best AI Agent Project**を主対象とする設計です。RWA Tokenizationは追加候補ですが、初回スコープにNFT市場や不動産所有権の表現を追加しません。ENSは**Best Use of ENSv2**も対象とし、親名と上位接続は確認済みで、拠点接続・名前発行の実接続検証を進めています。賞への適合方針は[資料一覧](docs/sources.md)を参照。

## デモ構成

デモはIntercepta screening、Base Sepoliaの住所決済、LeaseRegistry/MultiBaas照会、別途ENS add-on決済とSepolia登録・名前解決、World sandbox承認、人間の宛先保存を一つの流れとして構成します。Firestoreで契約と処理状態を保持し、二重課金・区画重複・人間承認のない転送設定を防ぐ設計です。

Worldのイベント環境は主催者側の模擬proofを利用する旨が告知されています。公式環境への実接続と、本番の本人確認保証は区別します。World IDの認証だけで法的本人確認が完了するとは扱いません。

## ハッカソンのテスト方針

テストは最小限。主要機能の実接続デモと、二重決済・区画重複・未承認操作を防ぐ少数の確認を優先します。手動確認を認め、同じデモ結果を複数の検証に再利用します。網羅的な単体テスト、負荷試験、全面的な障害注入や大規模E2E基盤は今回の必須作業にしません。詳細は[最小チェック](docs/acceptance.md)を参照してください。

## ローカル起動と検証

以下にWindows PowerShell・WSL bash・macOS zsh/bashのコマンドを示します。各OSのnative toolchainを使ってください。WSLではLinux版のNode.js・pnpm・Javaと、contract作業時のforgeを使い、別のLinux checkoutで依存関係を取得してください。Windowsの`node_modules`を流用せず、Windows/Linuxの実行ファイルを混在させないでください。

Node.js 22.21.0、pnpm 11.19.0、Java 21、Firestore Emulator 1.22.0を使用します。依存関係は`pnpm install --frozen-lockfile`で取得します。`.env.example`を未追跡の`.env`に複製し、既存の`.env`は上書きしないでください。`APP_ENV=local`と`GCP_PROJECT_ID=demo-realaddr-local`はローカルEmulator用です。決済には`PAYMENT_ASSET`、`PAYMENT_PAY_TO`等の有効な環境設定が必要です。

公式Firestore Emulator 1.22.0のJARを取得し、`FIRESTORE_EMULATOR_JAR`にそのファイルのパスを設定します。この作業で照合したJARのSHA-256は`9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`です。hashが一致することを確認してから、以下のEmulatorコマンドを別のターミナルで起動します。

Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -Path $env:FIRESTORE_EMULATOR_JAR
java -jar $env:FIRESTORE_EMULATOR_JAR --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

別のWindows PowerShell:

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
$env:VITE_APP_ENV = 'local'
$env:VITE_TERMS_VERSION = 'event-demo-1'
pnpm typecheck
pnpm build
pnpm dev
```

WSL bash:

```sh
sha256sum "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

macOS zsh/bash:

```sh
shasum -a 256 "$FIRESTORE_EMULATOR_JAR"
java -jar "$FIRESTORE_EMULATOR_JAR" --host 127.0.0.1 --port 8085 --project_id demo-realaddr-local --single_project_mode true
```

別のWSL bash / macOS zsh/bash:

```sh
pnpm install --frozen-lockfile
test -e .env || cp .env.example .env
export VITE_APP_ENV=local
export VITE_TERMS_VERSION=event-demo-1
pnpm typecheck
pnpm build
pnpm dev
```

`pnpm dev`はAPIを`http://localhost:8080`で起動します。先にFirestore Emulatorを`127.0.0.1:8085`で起動してください。別のターミナルで`node packages/agent-cli/dist/index.js health --json`、`GET /ready`を確認できます。機械処理でJSONと終了コードを直接読む場合はbuild済みCLIを`node`で起動します。`pnpm agent`はpnpmの表示が標準出力に混ざり、終了コードもpnpm側で変換される場合があります。`/health`はプロセス、`/ready`はEmulator接続を確認します。実施済みチェックは[実装状況](docs/implementation-status.md)に記録します。`pnpm test`は通常の最小チェックです。DB transactionチェックはテスト用プロセスに`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`を設定して実行します。未設定ならそのDBチェックはskipされます。`AGENT_SIGNER_KEY_REF`はGit管理対象外の`.secrets/`内の署名鍵、`AGENT_CREDENTIAL_FILE`は`.credentials/`内のCLI tokenファイルを指すよう設定し、実値をリポジトリへ追加しないでください。

`.env.example`では`CLOUD_TASKS_DISPATCH_ENABLED=false`です。dispatchを有効にできるのは、専用Cloud Tasks queueと同じprojectのworker、verified HTTPS `WORKER_URL`、専用invoke/runtime identitiesを備えた`APP_ENV=event`構成だけです。

Windows PowerShell:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
pnpm --filter @realaddr/db test:emulator
```

WSL bash / macOS zsh/bash:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @realaddr/db test:emulator
```

## テキスト形式とコミット前チェック

すべてのテキストはUTF-8・BOMなし・LFに統一します。`.editorconfig`で編集時、`.gitattributes`でGitの改行処理を設定します。バイナリは対象外です。

以下はWindows PowerShell・WSL bash・macOS zsh/bash共通です。

```text
git config core.hooksPath .githooks
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

初回clone後にhookを有効化してください。Linux/macOSでは必要に応じて `chmod +x .githooks/pre-commit` も実行します。既存hookがある場合は置き換えず検査を統合します。pre-commitはステージ済みの実データを検査し、不正なUTF-8・BOM・CR/CRLFがあればコミットを拒否します。改行の自動変換だけでは文字コードやBOMを保証できないため、検査も必須です。これらはアプリ実装前から利用できるリポジトリ管理用コマンドです。

## 提出前に揃えるもの

起動・テストの実コマンド、公開デモURL、デプロイ情報、コントラクト、各スポンサー呼び出し箇所、チーム紹介・SNS、実測した連携フィードバック。

## ETHGlobalの4つの応募先

| 賞 | 実装の役割・コード入口 |
| --- | --- |
| World — Best Use of World ID for Agents | [fresh OIDC検証](packages/world/src/index.ts#L79)、[人間専用の明示承認](apps/api/src/world.ts#L84)、Agentからの `mail request` |
| ENS — Best Use of ENSv2 | [階層・契約別resolver](contracts/src/RealAddrNameController.sol#L133)、[Universal Resolverとbinding照合](packages/ens/src/index.ts#L209)、開発者ページの名前照合 |
| Curvegrid — Best AI Agent Project | [共通Agent CLI](packages/agent-cli/src/index.ts)、[MultiBaasとfinalized blockの照合](apps/worker/src/registry-reader.ts#L90) |
| Intercepta — Safe Agent-to-Agent Payments with x402 | [Quick Scan呼び出し](packages/intercepta/src/index.ts#L65)、[payTo・payerによる決済準備gate](apps/api/src/payment-screening.ts#L39) |

[フォームに貼る日本語・英語の回答、コード行、デモの順序](docs/submission.md)と[スポンサー別feedback](docs/feedback.md)を用意しています。動作確認の記録と次に接続する処理は[実装状況](docs/implementation-status.md)に集約しています。setup・testingは本READMEと[OS別開発手順](docs/development.md)を参照してください。

### Intercepta feedback

- 認証付きQuick ScanでHTTP 200とschema一致を確認し、一回の成功応答は約1.6秒でした。
- typed adapterで危険trait・未知の応答・通信失敗を、決済準備を止める理由へ変換しました。
- スコアの意味とendpoint別mainnet coverageの説明が、判定policyの確定に必要です。
- 安全・危険の参照例、推奨policy、testnet決済のmainnet照会例をまとめたガイドを提案します。

### MultiBaas feedback

ABI登録・contract link・read-backを確認できました。deployment UIでtransactionが返らずwallet promptが開かないケースでは、署名とreceiptの独立照合を分けて対処しました。transaction生成失敗・署名待ち・結果不明を区別するUIとhistorical block指定例を提案します。

### チーム

チーム: **chain.tokyo**。メンバー: **Masafumi Aida** — [X](https://x.com/masafumiaida)。

### ライセンス

独自コードは[MIT License](LICENSE)で公開します。依存ライブラリと外部由来コードの著作権表示・ライセンスは各配布元の条件を維持します。
