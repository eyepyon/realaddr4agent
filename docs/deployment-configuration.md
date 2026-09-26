# event環境の設定値と投入先

この資料はT-00/T-01/T-16の設定準備用である。ローカル用`.env.example`、GitHub Actionsの`ci` workflow、[Terraform bootstrap](../infra/README.md)と[read-only inventory](gcp-inventory.md)は作成済み。bootstrap5件の初期登録とlive設定確認は完了した。`infra/app`の基盤・条件付きサービス定義とコンテナ準備を追加し、GCS state移行は完了した。app基盤applyは完了した。`deploy-event` workflow、Cloud Run/Scheduler、Secret Managerの値は未作成・未検証。ローカル検証結果は[実装状況](implementation-status.md)へ記録する。ここに書いた外部設定例は払い出し済みの値を意味しない。設定の正本は[運用仕様](operations.md)、[インフラ仕様](infrastructure.md)、[管理仕様](admin.md)、[料金仕様](pricing.md)とする。実際の外部account識別子、secret、鍵、個人住所をリポジトリ文書・source comment・例・commit messageへ載せない。Terraformの保護されたstate/planにはresource metadataが必要だが、secret payload、署名鍵、個人住所を入れない。Actions logにも実値やcredentialを出力しない。

## 投入先と順序

1. **event専用の保護された設定manifest**を運用者がリポジトリ外に用意する。対象project/region、専用resourceの確定ID、共有Firestoreの既存配置、WIFの信頼条件、`DEPLOY_SERVICE_ACCOUNT`と各secretの参照先をここで管理する。Terraform、Actions、Cloud Runの設定はこのmanifestから必要な値だけを受け取る。GitHubに登録した変数がTerraformやCloud Runへ自動伝播することはない。
2. T-16のread-only live inventoryを行う。共有projectの所有者、既存resource、`(default)` DBのlocation/rules/index、API、IAM、予算、名前の空き、指定したdeploy service accountの所有者・binding・実効権限を確認する。Security Rulesが適用されるclientから本アプリprefixへの未認証・他利用者のread/write拒否を確認する。planが他サービスや共有DB本体・rules・project IAM等へ触れるならapplyしない。
3. 管理主体が`infra/bootstrap`の本アプリ専用state bucket、Artifact Registry、repository制限付きWIFを作る。bootstrap stateの専用bucketへの移行は別途記録する。管理主体が`infra/app`の専用web/worker/Tasks invoker/Scheduler invoker service account、Cloud Run、queue、secret metadata、必要な限定IAMを作る。4つのservice accountは別々に新規作成し、default accountを使わない。指定されたdeploy service accountは本アプリのTerraformで作成・import・削除しない。既存bindingを保ち、確認済みの本アプリresourceへのgrantと専用WIF principalの狭いimpersonation memberだけを追加する。
4. 権限のある運用者がsecretの**値**をSecret Managerへ別途登録し、web/workerに必要なsecret versionだけを参照させる。値をTerraform変数に渡さない。runtime主体の実IAM権限と対象外DB拒否を、業務データ投入・公開route有効化前に検証する。
5. GitHubの保護された`event` Environmentで、mainの検証済みcommitから手動`deploy-event`を実行する設計である。WIFの短期credentialを使い、同じimage digestをworkerとwebに適用する。JSON service account keyはGitHub Secretsへ登録しない。`ci`は存在するが`deploy-event`は未実装のため、以下を登録してもdeployは動かない。

## GitHub Actionsへ渡す値

GitHub repositoryの **Settings → Environments → event** で保護規則を設定し、次のEnvironment Variables/Secretsを登録する。表の値は保護manifestで確認した実値へ置き換える。Environment Variableはsecretのような自動maskを前提にせず、workflowで出力しない。PRの`ci`にはGCP credentialとremote stateへのアクセスを与えない。下表は今回の**予定workflow入力契約**であり、workflow実装時に名前・参照・検証を同期する。[GitHub Environmentの公式手順](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| キー | `event`の登録先 | 値の例・決め方 |
| --- | --- | --- |
| `GCP_PROJECT_ID` | Environment Variable | `<event-project-id>`。live inventoryで確定 |
| `GCP_REGION` | Environment Variable | `<verified-region>`。既存DB配置と直接domain mapping対応を確認後に確定。`us-central1`を未確認の既定値として適用しない |
| `RESOURCE_PREFIX` | Environment Variable | `realaddr-event`。Terraform/runtimeにも別途渡す |
| `FIRESTORE_COLLECTION_PREFIX` | Environment Variable | `realaddr_event_`。Terraform/runtimeにも別途渡す。衝突時の変更はmanifest・mapper・index・cleanupと同期 |
| `WIF_PROVIDER` | Environment Variable | `projects/<project-number>/locations/global/workloadIdentityPools/realaddr-event-gh/providers/github`。専用bootstrap出力でproject numberと所有権を確認 |
| `CLOUD_RUN_WEB_SERVICE` | Environment Variable | `realaddr-event-web`。live所有権と確定suffixを照合 |
| `CLOUD_RUN_WORKER_SERVICE` | Environment Variable | `realaddr-event-worker`。live所有権と確定suffixを照合 |
| `ARTIFACT_REPOSITORY` | Environment Variable | `realaddr-event-images`。本アプリ専用repositoryの確定IDを照合 |
| `DEPLOY_SERVICE_ACCOUNT` | Environment Secret | `<deploy-sa>@<project-id>.iam.gserviceaccount.com`。既存deploy accountの識別子を保護設定として扱う。Terraform lifecycle対象外で、所有者・binding・実効権限を確認 |

workflowでは例えば`${{ vars.GCP_PROJECT_ID }}`と`${{ secrets.DEPLOY_SERVICE_ACCOUNT }}`で読む。`APP_ENV=event`と`PUBLIC_ORIGIN=https://address.chain.tokyo`は**Actions Environmentへ別途登録不要**で、Cloud Run runtimeの設定として渡す。GitHubのrepository名だけをWIF信頼条件にせず、repository/ownerのimmutable IDと許可ref/Environment/event/workflow refを保護manifestからprovider条件へ反映する。deploy workflowは`contents: read`と`id-token: write`、main/`event`/手動起動、同時実行制御、事前target照合、事後digest・IAM確認を必要とする。WIFの短期credentialを使用し、JSON service account keyは作成・登録しない。[Google Cloud WIF公式手順](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)

## Cloud Run runtimeへ渡す非秘密設定

次のキーは運用仕様の設定表と初期実装の設定契約を合わせたものである。値は例または確定済み定数であり、未確認の外部endpoint、token address、contract addressを推測して埋めない。web/workerのどちらに必要かはT-01/T-16で実装に合わせて最小化する。設定欠落やnetwork/価格の不一致はfail closedにする。

| 分野 | キーとevent用の値例・確認事項 |
| --- | --- |
| 環境・公開 | `APP_ENV=event`、`PUBLIC_ORIGIN=https://address.chain.tokyo`、`GCP_PROJECT_ID=<event-project-id>`、`GCP_REGION=<verified-region>`、`FIRESTORE_DATABASE_ID=(default)`、`FIRESTORE_COLLECTION_PREFIX=realaddr_event_`、`RESOURCE_PREFIX=realaddr-event` |
| Cloud Tasks dispatch | `CLOUD_TASKS_DISPATCH_ENABLED=false`をdefaultとする。`true`は`APP_ENV=event`のみ許可し、`GCP_REGION`、`TASKS_QUEUE=realaddr-event-jobs`、workerと同一projectであること、専用worker runtime identity、`WORKER_URL`のHTTPS origin、専用`TASK_INVOKER_SA`を構成検査する。key file、service account key、ADC fallbackを使用しない。Cloud Run metadata serverで得るruntime identity emailを検証する |
| 認証・価格profile | `TERMS_VERSION=<published-terms-version>`、`PRICE_PROFILE=testnet`、`PRICING_VERSION=<reviewed-price-version>`。eventの`RATE_LIMIT_HMAC_KEY`は下の秘密設定に置く。mainnet profileを指定しても販売を開始しない |
| app resource | `GCS_BUCKET=<app-private-bucket>`、`TASKS_QUEUE=realaddr-event-jobs`、`WORKER_URL=<verified-https-worker-origin>`、`TASK_INVOKER_SA=<new-app-task-invoker>`、`SCHEDULER_INVOKER_SA=<new-app-scheduler-invoker>`。実IDはinventory後のmanifestから取得。`ARTIFACT_REPOSITORY`はActionsのimage push先でありruntimeに不要 |
| 上限 | `DAILY_NEW_LEASE_LIMIT=100`。`BILLING_ALERT_USD=5`は本アプリの月次運用目標であり、共有projectの既存予算通知や課金停止を設定するキーではない |
| World・risk | `WORLD_ISSUER=<verified-issuer>`、`WORLD_CLIENT_ID=<event-client-id>`、`WORLD_REDIRECT_URI=https://address.chain.tokyo/auth/world/callback`、`INTERCEPTA_BASE_URL=<verified-live-api-url>`。World issuerとIntercepta endpoint/schemaはT-00の実接続で確定 |
| x402決済 | `PAYMENT_NETWORK=<verified-base-sepolia-caip2>`、`PAYMENT_ASSET=<verified-base-sepolia-usdc-address>`、`PAYMENT_DECIMALS=6`、`PAYMENT_PAY_TO=<reviewed-receiving-address>`、`X402_FACILITATOR_URL=<verified-facilitator>`、`PAYMENT_FINALITY_POLICY=<tested-policy>`。Base Sepoliaのasset・facilitator・receipt/finalityはT-00で実測 |
| 価格・期間 | `LEASE_PRICE_TESTNET_ATOMIC=550000`、`LEASE_PRICE_MAINNET_ATOMIC=55000000`、`LEASE_PERIOD_DAYS=30`、`ENS_ADDON_STANDARD_PRICE_TESTNET_DEV_ATOMIC=100000`、`ENS_ADDON_STANDARD_PRICE_MAINNET_ATOMIC=10000000`、`ENS_ADDON_CUSTOM_PRICE_TESTNET_DEV_ATOMIC=300000`、`ENS_ADDON_CUSTOM_PRICE_MAINNET_ATOMIC=30000000`。mainnet値は将来の価格定義でありeventでのmainnet決済を有効化しない |
| LeaseRegistry・MultiBaas | `MULTIBAAS_URL=<verified-deployment-url>`、`MULTIBAAS_CHAIN_LABEL=<verified-sepolia-label>`、`REGISTRY_ADDRESS=<verified-contract-address>`、`REGISTRY_CHAIN_ID=11155111`、`REGISTRY_CONTRACT_LABEL=<verified-label>`。登録先と権限は実deploymentで確認 |
| ENSv2 | `ENS_CHAIN_ID=11155111`、`ENS_RPC_URL=<verified-sepolia-rpc>`、`ENS_PARENT_NAME=<controlled-parent-name>`、`ENS_PARENT_REGISTRY=<verified-address>`、`ENS_USER_REGISTRY=<verified-address>`、`ENS_NAME_CONTROLLER=<verified-address>`、`ENS_UNIVERSAL_RESOLVER=<verified-address>`、`ENS_FACTORY=<verified-address>`、`ENS_RESOLVER_IMPLEMENTATION=<verified-address>`、`ENS_FINALITY_POLICY=<tested-policy>`。親名の制御・公式deployment/ABI・gas確認までは販売を無効にする |
| 管理者OIDC | `ADMIN_GOOGLE_CLIENT_ID=<app-client-id>`、`ADMIN_OIDC_REDIRECT_URI=https://address.chain.tokyo/auth/admin/callback`。本アプリ専用clientの実値・callback登録を確認し、server側の保護設定から注入。World session/consentとは独立 |

Cloud Tasks dispatchはlocal/defaultで無効とし、event設定のCloud Tasks/worker接続が検証されるまで有効化しない。`WORKER_URL`は完全なHTTPS originとして検査し、末尾path等を補完・推測せず、設定した専用worker URLと完全一致させる。Tasks HTTP targetのaudienceと宛先originは同じworker originに固定する。dispatchが有効な構成でも、queueにtaskが存在することはoutbox jobの業務完了やpayment successを意味しない。Cloud Tasks/Scheduler/GCPへの実接続やIAM/Rules gateの確認は未実施・未検証である。

Web buildは`VITE_APP_ENV=local|event`と`VITE_TERMS_VERSION=<published-terms-version>`をbuild時に固定する。event buildは正式なterms versionと公開設定が確認できるまで実施しない。ブラウザへsecretを含む`VITE_`変数を渡さない。

`PAYMENT_NETWORK`はBase Sepolia、`REGISTRY_CHAIN_ID`と`ENS_CHAIN_ID`はEthereum Sepoliaに対応する。両chain間のbridgeや別の決済chainを設定しない。ENSは住所購入と別の初回add-on決済であり、renewに購入済みENSの維持を含む。`FIRESTORE_EMULATOR_HOST`はlocal/CIだけに設定し、event/productionでは拒否する。ENSの拠点別registryは各拠点登録とreceipt検証で得る永続stateであり、全拠点共通の環境変数で代用しない。

## Secret Managerと保護されたbootstrap入力

実際のsecret名、versionとweb/workerへの割当はT-01/T-16で決める。ここに挙げるのは既存の**runtime設定キー**であり、secret名を同じ綴りにする契約ではない。Secret Managerには値を登録し、Cloud Runへ必要な版だけを注入する。versionを運用記録に残し、暗号化済みデータやrollbackで参照する鍵を早期に破棄しない。`ENS_RPC_URL`、`X402_FACILITATOR_URL`などのURLにcredentialが含まれる場合もSecret Managerに置き、GitHub Variableや公開logへ出さない。`*_KEY_REF`は秘密鍵そのものではなく参照名とし、実際の署名・鍵の保存方式はT-00で確認する。

| 用途 | 既存キー | 入力・取扱い |
| --- | --- | --- |
| web session/宛先暗号化 | `SESSION_SECRET`、`DATA_ENCRYPTION_KEY_ID` | web等の必要なruntimeだけ。値や復号鍵は機密管理 |
| 公開APIのrate limit | `RATE_LIMIT_HMAC_KEY` | eventでは64桁のhexで表した32byteの秘密。IPをHMAC化してFirestoreのrate bucketへ保存し、raw IPを保存しない。localのみ未指定時に起動ごとに生成 |
| World/Intercepta/x402 | `WORLD_CLIENT_SECRET`、`INTERCEPTA_API_KEY`、`X402_FACILITATOR_CREDENTIAL` | providerから取得後に登録。facilitator認証が不要と確認される場合はcredentialを作らない |
| MultiBaas | `MULTIBAAS_API_KEY` | 最小権限の実API key |
| chain/返金署名 | `REGISTRY_SIGNER_KEY_REF`、`REFUND_SIGNER_KEY_REF`、`ENS_PUBLISHER_KEY_REF` | 役割を分離した鍵参照。署名方式と参照値の保存先は実接続で確定。復旧不能と確定した発行失敗の自動返金だけに返金鍵を使う |
| 管理者認証 | `ADMIN_GOOGLE_CLIENT_SECRET`、`ADMIN_SESSION_SECRET` | server側だけ。`ADMIN_ALLOWED_EMAILS`は保護された初回bootstrap入力であり稼働中の認可正本ではない |

管理者の初期principalは`ADMIN_ALLOWED_EMAILS`から保護された手順でprefixed Firestore collectionに作る。初回ログインで検証済みのGoogle OIDC `(issuer, subject)`を一度だけ固定し、以後はemailのみで再結合しない。権限の正本は有効な`admin_principals` entryであり、設定値だけで管理権限を与えない。実装前に値を登録しても管理APIは存在しない。

## ローカル設定

秘密のない`.env.example`を作成済みで、local/CIの非秘密キーとplaceholderを載せている。既存`.env`を上書きせず未追跡`.env`へ複製する。現在のEmulator設定は`APP_ENV=local`、`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`、`FIRESTORE_COLLECTION_PREFIX=realaddr_event_`、`GCP_PROJECT_ID=demo-realaddr-local`。ユーザーはMultiBaas接続値を未追跡`.env`へ登録する方針を選択したが、入力完了・値・疎通は未確認。`PAYMENT_ASSET`、`PAYMENT_PAY_TO`、`PAYMENT_DECIMALS`、`PRICING_VERSION`が未確認なら認証・healthは動作しても決済見積は無効になる。Webのlocal buildには`VITE_APP_ENV=local`と`VITE_TERMS_VERSION`を明示する。開発者の実secret・署名鍵はリポジトリ外の環境/secret storeへ置く。test doubleはlocalと表示し、event用の実鍵をlocalから流用しない。顧客CLIの例: `AGENT_API_ORIGIN=https://address.chain.tokyo`、`AGENT_CREDENTIAL_FILE=<local-untracked-file>`または`AGENT_API_TOKEN=<protected-token>`、`AGENT_SIGNER_KEY_REF=<local-key-reference>`、`AGENT_MAX_PAYMENT_ATOMIC=<reviewed-limit>`、`AGENT_DAILY_LIMIT_ATOMIC=<reviewed-limit>`、`AGENT_INTERCEPTA_KEY=<local-secret-reference>`。上限値は利用者の資金・運用方針に合わせて確定し、署名鍵・API keyをAgentへのprompt、client bundle、ログへ渡さない。

## 未確定と記録

T-00でWorld/Intercepta/facilitator/USDC/MultiBaas/ENSの実endpoint・address・認証方式・finalityを確定する。T-16でproject/region、専用resourceの実ID、WIF provider・信頼条件、IAM、Secret Manager名/版とruntime割当、domain mapping対応を確定する。管理者OIDC client/初期principalはT-18前に確定する。作業結果と未実施は`docs/implementation-status.md`に記録し、設定契約が変われば本表と`operations.md`、実装のenv validationを同時に更新する。

## 現実装の起動とapp opt-in

コンテナは`VITE_APP_ENV`と`VITE_TERMS_VERSION`を必須build引数とし、同一imageを`web`/`worker`引数で使う。現実装のweb起動には`APP_ENV=event`、`GCP_PROJECT_ID`、上表の`PUBLIC_ORIGIN`、正式な`TERMS_VERSION`、実`RATE_LIMIT_HMAC_KEY`が必要。worker起動は環境・project・prefix・default databaseと、実`WORKER_URL`・専用Tasks/Scheduler invokerを必要とする。provider secretは現在の閉じた起動経路では必須でなく、値を仮置きして販売を開かない。APIのdatabase明示検査とkey credential拒否はworkerと同等ではなく、runtime gateの残件である。

`infra/app`では非秘密設定を固定し、`secret_versions`でweb/workerごとの既存numeric versionだけを指定する。`secret_purposes`はmetadata作成対象で、payload/version作成を行わない。service配備・runtime ready・公開・Scheduler・dispatch・共有Firestore grantのopt-inは全て既定false。初期基盤applyとその後のruntime gateは別工程である。backend設定は保護されたbucketと専用prefixを使い、`TF_DATA_DIR`も保護directoryへ分ける。bootstrapはGCS移行済みで、cloneは既存remote stateへ接続する。[初期化手順](../infra/README.md)を参照。
