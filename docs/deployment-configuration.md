# event環境の設定値と投入先

この資料はT-00/T-01/T-16の設定準備用である。ローカル用`.env.example`、GitHub Actionsの`ci` workflow、[Terraform bootstrap](../infra/README.md)と[read-only inventory](gcp-inventory.md)は作成済み。bootstrap5件の初期登録とlive設定確認は完了した。`infra/app`の基盤・条件付きサービス定義とコンテナ準備を追加し、GCS state移行は完了した。app基盤applyは完了した。`deploy-event` workflowを追加したが、実行は未検証。Cloud Run/Scheduler、Secret Managerの値は未作成。ローカル検証結果は[実装状況](implementation-status.md)へ記録する。ここに書いた外部設定例は払い出し済みの値を意味しない。設定の正本は[運用仕様](operations.md)、[インフラ仕様](infrastructure.md)、[管理仕様](admin.md)、[料金仕様](pricing.md)とする。実際の外部account識別子、secret、鍵、個人住所をリポジトリ文書・source comment・例・commit messageへ載せない。Terraformの保護されたstate/planにはresource metadataが必要だが、secret payload、署名鍵、個人住所を入れない。Actions logにも実値やcredentialを出力しない。

## 投入先と順序

1. **event専用の保護された設定manifest**を運用者がリポジトリ外に用意する。対象project/region、専用resourceの確定ID、共有Firestoreの既存配置、WIFの信頼条件、`DEPLOY_SERVICE_ACCOUNT`と各secretの参照先をここで管理する。Terraform、Actions、Cloud Runの設定はこのmanifestから必要な値だけを受け取る。GitHubに登録した変数がTerraformやCloud Runへ自動伝播することはない。
2. T-16のread-only live inventoryを行う。共有projectの所有者、既存resource、共有`(default)`の履歴とnamed `realaddr` DBのlocation/rules/index、API、IAM、予算、名前の空き、指定したdeploy service accountの所有者・binding・実効権限を確認する。Security Rulesが適用されるclientから本アプリprefixへの未認証・他利用者のread/write拒否を確認する。planが他サービスや共有`(default)` DB/rules/index・project IAM等へ触れるならapplyしない。
3. 管理主体が`infra/bootstrap`の本アプリ専用state bucket、Artifact Registry、repository制限付きWIFを作る。bootstrap stateの専用bucketへの移行は別途記録する。管理主体が`infra/app`の専用web/worker/Tasks invoker/Scheduler invoker service account、Cloud Run、queue、secret metadata、必要な限定IAMを作る。4つのservice accountは別々に新規作成し、default accountを使わない。指定されたdeploy service accountは本アプリのTerraformで作成・import・削除しない。既存bindingを保ち、確認済みの本アプリresourceへのgrantと専用WIF principalの狭いimpersonation memberだけを追加する。
4. 権限のある運用者がsecretの**値**をSecret Managerへ別途登録し、web/workerに必要なsecret versionだけを参照させる。値をTerraform変数に渡さない。runtime主体の実IAM権限と対象外DB拒否を、業務データ投入・公開route有効化前に検証する。
5. GitHubの保護された`event` Environmentで、mainのCI成功済みcommitから手動`deploy-event`を実行する。これは既存2サービスのimage更新用であり、初回のCloud Run作成はTerraformで別途実施する。WIFの短期credentialを使い、同じimage digestをworkerとwebに適用する。JSON service account keyはGitHub Secretsへ登録しない。workflowを追加したが、Environment・WIFの有効化と実配備は未実施。

## GitHub Actionsへ渡す値

GitHub repositoryの **Settings → Environments → event** でmain限定の保護規則を設定し、Environment Secret **`DEPLOY_CONFIG`** に以下のキーを持つJSON objectを登録する。全値は文字列とする。runnerがstepの環境変数やaction入力を表示するため、従来案の個別Environment Variableではなく、target metadataも保護された一つの入力へまとめる。runtimeのsecret値は含めない。PRの`ci`にはGCP credentialとremote stateへのアクセスを与えない。[GitHub Environmentの公式手順](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| JSONキー | 値の例・決め方 |
| --- | --- |
| `GCP_PROJECT_ID` | `<event-project-id>`。live inventoryで確定 |
| `GCP_REGION` | `<verified-region>`。named `realaddr` DB配置とdomain接続方式を確認後に確定 |
| `RESOURCE_PREFIX` | `realaddr-event` |
| `FIRESTORE_COLLECTION_PREFIX` | `realaddr_event_` |
| `WIF_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/realaddr-event-gh/providers/github`。専用bootstrap出力で所有権を確認 |
| `CLOUD_RUN_WEB_SERVICE` | `realaddr-event-web` |
| `CLOUD_RUN_WORKER_SERVICE` | `realaddr-event-worker` |
| `ARTIFACT_REPOSITORY` | `realaddr-event-images` |
| `DEPLOY_SERVICE_ACCOUNT` | `<deploy-sa>@<project-id>.iam.gserviceaccount.com`。既存accountの所有者・binding・実効権限を確認。Terraform lifecycle対象外 |
| `TERMS_VERSION` | 正式version `realaddr-v1`。手動入力`terms_version`・Web build・既存web runtimeに一致させる。未承認の版やlocal demo versionはeventで拒否する。[採用記録と提供準備](terms-review.md)を参照 |
| `WORKER_URL` | 管理主体が確認したproject number/regionから確定する専用workerのdeterministic HTTPS `run.app` origin。image-onlyでは予定値を用い、初回配備後に実URLとの完全一致を確認 |
| `DEPLOYMENT_APPROVED` | 配備前レビューを済ませてから文字列`true`を指定。未設定時はcloud認証前に停止 |

workflowは`${{ secrets.DEPLOY_CONFIG }}`を読み、認証actionへ渡す識別子を個別maskして同job内のstep outputへ設定する。手動入力`commit`は実行時のmain commit SHAと完全一致させる。gate jobは`contents: read`とCI照会用`actions: read`だけで、cloud認証やEnvironment Secretを持たない。deploy jobだけが保護された`event` Environmentへ入り、`contents: read`と`id-token: write`を持つ。`APP_ENV=event`と`PUBLIC_ORIGIN=https://address.chain.tokyo`はCloud Run側で固定する。repository/ownerのimmutable IDと許可ref/Environment/event/workflow refをWIF条件へ反映し、JSON service account keyは作成・登録しない。[Google Cloud WIF公式手順](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)

## Cloud Run runtimeへ渡す非秘密設定

次のキーは運用仕様の設定表と初期実装の設定契約を合わせたものである。値は例または確定済み定数であり、未確認の外部endpoint、token address、contract addressを推測して埋めない。web/workerのどちらに必要かはT-01/T-16で実装に合わせて最小化する。設定欠落やnetwork/価格の不一致はfail closedにする。

| 分野 | キーとevent用の値例・確認事項 |
| --- | --- |
| 環境・公開 | `APP_ENV=event`、`PUBLIC_ORIGIN=https://address.chain.tokyo`、`GCP_PROJECT_ID=<event-project-id>`、`GCP_REGION=<verified-region>`、`FIRESTORE_DATABASE_ID=realaddr`、`FIRESTORE_COLLECTION_PREFIX=realaddr_event_`、`RESOURCE_PREFIX=realaddr-event` |
| Cloud Tasks dispatch | `CLOUD_TASKS_DISPATCH_ENABLED=false`をdefaultとする。`true`は`APP_ENV=event`のみ許可し、`GCP_REGION`、`TASKS_QUEUE=realaddr-event-jobs`、workerと同一projectであること、専用worker runtime identity、`WORKER_URL`のHTTPS origin、専用`TASK_INVOKER_SA`を構成検査する。key file、service account key、ADC fallbackを使用しない。Cloud Run metadata serverで得るruntime identity emailを検証する |
| 認証・価格profile | `TERMS_VERSION=realaddr-v1`、`PRICE_PROFILE=testnet`、`PRICING_VERSION=<reviewed-price-version>`。eventの`RATE_LIMIT_HMAC_KEY`は下の秘密設定に置く。mainnet profileを指定しても販売を開始しない |
| app resource | `GCS_BUCKET=<app-private-bucket>`、`TASKS_QUEUE=realaddr-event-jobs`、`WORKER_URL=<verified-https-worker-origin>`、`TASK_INVOKER_SA=<new-app-task-invoker>`、`SCHEDULER_INVOKER_SA=<new-app-scheduler-invoker>`。実IDはinventory後のmanifestから取得。`ARTIFACT_REPOSITORY`はActionsのimage push先でありruntimeに不要 |
| 上限 | `DAILY_NEW_LEASE_LIMIT=100`。`BILLING_ALERT_USD=5`は本アプリの月次運用目標であり、共有projectの既存予算通知や課金停止を設定するキーではない |
| World | webのみ`WORLD_ENABLED=false`を既定とし、`WORLD_REDIRECT_URI=https://address.chain.tokyo/auth/world/callback`を固定。issuerは`https://sandbox.auth.world.org`固定。client IDを含む4つの設定は下の秘密参照へ置く。productionではsandbox構成を受け付けない |
| x402決済 | `PAYMENT_NETWORK=<verified-base-sepolia-caip2>`、`PAYMENT_ASSET=<verified-base-sepolia-usdc-address>`、`PAYMENT_DECIMALS=6`、`PAYMENT_PAY_TO=<reviewed-receiving-address>`、`X402_FACILITATOR_URL=<verified-facilitator>`、`PAYMENT_FINALITY_POLICY=<tested-policy>`。Base Sepoliaのasset・facilitator・receipt/finalityはT-00で実測 |
| 価格・期間 | `LEASE_PRICE_TESTNET_ATOMIC=550000`、`LEASE_PRICE_MAINNET_ATOMIC=55000000`、`LEASE_PERIOD_DAYS=30`、`ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC=100000`、`ENS_ADDON_STANDARD_PRICE_MAINNET_ATOMIC=10000000`、`ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC=300000`、`ENS_ADDON_CUSTOM_PRICE_MAINNET_ATOMIC=30000000`。mainnet値は将来の価格定義でありeventでのmainnet決済を有効化しない |
| LeaseRegistry・MultiBaas | `MULTIBAAS_URL=<verified-deployment-url>`、`MULTIBAAS_CHAIN_LABEL=<verified-sepolia-label>`、`REGISTRY_ADDRESS=<verified-contract-address>`、`REGISTRY_CHAIN_ID=11155111`、`REGISTRY_CONTRACT_LABEL=<verified-label>`。登録先と権限は実deploymentで確認 |
| ENSv2 | `ENS_CHAIN_ID=11155111`、`ENS_RPC_URL=<verified-sepolia-rpc>`、`ENS_PARENT_NAME=<controlled-parent-name>`、`ENS_PARENT_REGISTRY=<verified-address>`、`ENS_USER_REGISTRY=<verified-address>`、`ENS_NAME_CONTROLLER=<verified-address>`、`ENS_UNIVERSAL_RESOLVER=<verified-address>`、`ENS_FACTORY=<verified-address>`、`ENS_RESOLVER_IMPLEMENTATION=<verified-address>`、`ENS_FINALITY_POLICY=<tested-policy>`。親名の制御・公式deployment/ABI・gas確認までは販売を無効にする |
| 管理者OIDC | `ADMIN_GOOGLE_CLIENT_ID=<app-client-id>`、`ADMIN_OIDC_REDIRECT_URI=https://address.chain.tokyo/auth/admin/callback`。本アプリ専用clientの実値・callback登録を確認し、server側の保護設定から注入。World session/consentとは独立 |

Cloud Tasks dispatchはlocal/defaultで無効とし、event設定のCloud Tasks/worker接続が検証されるまで有効化しない。`WORKER_URL`は完全なHTTPS originとして検査し、末尾path等を補完・推測せず、設定した専用worker URLと完全一致させる。Tasks HTTP targetのaudienceと宛先originは同じworker originに固定する。dispatchが有効な構成でも、queueにtaskが存在することはoutbox jobの業務完了やpayment successを意味しない。Cloud Tasks/Scheduler/GCPへの実接続やIAM/Rules gateの確認は未実施・未検証である。

Web buildは`VITE_APP_ENV=local|event`と`VITE_TERMS_VERSION`をbuild時に固定する。eventは正式採用済みの `realaddr-v1` を必須とし、本文のversionとの一致も確認する。正式version未確定の待ち条件は解消しており、実配備には公開設定・runtime等の残りの確認を要する。ブラウザへsecretを含む`VITE_`変数を渡さない。

`PAYMENT_NETWORK`はBase Sepolia、`REGISTRY_CHAIN_ID`と`ENS_CHAIN_ID`はEthereum Sepoliaに対応する。両chain間のbridgeや別の決済chainを設定しない。ENSは住所購入と別の初回add-on決済であり、renewに購入済みENSの維持を含む。`FIRESTORE_EMULATOR_HOST`はlocal/CIだけに設定し、event/productionでは拒否する。ENSの拠点別registryは各拠点登録とreceipt検証で得る永続stateであり、全拠点共通の環境変数で代用しない。

## Secret Managerと保護されたbootstrap入力

実際のsecret名、versionとweb/workerへの割当はT-01/T-16で決める。ここに挙げるのは既存の**runtime設定キー**であり、secret名を同じ綴りにする契約ではない。Secret Managerには値を登録し、Cloud Runへ必要な版だけを注入する。versionを運用記録に残し、暗号化済みデータやrollbackで参照する鍵を早期に破棄しない。`ENS_RPC_URL`、`X402_FACILITATOR_URL`などのURLにcredentialが含まれる場合もSecret Managerに置き、GitHub Variableや公開logへ出さない。`*_KEY_REF`は秘密鍵そのものではなく参照名とし、実際の署名・鍵の保存方式はT-00で確認する。

| 用途 | 既存キー | 入力・取扱い |
| --- | --- | --- |
| World session/宛先暗号化 | `WORLD_SESSION_KEY`、`MAIL_ENCRYPTION_KEY` | webだけに別々の32byte鍵をcanonical base64で注入。値や復号鍵は機密管理 |
| 公開APIのrate limit | `RATE_LIMIT_HMAC_KEY` | eventでは64桁のhexで表した32byteの秘密。IPをHMAC化してFirestoreのrate bucketへ保存し、raw IPを保存しない。localのみ未指定時に起動ごとに生成 |
| World OIDC | `WORLD_CLIENT_ID`、`WORLD_CLIENT_SECRET` | PortalのBasic認証clientを登録後、webのみ参照。client secretは一度だけ表示されるため保護設定へ直接保存 |
| Intercepta/x402 | `INTERCEPTA_API_KEY`、`X402_FACILITATOR_CREDENTIAL` | providerから取得後に登録。facilitator認証が不要と確認される場合はcredentialを作らない |
| MultiBaas | `MULTIBAAS_API_KEY` | 最小権限の実API key |
| chain/返金署名 | `REGISTRY_SIGNER_KEY_REF`、`REFUND_SIGNER_KEY_REF`、`ENS_PUBLISHER_KEY_REF` | 役割を分離した鍵参照。署名方式と参照値の保存先は実接続で確定。復旧不能と確定した発行失敗の自動返金だけに返金鍵を使う |
| 管理者認証 | `ADMIN_GOOGLE_CLIENT_SECRET`、`ADMIN_SESSION_SECRET` | server側だけ。`ADMIN_ALLOWED_EMAILS`は保護された初回bootstrap入力であり稼働中の認可正本ではない |

管理者の初期principalは`ADMIN_ALLOWED_EMAILS`から保護された手順でprefixed Firestore collectionに作る。初回ログインで検証済みのGoogle OIDC `(issuer, subject)`を一度だけ固定し、以後はemailのみで再結合しない。権限の正本は有効な`admin_principals` entryであり、設定値だけで管理権限を与えない。実装前に値を登録しても管理APIは存在しない。

## ローカル設定

秘密のない`.env.example`を作成済みで、local/CIの非秘密キーとplaceholderを載せている。既存`.env`を上書きせず未追跡`.env`へ複製する。現在のEmulator設定は`APP_ENV=local`、`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`、`FIRESTORE_COLLECTION_PREFIX=realaddr_event_`、`GCP_PROJECT_ID=demo-realaddr-local`。MultiBaas status APIはHTTP 200で応答schema検証を通過し、再検査でEthereum Sepolia (chain ID 11155111)との一致を確認した。registry設定、contract権限、read/write/event操作は未確認。`PAYMENT_ASSET`、`PAYMENT_PAY_TO`、`PAYMENT_DECIMALS`、`PRICING_VERSION`が未確認なら認証・healthは動作しても決済見積は無効になる。Webのlocal buildには`VITE_APP_ENV=local`と`VITE_TERMS_VERSION`を明示する。開発者の実secret・署名鍵はリポジトリ外の環境/secret storeへ置く。test doubleはlocalと表示し、event用の実鍵をlocalから流用しない。顧客CLIの例: `AGENT_API_ORIGIN=https://address.chain.tokyo`、`AGENT_CREDENTIAL_FILE=<local-untracked-file>`または`AGENT_API_TOKEN=<protected-token>`、`AGENT_SIGNER_KEY_REF=<local-key-reference>`、`AGENT_MAX_PAYMENT_ATOMIC=<reviewed-limit>`、`AGENT_DAILY_LIMIT_ATOMIC=<reviewed-limit>`、`AGENT_INTERCEPTA_KEY=<local-secret-reference>`。上限値は利用者の資金・運用方針に合わせて確定し、署名鍵・API keyをAgentへのprompt、client bundle、ログへ渡さない。

## 未確定と記録

T-00でWorld/Intercepta/facilitator/USDC/MultiBaas/ENSの実endpoint・address・認証方式・finalityを確定する。T-16でproject/region、専用resourceの実ID、WIF provider・信頼条件、IAM、Secret Manager名/版とruntime割当、domain mapping対応を確定する。管理者OIDC client/初期principalはT-18前に確定する。作業結果と未実施は`docs/implementation-status.md`に記録し、設定契約が変われば本表と`operations.md`、実装のenv validationを同時に更新する。

## 現実装の起動とapp opt-in

コンテナは`VITE_APP_ENV`と`VITE_TERMS_VERSION`を必須build引数とし、同一imageを`web`/`worker`引数で使う。現実装のweb起動には`APP_ENV=event`、`GCP_PROJECT_ID`、上表の`PUBLIC_ORIGIN`、正式な`TERMS_VERSION`、実`RATE_LIMIT_HMAC_KEY`が必要。worker起動は環境・project・prefix・named database `realaddr`と、実`WORKER_URL`・専用Tasks/Scheduler invokerを必要とする。provider secretは現在の閉じた起動経路では必須でなく、値を仮置きして販売を開かない。APIもeventでは専用prefixとnamed `realaddr` databaseの明示設定を要求し、demo project、不正project、Emulator、鍵credentialの環境変数を拒否する。

`infra/app`では非秘密設定を固定し、`secret_versions`でweb/workerごとの既存numeric versionだけを指定する。`secret_purposes`はmetadata作成対象で、payload/version作成を行わない。service配備・runtime ready・公開・Scheduler・dispatch・共有Firestore grantのopt-inは全て既定false。初期基盤applyとその後のruntime gateは別工程である。backend設定は保護されたbucketと専用prefixを使い、`TF_DATA_DIR`も保護directoryへ分ける。bootstrapはGCS移行済みで、cloneは既存remote stateへ接続する。[初期化手順](../infra/README.md)を参照。

## Worldの明示的な有効化

`infra/app`の`world_enabled`は既定false。有効化時には`secret_purposes`へ`world-client-id`、`world-client-secret`、`world-session-key`、`mail-encryption-key`を宣言し、`secret_versions.web`から`WORLD_CLIENT_ID`、`WORLD_CLIENT_SECRET`、`WORLD_SESSION_KEY`、`MAIL_ENCRYPTION_KEY`に既存の数値versionを割り当てる。secret payloadをTerraformへ渡さない。4つの参照が欠ける配備、`WORLD_ENABLED`/`WORLD_REDIRECT_URI`のsecret injection、workerへのWorld/mail secret割当を拒否する。

有効化前に専用resourceの所有権をinventoryし、`realaddr-event-world-callback` logging exclusionを作成する。filterは`cloud_run_revision`、`realaddr-event-web`、`run.googleapis.com/requests`、`/auth/world/callback`に限定し、code/stateを含むcallback request URLを通常logへ保存しない。Cloud Runはこのexclusionに依存する。他のservice・routeや共有logging設定は変更しない。独立のsinkなど別保存経路がある場合も秘匿値の保存有無を確認する。app診断はtoken/code/state/subject/宛先を出さない。

image更新guardは旧構成のWorld設定欠落を無効状態として許容し、有効状態では固定callbackと4つの専用numeric secret参照を要求する。設定とimageの反映はWorld live認証・承認完了の証拠ではない。[World設定手順](world.md)に従い、実paid leaseでの成功と代表的な拒否を別途確認する。

## image-onlyの入力と権限境界

同じ手動workflowで`operation=image-only`を選ぶと、正式terms・同SHAのCI・保護設定・承認・WIF条件を保ったまま、Artifact Registryへのevent image作成だけを行う。`operation`の既定は通常`deploy`で、不明値は拒否する。`DEPLOY_CONFIG`のJSON契約は同じで、image-only用に設定の必須項目や承認条件を省略しない。予定worker originは管理主体の確認したmetadataから確定し、後続の実配備で一致確認する。

image-only用deploy権限はレビュー済みの本アプリrepositoryへ限定する。実repository metadataと必要なget/upload/download・image get権限をjobで確認し、Run APIとIAM mutationは実行しない。Run不在・初回Terraform plan・runtime secret version・公開/配信gateは管理主体の別工程である。通常deployの既存サービス検査とrollbackは維持する。image-only成功はCloud Run配備・公開・スポンサー接続成功を意味しない。[実行手順](../infra/README.md#初回event-image-only)を参照。

## 初回配備とドメイン公開のgate

正式`realaddr-v1`のevent image-only workflowが成功し、同一immutable digestを非公開web/workerへ配備した。private構成のlive検証99件は通過した。Schedulerは停止、Cloud Tasks dispatchは無効のままで、Cloud Run公開と公開後100件の確認は完了し、独自ドメインのTLS発行・HTTPS応答も確認済み。

Terraformの`domain_mapping_reviewed`は既定false。`deploy_services=true`と`web_public=true`に加えて、管理主体が実domain所有権、専用web target、既存mapping不在とDNS recordをレビューしてからtrueを指定する。固定公開originだけをmappingし、`force_override=false`と削除防止を維持する。DNSはユーザー本人が管理し、mapping/certificate Readyと公開HTTP確認を別gateとする。

web公開は`web_public=true`の場合だけ専用webの`invoker_iam_disabled=true`で行い、workerは常にfalseとする。`allUsers` grantは作成せず、共有organization policyを変更しない。Cloud Runの認証gateを通過する公開webでも、利用者・管理者・人間承認のserver側認可を維持する。[Cloud Run公式の公開方式](https://docs.cloud.google.com/run/docs/authenticating/public)。
