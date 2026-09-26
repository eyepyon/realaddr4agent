# eventインフラ準備（T-16）

`bootstrap/`はTerraformの初期基盤rootで、専用state bucket、Docker repository、専用GitHub WIF pool/provider、既存deploy service accountへの限定的なimpersonation member、専用repositoryへのwriter memberを定義する。最初の5資源の登録とGCS state移行は完了し、その後writer memberを追加した。`app/`の基盤applyとコンテナ準備は完了した。このrootだけでサービスは稼働せず、配備の現在地は[実装状況](../docs/implementation-status.md)を参照する。

Terraform 1.14.6、Google provider 8.4.0を固定し、Windows上でfmt、validate、mock test 2件を確認した。lockfileには公式署名を検証したWindows/Linux amd64 packageのchecksumを含む。Linuxでの実行は未検証。作成後のlive metadata確認は下記に記録する。

project、region、bucket名、既存deploy service account、repository名とimmutable repository/owner IDは保護manifestから入力する。実値をリポジトリへ保存しない。認証は管理主体の短期credentialを別途使用し、service account keyやsecret payloadをTerraformへ渡さない。WIFはpool/providerとも既定でdisabled。`wif_enabled=true`には`deploy_workflow_reviewed=true`も必要だが、この確認flagはworkflowと保護されたevent Environmentの実レビューを代替しない。

WIFはimmutable repository/owner ID、repository名、main branch、event Environmentを含むID付きsubject（`repo:OWNER@OWNER-ID/REPO@REPO-ID:environment:event`）、固定deploy workflow ref、workflow_dispatchに限定する。指定deploy accountを作成・import・削除せず、当該account上では本アプリのworkloadIdentityUser memberだけを管理し、他のbindingを保持する。専用Artifact Registryに限定したwriter memberを別途付与する。bootstrapからstate accessやruntime権限を追加せず、既存の実効権限全体が狭いことは保証しない。[GitHubのsubject仕様](https://docs.github.com/en/actions/reference/security/oidc)に従い、名前だけの旧形式を同時に許可しない。

ローカル構文・mock検証:

```sh
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap fmt -check
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```

mock testはGCP認証・通信を行わず、resource設定を検査する。provider取得時のnetworkアクセスとは別である。lockfileを更新する場合はWindows/Linux両platformの公式checksumを取得し、変更をレビューする。

実apply前に[共存ゲート](../docs/infrastructure.md)のread-only inventoryと変更範囲・既存管理主体との競合確認を完了し、API有効化、既存IAMのauthoritative管理との競合、名前の所有者、管理主体だけのstate読書き権限を確認する。bucketのprivate設定は既存project IAMの広いアクセスを除去しない。初回はローカルstateで実行し、その後、バックアップ・移行先所有権・権限・専用prefix `realaddr/event/bootstrap`を確認してGCSへ移行した。現在のrootは値を含まないGCS backendを定義する。versioning保持量と費用を監視する。Terraformのprevent_destroyは設定が削除された場合や外部削除の防止を保証しない。

共有project/API/IAM、Firestore database/rules/index、予算、DNS、既存deploy accountのlifecycleはこのrootの管理対象外。runtime IAMの確認済み範囲は実装状況を参照。実Firebase利用者tokenのclient確認、スポンサー接続、デプロイ確認は残件。Rulesの適用・評価結果は下記に記録する。

実planでは確認済みregionとimmutable repository/owner IDを使用し、WIF pool/providerのdisabled、state bucketのuniform bucket-level access・public access prevention・versioningを確認した。plan・state・実値入り変数は保護されたリポジトリ外に置く。state bucket、Artifact Registry repository、WIF poolの指定名へのGETは各404だったが、全域の名前空きや所有権の証拠にはしない。

指定deploy accountのlifecycleは既存IaCの管理対象であることをsourceで確認した。レビューしたtracked sourceでは別member追加と競合するauthoritative IAM policy/bindingは見つからなかったが、live実効IAMとstate所有権の検証を完了したとは扱わない。Firestoreは現在未使用との運用者確認を得た。管理主体が初期deny-all Rulesを適用した。適用直前にdefault releaseの404を確認し、immutable rulesetとreleaseをCREATEだけで作成した。再取得したlive sourceは管理sourceとbyte一致し、公式Rules engineで未認証・合成した他利用者のget/list/create/update/delete計10件がDENY期待のSUCCESSだった。Authorizationなしの実Firestore REST GETとPOST createもPERMISSION_DENIEDを返し、documentは書かれていない。実際の別Firebase利用者tokenによるclient試験は未実施。server IAM・DB本体・indexは変更していない。 bootstrap初期登録の結果は下記に記録する。

## bootstrap初期登録結果

bootstrap applyは終了code 0で成功し、専用state bucket、Docker repository、無効WIF pool/provider、限定impersonation memberの5件を作成した。live再取得でbucketのuniform bucket-level access=true・public access prevention=enforced・versioning=true、repositoryのDOCKER、WIF pool/providerのdisabled=true、追加memberと既存deploy accountの全従前memberの保持を確認した。local stateと別時刻のbackupは保護されたリポジトリ外にあり、GCSへのstate移行は完了。

初期登録は完了したがT-16全体とアプリ稼働は未完了。Cloud Run/Scheduler配備、deploy workflowの実検証、GitHub event Environment、未検証のCloud Run/Tasks/Scheduler権限と実Firebase他利用者client試験は残件。適用後Terraform planはdetailed exit code 0で差分なし。修正した5型CAI filterのlive検索は終了code 0・metadata 34件を取得した。CAIのeventual freshnessと他regionのScheduler coverageは引き続き確認対象。

## GCS backendとapp準備

bootstrap stateのGCS移行は成功した。移行前backupを保護されたリポジトリ外へ保存し、専用bucketの所有権・空の対象prefix・必要権限を確認した。保護された設定copyで元のlocal backendとstateを初期化してからGCSへ切り替え、`terraform init -migrate-state -force-copy`を実行した。取得したremote stateはlineage・5 resource・outputsが一致し、serialは移行により6から7へ増加した。リポジトリのGCS backendからの後続planは差分0。local backupは復旧専用とし、古いlocal stateでapplyしない。

新しいcloneは短期credentialと保護manifestを別途準備し、既存remote stateへ接続する。backend cacheもリポジトリ外に置く。placeholderを実値へ置き換え、backend設定・変数・plan・state・credentialをGitへ追加しない。

```sh
export TF_DATA_DIR="<protected-backend-cache-directory>"
terraform -chdir=infra/bootstrap init -backend-config="<protected-bootstrap-backend-config>"
terraform -chdir=infra/bootstrap plan -var-file="<protected-bootstrap-variable-file>"
```

backend configは専用state bucketと`prefix = "realaddr/event/bootstrap"`を指定する。app rootは別cacheと`realaddr/event/app`を使う。通常のclone初期化で移行commandを再実行しない。認証不要の検証は別cacheへ`init -backend=false`で初期化し、実plan/applyにはremote backend接続を確認する。

`app/`はweb/worker/tasks/schedの4専用service account、private業務bucket、Cloud Tasks queue、指定したSecret Manager metadata、限定IAMと条件付きCloud Run/Schedulerを定義する。業務bucketは7日でobject削除、versioningなし、soft deleteなし、public access prevention・uniform access・削除防止。queueは同時実行1、毎秒1、最大10試行。secret値/version作成はTerraformで扱わない。共有default DBの`datastore.user` grantは`firestore_access_reviewed=true`をレビュー後に指定した場合だけで、prefixをIAM境界とは扱わない。

`deploy_services`、`runtime_ready`、`web_public`、`scheduler_enabled`、`dispatch_enabled`、`firestore_access_reviewed`、`domain_mapping_reviewed`は既定でfalse。`secret_purposes`も空が既定。基盤のapp applyは17 add・0 update・0 deleteで完了した。service配備には正式なterms、実secret version、同一image digest、worker origin、runtime IAM gateが必要で、公開/dispatch/Schedulerは別の明示的な有効化が必要になる。

## コンテナ準備

DockerfileはNode 22.21.0のofficial registry digestとpnpm 11.19.0を固定し、frozen lockfileで一つのimageをbuildする。entrypointは`node scripts/container-entrypoint.mjs`、引数は`web`（既定）または`worker`。web assetは`/app/apps/web/dist`に同梱する。`.dockerignore`はsource・manifest・lockfile・build設定・公開OpenAPIだけを許可し、`.env`、秘密、state、Git、local build/dependencyを送信しない。Cloud Buildは使わない。

```sh
docker build --build-arg VITE_APP_ENV=local --build-arg VITE_TERMS_VERSION=event-demo-1 -t realaddr-local-check .
```

これはlocal検証用command。端末のDocker daemonは利用できなかったが、Linux CIで同じlocal設定のimage buildとweb/worker起動・拒否確認が通過した。既存Node toolingによる型検査/API/worker/Web buildも通過した。正式terms確定後のevent image build/pushと非公開Cloud Run配備は完了した。run.appでの公開確認は完了し、独自ドメインTLSとスポンサー接続は未完了。

## 通常更新用deploy workflow

`deploy-event.yml`と`scripts/deploy-event.mjs`は既存2サービスのimage更新と、明示的な初回image-only操作を提供する。Cloud Runの初回作成には使わない。正式terms・Secret Manager実version・worker origin・runtime gateを確定してTerraformで初回配備し、web公開とworker専用invokerを実確認してから使用する。image-onlyのworkflowと非公開初回配備は完了した。run.appでの公開前提は確認済みで、独自ドメインTLSは発行待ち。

保護された`event` Environmentの`DEPLOY_CONFIG` Secretへ、[設定契約](../docs/deployment-configuration.md#github-actionsへ渡す値)のtarget metadataをJSONで登録する。runtime secret値やservice account鍵は含めない。専用Artifact Registryのpush権限とruntime actAs・Run更新/検証権限を実確認し、既存bindingを保持したままWIFを別工程で有効化する。EnvironmentやWIFをworkflow自身で作成・有効化しない。

手動実行時の`commit`は選択したmainの完全SHA、`terms_version`は正式versionとする。cloud権限なしのgate jobで同SHAのCI成功を確認し、deploy jobはcloud認証前に保護設定との一致を確認する。既存2サービスの名前・project/region・専用runtime/invoker・default DB/prefix・料金network・terms・numeric secret version・上限・Ready revisionへの100% traffic・旧digestの一致を検査する。不在・不一致ならimage build前に停止する。

検証済みcommitの許可sourceだけを一時build contextへ取り出し、Linux runnerのDockerでbuild/pushする。registryから得た同一digestをworker、webの順にimage属性だけ更新し、IAMと他設定の保持、両Ready revisionのdigest、公開healthと未認証worker拒否を再確認する。更新結果が不明な側も含め、失敗時には試みたサービスを逆順で旧digestへ戻して再照合する。復帰確認の成功・未確認を区別してworkflowは失敗する。runner消失やjob強制終了では復帰処理の実行を保証できないため、live revision/trafficを照合してから再開する。mock検査は実配備・実rollback成功の証拠ではない。

GCPへ接続しない`container-check.yml`はlocal demo設定でimage buildと内部loopback smokeを実施する。こちらの成功や通常CI成功だけでデプロイ完了とは扱わない。

## app基盤の実登録結果

app foundationの実applyは17 add・0 update・0 deleteで成功した。live再取得で専用4 service accountがenabled・user-managed key 0、既存project IAM memberの保持、業務bucketのuniform access/public access prevention有効・soft delete 0・7日削除、queueの毎秒1・同時実行1・最大10試行、作成secretのversion 0件を確認した。web/workerの共有default DB限定IAM grantは個別レビュー後に今回の保護設定で有効にした。入力の既定値は引き続きfalseであり、同DB内のcollection隔離を意味しない。

基盤登録時は正式terms未確定のため配備を保留した。その後realaddr-v1を正式採用し、規約versionの待ち条件は解消した。event image、Cloud Run、公開IAM、Scheduler、dispatch、deploy CI/WIFの有効化は行っていない。専用主体のFirestore操作・DB拒否とqueue権限の代表検査は通過し、合成documentと短期grantのcleanupを確認した。Cloud Run invoker、Tasks OIDC、スポンサー、別Firebase利用者のclient試験は未検証。詳しい証跡範囲は実装状況のruntime IAM節を参照する。appのremote post-apply planはdetailed exit code 0で差分なし。state pullの17 resource instance、保護backupとmanifest更新を確認した。T-16全体は未完了。

## 初回event image-only

手動workflowの`operation`は`deploy`が既定で、初回image作成だけを行う場合は`image-only`を明示する。mainの完全SHA・同SHAのCI成功・正式`realaddr-v1`・保護されたevent設定・専用WIF/workflow条件・承認を両モードで検査する。不明なoperationはcloud認証前に拒否する。

image-onlyは確認したdeploy主体で、本アプリ専用Artifact Registryのname/project/location、DOCKER、STANDARD_REPOSITORY、bootstrapの用途descriptionを照合し、repository get/upload/downloadとdocker image getを実`testIamPermissions`で確認してから、許可sourceだけでevent imageをbuild/pushする。descriptionだけを所有権の証拠にせず、管理主体のlive inventoryと保護manifestによる所有レビューを先に済ませる。Run不在は管理主体の別gateで確認し、このjobのためにproject-wide Run権限を追加しない。jobはRun API、サービス作成・更新、IAM変更、Cloud Buildを呼ばない。

成功時はimageのsha256 digestだけをlogへ出し、projectを含む完全なimage参照はmaskして同stepの`IMAGE_DIGEST` outputへ保存する。実識別子・token・secret値をlogへ表示しない。確定digestを保護manifestのTerraform `image_digest`へ渡す。worker URLは確認済みproject number/region/サービス名から公式deterministic形式で予定値を確定できるが、初回配備後のlive URL一致確認までは配信を有効化しない。通常deployの既存サービス・IAM・revision・rollback検査は変更しない。

## 非公開配備後のドメイン公開

正式`realaddr-v1`のevent image-only workflowでimageを作成し、同一immutable digestを非公開Cloud Run 2サービスへ初回配備した。private構成のlive検証99件は通過した。Scheduler停止・dispatch無効を維持し、Cloud Run公開と公開後100件の確認は完了し、独自ドメインはrouting確認済み・TLS証明書発行待ち。上記の初期登録時点の記録は、その時点の検査範囲を示す。

app rootのdomain mappingは`deploy_services && web_public && domain_mapping_reviewed`の場合だけ作成する。既定falseのreview flagを変更する前に、実domain所有権、専用web target、既存mapping不在とDNS recordをレビューする。固定`address.chain.tokyo`を同project/regionの専用webへ接続し、`force_override=false`・削除防止を維持する。DNSは変更せずユーザー本人が管理する。mappingとmanaged certificateのReady、公開HTTP確認が揃うまでは公開完了としない。

web公開は`web_public=true`の場合だけ専用webの`invoker_iam_disabled=true`で行い、workerは常にfalseとする。`allUsers` grantは作成せず、共有organization policyを変更しない。Cloud Runの認証gateを通過する公開webでも、利用者・管理者・人間承認のserver側認可を維持する。[Cloud Run公式の公開方式](https://docs.cloud.google.com/run/docs/authenticating/public)。

公開適用はwebのinvoker IAM check無効化1 updateとdomain mapping1 createで完了し、post-apply planは差分なし。公開後100件の確認が通過し、workerの未認証・operator呼出し拒否を維持した。独自ドメインはDomainRoutable=True、ReadyはCertificatePendingで、既存CNAMEは期待値と一致した。DNS変更は行っていない。TLS発行完了とスポンサー接続は未確認。
