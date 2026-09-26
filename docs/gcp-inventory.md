# GCP read-only inventory（T-16）

`scripts/gcp-inventory.ps1`は共有projectのmetadataを読み取り、保護されたリポジトリ外ディレクトリへUTC付きJSON evidenceを保存する。resource作成・API有効化・設定変更・deploy・secret version access・Firestore document読取は行わない。通常画面へ出すのは成功／不完全の件数だけで、実際のproject・account・resource識別子は文書へ転記しない。

## 実行入力

運用者が確認したproject ID、既存`DEPLOY_SERVICE_ACCOUNT`、レビュー済みgcloud executableの絶対path、新しいevidence directoryの絶対pathをPowerShellの`-ProjectId`、`-DeployServiceAccount`、`-GcloudPath`、`-OutputDirectory`へ渡す。実値入りcommandをリポジトリへ保存しない。事前に対象accountでgcloudへloginし、evidence directoryの親が当該運用者だけに許可された保存領域であることを確認する。このscriptはdirectoryのACLを変更しない。

`-Region`は確認済みregionだけを指定する。省略時は読み取れた`(default)` DBのregional locationのみ使う。multi-regionからregionを推測しない。その場合regional readは不完全と記録し、運用者が配置を決めてから別のevidence directoryへ再実行する。全commandへprojectを明示し、global gcloud project設定を変更しない。

指定deploy accountは同じproject所属に限定する。SDK 586.0.0のAPI error handlerで確認した`CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false`を各read subprocessへ渡し、API有効化promptを無効化する。呼出後は以前のprocess環境値へ戻す。`--quiet`だけにAPI非有効化の保証を依存せず、`--no-log-http`でHTTP credential loggingも無効化する。別SDK版へ変更する場合はこのpropertyとAPI error handlerの動作を再検証する。

## 読み取る範囲

project／billing metadata、enabled API、Firestore database配置・edition・index・field exemption、bucket、Artifact Registry repository、secret metadata、service account、project IAM、指定deploy accountとそのIAM、global WIF pool/providerを読む。Cloud Asset Inventoryでは対象service種別の名前・location・stateだけをproject全域で検索する。regional Run／Tasks／Schedulerは決められたregionのmetadataだけを読み、環境変数・task payload・scheduler body・secret contentsを取らない。

command失敗、権限不足、API無効、JSON解析失敗は`summary.json`の`incomplete`として残し、終了code 2とする。成功した空listも名前が使用可能である証拠にはしない。stderrは保存・表示せず削除するため、原因調査は運用者が当該read commandを保護された環境で個別実行する。summary内のcommand引数にも実識別子が入るのでevidence一式を公開しない。

## 未完了gate

inventoryだけでT-16を完了しない。Asset Inventoryの対応asset type・反映遅延・location coverageを確認し、他regionのresourceと所有者を補完する。共有resourceの所有権、名前衝突、祖先からのgrant・IAM condition・denyを含むdeploy accountの実効権限、account管理主体、既存budget管理は別途確認する。project IAMとservice account IAMの列挙は実効権限評価ではない。

live Rulesの取得・公式engine評価と実未認証read/create拒否は確認済み。実Firebase利用者tokenのclient試験、専用runtime identityのIAM・対象外DB拒否検証はpendingを維持する。既存DB、Rules、project IAM、API、budgetをTerraform管理へ取り込まない。権限不足や読取不能を「resourceなし」「名前が空いている」と扱わない。認証済みの読み取りinventoryは実施済みだが、deployは未実施である。

ローカル検証ではGoogle Cloud CLI 586.0.0の20 commandのhelpを確認し、fixture test 4件が通過した。liveの読み取り結果は次節に記録する。fixtureだけで実権限を証明したとは扱わない。

## 現在の切替状態

後続のfresh inventory時点では、named `realaddr` DBはまだ存在せず、候補regionは既存サービスの配置と一致することを確認した。app Terraformの4-resource planはレビュー済みでapply進行中だが、live creation完了は未確認。実アプリのruntime設定契約は`FIRESTORE_DATABASE_ID=realaddr`で、`(default)`へのfallbackは禁止。Terraformでのnamed DB作成、delete protection / `prevent_destroy`、deny-all client Rules、専用runtime IAM、データ照合・保守移行・joint image/env rolloutとcutoverは未完了である。既存の業務IDや顧客データはrepositoryへ記録しない。

## 過去時点のlive読み取り結果（`(default)`）

当時の認証済みinventoryは20件成功・1件incomplete。過去の対象である共有`(default)` DBはNative mode / Standard edition、locationとbilling状態を確認した。この記録はnamed `realaddr` DBの存在・配置・作成を示さない。Cloud Asset APIが利用できずproject全域の横断検索は未完了。確認regionで専用prefixに一致するresourceが見つからなかったことは、所有権や他regionを含む名前の空きの証拠ではない。

project・organizationと選択済みdeploy service accountのIAM metadataを読み取った。祖先grant、condition、denyを含む実効権限、指定deploy accountのlifecycle管理は既存IaC sourceで確認した。レビューしたtracked sourceではdistinctなadditive IAM memberと競合するauthoritative policy/bindingは見つからなかった。liveの実効権限、他管理主体との競合、state所有権の検証は未完了である。

Rules RESTは明示的なquota project headerで読取可能となった。release一覧にFirestore releaseはなく、`cloud.firestore`と`cloud.firestore/(default)`の両形式のGETは404だった。Authorization headerなしのFirestore REST GETは`PERMISSION_DENIED` / `Missing or insufficient permissions`を返した。この結果は対象の未認証read拒否だけを示し、live Rules sourceの取得・評価、他利用者のread/write拒否を証明しない。この時点では共存gateはpendingとし、Rulesの不在をdeny-allへ読み替えなかった。後続の初期適用結果は下記に記録する。

初回inventoryではAPI有効化、resource作成、IAM・Rules・DNS変更、apply・deployは行っていなかった。専用runtime identityのIAMと対象外DB拒否も未検証である。
command契約の一次資料: [Cloud Asset metadata search](https://docs.cloud.google.com/sdk/gcloud/reference/asset/search-all-resources)、[Firestore composite index list](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/indexes/composite/list)、[field exemption commands](https://docs.cloud.google.com/sdk/gcloud/reference/firestore/indexes/fields)、[WIF provider list](https://docs.cloud.google.com/sdk/gcloud/reference/iam/workload-identity-pools/providers/list)、[Artifact Registry repository list](https://docs.cloud.google.com/sdk/gcloud/reference/artifacts/repositories/list)。実gcloud版でのhelpと実接続結果を検証するまではlive成功済みとしない。

## 過去時点のbootstrap planと指定名の確認

実planは5 create・0 update・0 destroy。確認済みregionとimmutable repository/owner IDを使い、WIF pool/providerはdisabled、state bucketはuniform bucket-level access・public access prevention・versioningを備える。plan・local state・実値入り変数は保護されたリポジトリ外に保存する。指定state bucket、Artifact Registry repository、WIF poolへのGETは各404だった。Cloud Assetの横断検索未完了を補う全域の所有権・名前空き証明とは扱わない。

この段落は過去時点の共有`(default)` Firestore調査であり、named `realaddr` DBの作成結果ではない。Firestoreは当時未使用との運用者確認を得たが、他identityのアクセス不可やstate所有権を証明したとは扱わない。管理主体が初期deny-all Rulesを適用した。適用直前にdefault releaseの404を確認し、immutable rulesetとreleaseをCREATEだけで作成した。再取得したlive sourceは管理sourceとbyte一致し、公式Rules engineで未認証・合成した他利用者のget/list/create/update/delete計10件がDENY期待のSUCCESSだった。Authorizationなしの実Firestore REST GETとPOST createもPERMISSION_DENIEDを返し、documentは書かれていない。実際の別Firebase利用者tokenによるclient試験は未実施。server IAM・DB本体・indexは変更していない。

Cloud Asset APIは運用手順で有効化した。横断inventoryの再確認は進行中で、初回20件成功・1件incompleteを完了結果へ読み替えない。既存budget一件を読み取り、変更していない。bootstrap applyと5件の専用resource初期登録は完了し、app resource・DNS・deploy、live実効IAMとruntime IAMは残件。

Cloud Assetの型filterから非対応のCloud Scheduler Jobを除いた。Schedulerは選択regionのmetadata listを維持し、他regionは別途確認する。対応asset型だけの横断検索も鮮度・網羅性の限界を持つ。[公式asset型一覧](https://docs.cloud.google.com/asset-inventory/docs/asset-types)にScheduler Jobは掲載されていない。運用手順によるfilterなしのmetadata検索では対応assetを取得し、専用prefixの一致はなかったが、未対応型や他regionのSchedulerの不在を証明しない。Run service 14件、Tasks queue 2件、repository 4件、bucket 5件、secret metadata 7件を読み取った。

選択deploy accountのresource grantは15件（Run developer 6、serviceAccountUser 6、Artifact Registry writer 1、secretAccessor 1、KMS publicKeyViewer 1）をliveで確認した。project・organizationの直接grantは見つからなかったが、継承・condition・denyを含む実効権限が最小である証明にはしない。

## bootstrap初期登録結果

bootstrap applyは終了code 0で成功し、専用state bucket、Docker repository、無効WIF pool/provider、限定impersonation memberの5件を作成した。live再取得でbucketのuniform bucket-level access=true・public access prevention=enforced・versioning=true、repositoryのDOCKER、WIF pool/providerのdisabled=true、追加memberと既存deploy accountの全従前memberの保持を確認した。local stateと別時刻のbackupは保護されたリポジトリ外にあり、GCSへのstate移行は未実施。

初期登録は完了したがT-16全体とアプリ稼働は未完了。infra/app、web/worker/tasks/schedの4 runtime account、Cloud Run、Cloud Tasks/Scheduler、secret metadata、deploy workflow、GitHub event Environment、runtime IAM・実Firebase他利用者client試験、GCS state移行は残件。適用後Terraform planはdetailed exit code 0で差分なし。修正した5型CAI filterのlive検索は終了code 0・metadata 34件を取得した。CAIのeventual freshnessと他regionのScheduler coverageは引き続き確認対象。
