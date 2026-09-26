# 運用・設定・未確定事項

優先順位付きの短い確認一覧は[未解決事項](open-items.md)を参照。各項目の詳細、設定契約、実施時期は本書と参照先を正本とする。

GitHub Actions、Cloud Run、Secret Manager、localへの設定値の配置とダミー例は[event環境の設定手順](deployment-configuration.md)を参照。

ユーザー指定により、今回は実際の郵便処理を行わない。World承認後に転送可表示と人間の転送先フォームを提供する。

## 環境と完成範囲

| 環境 | 用途 | 条件 |
| --- | --- | --- |
| local | 自動テスト/故障注入 | test double可、localと表示 |
| event | ハッカソン実動作 | 公式World dev、Intercepta live、testnet決済、MultiBaas live、DB保存 |
| production | 将来の商用 | 今回の仕様だけでは開通不可。法務/本人確認/郵便実務を別途設計 |

環境のDB/鍵は分離。productionでsandbox Worldやmock adapterは起動拒否。eventの「郵便転送可」は設定許可のデモであり、現物転送を開始しない。画面にその意味を明示する。

## 設定

T-01で秘密のない.env.exampleを作る。secretは環境/secret managerに入力しチャットへ貼らない。

| 変数群 | 用途 |
| --- | --- |
| APP_ENV, PUBLIC_ORIGIN | 環境、公開origin=https://address.chain.tokyo |
| DEPLOY_SERVICE_ACCOUNT | デプロイ用service accountを保護された設定manifestで明示指定。本アプリでは作成・import・削除しない |
| GCP_PROJECT_ID, GCP_REGION, FIRESTORE_DATABASE_ID | 他サービスと共存する既存project ID、fresh inventoryで確認したnamed DB配置に合わせる新規resourceのregion、専用named `realaddr` |
| FIRESTORE_COLLECTION_PREFIX, RESOURCE_PREFIX | 固定値`realaddr_event_`（全論理collectionの単一mapper）、`realaddr-event`（専用GCP resource名） |
| FIRESTORE_EMULATOR_HOST | local/CIのみ。event/production指定時は起動拒否 |
| GCS_BUCKET, ARTIFACT_REPOSITORY | privateファイルbucket、image格納先 |
| TASKS_QUEUE, WORKER_URL, TASK_INVOKER_SA, SCHEDULER_INVOKER_SA | 非公開worker呼出先とOIDC主体 |
| DAILY_NEW_LEASE_LIMIT, BILLING_ALERT_USD | 初期100件/UTC日、月$5は本アプリの運用目標。共有projectの既存予算・通知は別管理であり強制課金上限ではない |
| SESSION_SECRET, DATA_ENCRYPTION_KEY_ID | session/個人情報暗号化 |
| WORLD_ISSUER, WORLD_CLIENT_ID, WORLD_CLIENT_SECRET, WORLD_REDIRECT_URI | backend OIDC |
| INTERCEPTA_API_KEY, INTERCEPTA_BASE_URL | live risk |
| PAYMENT_NETWORK, PAYMENT_ASSET, PAYMENT_DECIMALS, PAYMENT_PAY_TO | 決済条件。network/asset allowlistとrate整合を検査 |
| X402_FACILITATOR_URL, X402_FACILITATOR_CREDENTIAL | 接続先、必要な場合の認証 |
| PAYMENT_FINALITY_POLICY | receipt/finality基準 |
| MULTIBAAS_URL, MULTIBAAS_API_KEY, MULTIBAAS_CHAIN_LABEL | deployment |
| INTERCEPTA_API_KEY | server-onlyのaddress screening key。固定provider endpointへだけ使用。暫定policyはallowを返さず、欠落時は外部呼出なしでhold |
| REGISTRY_ADDRESS, REGISTRY_CHAIN_ID, REGISTRY_CONTRACT_LABEL | 記録先 |
| REGISTRY_READBACK_ENABLED | workerの読み取り照合を有効化。既定false。署名・送信の許可ではない |
| REGISTRY_CONTRACT_VERSION, REGISTRY_RUNTIME_CODE_HASH | 固定library versionと検証済みruntime bytecodeのKeccak-256 |
| REGISTRY_RPC_URL, REGISTRY_FINALITY_POLICY | HTTPS RPCと`finalized`。同じblockのMultiBaas historical readが利用できることを確認する |
| REGISTRY_SIGNER_KEY_REF, REFUND_SIGNER_KEY_REF | registry発行鍵と、発行失敗が確定した注文の自動返金用鍵を分離して参照。返金鍵と実USDC/network/finalityはT-00/T-05で疎通確認 |
| LEASE_PRICE_MAINNET_ATOMIC, LEASE_PRICE_TESTNET_ATOMIC, LEASE_PERIOD_DAYS | 住所価格と期間。6-decimal USDCでmainnet想定55000000、testnet/dev 550000、期間30日。mainnetは今回無効 |
| ENS_ADDON_STANDARD_PRICE_MAINNET_ATOMIC, ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC | 標準ENS初回額。mainnet想定10000000、testnet/dev 100000。各環境の固定network/assetと照合 |
| ENS_ADDON_CUSTOM_PRICE_MAINNET_ATOMIC, ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC | custom ENS初回額。mainnet想定30000000、testnet/dev 300000。各環境の固定network/assetと照合 |
| AGENT_MAX_PAYMENT_ATOMIC, AGENT_DAILY_LIMIT_ATOMIC | 支出上限 |
| AGENT_SIGNER_KEY_REF, AGENT_API_ORIGIN, AGENT_INTERCEPTA_KEY | 顧客CLIローカル設定 |

住所のmainnet想定価格は30日55 USDC、testnet/devは30日0.55 USDC（USDC 6 decimals）。purchase/renewとも同額。ENS初回add-onは標準名が10/0.10 USDC（atomic 10000000/100000）、custom名が30/0.30 USDC（atomic 30000000/300000）、mainnet想定 / testnet-dev。今回mainnet販売は無効。name-type別価格設定の欠落/null/0、network・asset・rate不一致は起動時と支払い前に拒否する。chain別USDC token address/decimalsは公式情報で固定し、環境変数のみでmainnetを有効化しない。ENS価格はENS status readだけでは取得できず、CLIが作成する`ens_addon` intentの見積に含める。ENSは利用者の明示選択後に別payment intent/receiptを持ち、住所購入で自動付与しない。住所renewは購入済みENSの期間同期を含むため追加ENS料金なし。ENS期限ポリシーは`follow_lease`に固定し、設定で変更できない。

## 人間の操作

人間は対象ownerWalletと同じテストEOAをブラウザwalletで使用する。承認URLを開きwallet署名 → World認証 → 明示承認 → 「郵便転送可」とフォーム → 人間が住所入力 → 保存 → reloadで確認。デモ住所は自社で公開許可したテスト値を使い、第三者の個人住所を公開動画へ載せない。

責任者の変更/紛失回復はv1対象外。初回以降は同一issuer/subjectを要求する。開発DBを初期化して回避した場合は既存利用者の回復フローを実装したと主張しない。

## 障害・運用

Cloud TasksのHTTP要求でworkerを実行し、5分ごとのSchedulerが不明決済、outbox、期限切れholdを小分け回復。常駐timerや起動時全件走査を使わない。結果不明を未払いへ初期化しない。settling/reconcilingを5分超で運用キューへ出す。決済済み未発行は照合・同じ注文への再発行を行い、不明・再試行可能ならmanual_reviewで支払い証跡と権利を保持する。提出済みtxと提供物をfinality付きで調べ、復旧不能な発行失敗が確定した場合だけworkerが自動返金する。返金は元payer・同一network/USDC asset・注文額全額で、gasは運営負担。署名済み送金とnonce/tx hashをbroadcast前に永続化し、返金結果不明なら同じ送金を照合して新nonceで再送しない。管理画面から返金送金は開始しない。詳細は[状態・取引設計](../.kiro/specs/realaddr/design.md)。

監視はAPI失敗率、リスクquota、不明決済、予約滞留、OIDC失敗、outbox遅延、chain不一致。PII/秘密/token/完全な署名はログに含めない。宛先は暗号化し閲覧権限を限定する。

提出前は[最小チェック](acceptance.md)に従い、再起動後の契約・設定保持を代表1件で確認。書込停止snapshot/Emulator restoreの全面訓練は必須外とし、必要時の手順は[インフラ仕様](infrastructure.md)を参照。snapshot、期限削除、復元は`realaddr_event_` collectionと本アプリ専用bucket/queueだけを対象とし、他サービスや共有DB全体のwriterを停止しない。有料managed backup/PITRは本アプリでは初期構成の前提としないが、既存DB全体の設定は本アプリから変更しない。snapshot保持7日、復元時はchain再照合を必須とする。通常ログ30日、demo宛先はイベント後30日で削除する初期案。商用の契約記録保持は別判断。chainは削除不可なので宛先/World subjectを記録しない。

## 商用へ進む前の境界

Worldの人間認証と明示同意は、郵便事業の法的な取引時確認を代替しない。経済産業省の[行政処分例](https://www.meti.go.jp/press/2026/04/20260403004/20260403004.html)では郵便物受取サービスの取引時確認・確認記録・疑わしい取引の判断が問題とされている。

今回はその業務実装を対象外にする。将来は契約主体、本人確認、代理権、保存期間、受領/保管/転送/解約後郵便、操作ごとの転送同意を事業者の手順と専門家確認に沿って追加する。「住所だけなら法的手続き不要」「Worldを通せば法律上発送可能」とは断定しない。

## 外部確認・運用の未実施事項

| ID | 内容 | 仮定/担当 | 必要時点 |
| --- | --- | --- | --- |
| O-01 | 権限のある管理画面で提供拠点の住所・郵便番号・slug・表示名・公開エリア/文言を登録し、運営者が公開許可と表示内容を確認する。通常の拠点登録であり、事前に実住所をコード/seedへ固定する必要はない。 | 運営者。事業者名・公式URLは確定済み。1拠点65,535仮想区画 | 販売開始前 |
| O-03 | World client/イベント認証手順 | 開発担当+portal | T-03 live |
| O-04 | Intercepta key/schema/危険アドレス | 開発担当+スポンサー | T-04 live |
| O-05 | facilitator/token/finality | Base Sepolia優先 | T-05 live |
| O-06 | MultiBaas deployment/chain/署名方式 | 開発担当+Curvegrid | T-07 live |
| O-07 | address.chain.tokyoのDNS/TLS接続とWorld callback登録 | ドメイン設定はユーザー担当。開発担当は接続先と必要設定を提示 | E2E前 |
| O-08 | 参加track/応募対象 | チーム | 提出前 |

O-02（決定済み）: 任意取消・通常運用では返金しない。発行失敗が照合後に復旧不能と確定した場合だけ対象注文の全額をworkerが自動返金する。サービス終了時に残る前払い分の対象条件・方法・時期はその時に別途案内する。価格と処理条件は[料金仕様](pricing.md)・[状態設計](../.kiro/specs/realaddr/design.md)を正とし、返金鍵・asset・finalityの実疎通はO-05/T-00/T-05の外部設定作業に含める。管理UIに返金実行を設けない。

事業者の正式表記は**国立日本総合研究センター株式会社**、公式URLは[https://jgrec.jp/](https://jgrec.jp/)とする。提供拠点住所をこの事業者の住所から推定せず、販売前に権限のある管理画面で運営者が拠点情報を登録し、公開許可と表示内容を確認する。住所等は事前にチャットで提示したり、実住所をコード/seedへ固定したりする必要はない。[管理仕様](admin.md)を正本とする。実郵便フローの詳細は今回の未確定blockerに含めない。外部値の取得やlive接続を要する項目と仕様不足を区別し、独立作業は進める。実成功結果を捏造して穴埋めしない。

## ENSv2追加設定と運用

設定: ENS_CHAIN_ID=11155111、ENS_RPC_URL、ENS_PARENT_NAME、ENS_PARENT_REGISTRY、ENS_USER_REGISTRY、ENS_NAME_CONTROLLER、ENS_UNIVERSAL_RESOLVER、ENS_FACTORY、ENS_RESOLVER_IMPLEMENTATION、ENS_PUBLISHER_KEY_REF、ENS_FINALITY_POLICY。`ENS_PARENT_REGISTRY`は親名を管理する公式registry、`ENS_USER_REGISTRY`はその親名直下の上位UserRegistryを指す。拠点ごとのchild registryは運営登録・receipt検証した`ens_namespaces/{buildingId}.locationRegistry`から取得し、全拠点で単一child registryを使い回さない。親→拠点slug→ENS child nameの3階層とする。REGISTRY_CHAIN_IDも11155111とする。各addressは公式deploymentsとcode存在を確認して固定する。

親名の取得/更新は事業者の設定作業。realaddr.ethは取得済みではない。親期限が最大子期限+運用余裕30日を下回る前に警告し、残存不足の場合は名前発行/更新を保留する。親名やpointerの監視、pending/error滞留、gas不足、record不一致、reorgをアラート対象へ追加する。

names/resolverは購入済み件数分だけ作る。デモは数件に限定し実gas/発行所要時間を測定。65,535件を同時発行できる性能があるとは主張しない。全capacityはbuildingの論理区画数であり（65,535 documentは事前生成しない）、オンチェーン発行済み件数とは別に表示する。

追加未確定: O-09 親ENSv2名と管理鍵、O-10 公式deployment/ABI/SDK pin、O-11 MultiBaas Sepoliaとgas予算。T-00/T-12の疎通条件とする。ENSは住所planと分離した任意の初回購入で提供する。人間の転送先は引き続き非公開。

## GCP運用追加

[インフラ仕様](infrastructure.md)が構成・無料枠・復旧・CI/CDの正本。O-12: 共存先の既存GCP project/billing account、共有`(default)`の歴史的状態とnamed `realaddr` DBのlocation/rules/index、既存IAM/API/予算・無料枠消費、専用resource名の空き、GitHub repository/Environment/WIFをT-16前に確認する。[read-only inventory](gcp-inventory.md)と[Terraform bootstrap](../infra/README.md)を準備済みだが、認証済みlive inventoryとbootstrap初期登録は完了した。fresh inventory時点でnamed `realaddr` DBは未作成だった。Terraform applyの完了は未確認で、専用runtime IAM試験、Firestore client deny試験、データreconcile/migration、joint image/env rolloutとcutoverは残件。runtimeは未完了で、共有`(default)`へのfallbackを禁止する。CLIの配置と検証範囲は[実装状況](implementation-status.md)を参照する。価格・quotaはdeploy前に再確認する。API/workerが参照するsecret versionと復号鍵を記録し、rollback/snapshotが使う鍵を先に破棄しない。

T-16では共有projectの読み取りinventoryでresource IDと所有者、IAM grantとその管理方法、project API、共有`(default)`の歴史的状態、named `realaddr` DBのlocation/rules/index/field exemption、既存予算と無料枠消費を確認する。named DB作成前にfresh ownership/region inventoryを行う。named DBの新規作成前に所有権・名前衝突・regionを再確認し、client Rulesをdatabase全体deny-allにする。Firebase clientなどRules適用経路でread/write拒否を確認する。server SDK/IAM RESTはRulesを迂回するため、この確認の代わりにしない。新規web/worker runtime service accountの権限は作成後、顧客データ投入・公開業務routeの有効化前に実identityでnamed `realaddr` DBの必要操作と対象外DBへの拒否を確認する。apply前は既存resource/IAM所有者・planとRules適用clientの拒否を調べる。運用者credentialでの成功はruntime主体の証拠にならず、documentのNOT_FOUNDはIAM拒否の証拠にならない。追加のdenyだけで既存allowを上書きできない。[Rules評価](https://firebase.google.com/docs/rules/rules-behavior)。本アプリのstateへ共有`(default)` DB/rules/index・既存API・既存予算をimportしない。共有`(default)` DB/rules/indexの変更、他サービスのindex削除、project IAM policy/binding、API disableを本アプリの手順から除外する。別stateが同roleのauthoritative IAM bindingを管理する場合も、本アプリのadditive memberと競合させない。必要APIの有効化やrules修正は共有project管理主体の別手順で行う。

共存ゲートを通過したら、管理者がbootstrap rootで本アプリ専用state bucket/WIF/Artifact Registryを作成する。web/worker/tasks/schedの4専用service accountはbackend初期化とplan審査の後、app rootのapplyで作成する。デプロイ用service accountは`DEPLOY_SERVICE_ACCOUNT`で保護された設定manifestから指定し、本アプリstateで作成・import・削除しない。そのaccountのIAM policyは置換せず、所有者・現在のgrant・実効権限を確認したうえで本アプリ専用WIFからの狭いimpersonation memberと対象resource限定grantだけを追加する。state bucketは`${GCP_PROJECT_ID}-realaddr-event-tfstate`、業務bucketは`${GCP_PROJECT_ID}-realaddr-event-data`、state prefixは`realaddr/event/bootstrap`と`realaddr/event/app`。Cloud Run等の基本名は`RESOURCE_PREFIX=realaddr-event`から生成し、実IDは保護された設定manifestへ置く。同名のresourceが本アプリ所有と確認できなければ上書き/importせず停止し、明示的なsuffixを設定する。その際は`FIRESTORE_COLLECTION_PREFIX`の単一mapperも同じmanifestで確定し、コード・Terraform・cleanup対象と一致させる。運用開始後のprefix変更はdocument移行が必要であり、単純な設定変更として扱わない。ランダム名での再試行はしない。planは本アプリ専用resourceとmanifestのprefixに属するcollection groupの複合index/field exemptionだけに触れることを確認する。bootstrapの初期ローカルstateを専用state bucketへ移す作業は別の手動手順として記録し、実施前は移行済みと書かない。state bucketは版管理・削除防止、業務bucketは短期保持を適用する。secret値はTerraformの変数・state・planを通さずSecret Managerに登録し、参照するversionを運用記録に残す。`FIRESTORE_COLLECTION_PREFIX`は名前衝突対策でありIAM隔離ではないため、現在の広いIAM grantも確認する。DBがregionalなら新規resourceは原則同region、multi-regionなら公式配置を確認して保存/通信費を見積もる。[Firestore複数DB管理](https://firebase.google.com/docs/firestore/manage-databases)の通り追加の名前付きDBは可能だが、無料quota対象はproject内1 DBだけなので初期構成では採用しない。[Firestore無料quota](https://docs.cloud.google.com/firestore/quotas)

公開deployはmainの検証済みcommitから保護されたevent Environmentの手動workflowで行う。Actionsの短期WIF認証を使用し、実行前にproject/region/ref/environmentと対象2サービスのresource IDを確認する。workflowは同じimage digestを本アプリのworkerとwebへ順次反映するため、両方のdigest、min=0、workerの未認証拒否と公開healthを確認してから成功とする。片方で失敗したら旧digestと現在の業務状態を確認し、安全な再実行または旧digestへのrollbackを記録する。Terraformは本アプリ専用サービスの設定/IAMを所有し、通常deployが変更するimage属性だけを除外する。この運用手順と実際のコマンド・結果は実装後に`docs/implementation-status.md`へ記録する。

## 公開ドメイン

公開originは`https://address.chain.tokyo`。`PUBLIC_ORIGIN`、OpenAPI servers、canonical/OG URL、sitemap、llms.txt、Agent向け案内をこのoriginへ統一する。Worldの`WORLD_REDIRECT_URI`は`https://address.chain.tokyo/auth/world/callback`としてportalに完全一致登録する。Agentのwallet challenge domainとCSRF Originも同じ公開hostを基準とする。転送ヘッダーや任意Hostからcallback/承認URLを組み立てない。

ドメイン取得・DNS・接続設定はユーザーが行う。eventの初期接続方式はCloud Run direct domain mappingとする。実regionの対応、所有権確認、既存mapping/recordとの衝突を確認してから本アプリweb serviceへmappingを作る。条件を満たせなければ公開を停止し、別方式を明示決定する。開発側はmappingから実際に返されたDNS recordとmanaged certificate状態を提示し、ユーザーが対象recordだけを設定する。他サービスのmappingやDNSを上書きしない。未取得のDNS値を推測しない。この方式はpreviewでproduction非推奨のため将来の商用接続方式は再検討する。[Cloud Run custom domain mapping](https://docs.cloud.google.com/run/docs/mapping-custom-domains)。設定後は`GET https://address.chain.tokyo/health`を認証なしで直送し、TLS検証を維持してredirectを追わず、30秒・応答4 KiB以内で現在のhealth契約に従うJSONの`status=ok`を確認する。同一originのAPI、World/admin callback、cookieも最小確認してから公開済みと記録する。現在は設定予定であり、DNS/TLS/デプロイ完了を意味しない。

run.app URLは運用確認用に保持できるが、公開案内・検索向けcanonicalには使わない。別originの認証開始・承認処理は拒否し、公開GETの正規化redirectだけを許可する。workerのIAM/OIDC audienceは実worker URLのまま分離する。利用者が構成するドメイン/DNSをTerraformで勝手に作成・上書きしない。

## 管理者ログインと公開画面の設定

O-13: 本アプリ専用のGoogle OIDC client、`https://address.chain.tokyo/auth/admin/callback`、明示的に許可する運用者をT-18前に確定する。共有projectの既存clientやconsent設定を全面置換しない。credential/allowlist実値はリポジトリへ記載しない。[管理仕様](admin.md)に従って登録し、設定がない状態では管理データを返さない。Worldの人間承認callbackと管理者callbackを取り違えない。

O-14: 運営者名は**国立日本総合研究センター株式会社**、公式URLは[https://jgrec.jp/](https://jgrec.jp/)に固定する。提供拠点住所等は仕様検討項目ではなく、販売前に権限のある管理画面から運営者が登録し、公開許可と表示文言を確認する通常運用入力とする。事業者の住所から推定しない。事前にチャットで住所を提示したり、実住所をコード/seedへ固定したりする必要はない。[管理仕様](admin.md)を正本とし、[画面仕様](frontend.md)と[AEO仕様](aeo.md)を適用する。架空の導入実績や本番稼働を表示しない。
