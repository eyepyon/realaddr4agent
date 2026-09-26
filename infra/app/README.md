# T-16 app root

本rootはTerraform 1.14.6 / Google provider 8.4.0の設定であり、基盤live applyは完了した。Firestore操作・拒否とqueue権限は専用主体で検証済み。サービス起動と配信権限は未検証。bootstrapと別stateを使用する。GCS backendのbucketと`prefix=realaddr/event/app`は保護されたリポジトリ外のbackend設定から渡す。state、plan、実値tfvarsをリポジトリへ置かない。

必須入力は`project_id`、DB配置と照合済みの`region`、所有確認済みの`data_bucket_name`、既存の`deploy_service_account`。デフォルトは4つの専用SA、private業務bucket、queueとresource単位のadditive IAMだけを作るfoundation構成。bucketは7日で削除、versioningなし、soft deleteなし、Terraform削除防止。`secret_purposes`に指定した用途だけsecret metadataを作り、値・versionは作らない。

`deploy_services=false`、`web_public=false`、`scheduler_enabled=false`、`dispatch_enabled=false`、`firestore_access_reviewed=false`が初期値。サービス作成には`deploy_services`と`runtime_ready`、Firestore権限レビュー、digest固定image、検証済み`worker_url`、正式`terms_version`、実登録済みのweb `RATE_LIMIT_HMAC_KEY`版が必要。`secret_versions`はweb/worker別に環境変数名から`{purpose, version}`へ対応させ、numeric versionを指定する。秘密値をTerraformへ渡さない。未接続スポンサー設定は注入せず、現在のAPIは販売を有効化しない。

web/workerは同じimageで異なるNode entrypointを起動する。imageだけを`ignore_changes`にし、通常deployのdigest更新後も他設定の差分を検出する。webはmin=0/max=2/concurrency=20、workerはmin=0/max=1/concurrency=1。両方1 CPU/512MiB、request-based、60秒。workerはtasks/sched専用主体だけinvoker memberを追加し、公開webは明示opt-in。Schedulerはサービス作成時にpausedで作成し、dispatch検証後に有効化する。

web/workerのqueue単位`roles/cloudtasks.enqueuer`を保持し、workerだけへ同queueの`roles/cloudtasks.viewer`を追加する。dispatcherの409・結果不明時のtask GET照合にはenqueuerに含まれない`cloudtasks.tasks.get`が必要。viewerは対象queue/tasksのget/list readも許可し、fullViewはenqueuerにも既に含まれる。web、tasks/sched invokerにはviewerを追加せず、project custom roleも作らない。[Cloud Tasks公式IAM role](https://docs.cloud.google.com/iam/docs/roles-permissions/cloudtasks)

`worker_url`は保護manifestで確定するHTTPS origin。初回起動のaudienceは自サービスURIへのTerraform循環参照を避けて外から指定する。作成後の実URIとの一致、OIDC audience、未認証拒否、両revisionのdigestをliveで確認するまで配信・公開を有効化しない。既存の広いIAM memberは本rootで削除しないため、invokerの実効権限を別途確認する。

Firestoreの通常実行先は専用named DB `realaddr`。`firestore_database_ownership_reviewed=true`はfresh live inventoryで未作成、配置region・所有権・費用を確認した後に適用する。event用named DBを作成し、database delete protection、Terraform `prevent_destroy`と`ABANDON`を設定済み。共有`(default)` DBをimport・管理せず、そのRulesも変更していない。専用DBのruntime IAMをscopedに設定し、`realaddr_event_outbox`のdue index（`state ASC, availableAt ASC`）は作成・ready。Owner order/lease listは、`realaddr_event_orders`の`tenantId ASC, agentId ASC, createdAt DESC, __name__ DESC`と`realaddr_event_leases`の`tenantId ASC, agentId ASC, updatedAt DESC, __name__ DESC`を必要とし、いずれもready。Named DB client Rulesは別gateでdatabase全体deny-allとして適用済み。Rules engine 10件の拒否と匿名GET/POSTのHTTP 403を確認した。実Firebase利用者token試験は別gate。Rules、project API、予算、DNS、deploy SA lifecycle、WIFは本rootで管理しない。

deploy accountへの追加grantは本アプリ2サービスの`roles/run.developer`とweb/worker SAの`roles/iam.serviceAccountUser`だけ。Artifact Registry/state/WIF権限はここで追加しない。Cloud Tasks/SchedulerのGoogle管理service agentと既存APIの権限は管理主体のinventoryで確認する。TasksがOIDC tokenを発行できる権限とScheduler service agentの既存権限を未検証のまま成功扱いしない。本rootはproject全体のservice-agent grantを追加しない。

ローカル検証はbackend無効のinit、fmt、validate、3つのmock-provider plan test。mockは設定境界の検証であり、live接続を証明しない。API有効化・名前の所有・共有IAMとの競合・project外保存先を確認したplan reviewとapplyは別gateである。

## app基盤の実登録結果（当時の確認）

以下はapp foundation直後の状態を記録する。terms・deploy・IAMの進捗は後続のnamed DB migration節と実装状況に従う。

app foundationの実applyは17 add・0 update・0 deleteで成功した。live再取得で専用4 service accountがenabled・user-managed key 0、既存project IAM memberの保持、業務bucketのuniform access/public access prevention有効・soft delete 0・7日削除、queueの毎秒1・同時実行1・最大10試行、作成secretのversion 0件を確認した。過去のfoundation適用ではweb/worker向けFirestore IAMを当時の共有`(default)` DB向けに設定した。現在のnamed database向けIAM確認と切替状況は下記のnamed DB migration節を参照する。この履歴はshared Rules/index変更やcurrent runtime cutoverを意味しない。

正式termsは未確定で、今回は基盤登録までとの利用者指定に従う。event image、Cloud Run、公開IAM、Scheduler、dispatch、deploy CI/WIFの有効化は行っていない。専用主体のFirestore操作・DB拒否とqueue権限の代表検査は通過し、合成documentと短期grantのcleanupを確認した。Cloud Run invoker、Tasks OIDC、スポンサー、別Firebase利用者のclient試験は未検証。詳しい証跡範囲は実装状況のruntime IAM節を参照する。appのremote post-apply planはdetailed exit code 0で差分なし。state pullの17 resource instance、保護backupとmanifest更新を確認した。T-16全体は未完了。

## named DBへの移行とlist indexes

専用`realaddr` DBの作成・削除保護、deny-all client Rules、3つのrequired indexesはready。index契約は`realaddr_event_outbox`（`state ASC, availableAt ASC`）、`realaddr_event_orders`（`tenantId ASC, agentId ASC, createdAt DESC, __name__ DESC`）、`realaddr_event_leases`（`tenantId ASC, agentId ASC, updatedAt DESC, __name__ DESC`）。共有`(default)` DB・Rules・indexは変更しない。

切替は完了した。webを一時非公開にして既存rate limit記録1件を移行・照合し、元データを保持した。worker→webの順に同一immutable imageとDB環境変数を更新した。非公開webでDB readinessを確認後、公開を再開し、最新ready revisionへの100% trafficとhealth/readiness/正式規約の200を確認した。旧DB向け本アプリIAM member 2件だけを除去し、他のruntime設定・共有Rules・元データを保持した。retain_legacy_default_accessは既定falseで、移行中の旧DBアクセス保持だけを明示trueで指定する。

web/workerの短期tokenによるrealaddrのCREATE/GET/PATCH/DELETEと旧(default)へのGET拒否が通過した。試験document・一時grantを削除し、他IAM memberの保持を確認した。切替後Terraform planは差分0。Rules engine・未認証GET/POSTの拒否は別gateとして通過済み。実Firebase利用者tokenによるclient試験は未実施。アプリはrealaddrだけを使い、(default)へfallbackしない。
