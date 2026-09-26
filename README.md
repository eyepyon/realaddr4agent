# RealAddr for Agents

AIエージェントがx402で実住所の利用区画を契約し、ENSv2名で住所契約を参照し、World IDによる人間承認後に郵便転送設定を有効化するサービス。

## 現在の状態

仕様と部分実装を公開しています。event環境の公開HTTPS、専用named Firestore `realaddr`、公開ページ、所有者向け状態取得、管理画面を確認済みです。購入・更新の公開mutationと実決済は未接続で、販売を停止しています。mainnet運用は対象外です。

| 項目 | 確認済み | 残る接続・検証 |
| --- | --- | --- |
| GCP・管理 | 公開HTTPS、runtime IAM、named DB、管理ログインの本人報告、停止中拠点の登録 | Tasks/Schedulerの実OIDC配信、実Firebase利用者clientのRules試験 |
| 住所契約・決済 | DB予約・一意性・不明決済の保持・確認済みreceiptからの復旧をローカル検証 | Base Sepoliaのx402実決済、公開pay、署名器 |
| LeaseRegistry・MultiBaas | Sepolia配備、独立RPC検証、MultiBaas read-only照合 | 実lease記録・取消、eventのworker有効化、indexed events/reorg回復 |
| Intercepta | 認証付きQuick ScanのHTTP 200・schema一致 | 安全policy・chain coverageが未確定のためhold。公開pay・署名器未接続 |
| World sandbox | OIDC・人間専用承認フォームをevent配備、未認証・Agent拒否 | live認証・token交換、実paid leaseでの明示同意・宛先保存 |
| ENSv2 | 親名、上位registry接続、NameControllerのreceipt・runtime・権限・最終確定を独立検証。永続buildingKey保存と拠点5操作helperを準備 | 拠点署名操作の完了検証、公式解決、paid leaseの名前発行。`namespaceReady=false`・販売停止を維持 |

最新の証拠、実行した検査と履歴は[実装状況](docs/implementation-status.md)、残件は[未解決事項](docs/open-items.md)を参照してください。ローカルfixtureや署名helperの起動を外部接続の完了とは扱いません。郵便のデモは人間承認、有効表示、宛先フォームに限定します。

日本語が仕様の正本です。[ドキュメント案内](docs/README.md)、[English overview](README.en.md)、[English documentation guide](docs/en/README.md)から目的別の資料を参照できます。現況更新: 2026-09-27。

## 読む順序

1. [要件・受入条件](.kiro/specs/realaddr/requirements.md)
2. [設計・状態遷移・データモデル](.kiro/specs/realaddr/design.md)
3. [外部連携仕様](docs/integrations.md)
4. [API契約](docs/api.md) / [OpenAPI](docs/openapi.json)
5. [実装タスク](.kiro/specs/realaddr/tasks.md)
6. [受入テスト・デモ](docs/acceptance.md)
7. [運用・設定・未確定事項](docs/operations.md) / [未解決事項一覧](docs/open-items.md)
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
依存関係を満たす最初の未完了タスクを実装してください。
検証はdocs/acceptance.mdのハッカソン最小チェックを基準に、変更に関係する項目だけ行ってください。
網羅テストや全49ケースの自動化は不要です。未実施は未実施と記録してください。
外部APIの未確認部分を捏造せず、実接続できない項目はBLOCKEDとして記録し、
独立して進められる作業を続けてください。
```

仕様の自動読み込みと、実サービスを利用するエージェントの接続は別です。実装後は3ツールとも同じCLI/HTTP APIを使用し、Worldの公式プラグインが使えないクライアントでもブラウザ承認URLを介して利用できます。

## 公開URLと画面方針

公開originは **https://address.chain.tokyo**。ドメイン/DNS設定はユーザーが担当します。Cloud Runのweb公開とworker非公開を確認済みで、独自ドメインのTLS発行とHTTPS応答も確認済みです。公開サイト、利用者画面、人間承認画面、管理画面は白〜薄いグレーと控えめな青の標準的なSaaSデザインを使用します。公開説明は検索/AI向けにも初期HTMLで配信します。公開到達性は、未接続の購入・決済機能の利用開始を意味しません。

## スコープ

- Cloud Run（最小instance数0）、Firestore、Cloud Storage、GitHub Actions。非同期処理はCloud Tasks、回復はScheduler。無料枠中心の運用を設計し、完全0円は保証しない。
- 共有GCP projectでは `RESOURCE_PREFIX=realaddr-event` と `FIRESTORE_COLLECTION_PREFIX=realaddr_event_` を使う。`(default)` DB等は共有参照に限定し、Terraform stateへimport・一括管理しない。デプロイ用service accountは保護された設定の`DEPLOY_SERVICE_ACCOUNT`で指定し、所有者・binding・実効権限を事前に確認する。そのaccountの作成・import・削除は本アプリのTerraform対象外とし、限定的なIAM追加は[インフラ仕様](docs/infrastructure.md)に従う。Cloud Run runtime/invoker等のservice accountは専用とする。prefixはIAM境界ではなく、project全体で無料枠/予算を評価する。基盤登録とCloud Run公開は完了し、独自ドメインHTTPSも確認済みで、スポンサー実接続は未完了。
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

## 完成の意味

単体テストのモックは許可しますが、提出デモでは公式World開発環境・実Intercepta API・テストネット決済・実MultiBaas照会・公式ENSv2の登録/名前解決を通します。再起動後にも契約が残り、二重課金と未承認の転送設定を防ぎます。

Worldのイベント環境は主催者側の模擬proofを利用する旨が告知されています。公式環境への実接続と、本番の本人確認保証は区別します。World IDの認証だけで法的本人確認が完了するとは扱いません。

## ハッカソンのテスト方針

テストは最小限。主要機能の実接続デモと、二重決済・区画重複・未承認操作を防ぐ少数の確認を優先します。手動確認を認め、同じデモ結果を複数の検証に再利用します。網羅的な単体テスト、負荷試験、全面的な障害注入や大規模E2E基盤は今回の必須作業にしません。詳細は[最小チェック](docs/acceptance.md)を参照してください。

## ローカル起動と検証

Windowsでの実行とLinux CIの結果を記録済みです。WSL・macOSの手動起動は未検証で、以下の対応コマンドを実行済みの結果とは扱いません。WSLではLinux版のNode.js・pnpm・Javaと、contract作業時のforgeを使い、別のLinux checkoutで依存関係を取得してください。Windowsの`node_modules`を流用せず、Windows/Linuxの実行ファイルを混在させないでください。

Node.js 22.21.0、pnpm 11.19.0、Java 21、Firestore Emulator 1.22.0を使用します。依存関係は`pnpm install --frozen-lockfile`で取得します。`.env.example`を未追跡の`.env`に複製し、既存の`.env`は上書きしないでください。`APP_ENV=local`と`GCP_PROJECT_ID=demo-realaddr-local`はローカルEmulator用です。`PAYMENT_ASSET`、`PAYMENT_PAY_TO`等の実設定が未確認の間、決済可能なintentは作成しません。

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

`.env.example`では`CLOUD_TASKS_DISPATCH_ENABLED=false`です。dispatchを有効にできるのは、専用Cloud Tasks queueと同じprojectのworker、verified HTTPS `WORKER_URL`、専用invoke/runtime identitiesを備えた`APP_ENV=event`構成だけです。現時点でGCP上のCloud Tasks/Scheduler dispatchは未接続・未検証です。

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

起動・テストの実コマンド、公開デモURL、デプロイ情報、コントラクト、各スポンサー呼び出し箇所、チーム紹介・SNS、実測した連携フィードバック。未実行のコマンドや未取得の成功結果を掲載しないこと。
