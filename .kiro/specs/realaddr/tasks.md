# 実装タスク

実装を開始した。現在の実装範囲・実行可能なコマンド・検証結果は[実装状況](../../../docs/implementation-status.md)に記録する。チェックはタスク全体の実装と最小ゲートの証跡が揃ってから付け、部分実装だけでは完了にしない。A-01〜A-49は追跡用シナリオであり全件実行・自動化はタスク完了条件ではない。追加検証は未実行と記録する。最小ゲートは`docs/acceptance.md`を参照。

## 着手順と外部依存

1. **先行実装**: T-01のworkspace・HTTP配信・CLI・CIと、T-02のFirestore/認証/区画を実装する。T-08/T-18/T-19の画面部品・公開HTML・API clientも並行して作る。各画面の業務機能が完成するまで、下記の統合依存は満たしたと扱わない。
2. **接続準備を並行**: T-00をWorld、Intercepta/x402、MultiBaas、ENSごとに分け、取得済みの設定から疎通する。利用資格情報が必要な部分だけを外部待ちにし、共通基盤を止めない。未検証の依存をmock成功で代用してeventの販売を開かない。
3. **業務統合**: 対応するT-00確認後にT-03/T-04/T-05/T-07、続いてT-06/T-12/T-13/T-14を接続する。T-18の実管理者ログインには専用Google OIDC設定が必要。
4. **公開と提出**: T-16のlive inventory・共存条件を満たしてからGCPへ適用し、T-09/T-15/T-17/T-10の最小検証、T-11の提出準備へ進む。DNS/TLSと外部接続未確認の段階を公開稼働済みにしない。

## 実装・検証チェックリスト

- [ ] T-00 外部連携の最小疎通と設定確定
  - World discovery/portal client/HTTPS callback/fresh認証、Intercepta liveレスポンス/危険アドレス、x402 facilitator/asset/finality、MultiBaas Sepolia権限、ENSv2公式deployment/ABI/SDK・親名の制御・gasを確認。
  - 資格情報未取得はBLOCKEDとし、独立項目を継続。API methodやrisk enumを推測しない。
  - 成果: `docs/implementation-status.md`、秘密を除いた設定表、version/ADR。対応: R-04/R-06/R-08/R-11、A-20〜A-23/A-27。
- [ ] T-01 ワークスペースと実行基盤
  - React/Vite/Fastify/HTTP worker/Firestore Emulator、pnpm、strict TS、CI、schemaVersion/index管理、env validation、secretのない.env.exampleを作る。
  - `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm agent`を実装し、変更箇所の重点チェックを実行できる最小の`pnpm test`を用意する。専用のlint/integration/e2e/liveコマンドは実際に必要な時に追加し、READMEへ実装済みのコマンドのみ記載。
  - 成果: clean cloneから起動、health/readiness、単一HTTPS origin。対応: R-10/A-18。
- [ ] T-02 ドメイン/DB/Agent認証/区画
  - 依存: T-01。全collection/guard/index/repository、wallet challenge、Bearer hash管理、tenant認可、冪等store。
  - `FIRESTORE_COLLECTION_PREFIX=realaddr_event_` をrepository境界のmapperで適用し、論理名を物理collection名へ変換する。業務、admin、uniqueness guard、outboxを含む全collectionに適用し、prefix欠落や二重prefixをfail closedで拒否する。FirestoreのprefixはIAM隔離を意味しない。
  - 64shard bitmapと必要時のslot作成、floor指定時の対象区画予約・省略時の自動割当、並行予約、期限/状態遷移、reserve quota/日次予算を実装。65,535 documentをseedしない。
  - 最小確認: slot境界、同一区画の競合予約、他tenant拒否をDBで確認。A-01〜A-04、A-17/A-37/A-38は追加検証の参照。R-01/R-02/R-15。
- [ ] T-03 World backendと人間session
  - 依存: T-00 World、T-02。owner challenge/署名、OIDC code+PKCE、JWKS検証、freshness、candidate binding、明示同意を実装。
  - CSRF、state再送、callback失敗、別World本人を拒否。OIDC成功のみではMailProfileを変えない。
  - 最小確認: 正しいowner/World/同意で承認し、別人または同意なしでは拒否。A-10〜A-14/A-21は追加検証の参照。R-05/R-06。
- [ ] T-04 Intercepta policy adapterと署名器
  - 依存: T-00 Intercepta、T-02。実レスポンスに対応した正規化、allow/deny/hold、buyer/payTo・seller/payer判定、金額/asset/chain/domain制約、予算ledgerを実装。
  - 不明enumはhold、mainnet coverageを明示。ライブ理由の画面表示。
  - 最小確認: 実allow/denyで署名・決済の可否を確認し、未知判定はhold。A-07〜A-09/A-20は追加検証の参照。R-04。
- [ ] T-05 x402注文/実決済/照合
  - 依存: T-00 facilitator、T-02、T-04。402 v2、固定価格、verify/screen/settle順、receipt確認、exactly-once相当の業務冪等性を実装。
  - 不明結果を永続化し照合、二重settle防止、更新、確定した発行失敗だけの自動全額返金を実装。元payer・同一network/asset・注文額を固定し、送金前に署名済みtx/nonceを永続化、未知返金結果は同じtxを照合して二重送金しない。middlewareの配信順に依存しない。
  - 最小確認: 実決済一件、同じ要求の再送、結果不明時の照合とslot保持。A-05/A-06/A-19/A-22は追加検証の参照。R-03。
- [ ] T-06 郵便転送設定の最小機能
  - 依存: T-03、T-05。mail.enable承認URL、apply一回、enabled表示、人間専用フォーム、国内住所validation、暗号化、version競合、取消。
  - 実郵便処理・送料・配送APIは作らない。Agentはenabled/destinationConfiguredのみ参照。
  - 最小確認: 人間の承認・宛先保存/再読込、Agentまたは別人の全文取得/書込拒否。A-10〜A-16は追加検証の参照。R-06/R-07。
- [ ] T-07 LeaseRegistryとMultiBaas
  - 依存: T-00 MultiBaas、T-02。role/slot/version/非譲渡registry、Foundryテスト、Sepolia deploy、MultiBaas ABI/read/write/events、outbox/reorg回復。
  - 宛先/World subjectなどPIIをchainへ出さない。
  - 最小確認: 実write/readの一致と無権限変更の拒否。A-23/A-24は追加検証の参照。R-08。
- [ ] T-12 ENSv2 namespaceと契約別Resolver
  - 依存: T-00 ENS、T-01、T-07。3階層registry（親→拠点slug→ENS child name）を作り、親ENS名取得、UserRegistry deploy/親への接続、契約ごとのResolverをfactory生成する。leaseごとのcanonical full name uniqueness guardとquote snapshotを実装する。
  - role bitmapを固定し、顧客descriptionだけの委任とtransfer/契約record変更拒否を実コントラクトで確認。
  - 対応: R-11/R-13、A-27/A-29/A-30。
- [ ] T-13 ENS契約bindingとライフサイクル
  - 依存: T-12、T-05。ENS未購入契約は`not_purchased`として区別し、既存有効leaseへの明示ENS add-on intent/receipt確定後にNameController、ens_bindings、holderCommitment検証、発行/停止outbox、read-back、再送/reorgを実装する。
  - 住所更新は購入済みENSの期限を同期し、ENSの追加課金をしない。expired leaseの再開でも同じ名前を再購入させない。失効中ENSは無効。paid後のENS同期retryは再課金せず、同じleaseの二重購入は拒否する。ENS発行待ちでも住所利用は可能、古いresolver recordを有効証明にしない。
  - 標準名は`f` + 仮想区画の5桁ゼロ埋め（例`f00042`）。custom名は3〜32文字の小文字ASCII英数字と内部hyphenのみ、dot不可、先頭末尾hyphen不可。標準用`f`+数字namespaceとサービス予約語を拒否し、ENSIP-15正規化検査を行う。ENS初回費用は標準10/0.10 USDC、custom30/0.30 USDC（mainnet想定/testnet-dev、atomic 10000000/100000と30000000/300000）。環境別価格欠落/null/0やnetwork・asset・rate不一致はfail closed。拠点slugとの合成後canonical full name guardを原子的に確保する。予約中/使用中は名前空きなしとして別名か標準名の明示選択を促し、黙った切替・再課金をしない。購入初回だけtype/labelを選択し、既購入name変更/複数nameはv1対象外。
  - 対応: R-11/R-12/R-13、A-28/A-31〜A-34。
- [ ] T-14 ENS HTTP/署名器/CLI
  - 依存: T-13。`POST /v1/payment-intents` の`kind=ens_addon,subscriptionId`と名前選択から確定見積を作り、従来のpay/照合経路で支払う。標準CLI `ens purchase --subscription <id>`、custom CLI `ens purchase --subscription <id> --name-type custom --name <label>`、public resolve、owner専用by-ens、ens status、description unsigned txと制限付き署名/read-backを実装する。intent応答のcanonical name/price/receiptが正本で、status GETはname availability/quoteを返さない。
  - 転送先/World情報の非公開を維持。API/OpenAPIと実レスポンスを照合。
  - 対応: R-12/R-14、A-28/A-29/A-35/A-36。
- [ ] T-08 UIと共通CLI
  - 依存: T-03〜T-07、T-14。ダッシュボード、risk理由、World承認ページ、住所フォーム、JSON CLI/exit code/poll/再開、ENS名と検証状態を接続する。
  - 実API/DBから表示。pending/errorを成功に見せない。住所30日料金と任意ENS add-on料金を分け、`not_purchased`に別購入導線を表示する。ENS購入UIは既存CLI `ens purchase`へ引き渡し、新しいbrowser signerを作らない。公開HTTPはlocations/payment-intents/subscriptionsとflatなerror形式を使い、内部モデルとの変換をAPI境界へ集約する。
  - 最小確認: 実APIの表示と共通CLIの状態取得。A-15/A-16/A-25は追加検証の参照。R-09。
- [ ] T-18 管理画面と運用者API
  - 依存: T-02、T-05、T-07、T-13。docs/admin.mdと管理OpenAPIに従いGoogle OIDC/allowlist、独立session、管理の一覧/詳細、拠点登録フォームと編集・販売停止/再開、安全な再照合要求、監査を実装する。拠点はserver導出planと固定仮想区画数で停止状態から作成し、登録済み一覧の行から編集する。実住所のseedを必須とせず、運用時に管理画面登録する。
  - docs/frontend.mdの標準SaaS部品を共有する。既存一覧に条件付きcursorとID一件照会を実装し、一覧要約だけの詳細panelと関連ID間の導線を用意する。管理者によるWorld承認代行、宛先全文取得、手動paid上書きを許可しない。
  - 最小確認: 管理ログインとAgent/未認証拒否、拠点の受付停止または再照合要求1件の監査。対応: R-16/R-17、A-45/A-46。
- [ ] T-19 公開HTML・AEO・画面統一
  - 依存: T-01、T-08。docs/frontend.mdとdocs/aeo.mdに従い/・/developers・/faqの初期HTML、metadata/JSON-LD、robots/sitemap/llms、OpenAPI導線を共通公開設定から生成する。
  - 公開originはhttps://address.chain.tokyo。公開/利用者/承認/adminで白/薄灰/青のSaaS UIを共有し、私的データをpublic HTMLへ含めない。SPA fallbackは既知routeだけ。
  - 最小確認: 狭い/広い画面を1回確認し、no-JS GETの本文と発見用ファイル、private noindex/no-storeを確認。ドメイン到達はT-16完了後。対応: R-17/R-18、A-47〜A-49。
- [ ] T-16 GCP基盤とGitHub Actionsデプロイ
  - 依存: T-01、T-02。docs/infrastructure.mdに沿って2つのCloud Run、Firestore、private GCS、Tasks、Scheduler、Secret Manager、Artifact Registry、WIFを定義する。
  - `infra/bootstrap`と`infra/app`の2 rootを維持し、`RESOURCE_PREFIX=realaddr-event` でCloud Run、業務GCS、Terraform state bucket、WIF、runtime/invoker service account、Secret Manager secret、queue等を専用命名する。既存`(default)` DBは必要時に共有参照のみとしapp stateへimport・管理しない。secret値をTerraform stateへ入れない。初回bootstrap stateの移行は手動手順を作り、実施結果を別途記録する。
  - deploy前にlive inventoryからproject、resource ownership、Firestore database/rules/index、region、IAM、API有効化、予算を確認する。デプロイ用service accountは保護された最終設定の`DEPLOY_SERVICE_ACCOUNT`で指定し、所有者・binding・実効権限を読み取り確認する。accountの作成・import・削除やIAM policy bindingの置換は禁止する。許可するIAM変更は、本アプリ専用SAへの必要最小限のadditive grant、指定したデプロイ用service accountに対する本アプリ専用WIF principalのimpersonation member、本アプリ専用resourceへの必要なgrantに限定し、他主体grantを削除・置換しない。共有DB/rules/project IAM/API/予算の包括変更・削除は禁止する。index変更は本アプリのprefix付きcollection groupだけに限定する。Terraform planで本アプリ所有外の更新/削除を検知した場合は拒否する（上記3種類の限定IAM追加を除く）。名前が未使用に見える場合もlive確認は省略しない。
  - Terraformは専用Cloud Run設定と限定的IAM memberを所有し、通常deployだけがimage digestを更新する。対象image属性に限定したdrift除外を検証し、同じdigestを2サービスへ順次deploy、失敗時の片側復旧と旧digest rollbackを実装する。既存Firestore rulesは管理主体を確認して有効内容を照合し、本アプリprefix付きindexだけを管理する。IAM分離、永続outboxの配信/回復、min=0、retry上限、image/snapshot保持を設定し、既存予算通知の有無としきい値を確認する。
  - PR CIはGCP認証なしで最小チェック、Terraform変更時だけ対象rootのfmt/validate。保護されたmain手動deployはWIF条件・最小権限・同時実行制御・事前target照合と事後digest/IAM確認を実装する。bootstrap/deploy手順を記録し、提出用環境のmin=0復帰と未認証拒否を代表操作で確認する。専用`pnpm test:infra`は必要になった時に追加する。T-05/T-07/T-13の外部効果runnerをrequest駆動へ接続する。
  - 公開origin・World/admin callbackはaddress.chain.tokyoへ統一し、ユーザーへ必要なDNS/TLS接続情報を提示する。設定自体はユーザー担当。
  - 対応: R-15/R-18、A-39〜A-41/A-43/A-49。
- [ ] T-09 復旧/機密/公開環境
  - 依存: T-05〜T-08、T-16、T-18、T-19。環境分離、HTTPS、代表的な停止・再起動、rate limit、ログredaction、origin allowlist。完全なsnapshot/Emulator restoreと失敗注入マトリクスは追加検証。
  - 最小確認: 永続状態・未完了jobの再開、ログ/公開応答に秘密・宛先全文がないこと。A-17〜A-19/A-26は追加検証の参照。R-10。
- [ ] T-15 ENSv2実接続の縦断検証
  - 依存: T-09。住所契約（ENS未購入）→明示ENS add-on決済→Sepolia名の発行→公式解決→住所取得を確認し、add-on二重購入拒否または住所renewで追加ENS課金なしの一方と、禁止key拒否または失効時拒否を代表的な失敗経路として示す。残りの組合せは追加検証。
  - 代表ツールで名前から住所契約へ到達し、他の2ツールは共通CLIの認証・状態取得・ENS照合を疎通する。公開動画・gas・代表的な失敗証跡を保存する。
  - 対応: R-11〜R-14、A-27〜A-36は追加検証の参照。ベータ未接続を成功扱いしない。
- [ ] T-17 使用量・Firestore実環境・復旧検証
  - 依存: T-09。Emulatorで代表的な競合/guardを確認し、提出用GCP環境でscale-to-zero復帰と未認証拒否を確認する。Tasks再配信の網羅は追加検証。
  - 使用region、min=0、予算通知と観測できた使用量・請求を記録する。snapshot復元/日次予算到達、費用・性能の全測定は追加検証。
  - 対応: R-10/R-15、A-37〜A-44。
- [ ] T-10 3ツール横断とスポンサーlive検証
  - 依存: T-09、T-15、T-17。Codex/Claude Code/Kiroの代表する1ツールで購入→URL提示→人間承認/住所保存→Agent状態確認。他の2ツールは同じCLIの認証・状態取得・ENS照合を疎通。
  - live Intercepta成功/拒否、World成功/拒否、x402 tx、MultiBaas query、ENSv2登録/解決を証跡化。未接続・テスト未実行をチェック済みにしない。
  - 最小確認: 一つの実接続縦断フローと代表的なdeny/拒否。A-20〜A-36は追加検証の参照。
- [ ] T-11 提出パッケージ
  - 依存: T-10。公開リポジトリ、README起動手順、team/SNS、デモ動画、chain/contract URL、統合コードへのリンク、実測feedback。
  - 賞の最新条件を再確認。録画とliveの別、sandbox proof、郵便設定のみであることを明示。

## 完了報告フォーマット

タスクID / 変更ファイル / 実行コマンド / 合否 / 証跡パス / 未解決事項。未実行は「未実行」と書く。認証情報や個人住所を証跡に含めない。
