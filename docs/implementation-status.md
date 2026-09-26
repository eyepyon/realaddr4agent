# 実装状況

実装開始: 2026-09-26。仕様上の完成条件と、実装・検証できた範囲を区別する。[タスク一覧](../.kiro/specs/realaddr/tasks.md)のチェックはタスク全体の証跡が揃ったときに更新する。

## 現在の作業

| 対象 | 状態 | 範囲 |
| --- | --- | --- |
| T-01 実行基盤 | 実装中 | pnpm workspace、strict TypeScript、Fastify、web/worker、共通CLI、CI workflowとローカル`.env.example`を作成。全経路の起動確認は未完了 |
| T-02 認証・Firestore・区画 | 部分実装 | wallet challenge、Bearer hash、collection prefix、64 shard予約に加え、住所購入の決済受付・不明状態保持・確定後の契約発行・未払い確定後のhold解放をrepositoryへ実装。外部の検証済み結果を受け取る内部DB境界であり、実決済・照合worker・更新・返金は未実装 |
| T-02/T-08 所有者向け状態取得 | 部分実装・ローカル検証済み | 注文・契約の一覧と詳細、ENS購入状態をFirestoreから返す。所有権、応答の公開field制限、署名付きcursor、既存CLIの状態取得を確認 |
| T-05/T-16 worker・outbox | 部分実装・ローカル検証済み | Firestore claim/generation/期限、保存済み支払いからの発行復旧、Cloud Tasks REST配信・結果照合とSchedulerの永続cursor。実送金・chain同期・実Cloud Tasks/Scheduler接続は未検証 |
| T-08/T-18/T-19 UI | 部分着手 | 公開HTML/AEO、標準SaaSの画面、実APIへの接続。業務統合・実管理者ログインは別途 |
| T-00 外部連携 | 設定の有無を確認・実接続未実施 | MultiBaasの接続設定は一部入力済み。chain・registry設定、権限、実疎通は未確認。World、Intercepta、x402、ENS、管理者OIDCの必要設定も揃っていない。値を表示せずキーの有無だけ確認し、接続済みとは扱わない |
| T-16 GCP | 未適用 | live inventory、IAM/Rules、専用resource作成、DNS/TLSが必要。現在の作業で実GCPへ変更していない |

## 検証の記録

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

live inventory、runtime IAMとclient Rules、prefixed index、実OIDC、実Cloud Tasks/Scheduler、Cloud Run停止復旧は未検証。25秒を超えたらsweepの新規job開始を止めるが、Firestore遅延時を含む実環境の要求期限内完了は未検証。公開購入APIは引き続き販売を拒否し、T-05/T-16の完了チェックは付けない。

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

## 次の接続条件

- World client/callbackとfresh認証、Intercepta keyと実schema、x402 facilitator/USDC/finalityを確認する。
- MultiBaasの権限とSepolia接続、ENS親名の管理権限・公式deployment・署名方法・gasを確認する。
- 専用Google OIDC clientと初期運用者、GCPのinventory/必要権限、公開ドメインのDNS/TLSを用意する。
- 提供拠点住所は認可された管理画面の完成後に登録する。実郵便処理は今回の範囲外。
