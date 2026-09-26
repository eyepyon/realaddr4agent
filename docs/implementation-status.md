# 実装状況

実装開始: 2026-09-26。仕様上の完成条件と、実装・検証できた範囲を区別する。[タスク一覧](../.kiro/specs/realaddr/tasks.md)のチェックはタスク全体の証跡が揃ったときに更新する。

## 現在の作業

| 対象 | 状態 | 範囲 |
| --- | --- | --- |
| T-01 実行基盤 | 実装中 | pnpm workspace、strict TypeScript、Fastify、web/worker、共通CLI、CI workflowとローカル`.env.example`を作成。全経路の起動確認は未完了 |
| T-02 認証・Firestore・区画 | 部分実装 | wallet challenge、Bearer hash、collection prefix、64 shard予約に加え、住所購入の決済受付・不明状態保持・確定後の契約発行・未払い確定後のhold解放をrepositoryへ実装。外部の検証済み結果を受け取る内部DB境界であり、実決済・外部照合・返金は未実装。更新の内部DB処理はT-05として追加 |
| T-05 住所更新 | 部分実装・ローカル検証済み | 同一leaseの更新排他、固定見積、確定支払いの一度だけの反映、結果不明保持、保存済みreceiptからのworker復旧。公開更新API・実決済・chain/ENS同期は未接続 |
| T-02/T-08 所有者向け状態取得 | 部分実装・ローカル検証済み | 注文・契約の一覧と詳細、ENS購入状態をFirestoreから返す。所有権、応答の公開field制限、署名付きcursor、既存CLIの状態取得を確認 |
| T-05/T-16 worker・outbox | 部分実装・ローカル検証済み | Firestore claim/generation/期限、保存済み支払いからの発行復旧、Cloud Tasks REST配信・結果照合とSchedulerの永続cursor。実送金・chain同期・実Cloud Tasks/Scheduler接続は未検証 |
| T-08/T-18/T-19 UI | 部分着手 | 公開HTML/AEO、標準SaaSの画面、実APIへの接続。業務統合・実管理者ログインは別途 |
| T-02/T-08/T-19 利用規約 | v1正式採用・event配信確認済み | realaddr-v1として15条を正式採用。単一Markdownから/termsへ初期HTML配信し、正式versionの同意欄・API/build/deploy設定を一致させる。提供開始準備と実利用者の同意確認は別途 |
| T-00 外部連携 | 一部のread-only疎通を確認・全体未完了 | MultiBaas status APIでEthereum Sepolia (chain ID 11155111)との一致を確認。registry設定、contract権限とread/write/event操作は未確認。World、Intercepta、x402、ENS、管理者OIDCの必要設定も揃っていない |
| T-16 GCP | 独自ドメインHTTPS確認済み・全体未完了 | WIFとeventイメージbuild/push、runtime IAM検査、初回Cloud Run配備、公開後100項目と後続plan差分0を確認。TLS発行・独自ドメイン8経路の表示と拒否を確認。Tasks/Schedulerの実配信、実Firebase利用者client試験、外部業務連携は残件 |

## 検証の記録

### T-00 MultiBaas status 照会

既存の非追跡設定を使い、公式MultiBaas `GET /api/v0/chains/ethereum/status`を照会した。初回はHTTP 200と応答schema検証を確認したが、chain ID 11155111との不一致だった。設定更新後の再検査では、接続設定有効、照会試行、HTTP 200、応答schema検証通過、CLI終了code 0と成功結果を確認し、Ethereum Sepolia (chain ID 11155111)との一致を確認した。contract権限、read/write/event操作、registry設定は未検証。書き込み・送金は行っていない。外部業務統合と販売・登録等の業務操作は引き続き未完了・閉じたままとする。

### T-16 eventサービスの初回配備

限定WIFによるGitHubの実認証、専用Artifact Registryへのeventイメージbuild/pushが成功した。同じimmutable digestをweb/workerへ非公開で初回配備し、専用実行アカウント、起動用secretの数値version参照、規約 `realaddr-v1` を反映した。Schedulerは停止、Tasks dispatchは無効を維持している。

live検査99項目が通過した。両サービスのReady・revision・image一致、min=0とmax web=2/worker=1、CPU idle、環境変数とIAM、未認証拒否を確認した。認証したwebではhealth、Firestore readiness、規約両URLの200と全文末尾・index方針、appのno-store/noindexを確認し、workerでは許可されていない管理用本人tokenも拒否された。実Tasks/SchedulerのOIDC配信、実利用者のwallet同意、スポンサー接続、販売・ENS発行はこの検査に含まない。

Schedulerの明示的な空のretry設定はAPIが省略して返すため、設定を省略し、API既定のretry回数・期間とも0を使用するよう修正した。動作を変えずにprivate構成の後続plan差分0を確認した。Terraform fmt/validate/mock 5件が通過した。

webの `allUsers` IAM追加は共有環境のdomain-restricted sharingに拒否され、その試行では公開IAMとドメイン割当は作成されなかった。共有ポリシーは変更していない。実効 `run.managed.requireInvokerIam` が強制されていないことを読み取り確認し、[Google公式のサービス単位の公開方式](https://docs.cloud.google.com/run/docs/authenticating/public)に合わせてwebだけのInvoker IAM検査を無効化した。workerのIAM検査・限定invokerとアプリの認証を維持する。通常deployの事前検査もこの方式を許可し、workerの検査無効化や不明な設定値・混在方式を拒否する。限定テスト18件が通過した。

web公開設定1更新と専用ドメイン割当1作成を適用し、後続plan差分0を確認した。DNS変更はしていない。公開後のlive検査100項目が通過し、未認証webでhealth・Firestore readiness・正式規約とprivate画面のcache/index制御を確認、workerへの未認証と許可されていない本人tokenは拒否された。

証明書発行後、独自ドメインのReady・CertificateProvisioned・DomainRoutableがすべてTrue、既存CNAMEが要求値と一致することを確認した。HTTPSで `/`・`/health`・`/ready`・`/terms`・`/terms/`・`/developers`・`/app` の200、未認証 `/v1/locations` の401を確認。規約v1本文とindex方針、private画面のno-store/noindexも通過した。利用者による公開画面の確認も得た。配備設定commitの通常CIは成功した。実決済、World承認、ENS登録を含む完成を意味しない。

通常deployのメタデータ検査を実サービス応答に合わせた。worker originは主URLまたはCloud Runが返す正規URL一覧との完全一致だけを許可し、不正JSON・未知URL等を拒否する。v2で無効を確認したstartup CPU boostがv1では省略される応答に対応し、有効・不明値を拒否する。限定テスト21件が通過した。取得した実web/worker・IAM・revisionメタデータを通常deployと同じ検査関数へ渡して通過を確認した。この読み取り検査はdeploy主体での実更新・rollback試験を代替しない。

### T-16 初回eventイメージと配備準備

CI成功後のlive確認では専用web/workerとイメージは存在せず、配備完了ではなかった。正式termsの確定を受け、既存deploy workflowへ明示的な `image-only` 操作を追加した。mainの同一SHAのCI成功・保護されたevent Environment・限定WIF・正式terms検査を維持し、専用Artifact Registryのmetadataと実upload/download等の権限を検査してからイメージを作成する。この操作はRun APIやIAM変更を呼ばず、サービスの作成は管理主体によるTerraformの別工程とする。通常更新の事前検査・rollback経路は維持した。

deploy scriptの限定mockテスト14件、構文検査が通過した。無効operation、対象repo不一致、権限不足の拒否、image-onlyがRun/IAM操作を行わないことを追加確認した。専用repoだけのwriter IAM memberをbootstrapへ追加し、fmt・validate・mock 2件が通過した。live planはwriter member 1追加とWIF pool/providerのdisabled属性2更新だけで、共有資源の変更・削除は含まない。

main branchだけを許可するGitHub event Environmentと保護された配備設定を登録し、既存の本アプリ専用Secret Managerへランダムな起動用秘密値を1版登録した。値はTerraform、ログ、リポジトリへ保存しない。WIF apply、イメージbuild/push、Run作成と実配信の結果は後続の実行記録で確認する。

image-only追加commitの通常CIは成功した。WIF有効化2件と専用repo writer member追加1件は個別承認後に適用し、live設定と後続plan差分0を確認した。GitHub Environment/保護設定/起動用secret versionの登録と、デプロイ成功を区別する。初回サービス配備はまず非公開・dispatch無効・Scheduler停止で計画し、起動と権限の実検査後にweb公開を判断する。

初回image-only実行はWIFのattribute conditionで拒否された。新規repositoryのGitHub OIDC subjectにはimmutable owner/repository IDが含まれるため、名前のみの旧subjectからID付きの厳密なsubjectへ修正した。providerと本アプリのimpersonation memberだけを更新し、他の既存bindingの保持と後続plan差分0を確認した。許可するrepo・main・event・workflow・手動実行の範囲は拡張していない。workflowにtokenやclaim値を出力しない8項目の一致確認を追加した。限定テスト15件、bootstrap fmt/validate/mock 2件が通過した。以降の実認証・image作成結果は後続記録で確認する。

### 利用規約バージョン1の正式採用

2026-09-26に本文15条を `realaddr-v1` として正式採用した。原案用の前文と表示を正式版へ置換し、本versionの提示・同意から適用する。過去の開発用署名は正式同意に読み替えない。`/terms` はindex対象の初期HTMLとし、nav/footer、同意欄、sitemap、llms.txtから参照する。API・Web build・deployは共通の承認済version定数との一致を要求する。本文のversion行と定数の一致もbuild時に確認する。

Web/APIの型検査、local demoと正式event設定のWeb buildが通過した。本文の全非空行が初期HTMLへ含まれること、正式版表示、index/followとsitemap/llms掲載を確認した。eventのversion欠落・開発用版・不一致のWeb build拒否、API設定テスト3件、deploy script限定テスト10件が通過した。通常CIのWeb buildにはlocal demo設定を明示し、local認証条件と正式規約の同意を画面で区別した。container smokeを正式versionとindex方針の確認へ更新し、構文検査も通過した。

DBに接続しないFastify injectで `/terms` と `/terms/` の両200、正式version・第15条を含むHTML、metaのindex/follow、HTTPのnoindex headerがないことを確認した。

v1反映commitの通常CIとLinux container checkが成功した。local demo imageの実build/runで、正式規約の配信・index方針、web health、worker未認証拒否と未知role拒否を確認し、検査用container/imageをcleanupした。これはevent imageの配備や実利用者の同意の検証ではない。

正式version未確定の待ち条件は解消した。保護された配備設定・実runtimeへの反映、実wallet同意操作、公開originへの到達、GCPへのevent image配備はこの変更では実施していない。問い合わせ窓口・プライバシー案内等の提供準備は[採用記録と提供準備](terms-review.md)に残す。以降の原案・基盤節にあるterms未確定の記載は、その作業当時の記録である。

### 利用規約原案の反映（v1採用前の記録）

以下は原案時点の検証記録。現在は正式v1へ移行しており、原案のnoindex・version未確定という条件は適用しない。[採用記録](terms-review.md)を参照。

[規約原案](terms.md)を新規作成し、[正式採用前の確認事項](terms-review.md)を整理した。同じ宛先への適用済み同意と支払いで決まる利用期間を分離し、testnet料金、任意ENS追加、限定的な発行失敗返金、実郵便を扱わない範囲を既存仕様と照合した。法的適法性の確認が済んだことを意味しない。

Web/APIの型検査とlocal設定のWeb buildが通過した。原案の全非空行をescape後の生成HTMLと比較し、15条の全文、原案識別子、未施行・非同意対象の説明を初期HTMLで確認した。DB未接続のAPI injectで `/terms`・`/terms/` がともに200、HTML本文の一致、Content-Type、`X-Robots-Tag: noindex, follow` を確認した。HTMLのnoindex、公開ページのリンク、sitemap/llms.txtからの除外も確認した。deploy scriptの既存限定テスト10件も通過した。

Docker contextとgit archiveの対象へ本文を追加し、本文変更でLinux container CIが動くようにした。正式TERMS_VERSIONや保護された設定を変更しておらず、event image作成・push・Cloud Run配備は行っていない。ブラウザの目視、公開originへの到達、正式版への同意・本文version対応の本番検証は未実施。タスク全体の完了チェックは付けない。

原案を反映した同一commitで通常CIとLinux container checkが成功した。後者はlocal demo imageを実build/runし、webの `/terms` が200で原案識別子と第15条を含むこと、HTTPとHTMLの両方がnoindexであることを確認した。従来のweb health、worker未認証拒否、未知role拒否も通過し、作成したcontainer/imageをcleanupした。外部のDB・決済・GCP配備を行う検査ではない。

Node.js 22.21.0、pnpm 11.19.0を確認。Firestore Emulator 1.22.0をGoogle公式配布物から取得し、SHA-256 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`を検証した。Java 21でローカルの`127.0.0.1:8085`へ起動し、架空project `demo-realaddr-local`を使用する。実GCPのFirestoreや利用者データには接続していない。Emulatorを指定した`pnpm test`は2件通過、skip 0。内容はfloor境界/prefix拒否、challenge再使用拒否、tenant所有権、同一floorの並行予約、rate bucketと空き数である。payment・World・ENSの実接続結果を含まない。

rootの`pnpm typecheck`は全6 package、`pnpm build`はAPI/worker/CLI/Webで通過した。Web buildには`VITE_APP_ENV=local`を指定した。`node scripts/check-text-format.mjs`も通過した。Emulatorへ接続したHTTP smokeでは`/health`・`/ready`が200、未認証のlocationsが401、未知routeが404、テスト用EOAのchallenge/sessionが201、認証済みlocationsが200、challenge再使用が403、credential失効が204で旧tokenが401、worker内部routeの未認証アクセスが401だった。build済み共通CLIを直接`node`で起動した`health --json`も確認した。HTTP header確認では`/admin`が200・`no-store`、`/auth/admin/start`が503・`no-store`、`/developers`が200・service descriptionへの`Link`付き、存在しないassetが404・`no-store`だった。ブラウザでは白・青の公開ホーム、`/developers`、`/faq`の遷移と`/app`・`/admin`の認証前ゲートを確認し、新しいbuild済みserver tabでwarn/error logは記録されなかった。wallet UI操作とGoogle管理者ログイン成功は未検証。これらはlocalだけの結果であり外部スポンサー連携を含まない。CIの`pnpm test`は現状Firestore Emulatorを起動しないため、DB transactionテストはskipされる。ローカルで`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`を渡した実行結果とCI結果を混同しない。Docker daemonは利用できず、container imageの検証は未実施。

外部スポンサーの認証・決済・発行、Google管理者認証、GCP公開、3ツールからの縦断デモは未実施。

## T-02 住所購入のDB状態遷移

変更: `packages/db/src/repository.ts`、`packages/db/test/purchase-lifecycle.test.ts`。公開HTTPの購入・支払いrouteは引き続き`integration_unavailable`を返す。以下は信頼できるserver adapterから検証結果を受け取る内部処理であり、`verified`フラグをclientから受け付けるAPIではない。テストの検証結果fixtureはローカルの入力例で、スポンサーの実応答・決済成功の証跡ではない。

- 固定見積、payer、支払い認可nonce、支払先/payerの新鮮なallow判定を照合し、暗号化payload・payment・nonce guard・settlement outboxを同一transactionで保存する。既存支払いの再送では新しいsettle jobを作らない。
- 結果不明はorder=`reconciling`、payment=`unknown`として、期限後も区画・wallet quota・予約日の予算を保持する。
- finality確認済みreceiptのnetwork/asset/payer/payTo/amount/nonceを照合し、Transfer識別子のguard、契約、disabledのmail profile、bitmap、quota、予約日の予算消費、registry outboxを原子的に確定する。住所購入だけではENS entitlement/jobを作らない。
- 発行時の区画・quota等が不整合なら支払い証跡をconfirmedとして保持し、注文を`manual_review`、復旧jobをpendingにする。同じ支払いから復旧し、元の確定時刻と30日間を変えない。
- 未送信の期限切れ予約、またはprovider/chainによる未払い確定・認可の終了が検証された予約だけを一度解放する。結果不明、時刻経過、単なる未検出だけでは解放しない。

検証はFirestore Emulator 1.22.0を使い、既存2件と追加5件の計7件が通過（skip 0）。同時確定の一契約化、nonce/Transfer使い回し拒否、他tenant/価格/payer/risk不一致の拒否、期限後の不明決済保持、元の日付bucketへの解放、確認済み支払いの復旧を確認した。再起動相当の確認は同じEmulatorへ新しいrepository instanceを接続する範囲であり、API/workerの停止・再起動やCloud Run復旧の実証ではない。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @realaddr/db test:emulator`（環境変数を設定して実行） | 7件通過・skip 0 | `packages/db/test/purchase-lifecycle.test.ts`、`packages/db/test/repository.test.ts` |
| `pnpm typecheck` | 通過 | 全6 package |
| `VITE_APP_ENV=local pnpm build`（環境変数を設定して実行） | 通過 | API/worker/CLI/Web |
| `node scripts/check-text-format.mjs` / `git diff --check` | 通過 | 作業ファイルのUTF-8・BOMなし・LFと差分 |

未実施・残件: 実providerによる認可/receipt/finality確認、payloadの実暗号化adapter、送金直前の再検査、Tasks配信・外部結果の照合、住所renew、自動返金、人間承認・宛先アクセス、実環境の復旧。worker claimと保存済み支払いからの復旧は次節で追加した。CIは引き続きEmulatorを起動しないためDBチェックがskipされる。T-02/T-05全体の完了チェックは付けない。

## T-05/T-16 永続outboxとHTTP worker

変更: `packages/db/src/outbox.ts`、`packages/db/src/repository.ts`、`apps/worker/`と関連テスト・依存定義。既存versionのFirestoreとworkspace DB packageをworkerへ追加し、新しいprovider SDKは追加していない。

- claimは60秒、owner/generation/期限をtransaction内で検査する。競合時は一つだけ取得し、期限切れ処理の再取得は`reconciliationOnly`を保持する。5回で`manual_review`へ保留し、既存の管理用projectionも同時に更新する。候補照会は最大20件で、全件走査しない。
- `/tasks/run`は専用Tasks invokerのGoogle OIDCだけを受け付け、bodyは`outboxId`だけ。追加のreceipt/verified等は削除して受理せず400で拒否する。Schedulerの主体をTasksの主体として使えない。
- 実行できる処理は`payment.issuance_recovery_requested`。保存済みpaymentの確認証跡を読み、現在のclaim・order version・復旧jobとの一致を確認した同じtransactionで契約を発行する。復旧時に呼出側のreceiptで上書きせず、直接のconfirm再送でclaim検査を迂回できない。発行できなければ再試行・保留を継続する。
- 未接続の送金・registry・ENS handlerは`handler_unavailable`として永続的に再試行・保留し、成功や契約発行を作らない。HTTP応答はDB処理の完了を待ち、応答後に業務処理を続けるタイマーは作らない。
- この段階では`/scheduler/sweep`と終端ACKは未実装だった。次節の配信処理でScheduler入口と終端ACKを追加した。実queueのretry上限の検証は引き続き未実施。

workerの環境変数は`APP_ENV=local|event`、`RESOURCE_PREFIX=realaddr-event`、`FIRESTORE_COLLECTION_PREFIX=realaddr_event_`、`FIRESTORE_DATABASE_ID=(default)`、`GCP_PROJECT_ID`、`WORKER_URL`、`TASK_INVOKER_SA`、`SCHEDULER_INVOKER_SA`。localはdemo projectとEmulator必須。eventはHTTPS audienceと専用invoker必須で、現実装は同projectの基本名`realaddr-event-tasks`/`realaddr-event-sched`を要求する。production/mainnetは起動しない。`.env`は自動読込せず、起動プロセスの環境へ設定する。Google token検証の差し替えはlocalのテスト用factory引数だけで、環境変数による認証迂回はない。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| `FIRESTORE_EMULATOR_HOST`を設定し、DB packageで固定済み`tsx --test test/*.test.ts` | 11件通過・skip 0 | 既存7件＋`packages/db/test/outbox.test.ts`の4件。競合claim、古い実行権拒否、再試行上限、保存済み支払いからの復旧 |
| 固定済み`tsx --test apps/worker/test/*.test.ts` | 5件通過 | `apps/worker/test/worker.test.ts`。認証・role分離・body制約・未接続handler・復旧待ち。Google認証はunit用差替えで、実OIDC成功ではない |
| 固定済み`tsc -p`を各workspaceのtsconfigへ実行 | 全6 package通過 | workerのtestも型検査対象 |
| 各package定義の固定済み`esbuild`とWebの`node scripts/build.mjs`（`VITE_APP_ENV=local`） | API/worker/CLI/Web通過 | workspace DBコードをworkerへbundleし、runtimeの未配置TS source importを残さない |
| build済みworkerをlocal設定で起動し、未認証で`POST /tasks/run` | 401・no-store | 実プロセス起動確認。テスト後停止。実Google tokenによる呼出は未実施 |

依存関係はoffline frozen installで固定済み205 packageをcacheから復元した。当該実行環境ではpnpmの実行前検査が依存再配置を要求するため、今回の最終チェックはインストール済みの固定versionの実行ファイルを直接使った。テストのfixture・認証差替えは実スポンサー接続の証跡ではない。Firestoreの複合index配備、実Cloud Tasks/Scheduler/OIDC、実providerの送金・照合、Docker image起動、Cloud Runのmin=0復帰は未検証であり、T-05/T-16を完了扱いにしない。

## T-16 Cloud Tasks配信とScheduler回復

変更: `packages/db/src/dispatch.ts`、`apps/worker/src/dispatcher.ts`とworkerの設定・HTTP入口。Cloud Tasksの実queue作成や呼出は行っていない。ローカルのtransport差替えは配信契約のテスト用であり、実接続の証跡ではない。

- 実行claimとは別に配信claimとtask IDをFirestoreへ保存してから、transactionの外でCloud Tasks RESTを呼ぶ。応答不明では同じtask IDを保持する。重複エラーではtaskを照会し、存在確認と削除済みIDの区別を行う。queueへの登録確認を決済成功・契約発行とは扱わない。
- Schedulerは専用の実行権とcursor、巡回開始時の対象時刻上限を保存し、due outboxを時刻・document ID順で最大20件読む。継続位置を次回呼出へ引き継ぎ、末尾で先頭へ戻す。巡回中の新規jobは次の巡回へ回す。個別の失敗で後続jobを恒久的に塞がない。
- 配信の再試行間隔は5秒から最大300秒、累計10回でoutboxと対応する管理projectionを`manual_review`へ保留する。支払い証跡やholdを変更しない。業務実行の上限5回とは別に管理する。
- 完了・置換済み・要確認・存在しないoutboxの再配信には、それぞれの状態を示してHTTP 200で配信を終了する。要確認を`fulfilled`として返さない。処理中・未到来のjobは503で再試行する。
- 実配信は既定で無効。eventの明示設定、専用queue、専用worker identityのmetadata照合を必要とし、配信の認証に鍵ファイルやローカルADCを使わない。外部リクエストには中断期限を設定し、開始済みのローカル処理をawaitしてからHTTP応答する。外部側の処理中断を保証したとは扱わず、結果不明を保存する。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| `FIRESTORE_EMULATOR_HOST`を設定し、DB packageで固定済み`tsx --test test/*.test.ts` | 14件通過・skip 0 | 既存11件＋dispatchの競合、応答不明のID保持、期限切れ実行権の拒否、cursorと時刻上限、再試行上限・payment保持 |
| 同じEmulatorを設定し、固定済み`tsx --test apps/worker/test/*.test.ts` | 12件通過・skip 0 | 認証・終端ACK・設定拒否・REST形状・metadata主体不一致。実DBとテスト用transportを組み合わせたtimeout→409/存在確認→404/世代更新も確認 |
| 固定済み`tsc -p`を各workspaceのtsconfigへ実行 | 全6 package通過 | DB・workerと依存側の型検査 |
| package定義の固定済み`esbuild` | API/worker通過 | 変更したDB exportを含めてbundle。CLI/Webはこの変更で再buildしていない |
| build済みworkerをlocalで起動、未認証POSTを2経路へ送信 | 両方401・no-store | `/tasks/run`、`/scheduler/sweep`。確認後workerとEmulatorを停止 |
| `node scripts/check-text-format.mjs` / `git diff --check` | 通過 | 作業ファイルのUTF-8・BOMなし・LFと差分 |

この段階ではlive inventoryも未実施だった。後続のinventory結果はT-16節に記録し、runtime IAMとclient Rules、prefixed index、実OIDC、実Cloud Tasks/Scheduler、Cloud Run停止復旧は未検証のままとする。25秒を超えたらsweepの新規job開始を止めるが、Firestore遅延時を含む実環境の要求期限内完了は未検証。公開購入APIは引き続き販売を拒否し、T-05/T-16の完了チェックは付けない。

## T-02/T-08 所有者向け状態取得

変更: `packages/db/src/owner-reads.ts`、`apps/api/src/owner-cursor.ts`、`apps/api/src/server.ts`と関連テスト。既存CLIと利用者画面が呼ぶGETのうち、payment-intentとsubscriptionの一覧・詳細、subscriptionのENS状態を接続した。公開HTTPの購入・支払い・人間承認・宛先書込は有効化していない。

- tenant、agent、owner walletが一致する注文・契約だけを読み、他者と不存在は同じ404にする。関連するpayment、risk、mail、ENS entitlementをread-only transactionで整合した状態から読む。
- 明示した公開fieldだけで応答を作り、転送先全文・暗号文・World識別子・署名payload・nonceを返さない。契約住所は購入時のsnapshotから返し、仮想区画を`V00042`形式で区別する。
- 注文は作成時刻降順、契約は更新時刻降順とし、同時刻はdocument ID降順。1〜100件にlookaheadを1件だけ追加する。署名付きcursorを所有者・endpoint・sort・limitに固定し、改ざんや他の条件への使い回しを拒否する。
- 期限切れのactive契約はGETでexpiredとして返すが、DB更新・区画解放は行わない。支払い結果不明の注文を期限だけで未払い扱いにしない。
- ENS未購入と購入済み確認待ちを分離する。外部確認adapterがない状態でreadyを返さず、保存済み文字列だけでENSの利用権を認めない。mailのenabled状態やchainの同期済み状態は、対応する検証統合まで503で拒否する。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| Emulatorを指定して固定済み`tsx --test packages/db/test/owner-reads.test.ts apps/api/test/owner-reads.test.ts` | 3件通過・skip 0 | DBの2件とAPIの1件。tenant/agent/wallet不一致拒否、秘匿field除外、同時刻のページ送り、cursor改ざん・他条件への流用拒否、期限導出、receiptのfinality/価格不一致拒否、ENSの未購入/確認待ち/返金状態 |
| APIチェック内で実HTTP listenerと共通CLIを起動 | `lease status`と`intent status`通過 | テスト用Bearer資格情報でローカルAPIを呼び、JSON出力を確認。実決済・スポンサー疎通や3ツールのliveデモではない |
| API応答をOpenAPI schemaで確認 | 通過 | Lease/Order/EnsStatusのrequired・field型・enum・追加field拒否。AJVのformat検証は無効とし、日時/UUID等は実装側で検査 |
| 固定済み`tsc -p`を各workspaceへ実行 | 全6 package通過 | APIのテストも型検査に追加 |
| 固定済み`esbuild`によるAPI/worker build | 通過 | 共通DB exportの変更を含む。CLI/Webの再buildとブラウザの目視操作はこの変更では未実施 |
| `node scripts/check-text-format.mjs` / `git diff --check` | 通過 | UTF-8・BOMなし・LF、差分確認 |

今回のテストは保存済み状態のローカルfixtureを使い、スポンサー応答を模擬して販売を開くものではない。既存の決済・outboxテスト全体は前節の実行結果とし、今回は変更箇所の重点チェックに限定した。CIはEmulatorを起動しないため、追加したAPI/DB統合チェックも通常CIではskipされる。実provider接続、人間承認、実GCPのprefixed index配備、3ツールのlive縦断デモは未実施。T-02/T-08全体の完了チェックは付けない。

## T-05 同一住所契約の更新

変更: `packages/db/src/repository.ts`、`packages/db/test/renewal.test.ts`、workerの復旧routeとテスト。購入・更新で認可、riskの鮮度確認、nonce guardを共有する。公開intent/payは引き続き503で、以下は信頼できるserver adapter向け内部DB境界のローカル検証である。

- 同じownerのactive/expired leaseだけに更新見積を作り、lease version・旧期限・住所・区画・価格を固定する。同一leaseの未解決更新を一件に制限し、新規区画・wallet hold quota・日次新規購入枠を消費しない。
- 確定支払いは同じleaseへ一度だけ反映し、期限を`max(旧期限, 元の支払い確定時刻)+30日`へ更新する。nonce/receiptを別注文で使えず、並行再送で期間が二重加算されない。
- 結果不明は見積期限後も排他を保持する。未認可の期限切れ、または検証済み確定未払いだけを終了でき、旧lease・区画・利用期間は変えない。履行後は次回更新を許可するが、支払いguardを消さない。
- 支払い後のlease/slot/version不整合は旧権利と支払い証跡を保持し、`manual_review`と更新復旧outboxへ送る。workerは保存済みreceiptだけを使い、claimのowner/generation/期限とorder versionを同じtransactionで検査する。
- 新lease versionのregistry outboxを作る。ENS entitlementがpaidの場合だけ同じleaseの同期jobを追加し、名前変更や追加料金は発生させない。実chain/ENS handlerは未接続のままである。
- 郵便転送の承認は転送先を変更するまで期限を設けず保持する。住所利用期間はx402の確認済み決済だけで更新し、期限内更新・期限切れ後の更新とも既存mail profileと承認を変更しない。明示的なdisabled/suspendedも更新で解除しない。未適用approvalは新lease versionで使えなくなる。暗号化宛先と登録有無・human bindingを保持し、outboxへ宛先を出さない。

仕様の整合: 郵便転送の承認を住所契約の期間から切り離した。課金済み期間が切れた間は住所利用・転送可表示を停止するが、承認自体は消さない。同じ転送先で住所利用を再開する場合は再承認を要求せず、転送先変更には新たな人間承認を要求する。承認要求URLの有効期限と適用済みの承認を区別する。人間承認の実装・検証済みを意味せず、公開readは引き続き未検証のenabled profileを503で拒否する。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| Emulatorを指定し固定済み`tsx --test packages/db/test/*.test.ts apps/worker/test/*.test.ts apps/api/test/*.test.ts` | 35件通過・skip 0 | 更新5件を含むDB21件、worker13件、API1件。購入・更新の共通認可処理、保存済み支払いの復旧、既存owner read/CLI確認を含む |
| 固定済み`tsx --test packages/db/test/renewal.test.ts`をEmulatorへ再実行（承認期限の撤廃前） | 5件通過・skip 0 | owner readの更新反映とmail suspensionの保持を確認。旧承認期限のチェックは下記の承認保持チェックへ置換 |
| 固定済み`tsc -p`を各workspaceへ実行 | 全6 package通過 | 共通DB処理を使うAPI/worker/CLIとWeb、domainを含む |
| 固定済み`esbuild`でAPI/workerをbuild | 通過 | 更新repositoryとworker routeをbundle。CLI/Webの再buildと画面操作は今回未実施 |
| `node scripts/check-text-format.mjs` / `git diff --check` | 通過 | UTF-8・BOMなし・LFと差分 |

fixtureは検証済み入力を模したローカルの境界テストであり、実スポンサーの応答・送金・World同意ではない。実provider接続、送金直前の再検査、実chain/ENS同期、自動返金、人間承認・宛先アクセス、GCP配備と復旧は残件。CIでのEmulator起動も未実装であり、T-05の完了チェックは付けない。

## T-05/T-06 郵便転送承認と課金期間の分離

住所利用期間はx402の支払い確定だけで決まり、人間承認は期間を増減しない。DBと公開Mail schemaから承認期限の項目を削除し、更新処理がmail profileの承認・version・宛先を変更しないよう修正した。契約期限切れは承認取消として永続化せず、利用可否を現在の契約状態・期限から判定する設計に統一した。未払い・不明決済の注文を作っただけでは契約期間を延長しない。

同じ転送先への承認継続と、転送先変更時の再承認を要件・設計・API・画面・受入条件へ反映した。人間向けの承認適用、転送先versionへの束縛、実効状態の公開readは引き続き未実装であり、保存済みenabledを公開APIから有効として返さない。実郵便物の転送処理は対象外のままである。

| 実行したチェック | 結果 | 証跡・範囲 |
| --- | --- | --- |
| Emulatorへ固定済み`tsx --test packages/db/test/renewal.test.ts packages/db/test/owner-reads.test.ts` | 7件通過・skip 0 | 有効期限の前後でmail profile・適用済み承認を保持、disabled/suspendedを解除しない、不明・未払い更新では契約期間と承認を変えない、承認期限のないDTO |
| Emulatorへ固定済み`tsx --test packages/db/test/purchase-lifecycle.test.ts` | 5件通過・skip 0 | 新規購入・再送・結果不明・復旧の既存動作 |
| Emulatorへ固定済み`tsx --test apps/api/test/owner-reads.test.ts` | 1件通過・skip 0 | 変更後のOpenAPIとの整合、enabled profileの503維持、共通CLIの状態取得 |
| 固定済み`tsc -p`、API/workerの`esbuild` | 全6 package型検査と両build通過 | 人間承認の実接続、実郵便処理、CLI/Webの再build・ブラウザ操作は未実施 |
| `node scripts/check-text-format.mjs` / `git diff --check` | 通過 | 変更後のJSON解析、UTF-8・BOMなし・LFと差分 |

旧承認期限モデルのテスト結果は前節の履歴とし、現在の動作確認には本節の結果を用いる。T-03/T-06の承認・宛先変更の実装やlive gateを完了扱いにしない。

## T-16 GCP bootstrap準備

`infra/bootstrap`は本アプリ専用のstate bucket（private・versioning・削除防止）、Docker用Artifact Registry、repository/owner immutable ID・main ref・event Environment subject・固定workflow ref・手動起動に限定したWIF pool/providerを定義する。既存の明示されたdeploy service accountへ狭いworkloadIdentityUser memberだけを追加し、そのaccount自体やIAM policy全体を管理しない。WIFは既定で無効であり、未実装のdeploy workflowを利用可能とは扱わない。共有project/API/Firestore database/rules/予算/DNSを作成・import・変更するresourceはない。

`scripts/gcp-inventory.ps1`は指定projectのmetadataだけを読み、実識別子を含む結果は保護されたリポジトリ外の新規directoryへ保存する。secret値・Firestore document・Run環境変数・task本文は取得しない。失敗や読取不能はincompleteとし、空listや権限不足を名前の空きの証拠にしない。Rules client経路、runtime IAM、祖先を含む実効IAM、所有者と予算の確認は別gateとして残す。

Terraform 1.14.6とGoogle provider 8.4.0を固定し、公式配布物のchecksumを検証した。provider lockfileにはWindows/Linuxの公式checksumを保存したが、実行検証はWindowsのみ。`terraform fmt -check`、`validate`、認証不要のmock test 2件が通過した。mockは設定検査だけであり、実GCPのplan/apply成功を意味しない。

inventory scriptのfixture検証4件が通過した。読み取りcommandだけの実行、project明示、API-enable promptの抑止、HTTPログ抑止、同projectのdeploy account検査、失敗のincomplete保持、地域の推測拒否と画面への実識別子非表示を確認した。fixtureは実認証・IAM・GCP応答の証跡ではない。Google Cloud CLI 586.0.0の公式archiveをSHA-256照合してポータブル配置し、システムPATHや既存の認証設定を変更していない。

隔離した一時CLI設定と付属Pythonでversionおよびinventoryの20 commandのローカルhelpを確認した。Firestore field exemptionはcollection groupを省略したdatabase全体の照会をサポートする。当時のlive権限・応答projectionは未検証であり、後続の読み取り結果は下記に記録する。`node scripts/check-text-format.mjs`と`git diff --check`も通過した。

認証済みlive inventoryは20件成功・1件incomplete。共有`(default)` DBのNative mode / Standard edition、`asia-northeast1`配置とbilling有効を確認した。Cloud Asset APIが利用できず全regionの横断検索は未完了であり、確認regionの専用prefixに一致がない結果だけで所有権や名前の空きを認めない。project・organization・選択済みdeploy service accountのIAM metadataは取得したが、指定deploy accountのlifecycle管理を既存IaC sourceで確認し、レビューしたtracked sourceにdistinctなadditive IAM memberと競合するauthoritative policy/bindingは見つからなかった。live実効権限・他管理主体との競合・state所有権の検証は未完了。

明示的なquota project headerでRules RESTを読み取った。release一覧にFirestore releaseはなく、defaultの両release形式のGETは404。Authorization headerなしのFirestore REST GETは`PERMISSION_DENIED` / `Missing or insufficient permissions`だった。これは対象の未認証read拒否のみの証拠であり、この時点ではlive Rules sourceの取得・評価と他利用者のread/write gateはpendingだった。後続の適用結果を下記に記録する。専用runtime identityのIAM・対象外DB拒否も未検証。

実bootstrap planは5 create・0 update・0 destroyで、確認済みregion・immutable repository/owner ID、WIF pool/providerのdisabled、state bucketのuniform bucket-level access・public access prevention・versioningを確認した。指定state bucket、Artifact Registry repository、WIF poolのGETは各404だが、全域の名前空き・所有権の証拠にはしない。plan・local state・実値入り変数は保護されたリポジトリ外で扱う。

Firestoreは現在未使用との運用者確認を得た。これは他IAM主体のアクセス不可やstate所有権の証明ではない。管理主体が初期deny-all Rulesを適用した。適用直前にdefault releaseの404を確認し、immutable rulesetとreleaseをCREATEだけで作成した。再取得したlive sourceは管理sourceとbyte一致し、公式Rules engineで未認証・合成した他利用者のget/list/create/update/delete計10件がDENY期待のSUCCESSだった。Authorizationなしの実Firestore REST GETとPOST createもPERMISSION_DENIEDを返し、documentは書かれていない。実際の別Firebase利用者tokenによるclient試験は未実施。server IAM・DB本体・indexは変更していない。

Cloud Asset APIは運用手順で有効化し、横断inventoryの再確認は進行中。既存budget一件を読み取り、変更していない。Rules初期適用に続きbootstrap5件を作成し、限定IAM memberを追加した。DNS変更・app deployは未実施。GitHubのevent Environmentは確認時点で未作成。この確認時点ではapp resource作成、GCS state移行、`infra/app`、deploy workflowとCloud Run公開が残件だった。後続のGCS移行とapp基盤登録は下記へ記録し、T-16は未完了のままとする。詳細は[読み取りinventory](gcp-inventory.md)に記録する。

## 次の接続条件

- World client/callbackとfresh認証、Intercepta keyと実schema、x402 facilitator/USDC/finalityを確認する。
- MultiBaasの権限とSepolia接続、ENS親名の管理権限・公式deployment・署名方法・gasを確認する。
- 専用Google OIDC clientと初期運用者、GCPのinventory/必要権限、公開ドメインのDNS/TLSを用意する。
- 提供拠点住所は認可された管理画面の完成後に登録する。実郵便処理は今回の範囲外。

## T-16 Cloud Asset型filterの修正

公式対応asset型にないCloud Scheduler Jobを横断検索filterから除外した。選択regionのScheduler metadata listは維持し、他regionは別確認としてsummaryのmanualPendingへ記録する。運用上のfilterなしmetadata検索は成功したが、非対応型や全regionのScheduler不在証明ではない。修正後の固定fixture4件は全件通過・skip0。成功fixtureでCAI型filter、regional Scheduler list、coverage残件を確認した。`node scripts/check-text-format.mjs`（99 paths）と`git diff --check`も通過した。修正scriptのlive再実行はこのテストに含めない。

## bootstrap初期登録結果

bootstrap applyは終了code 0で成功し、専用state bucket、Docker repository、無効WIF pool/provider、限定impersonation memberの5件を作成した。live再取得でbucketのuniform bucket-level access=true・public access prevention=enforced・versioning=true、repositoryのDOCKER、WIF pool/providerのdisabled=true、追加memberと既存deploy accountの全従前memberの保持を確認した。local stateと別時刻のbackupは保護されたリポジトリ外にあり、GCSへのstate移行は完了。

初期登録は完了したがT-16全体とアプリ稼働は未完了。Cloud Run/Scheduler配備、deploy workflow、GitHub event Environment、未検証のCloud Run/Tasks/Scheduler権限と実Firebase他利用者client試験は残件。適用後Terraform planはdetailed exit code 0で差分なし。修正した5型CAI filterのlive検索は終了code 0・metadata 34件を取得した。CAIのeventual freshnessと他regionのScheduler coverageは引き続き確認対象。

## T-01/T-16 GCS state移行・app基盤・コンテナ準備

bootstrapのGCS state移行は成功。保護されたリポジトリ外へsource backupを保存し、専用bucketの所有権・対象prefixの空状態・権限の確認後、保護copyのlocal backend初期化とGCSへの`terraform init -migrate-state -force-copy`を実施した。取得stateのlineage・resource 5件・outputsが一致し、serialは6から7へ増加した。リポジトリのGCS backendからの後続planは差分0。state・変数・credential・backend cacheはリポジトリ外で扱い、local backupを通常applyに使わない。

`infra/app`へ専用4 service account、7日保持のprivate業務bucket、queue、secret metadata、限定IAMと条件付きRun/Schedulerを追加した。service配備・runtime ready・公開・Scheduler・dispatch・共有Firestore grantのopt-inは全て既定false。secret値/versionをTerraformへ入れない。app基盤applyは17 add・0 update・0 deleteで完了し、live metadataを再確認した。runtime IAMの代表検査は通過し、実Firebase他利用者client gateは未確認。T-16全体に完了チェックを付けない。

| 実行したチェック | 結果 | 範囲・未実施 |
| --- | --- | --- |
| infra/appのTerraform fmt-check・validate・mock test | 通過・3 passed / 0 failed | backend無効のローカル設定検査。保護stateやクラウド呼出しを使用しない |
| 公式Docker registryでNode 22.21.0 tag/index digestを照合 | 通過 | Dockerfileへdigest固定。実image取得は未実施 |
| `VITE_APP_ENV=local VITE_TERMS_VERSION=event-demo-1 node scripts/container-build.mjs` | 通過 | domain/DB/API/worker/Web型検査、API/worker bundle、Web HTML/assets build。local demo設定 |
| `node scripts/container-entrypoint.mjs invalid`とbuild設定なしの実行 | 期待通り拒否 | 未知roleと環境/terms欠落で非0終了 |
| `docker version` / `docker info` | daemon利用不可 | installed Desktopのhidden起動を試したがpipeへ接続不可。Docker build/runは未実行 |

image entrypointは`web`または`worker`を選ぶ。privateファイルをbuild contextへ送信せず、Web distと公開OpenAPIを同梱する。正式なterms/public configは未確定なのでevent image build・push・Cloud Run配備・DNSは未実施。支払い・World・ENSの実統合を成功扱いせず、業務mutationは閉じたまま。Cloud Buildは使用していない。

## app基盤の実登録結果

app foundationの実applyは17 add・0 update・0 deleteで成功した。live再取得で専用4 service accountがenabled・user-managed key 0、既存project IAM memberの保持、業務bucketのuniform access/public access prevention有効・soft delete 0・7日削除、queueの毎秒1・同時実行1・最大10試行、作成secretのversion 0件を確認した。web/workerの共有default DB限定IAM grantは個別レビュー後に今回の保護設定で有効にした。入力の既定値は引き続きfalseであり、同DB内のcollection隔離を意味しない。

正式termsは未確定で、今回は基盤登録までとの利用者指定に従う。event image、Cloud Run、公開IAM、Scheduler、dispatch、deploy CI/WIFの有効化は行っていない。専用主体のFirestore操作・DB拒否とqueue権限の代表検査は通過し、合成documentと短期grantのcleanupを確認した。Cloud Run invoker、Tasks OIDC、スポンサー、別Firebase利用者のclient試験は未検証。詳しい証跡範囲は実装状況のruntime IAM節を参照する。appのremote post-apply planはdetailed exit code 0で差分なし。state pullの17 resource instance、保護backupとmanifest更新を確認した。T-16全体は未完了。

## T-16 専用主体のruntime IAM代表検査

4専用service accountの短期token発行は初回に403となったが、15分の条件付き一時grantを保持して反映を待ち、再検査で全4主体が成功した。条件を緩めたり恒久権限へ変更していない。10分tokenで以下を実施し、token値と実識別子は公開記録に含めない。

| 実検査 | 結果・範囲 |
| --- | --- |
| web/workerでdefault DBの`realaddr_event_ops_metrics`へ一意な合成documentをPOST/GET/DELETE | 両主体で成功。業務データではなく代表的なserver CRUD確認 |
| 全4主体で既存の対象外named DB内の一意な不存在documentをGET | 全て`PERMISSION_DENIED`。NOT_FOUNDを拒否証拠として扱わない |
| tasks/schedでdefault DB documentをGET | 両主体で`PERMISSION_DENIED` |
| queueの`testIamPermissions` | webはtask createのみ、workerはcreate/get。tasks/schedは指定した5権限を持たない |
| cleanup/read-back | 合成document削除、一時grantの全4主体からの削除、baseline member保持を確認 |

これは検査したDB操作・queue権限の証拠であり、prefix内外のcollection IAM隔離を意味しない。Cloud Run invoker、Cloud Tasks/Schedulerの実OIDC配信、スポンサー接続、実際の別Firebase利用者tokenによるRules client試験は未検証。appのremote post-apply planはdetailed exit code 0で差分なし。state pullは17 resource instanceを保持し、保護backupとmanifest更新を確認した。T-16は未完了。

## T-01/T-16 配備前のAPI設定・コンテナ検査

APIのevent起動はresource/collection prefixと共有default DBの明示設定を要求し、Firestore clientへ検証済みdatabase IDを渡す。demo project、不正project ID、Emulator接続、鍵credentialの環境変数を拒否する。localはEmulator必須と既存のdefault設定を維持する。API型検査と`apps/api/test/config.test.ts`の3件は通過した。

Docker Desktopは内部ingest socketのrename/accessエラーでbackendが停止した。既存Desktopの起動を確認したが、reset、state削除、OS設定変更は実施していない。local設定の型検査・API/worker/Web buildは通過した。実コンテナ検査用に`container-check.yml`を追加し、GCP認証なしのLinux runnerでlocal demo imageをbuildする。起動containerはネットワークを無効にし、内部loopbackだけでweb health 200、worker未認証401/no-store、未知roleの拒否を検査する。DB/queue操作は行わず、作成したcontainerとimageだけを削除する。script構文検査は通過し、後続のLinux CIで実build/runも通過した。

正式termsは引き続き未確定で、event image作成・push・Cloud Run配備は行わない。CI成功とデプロイ成功を区別し、T-16を完了扱いしない。

最初のLinux container checkでは、pnpmがesbuildの実行fileをnative binaryへ最適化するため、Node経由のCLI起動が失敗した。固定済みesbuildのJavaScript APIで同じbundle設定を実行する形へ修正し、local型検査・API/worker/Web buildは通過した。修正後の同一commitで通常CIとLinux container checkが成功した。Docker imageのbuild/export、webの内部loopback health 200、workerの未認証401/no-store、未知role拒否、作成したcontainer/imageのcleanupを実確認した。local demo設定でnetworkを無効にした検査であり、DB/queue操作・event image push・GCP配備は行っていない。

## T-16 手動更新workflowの実装

`deploy-event.yml`と専用scriptを追加した。main手動実行・同SHAのCI成功・保護されたevent設定・正式terms一致を必要とし、CI照会jobだけに`actions: read`、deploy jobだけに`id-token: write`を付与する。target metadataはEnvironment Secret `DEPLOY_CONFIG`のJSON契約へ統一し、runtime secret値や鍵を含めない。初回Run作成・IAM設定・WIF有効化は別工程で、既存サービスがなければbuild前に停止する。

旧2digestの一致、既存のruntime設定・IAM・Ready revision/trafficを検査し、同一digestをworker→webへimage属性だけ更新する。更新結果不明も含め試みた側を旧digestへ戻し、復帰確認失敗を成功にしない。gcloudが生成するrevision名・nonce等のmetadataと業務設定を区別し、env/IAM/user labelの変更を検出する。runner強制終了時の復帰は保証せずlive再照合を必要とする。

`node --test scripts/deploy-event.test.mjs`は10件通過。設定欠落、branch/SHA/terms/CI拒否、サービス不在・設定違反で副作用なし、同digest更新、worker/webの不明結果からのrollback、rollback失敗、env/IAM/labelの変更検出、公開health/worker拒否をfake subprocessで検査した。この結果は実GCP更新・rollbackの証拠ではない。公式actionのtagとcommit SHAを照合して固定した。正式terms、初回event image/Run配備、Environment登録・WIF有効化、実デプロイ・実rollback・スポンサー接続は引き続き未完了。T-16に完了チェックを付けない。
