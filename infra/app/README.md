# T-16 app root

本rootはTerraform 1.14.6 / Google provider 8.4.0の設定であり、基盤live applyは完了した。Firestore操作・拒否とqueue権限は専用主体で検証済み。サービス起動と配信権限は未検証。bootstrapと別stateを使用する。GCS backendのbucketと`prefix=realaddr/event/app`は保護されたリポジトリ外のbackend設定から渡す。state、plan、実値tfvarsをリポジトリへ置かない。

必須入力は`project_id`、DB配置と照合済みの`region`、所有確認済みの`data_bucket_name`、既存の`deploy_service_account`。デフォルトは4つの専用SA、private業務bucket、queueとresource単位のadditive IAMだけを作るfoundation構成。bucketは7日で削除、versioningなし、soft deleteなし、Terraform削除防止。`secret_purposes`に指定した用途だけsecret metadataを作り、値・versionは作らない。

`deploy_services=false`、`web_public=false`、`scheduler_enabled=false`、`dispatch_enabled=false`、`firestore_access_reviewed=false`が初期値。サービス作成には`deploy_services`と`runtime_ready`、Firestore権限レビュー、digest固定image、検証済み`worker_url`、正式`terms_version`、実登録済みのweb `RATE_LIMIT_HMAC_KEY`版が必要。`secret_versions`はweb/worker別に環境変数名から`{purpose, version}`へ対応させ、numeric versionを指定する。秘密値をTerraformへ渡さない。未接続スポンサー設定は注入せず、現在のAPIは販売を有効化しない。

web/workerは同じimageで異なるNode entrypointを起動する。imageだけを`ignore_changes`にし、通常deployのdigest更新後も他設定の差分を検出する。webはmin=0/max=2/concurrency=20、workerはmin=0/max=1/concurrency=1。両方1 CPU/512MiB、request-based、60秒。workerはtasks/sched専用主体だけinvoker memberを追加し、公開webは明示opt-in。Schedulerはサービス作成時にpausedで作成し、dispatch検証後に有効化する。

web/workerのqueue単位`roles/cloudtasks.enqueuer`を保持し、workerだけへ同queueの`roles/cloudtasks.viewer`を追加する。dispatcherの409・結果不明時のtask GET照合にはenqueuerに含まれない`cloudtasks.tasks.get`が必要。viewerは対象queue/tasksのget/list readも許可し、fullViewはenqueuerにも既に含まれる。web、tasks/sched invokerにはviewerを追加せず、project custom roleも作らない。[Cloud Tasks公式IAM role](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudtasks)

`worker_url`は保護manifestで確定するHTTPS origin。初回起動のaudienceは自サービスURIへのTerraform循環参照を避けて外から指定する。作成後の実URIとの一致、OIDC audience、未認証拒否、両revisionのdigestをliveで確認するまで配信・公開を有効化しない。既存の広いIAM memberは本rootで削除しないため、invokerの実効権限を別途確認する。

Firestoreの通常実行先は専用named DB `realaddr`。`firestore_database_ownership_reviewed=true`は、live inventoryで同名DBが存在せず、配置region・所有権・費用を確認した後だけ指定する。DBは削除保護、Terraformの`prevent_destroy`と`ABANDON`を備え、共有`(default)` DBをimport・管理しない。専用DBのruntime IAM memberと`realaddr_event_outbox`のdue indexを個別に作成する。client Rulesは別gateで、管理主体がnamed release `cloud.firestore/realaddr`へdeny-allをCREATEし、未認証・他利用者拒否を確認してから`firestore_rules_reviewed=true`を指定する。Rules、project API、予算、DNS、deploy SA lifecycle、WIFは本rootで管理しない。

deploy accountへの追加grantは本アプリ2サービスの`roles/run.developer`とweb/worker SAの`roles/iam.serviceAccountUser`だけ。Artifact Registry/state/WIF権限はここで追加しない。Cloud Tasks/SchedulerのGoogle管理service agentと既存APIの権限は管理主体のinventoryで確認する。TasksがOIDC tokenを発行できる権限とScheduler service agentの既存権限を未検証のまま成功扱いしない。本rootはproject全体のservice-agent grantを追加しない。

ローカル検証はbackend無効のinit、fmt、validate、3つのmock-provider plan test。mockは設定境界の検証であり、live接続を証明しない。API有効化・名前の所有・共有IAMとの競合・project外保存先を確認したplan reviewとapplyは別gateである。

## app基盤の実登録結果

app foundationの実applyは17 add・0 update・0 deleteで成功した。live再取得で専用4 service accountがenabled・user-managed key 0、既存project IAM memberの保持、業務bucketのuniform access/public access prevention有効・soft delete 0・7日削除、queueの毎秒1・同時実行1・最大10試行、作成secretのversion 0件を確認した。web/workerの共有default DB限定IAM grantは個別レビュー後に今回の保護設定で有効にした。入力の既定値は引き続きfalseであり、同DB内のcollection隔離を意味しない。

正式termsは未確定で、今回は基盤登録までとの利用者指定に従う。event image、Cloud Run、公開IAM、Scheduler、dispatch、deploy CI/WIFの有効化は行っていない。専用主体のFirestore操作・DB拒否とqueue権限の代表検査は通過し、合成documentと短期grantのcleanupを確認した。Cloud Run invoker、Tasks OIDC、スポンサー、別Firebase利用者のclient試験は未検証。詳しい証跡範囲は実装状況のruntime IAM節を参照する。appのremote post-apply planはdetailed exit code 0で差分なし。state pullの17 resource instance、保護backupとmanifest更新を確認した。T-16全体は未完了。

## named DBへの移行

移行準備のapplyは`firestore_database_id`を明示的に旧DBへ固定し、`retain_legacy_default_access=true`で既存の本アプリ用IAM memberを保持する。新DB・named Rules・indexのreadyを確認し、新imageとDB環境変数を同時に切り替える。必要な本アプリprefixのデータだけを対象とし、共有DBのdocument、Rules、indexは削除しない。切替後に両runtimeの接続とpublic/worker smokeを確認してから、`retain_legacy_default_access=false`で本rootの旧DB向け2 memberだけを除去する。通常deployのguardは`FIRESTORE_DATABASE_ID=realaddr`を要求するため、移行そのものは通常のimage-only更新とは別工程になる。
