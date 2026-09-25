# RealAddr 要件 v1

日付: 2026-09-25。ユーザーの追加指定により、郵便は「人間承認後の転送可表示と、人間による転送先入力・保存」まで。実郵便処理は今回実装しない。MUST/SHALLは必須。以下はプロダクト要件であり、外部APIの機能保証ではない。

## 利用者と用語

- Agent: API資格情報と支払いウォレットを持つ自律クライアント。Codex、Claude Code、Kiroから実行可能。
- Owner human: 対象Leaseのowner walletの制御を署名で証明し、Worldで認証・承認する人間。法的契約主体の本人確認済みを意味しない。
- Building / Slot / Lease: 保有住所、1〜65,535のサービス区画、期間付き住所利用契約。
- Approval: 固定されたmail.enable操作についてのWorld fresh認証と明示同意。
- MailProfile: 転送可表示の権限状態と、人間が入力した転送先住所。実発送指示ではない。
- Order / Payment: 見積もり付き購入意図と、そのx402決済記録。

## R-01 区画と利用権

- R-01.1 WHEN 拠点を登録する THEN システムは1〜65,535の区画を用意し、0、負数、小数、65,536以上を拒否する SHALL。
- R-01.2 WHEN 契約を発行する THEN buildingId + slotNumberを一意に割り当てる SHALL。未確定決済中の区画を別契約へ渡さない。
- R-01.3 WHEN 表示する THEN 実住所・実在階と仮想区画を分離する SHALL。例「実在の建物3階／Agent区画 V00042」。仮想区画を実際の42階として表示しない。
- R-01.4 WHILE 人間承認前 THEN 住所利用権は利用できても、郵便転送設定はdisabledとする SHALL。
- R-01.5 WHEN 期限終了 THEN 住所利用権と転送可表示を停止する SHALL。v1では区画を他テナントに再利用しない。

## R-02 Agent認証

- R-02.1 WHEN 登録する THEN ドメイン・chain・nonce・期限を含むwallet署名を検証して資格情報を発行する SHALL。基本住所利用にWorldを要求しない。
- R-02.2 WHEN 契約を取得/操作する THEN bearerのtenant/agent所有権を検査する SHALL。他者のIDを知るだけでは操作不可。
- R-02.3 WHEN 支払いを受け付ける THEN 登録walletと検証済みpayerが一致する SHALL。v1はEOAのみ。
- R-02.4 WHEN 資格情報が失効する THEN 次の要求から拒否する SHALL。支払い鍵はモデルに渡さず署名器に保持する。

## R-03 x402による住所購入・更新

- R-03.1 WHEN orderを作る THEN サーバーが価格、期間、payTo、network、asset、予約期限を固定する SHALL。クライアントの金額を信用しない。
- R-03.2 WHEN 有効orderを未払いで実行する THEN x402 v2の402を返す SHALL。
- R-03.3 WHEN リスク許可と決済確定を確認する THEN World承認を挟まず住所契約を発行する SHALL。「即時」は決済確認後のDB反映。
- R-03.4 WHEN 同じ要求を再試行する THEN 同じ契約・領収情報を返し再決済しない SHALL。
- R-03.5 IF 決済結果不明 THEN reconcilingとして同じ認可を照合し、新たな支払いを求めない SHALL。
- R-03.6 WHEN 更新する THEN 同じ区画を保持し、期限内は旧期限へ30日、期限切れは確定時刻から30日を加算する SHALL。自動継続課金は対象外。

## R-04 Intercepta

- R-04.1 BEFORE buyer署名 THEN 実APIでpayToを評価し、chain/token/金額/署名内容のローカル検査も行う SHALL。
- R-04.2 BEFORE seller決済 THEN 検証済みpayerを実APIで評価する SHALL。
- R-04.3 IF 禁止判定 THEN 署名・決済・発行を止め理由を表示する SHALL。タイムアウト、429、未知レスポンスはhold。
- R-04.4 WHEN デモする THEN 実メインネットアドレスを評価する安全例と危険例を示す SHALL。testnet決済とrisk対象networkを明示する。
- R-04.5 WHEN 支払う THEN 並行要求でも1件/日次支出上限を越えない SHALL。

## R-05 人間と契約の紐付け

- R-05.1 WHEN 人間が承認URLを開く THEN 対象LeaseのownerWalletと同じEOAで一回限りのwallet challengeに署名し、操作主体を証明する SHALL。
- R-05.2 WHEN World認証を完了する THEN backend検証した(issuer, subject)をowner proofと同じbrowser sessionに結び付ける SHALL。URLを知るだけで紐付けしない。
- R-05.3 IF 既存bindingがある THEN 同じissuer/subjectとの一致を要求する SHALL。責任者の変更・回復はv1対象外。
- R-05.4 WHEN World認証が成功する THEN 法的KYC完了、実発送許可とは記録しない SHALL。
- R-05.5 WHEN 初回bindingを確定する THEN 人間の明示承認と同一transactionで確定する SHALL。キャンセルした認証だけで契約を占有しない。

## R-06 World操作承認

- R-06.1 WHEN Agentがmail.enableを要求する THEN lease、agent、ownerWallet、policy、nonce、期限を固定したapprovalを作り人間用URLを返す SHALL。
- R-06.2 WHEN 人間が承認する THEN 内容を表示し公式World環境でfresh認証、backend検証、CSRF付き明示同意POSTを通す SHALL。
- R-06.3 IF 拒否・取消・期限切れ・別人・不正token THEN 転送可にせず住所フォームの保存を拒否する SHALL。
- R-06.4 WHEN 承認を適用する THEN 一回だけMailProfileのenabled権限へ変換し、並行再送でも同じ結果にする SHALL。
- R-06.5 IF 対象Lease/owner/policyが変化 THEN 古い承認を使用不可にする SHALL。

## R-07 転送可表示と人間用フォーム

- R-07.1 WHEN mail.enableが承認された THEN 「郵便転送可」を表示し、人間に転送先入力フォームを提示する SHALL。
- R-07.2 WHILE 転送先未入力 THEN 「転送先未登録」も表示し、入力を促す SHALL。
- R-07.3 WHEN 人間がフォーム保存する THEN 氏名/宛名、国内郵便番号、都道府県、市区町村、番地、建物名任意を検証して暗号化保存する SHALL。
- R-07.4 BEFORE 保存/更新/閲覧 THEN owner walletとWorldで認証した人間session、lease有効性、enabled grant、CSRFを検証する SHALL。
- R-07.5 WHEN Agentが参照する THEN enabledとdestinationConfiguredだけを返し、転送先全文を返さない SHALL。Agent bearerによる宛先保存は禁止。
- R-07.6 WHEN 保存に成功する THEN 再読み込み後も保持し、versionによって更新競合を検知する SHALL。
- R-07.7 WHEN 表示する THEN 「ハッカソン版: 転送設定のみ。実際の郵便転送は行いません」を明示する SHALL。発送ジョブ、送料課金、配送APIを生成しない。
- R-07.8 WHEN 人間が権限を取り消す THEN 転送可を解除しAgentに反映する SHALL。再開には新たなWorld承認が必要。

## R-08 Curvegridとオンチェーン記録

- R-08.1 WHEN Lease発行/更新/取消 THEN outbox経由でLeaseRegistryに記録し、MultiBaasで照会する SHALL。
- R-08.2 WHEN 表示する THEN 契約利用可否とchain同期状態を分離する SHALL。
- R-08.3 WHEN chainへ記録する THEN 氏名、実住所、World subject、転送先、契約書本文を含めない SHALL。譲渡不可とする。
- R-08.4 WHEN 再起動/イベント再送 THEN cursorから再開し重複・reorg・欠落を処理する SHALL。

## R-09 UI/CLI

- R-09.1 CLIはJSON出力、安定したerror code、非対話実行、poll、再開IDを提供する SHALL。
- R-09.2 UIは住所、期限、決済、risk理由、chain同期、転送可/不可、宛先登録済み/未登録を表示する SHALL。
- R-09.3 人間画面は対象Agent/Lease、mail.enableの意味、World認証、承認/拒否、承認後の住所フォームを提供する SHALL。
- R-09.4 Codex/Claude Code/Kiro各々から同じCLIで住所購入→人間承認待ち→状態取得を実行し、証跡を残す SHALL。

## R-10 永続化と完成条件

- R-10.1 再起動で契約・承認・宛先・決済・jobsを失わない SHALL。
- R-10.2 traceId付きログで秘密と個人情報を除外する SHALL。
- R-10.3 live未実施を合格扱いしない SHALL。公式sandbox proofと本番proofを区別する。
- R-10.4 read p95 500ms以下、決済確認後5秒以内の住所反映を目標とし条件付き実測を残す SHOULD。
- R-10.5 商用の料金・契約主体・法務・本人確認は今回のデモ成功と分離する SHALL。

## R-11 ENSv2名の発行

- R-11.1 WHEN 住所契約が確定する THEN Sepoliaの公式ENSv2階層下に契約別サブネームを発行する SHALL。名称は拠点slugと区画から決定する。
- R-11.2 WHILE 発行/照合が未完了 THEN ensStatus=pendingとし住所利用を継続できるが、ENS利用可能とは表示しない SHALL。追加のx402課金をしない。
- R-11.3 WHEN 発行する THEN 一lease一canonical名と専用resolverを作り、別契約への再利用を禁止する SHALL。
- R-11.4 WHEN readyとする THEN 公式Universal Resolverでの実read-backとexact登録・owner・binding一致を確認する SHALL。

## R-12 名前から住所契約の照合

- R-12.1 WHEN ENS名を解決する THEN 正規化、正規階層、exact登録、事業者controller binding、LeaseRegistry/DBの状態と期限を検査する SHALL。
- R-12.2 WHEN 認証済みAgentが自分の名前を指定する THEN 対応する住所契約と営業所住所を取得できる SHALL。他者契約は404。
- R-12.3 WHEN public lookupする THEN 契約参照と検証結果だけを返し、人間の転送先、World情報、内部lease UUID、郵便設定を返さない SHALL。
- R-12.4 IF pointer改変、偽namespace、祖先wildcardのみ、chain不一致 THEN verifiedとしない SHALL。
- R-12.5 WHEN ENSで名を確認できても THEN World承認やIntercepta判定を省略しない SHALL。

## R-13 権限と期限

- R-13.1 WHEN Agentが編集する THEN 専用Resolverのdescriptionのみ許可し、契約pointer/addr/transfer/resolver差し替えをコントラクトで拒否する SHALL。
- R-13.2 WHEN 契約更新する THEN 確定versionに基づき名前期限を延長し、親名・lease期限を越えない SHALL。
- R-13.3 WHEN 契約/親名/サブネームが失効または停止する THEN 照合結果を無効または保留とし、古いresolver recordで認可しない SHALL。
- R-13.4 WHEN 再送/再起動/reorg THEN 二重名発行せず、同じname/lease/versionを照合して回復する SHALL。

## R-14 ENSv2の実動作と公開境界

- R-14.1 WHEN 提出する THEN 実登録→解決→住所取得、委任編集成功/禁止キー失敗、失効時拒否を実演する SHALL。
- R-14.2 WHEN 公開情報を説明する THEN walletと契約名の公開関連付け、testnet、事業者管理の非譲渡名であることを明示する SHALL。
- R-14.3 WHEN 3ツールから利用する THEN 共通CLIの名前による照合/状態確認を通す SHALL。

## R-15 GCP・低コスト・停止後の回復

- R-15.1 UI/APIとworkerはCloud Run、業務データはFirestore、ファイルはprivate Cloud Storage、CI/CDはGitHub Actionsを使用する SHALL。通常待機に常駐DB/workerを必要としない。
- R-15.2 Cloud Runはrequest-based / min instances=0とし、業務状態・未完了処理をFirestoreへ保存する SHALL。HTTP応答後のCPUに依存しない。
- R-15.3 Firestore transactionの再実行でも外部決済・名前登録を重複させず、決定的ID/guardで論理一意性を保証する SHALL。
- R-15.4 Cloud Tasksの重複・enqueue失敗・worker停止をoutboxとSchedulerで回復し、期限切れだけで未知決済を再送しない SHALL。
- R-15.5 65,535区画を事前document化せず、必要な区画だけ保存し、全件走査や常時pollを避ける SHALL。
- R-15.6 CI/CDはOIDC/WIFで短期認証し、workerとFirestore/GCSへ未認証でアクセスできない SHALL。
- R-15.7 無料枠・region・使用量・予算を記録し、利用増加や外部サービスを含めた完全無料を保証しない SHALL。日次上限到達後も既存決済を照合する。
- R-15.8 snapshot復元とscale-to-zero後の再開を検証し、未実測の可用性・料金・性能を成功扱いしない SHALL。

## 今回の対象外

実郵便の受領・開封・保管・発送・追跡・送料決済、配送業者API、現物作業UI、法的KYCシステム、NFT市場、不動産所有権/登記権保証、複数チェーン決済、自動継続課金。将来これらを追加するときは別仕様とする。
