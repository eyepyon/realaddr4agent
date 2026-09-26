# eventインフラ準備（T-16）

`bootstrap/`はTerraformのローカル検証用rootで、専用state bucket、Docker repository、専用GitHub WIF pool/providerと既存deploy service accountへの限定的なimpersonation memberだけを定義する。認証済みlive inventoryと実planを確認済み。実planは5 create・0 update・0 destroyで、bootstrap applyと5件の初期登録は完了し、GCS state移行は未実施。`app/`とdeploy workflowは未実装であり、このrootだけでサービスは稼働しない。

Terraform 1.14.6、Google provider 8.4.0を固定し、Windows上でfmt、validate、mock test 2件を確認した。lockfileには公式署名を検証したWindows/Linux amd64 packageのchecksumを含む。Linuxでの実行は未検証。作成後のlive metadata確認は下記に記録する。

project、region、bucket名、既存deploy service account、repository名とimmutable repository/owner IDは保護manifestから入力する。実値をリポジトリへ保存しない。認証は管理主体の短期credentialを別途使用し、service account keyやsecret payloadをTerraformへ渡さない。WIFはpool/providerとも既定でdisabled。`wif_enabled=true`には`deploy_workflow_reviewed=true`も必要だが、この確認flagはworkflowと保護されたevent Environmentの実レビューを代替しない。

WIFはimmutable repository/owner ID、repository名、main branch、event Environmentを含むsubject、固定deploy workflow ref、workflow_dispatchに限定する。指定deploy accountを作成・import・削除しない。IAMは当該accountのworkloadIdentityUser member追加だけで、既存bindingを置換しない。image push、state access、runtime権限は付与しない。既存の実効権限が狭いことを保証する設定ではない。

ローカル構文・mock検証:

```sh
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap fmt -check
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```

mock testはGCP認証・通信を行わず、resource設定を検査する。provider取得時のnetworkアクセスとは別である。lockfileを更新する場合はWindows/Linux両platformの公式checksumを取得し、変更をレビューする。

実apply前に[共存ゲート](../docs/infrastructure.md)のread-only inventoryと変更範囲・既存管理主体との競合確認を完了し、API有効化、既存IAMのauthoritative管理との競合、名前の所有者、管理主体だけのstate読書き権限を確認する。bucketのprivate設定は既存project IAMの広いアクセスを除去しない。初回はローカルstateで実行する契約で、このrootはremote backendを定義しない。stateはバックアップ、移行先所有権、権限、専用prefix `realaddr/event/bootstrap`を確認してから別のレビュー済み手順でGCSへ移行する。versioning保持量と費用を監視する。Terraformのprevent_destroyは設定が削除された場合や外部削除の防止を保証しない。

共有project/API/IAM、Firestore database/rules/index、予算、DNS、既存deploy accountのlifecycleはこのrootの管理対象外。runtime IAM、実Firebase利用者tokenのclient確認、スポンサー接続、デプロイ確認は残件。Rulesの適用・評価結果は下記に記録する。

実planでは確認済みregionとimmutable repository/owner IDを使用し、WIF pool/providerのdisabled、state bucketのuniform bucket-level access・public access prevention・versioningを確認した。plan・state・実値入り変数は保護されたリポジトリ外に置く。state bucket、Artifact Registry repository、WIF poolの指定名へのGETは各404だったが、全域の名前空きや所有権の証拠にはしない。

指定deploy accountのlifecycleは既存IaCの管理対象であることをsourceで確認した。レビューしたtracked sourceでは別member追加と競合するauthoritative IAM policy/bindingは見つからなかったが、live実効IAMとstate所有権の検証を完了したとは扱わない。Firestoreは現在未使用との運用者確認を得た。管理主体が初期deny-all Rulesを適用した。適用直前にdefault releaseの404を確認し、immutable rulesetとreleaseをCREATEだけで作成した。再取得したlive sourceは管理sourceとbyte一致し、公式Rules engineで未認証・合成した他利用者のget/list/create/update/delete計10件がDENY期待のSUCCESSだった。Authorizationなしの実Firestore REST GETとPOST createもPERMISSION_DENIEDを返し、documentは書かれていない。実際の別Firebase利用者tokenによるclient試験は未実施。server IAM・DB本体・indexは変更していない。 bootstrap初期登録の結果は下記に記録する。

## bootstrap初期登録結果

bootstrap applyは終了code 0で成功し、専用state bucket、Docker repository、無効WIF pool/provider、限定impersonation memberの5件を作成した。live再取得でbucketのuniform bucket-level access=true・public access prevention=enforced・versioning=true、repositoryのDOCKER、WIF pool/providerのdisabled=true、追加memberと既存deploy accountの全従前memberの保持を確認した。local stateと別時刻のbackupは保護されたリポジトリ外にあり、GCSへのstate移行は未実施。

初期登録は完了したがT-16全体とアプリ稼働は未完了。infra/app、web/worker/tasks/schedの4 runtime account、Cloud Run、Cloud Tasks/Scheduler、secret metadata、deploy workflow、GitHub event Environment、runtime IAM・実Firebase他利用者client試験、GCS state移行は残件。適用後Terraform planはdetailed exit code 0で差分なし。修正した5型CAI filterのlive検索は終了code 0・metadata 34件を取得した。CAIのeventual freshnessと他regionのScheduler coverageは引き続き確認対象。
