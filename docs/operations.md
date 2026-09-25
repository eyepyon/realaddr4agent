# 運用・設定・未確定事項

優先順位付きの短い確認一覧は[未解決事項](open-items.md)を参照。各項目の詳細、設定契約、実施時期は本書と参照先を正本とする。

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
| GCP_PROJECT_ID, GCP_REGION, FIRESTORE_DATABASE_ID | 他サービスと共存する既存project ID、既存DBの実配置に合わせて選ぶ新規resourceのregion、共有`(default)` |
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
| REGISTRY_ADDRESS, REGISTRY_CHAIN_ID, REGISTRY_CONTRACT_LABEL | 記録先 |
| REGISTRY_SIGNER_KEY_REF, REFUND_SIGNER_KEY_REF | 業務用鍵参照 |
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

Cloud TasksのHTTP要求でworkerを実行し、5分ごとのSchedulerが不明決済、outbox、期限切れholdを小分け回復。常駐timerや起動時全件走査を使わない。結果不明を未払いへ初期化しない。settling/reconcilingを5分超で運用キューへ出す。決済済み未発行は照合・再発行、不可なら元payerへ返金を別記録する。

監視はAPI失敗率、リスクquota、不明決済、予約滞留、OIDC失敗、outbox遅延、chain不一致。PII/秘密/token/完全な署名はログに含めない。宛先は暗号化し閲覧権限を限定する。

提出前は[最小チェック](acceptance.md)に従い、再起動後の契約・設定保持を代表1件で確認。書込停止snapshot/Emulator restoreの全面訓練は必須外とし、必要時の手順は[インフラ仕様](infrastructure.md)を参照。snapshot、期限削除、復元は`realaddr_event_` collectionと本アプリ専用bucket/queueだけを対象とし、他サービスや共有DB全体のwriterを停止しない。有料managed backup/PITRは本アプリでは初期構成の前提としないが、既存DB全体の設定は本アプリから変更しない。snapshot保持7日、復元時はchain再照合を必須とする。通常ログ30日、demo宛先はイベント後30日で削除する初期案。商用の契約記録保持は別判断。chainは削除不可なので宛先/World subjectを記録しない。

## 商用へ進む前の境界

Worldの人間認証と明示同意は、郵便事業の法的な取引時確認を代替しない。経済産業省の[行政処分例](https://www.meti.go.jp/press/2026/04/20260403004/20260403004.html)では郵便物受取サービスの取引時確認・確認記録・疑わしい取引の判断が問題とされている。

今回はその業務実装を対象外にする。将来は契約主体、本人確認、代理権、保存期間、受領/保管/転送/解約後郵便、操作ごとの転送同意を事業者の手順と専門家確認に沿って追加する。「住所だけなら法的手続き不要」「Worldを通せば法律上発送可能」とは断定しない。

## 未確定事項

| ID | 内容 | 仮定/担当 | 必要時点 |
| --- | --- | --- | --- |
| O-01 | 事業者名、公開許可住所、区画表記 | 事業者、1拠点65,535区画 | 実住所表示前 |
| O-02 | 返金規約、実行責任者、payerへの送金経路/署名権限、冪等性と不明結果の照合手順 | 料金は確定済み。admin UIから返金送金しない | live決済・返金実装前 |
| O-03 | World client/イベント認証手順 | 開発担当+portal | T-03 live |
| O-04 | Intercepta key/schema/危険アドレス | 開発担当+スポンサー | T-04 live |
| O-05 | facilitator/token/finality | Base Sepolia優先 | T-05 live |
| O-06 | MultiBaas deployment/chain/署名方式 | 開発担当+Curvegrid | T-07 live |
| O-07 | address.chain.tokyoのDNS/TLS接続とWorld callback登録 | ドメイン設定はユーザー担当。開発担当は接続先と必要設定を提示 | E2E前 |
| O-08 | 参加track/応募対象 | チーム | 提出前 |

住所料金・ENS add-on料金は[料金仕様](pricing.md)の値で確定済みであり、O-02に価格未確定を含めない。実郵便フローの詳細は今回の未確定blockerに含めない。外部値の取得やlive接続を要する項目と仕様不足を区別し、独立作業は進める。実成功結果を捏造して穴埋めしない。

## ENSv2追加設定と運用

設定: ENS_CHAIN_ID=11155111、ENS_RPC_URL、ENS_PARENT_NAME、ENS_PARENT_REGISTRY、ENS_USER_REGISTRY、ENS_NAME_CONTROLLER、ENS_UNIVERSAL_RESOLVER、ENS_FACTORY、ENS_RESOLVER_IMPLEMENTATION、ENS_PUBLISHER_KEY_REF、ENS_FINALITY_POLICY。`ENS_PARENT_REGISTRY`は親名を管理する公式registry、`ENS_USER_REGISTRY`はその親名直下の上位UserRegistryを指す。拠点ごとのchild registryは運営登録・receipt検証した`ens_namespaces/{buildingId}.locationRegistry`から取得し、全拠点で単一child registryを使い回さない。親→拠点slug→ENS child nameの3階層とする。REGISTRY_CHAIN_IDも11155111とする。各addressは公式deploymentsとcode存在を確認して固定する。

親名の取得/更新は事業者の設定作業。realaddr.ethは取得済みではない。親期限が最大子期限+運用余裕30日を下回る前に警告し、残存不足の場合は名前発行/更新を保留する。親名やpointerの監視、pending/error滞留、gas不足、record不一致、reorgをアラート対象へ追加する。

names/resolverは購入済み件数分だけ作る。デモは数件に限定し実gas/発行所要時間を測定。65,535件を同時発行できる性能があるとは主張しない。全capacityはbuildingの論理区画数であり（65,535 documentは事前生成しない）、オンチェーン発行済み件数とは別に表示する。

追加未確定: O-09 親ENSv2名と管理鍵、O-10 公式deployment/ABI/SDK pin、O-11 MultiBaas Sepoliaとgas予算。T-00/T-12の疎通条件とする。ENSは住所planと分離した任意の初回購入で提供する。人間の転送先は引き続き非公開。

## GCP運用追加

[インフラ仕様](infrastructure.md)が構成・無料枠・復旧・CI/CDの正本。O-12: 共存先の既存GCP project/billing account、`(default)` Firestoreのlocation・rules・index、既存IAM/API/予算・無料枠消費、専用resource名の空き、GitHub repository/Environment/WIFをT-16前に確認する。現時点でprojectのlive inventoryは未実施で、`gcloud`はPATHで未検出。実装開始まで本アプリのresourceは未作成。価格・quotaはdeploy前に再確認する。API/workerが参照するsecret versionと復号鍵を記録し、rollback/snapshotが使う鍵を先に破棄しない。

T-16は共有projectの読み取りinventoryから開始し、resource IDと所有者、IAM grantとその管理方法、project API、`(default)` Firestoreのlocation/rules/index/field exemption、既存予算と無料枠消費を確認する。live rulesを読み取り、Firebase clientなどRules適用経路で本アプリprefixの代表パスを未認証・他利用者がread/writeできないことを確認する。rulesの読取・評価ができない場合、または既存client rulesが本アプリprefixへのアクセスを広く許す場合は共存ゲート失敗とし、共有管理主体が修正するまでapplyしない。server SDK/IAM RESTはRulesを迂回するため、この確認の代わりにしない。追加のdenyだけで既存allowを上書きできない。[Rules評価](https://firebase.google.com/docs/rules/rules-behavior)。本アプリのstateへ共有DB本体・rules・既存API・既存予算をimportしない。共有DB全体のrules更新、包括的なFirebase index deploy、他サービスのindex削除、project IAM policy/binding、API disableを本アプリの手順から除外する。別stateが同roleのauthoritative IAM bindingを管理する場合も、本アプリのadditive memberと競合させない。必要APIの有効化やrules修正は共有project管理主体の別手順で行う。

共存ゲートを通過したら、管理者がbootstrap rootで本アプリ専用state bucket/WIF/Artifact Registryを作成し、app rootのGCS backendを初期化して差分を審査してから適用する。state bucketは`${GCP_PROJECT_ID}-realaddr-event-tfstate`、業務bucketは`${GCP_PROJECT_ID}-realaddr-event-data`、state prefixは`realaddr/event/bootstrap`と`realaddr/event/app`。Cloud Run等の基本名は`RESOURCE_PREFIX=realaddr-event`から生成し、実IDは保護された設定manifestへ置く。同名の既存resourceが本アプリ所有と確認できなければ上書き/importせず停止し、明示的なsuffixを設定する。その際は`FIRESTORE_COLLECTION_PREFIX`の単一mapperも同じmanifestで確定し、コード・Terraform・cleanup対象と一致させる。運用開始後のprefix変更はdocument移行が必要であり、単純な設定変更として扱わない。ランダム名での再試行はしない。planは本アプリ専用resourceとmanifestのprefixに属するcollection groupの複合index/field exemptionだけに触れることを確認する。bootstrapの初期ローカルstateを専用state bucketへ移す作業は別の手動手順として記録し、実施前は移行済みと書かない。state bucketは版管理・削除防止、業務bucketは短期保持を適用する。secret値はTerraformの変数・state・planを通さずSecret Managerに登録し、参照するversionを運用記録に残す。`FIRESTORE_COLLECTION_PREFIX`は名前衝突対策でありIAM隔離ではないため、既存の広いIAM grantも確認する。DBがregionalなら新規resourceは原則同region、multi-regionなら公式配置を確認して保存/通信費を見積もる。[Firestore複数DB管理](https://firebase.google.com/docs/firestore/manage-databases)の通り追加の名前付きDBは可能だが、無料quota対象はproject内1 DBだけなので初期構成では採用しない。[Firestore無料quota](https://docs.cloud.google.com/firestore/quotas)

公開deployはmainの検証済みcommitから保護されたevent Environmentの手動workflowで行う。Actionsの短期WIF認証を使用し、実行前にproject/region/ref/environmentと対象2サービスのresource IDを確認する。workflowは同じimage digestを本アプリのworkerとwebへ順次反映するため、両方のdigest、min=0、workerの未認証拒否と公開healthを確認してから成功とする。片方で失敗したら旧digestと現在の業務状態を確認し、安全な再実行または旧digestへのrollbackを記録する。Terraformは本アプリ専用サービスの設定/IAMを所有し、通常deployが変更するimage属性だけを除外する。この運用手順と実際のコマンド・結果は実装後に`docs/implementation-status.md`へ記録する。

## 公開ドメイン

公開originは`https://address.chain.tokyo`。`PUBLIC_ORIGIN`、OpenAPI servers、canonical/OG URL、sitemap、llms.txt、Agent向け案内をこのoriginへ統一する。Worldの`WORLD_REDIRECT_URI`は`https://address.chain.tokyo/auth/world/callback`としてportalに完全一致登録する。Agentのwallet challenge domainとCSRF Originも同じ公開hostを基準とする。転送ヘッダーや任意Hostからcallback/承認URLを組み立てない。

ドメイン取得・DNS・接続設定はユーザーが行う。開発側はCloud Runの実URLと選択した接続方法の必要レコード/TLS条件を取得後に提示する。未取得のDNS値を推測しない。HTTP/TLS到達、同一originのAPI、World callback、cookieを最小確認してから公開済みと記録する。現在は設定予定であり、DNS/TLS/デプロイ完了を意味しない。

run.app URLは運用確認用に保持できるが、公開案内・検索向けcanonicalには使わない。別originの認証開始・承認処理は拒否し、公開GETの正規化redirectだけを許可する。workerのIAM/OIDC audienceは実worker URLのまま分離する。利用者が構成するドメイン/DNSをTerraformで勝手に作成・上書きしない。

## 管理者ログインと公開画面の設定

O-13: 本アプリ専用のGoogle OIDC client、`https://address.chain.tokyo/auth/admin/callback`、明示的に許可する運用者をT-18前に確定する。共有projectの既存clientやconsent設定を全面置換しない。credential/allowlist実値はリポジトリへ記載しない。[管理仕様](admin.md)に従って登録し、設定がない状態では管理データを返さない。Worldの人間承認callbackと管理者callbackを取り違えない。

O-14: 公開ページの運営者表記、公開可能な説明・料金・住所表記をT-19で確認する。未確定項目は未確定と明示し、架空の導入実績や本番稼働を表示しない。[画面仕様](frontend.md)と[AEO仕様](aeo.md)を適用する。
