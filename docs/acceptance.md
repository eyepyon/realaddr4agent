# 受入テストと提出デモ

本書は実装後の検証計画。現時点のテスト結果ではない。unit testのmockとevent live証跡を明確に分ける。A-01〜A-49は追跡用のシナリオ一覧であり、ハッカソン提出前に全件を自動化・実行する義務を意味しない。未実行の行を合格と記録しない。

## ハッカソン提出前の最小ゲート

少数の実装に即したチェックを再利用し、実行コマンド、手動操作、公開可能な証跡、未実行範囲を`docs/implementation-status.md`に記録する。コード変更ではbuild/typecheckと変更箇所に関係するチェックを実行する。文書・設定だけの変更は形式検査とdiff確認を行い、動作に影響する場合は対応する重点チェックも行う。提出前に次を確認する。

1. Firestore EmulatorなどのDB統合チェックで、slot境界と同一区画への競合予約、同じ支払いの再送・結果不明時の照合を確認する。一つの確定支払いが複数注文を有効にせず、不明な支払い中のslotを解放・再課金しない（A-01/A-03/A-05/A-06/A-19/A-38の代表例）。100並行・全組合せは不要。
2. backendの権限チェックで、owner wallet proofとWorldのfresh認証・明示同意を通した場合だけmail.enableと宛先保存を許し、Agent資格情報や別人sessionによる承認・宛先全文取得/書込を拒否する（A-10〜A-16の代表例）。JWTの全改変パターンと全入力境界の網羅は追加検証とする。
3. 公式環境へつないだ一つの手動縦断フローで、Intercepta allowと住所30日料金のBase Sepolia決済後にENSが未購入であること、標準またはcustomを明示選択した別ENS add-on見積・決済、SepoliaのLeaseRegistry/MultiBaas照会、ENS発行・公式解決・住所照合、World承認、人間の宛先保存と再読込を確認する（A-20〜A-23/A-27/A-28/A-32の代表例）。ENS testnet/dev設定は標準100000、custom300000 atomic、6 decimalsに一致すること。価格設定欠落/0またはnetwork不一致なら販売拒否を確認し、そのままではadd-on決済から発行のlive gateは未実施/BLOCKEDであり、正しい設定後に一本を通して合格させる。二重add-on拒否または住所renew時の追加ENS課金なしを一件確認する。名前競合時に黙って別名へ切替/課金しないことも確認する。実Intercepta denyとWorld拒否または取消、ENSの禁止操作または失効照合を代表的な失敗経路として示す。providerごとの生応答と画面表示を照合し、sandbox/testnetを明記する。
4. 一度停止・再起動して契約、支払い冪等記録、承認状態、宛先、未完了jobが残り、再開後の状態取得ができることを確認する。Cloud Run/Firestoreの実環境を使う場合はmin=0復帰と未認証アクセス拒否も少数の手動チェックで確認する（A-18/A-39〜A-41の代表例）。完全なsnapshot復元訓練は追加検証とする。
5. 同じCLIをCodex/Claude Code/Kiroから実行し、代表する一つのツールで購入から承認後の状態確認まで通す。他の二つは認証、状態取得、ENS照合の短い疎通でよい（A-25/A-36）。秘密・転送先のログ/公開応答/chainへの露出がないことを代表フローで確認し、`node scripts/check-text-format.mjs`とcommit時の`--staged`検査を維持する。

管理画面・公開サイトの追加分は既存デモの確認にまとめる。管理者ログインと未認証拒否・運用操作1件、公開HTML/discovery/private headerと狭い画面の目視確認だけを追加し、網羅的なUI/検索crawlerテストは行わない。

実接続できない項目はBLOCKEDと記録し、その範囲を提出成功と主張しない。最小ゲート外のシナリオは実装要件を緩めるものではなく、追加の回帰・耐障害性検証として後回しにできる。

## 追加検証シナリオ一覧

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-01 | R-01 | APIのfloor（内部slot）に0/-1/1/32768/65535/65536/小数 | 1〜65535の整数のみ許可。Firestore repositoryでも拒否 |
| A-02 | R-01/R-03 | 100並行購入予約 | 異なる区画、重複契約なし |
| A-03 | R-01 | 同じfloor指定へ同時要求、最後の一枠、または全枠消費 | 指定区画は一件だけreserve。他はslot_unavailable、全枠消費で自動割当不可はsold_out。別区画への無断変更・課金なし |
| A-04 | R-02 | 別tenant ID、期限切れBearer、使い回しwallet nonce | 401/404、他者情報なし、session再発行なし |
| A-05 | R-03 | 無料要求→402→有効payload | 順序通りverify/screen/settle/確認/発行。一契約のみ |
| A-06 | R-03 | 同キー再送、別キー同payload、同キー別body、応答喪失 | 再課金なし、同契約または409 |
| A-07 | R-04 | buyerでlive risk deny | signer呼び出し0、txなし、理由表示 |
| A-08 | R-04 | sellerでpayer deny、429、timeout、未知enum | settle呼び出し0、deny/hold表示 |
| A-09 | R-04 | 金額増額、偽USDC、chain/payTo/domain/nonce変更、並行予算消費 | 署名前拒否または保留、日次上限超過なし |
| A-10 | R-05/R-06 | 承認URLのみ、別wallet、wallet challenge再送 | owner proof不可、enabled不可 |
| A-11 | R-05/R-06 | 正しいowner proof+World fresh認証+approve | DBのbinding/approval/profileを一回だけ更新、転送可表示 |
| A-12 | R-06 | World cancel/deny/expired/無効state | enabledにならず住所保存403 |
| A-13 | R-06 | JWT改変/誤iss/aud/nonce/期限/alg/kid、古いauth_time、既存bindingと別sub | backend拒否。JWKS更新も失敗なら拒否 |
| A-14 | R-06 | World callback成功だけ、CSRFなし、同時approve、lease version変更 | 同意前はdisabled、CSRF拒否、二重適用なし、古いapprovalは409/410 |
| A-15 | R-07 | 人間が承認後住所入力→保存→reload | 暗号化DBに永続化し本人画面で復元。転送可/登録済み表示 |
| A-16 | R-07 | Agentから宛先書込/全文取得、別human、無効郵便番号、過長文字、古いversion | 拒否。Agentはstatus/登録有無だけ。XSSなし |
| A-17 | R-01/R-07 | lease失効/停止、mail-disable、期限切れrenew | 転送可停止。再開は新承認。cron遅延でも期限判定 |
| A-18 | R-10 | API/worker停止・Firestore接続断とsnapshot restore | 契約・approval・住所・cursor・冪等記録を保持 |
| A-19 | R-03 | settle成功直後DB停止、timeout後遅延receipt、reorg。別の決定的な発行失敗を1件、同じ返金jobの重複・応答喪失とともに確認 | 不明結果はreconcilingから照合回復しslot解放/再課金なし。発行失敗確定後だけ元payer・同一network/asset・注文額全額の返金receiptを検証し、一payment一返金。返金結果不明は同じtx/nonceを照合し、二重送金なし |
| A-20 | R-04 | 実Intercepta key、mainnet安全/危険アドレス | 実レスポンスでpay/blockを制御。理由と時刻を表示。危険先送金0 |
| A-21 | R-06 | 公式World devで人間成功と拒否/期限切れ | 実callback検証、成功のみenabled。event fake proofを表示 |
| A-22 | R-03 | 実testnet token/facilitator | explorer/receiptで金額・payer/payTo照合。住所発行 |
| A-23 | R-08 | 実MultiBaasとregistry | write/read/eventから同じlease/version/期限を表示 |
| A-24 | R-08 | 無権限writer、slot0、同version別内容、重複event、reorg | revert/冪等/巻戻しが仕様通り。chainにPIIなし |
| A-25 | R-09 | 3開発ツール各々で同じCLIシナリオ | JSON解釈・人間待ち・状態再取得が成功。専用plugin必須でない |
| A-26 | R-07/R-10 | full E2Eとログ/ブラウザbundle検査 | 秘密漏洩なし、Agentに転送先なし、実発送/送料決済0 |

R-07の合格はフォーム保存と表示まで。現物発送・郵便局APIをテストしない。フォームをモックで成功表示するだけではA-15不合格。

## テストの実施方法

変更箇所に応じて小さなunit/DB統合/contractチェックを選ぶ。上記の最小ゲートはFirestore Emulatorの代表的な競合・照合、contractの重要な権限境界、実API/DBとブラウザの手動E2E、providerへの実接続で満たせる。専用のunit/integration/E2E/liveフルスイートを毎回構築・実行する必要はない。100並行、JWT全改変、reorg全経路、完全なsnapshot復元、費用と性能の全マトリクスは時間と環境が許す場合の追加検証とする。

live検証の結果はrunId、commit、時刻、環境、chain、公開可能なtx/contract、redacted provider evidenceで記録。自動テストでWorld本人操作を人間になりすまして代行しない。UIを人間が操作した箇所は手動ステップとして記録する。

## 5分デモ

1. 0:00–0:40: 「AIのリアル住所」と65,535区画を説明。Agentが住所契約を注文して402を受信。
2. 0:40–1:20: testnet/dev 30日住所料金0.55 USDC（550000 atomic）のIntercepta live allow→署名→settle→住所区画発行。ENSは未購入と示し、txとMultiBaas registry readを表示。
3. 1:20–2:00: Agentが標準`ens purchase --subscription <id>`またはcustom `ens purchase --subscription <id> --name-type custom --name <label>`を明示実行し、別intent/receiptの見積を確認・決済してENSを発行・公式解決する。固定testnet料金と選択名を確認する。環境設定欠落/不整合なら販売拒否を表示し、liveフローは未実施/BLOCKEDと記録する。以前のENS live証跡は補足資料としてのみ示し、未実施のadd-on縦断ゲートを合格扱いしない。
4. 2:00–2:20: 同じAgentがmail.enableを要求。まだ転送不可・フォーム保存不可であることを示す。
5. 2:20–3:20: 人間がwallet proof、World認証、明示承認。「郵便転送可」になり、人間自身が住所フォームへ入力・保存。reloadし永続化を確認。実発送なしを明示。
6. 3:20–4:05: 別の依頼でWorld取消/期限切れを示し、設定不可のままであることを表示。
7. 4:05–4:40: 自前の危険支払先challengeに対する実Interceptaのdenyを表示。署名も送金も起きない。
8. 4:40–5:00: 住所/ENS購入の同じ要求のretryでも契約・支払・名前を重複作成しないこと、3ツール共通利用の証跡を表示。

外部確認が長引いたら202とpollをそのまま見せる。録画をlive成功のように見せない。課金はtestnet、危険例は署名前停止。

## 提出証跡

- 公開repoと再現可能なsetup、lockfile、Firestore schema/index/rulesとbootstrap、tests、contract source。
- World: 成功/拒否、backend検証のコード、freshnessと同意の区別、実測feedback。
- Intercepta: live API呼び出し箇所、riskが署名/決済を止める箇所、理由、3〜5行feedback。
- Curvegrid: AI Agentがオンチェーンの契約状態を扱う説明、MultiBaasコード/証跡、team/SNS、実測feedback。
- demo URL、動画、設定制限、各SDK/chain/provider version。秘密/World subject/個人住所は非公開。

## ENSv2追加受入テスト

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-27 | R-11 | 公式Sepolia deploymentに親名/3階層registry/専用resolver接続。standard `f00042.<location-slug>.<parent>.eth`またはcustom `<label>.<location-slug>.<parent>.eth`を別ENS add-on intentで見積・決済 | Universal Resolverからexact子名を実解決。standard/custom test priceは100000/300000 atomic。料金・name type・canonical name・期限をintent snapshotと照合し、名前空きはintent時に確定。ローカルDBだけで合格にしない |
| A-28 | R-12 | 名前でpublic lookupとowner Agent lookup | publicはpointer/検証結果のみ。ownerだけ契約営業所住所へ到達。他者404 |
| A-29 | R-13 | Agentがdescription更新、他のrealaddr key/addr/link/upgrade変更 | descriptionのみchainで成功。禁止keyはrevert。別leaseのresolverも変更不可 |
| A-30 | R-13 | ownerとoperatorがtransfer/registry差し替えを試行 | 顧客権限では拒否。admin保持範囲を記録 |
| A-31 | R-13 | lease/name/parentの期限切れ、suspend/revoke、worker停止 | verified activeにならない。古いtext/祖先fallback/直resolver readを証明にしない |
| A-32 | R-11/R-13 | 有効leaseへの標準/custom ENS add-on見積・支払い後にENS RPC停止/tx応答喪失/再起動、同じleaseへの重複add-on要求、ENS購入済みleaseの住所renew、同拠点のcanonical name競合 | add-on未購入時はnot_purchased。standard/custom test priceは100000/300000 atomic。add-on確定後は住所利用を維持しENS pending、retryで再課金なし、重複購入拒否。renewは住所料金だけでENS期限を同期。名前競合時はno-saleを返して明示的な再選択を要求し、黙って名前/課金を切り替えない |
| A-33 | R-12 | 偽suffix、Unicode混同、偽controller/pointer、owner不一致、custom名にdot/大文字/長さ違反/先頭末尾hyphen/標準用`f`+digits namespace/service reserved word | canonical登録とbinding、ENSIP-15検査でinvalid。任意URLへsecret送信なし |
| A-34 | R-13 | renew/reorg/古いoutbox/同じname別lease | version整合、expiry上限、冪等、別lease再利用拒否 |
| A-35 | R-14 | 公開record/response/ブラウザ/ログのPII検査 | 転送先/World情報/承認URL/内部lease UUIDなし。名前・walletは公開と明示 |
| A-36 | R-14 | Codex/Claude Code/Kiroから同じENS CLI | 名前解決→owner契約取得。署名器は許可description txとgas capのみ送信 |

提出時のENS実動作はlive Sepoliaで住所契約とは別の明示add-on決済後に実登録・公式解決し、代表的な権限拒否または失効照合を示す。add-on重複購入拒否または住所renewにENS追加料金がないことも既存ケース内で一件示す。A-29/A-31の両方のlive実演や期限境界の網羅は追加検証とする。失効を実演する場合、通常30日契約をDBだけ短くしてchain失効を偽装しない。liveとローカルの結果を明確に区別する。

## ENSを含むデモ差分

従来の5分デモの住所購入直後に「ENS未購入→ユーザーが標準またはcustomを明示選択→別intentで見積・決済→発行済みENS名→公式名前解決→自分の住所契約取得」を追加。標準名は`f00042.<拠点slug>.<parent>.eth`、customは`<customLabel>.<拠点slug>.<parent>.eth`。testnet価格は住所0.55、標準ENS0.10、custom ENS0.30 USDC。住所purchase/renewだけではENSを発行しない。二重ENS add-on課金なし、住所renew時にENS追加課金なしを既存ENS購入/更新ケースの代表例として示す。名前競合では利用者へ標準/別customの再選択を求め、自動切替しない。禁止key拒否または取消後の照合拒否も代表的な失敗経路として提示する。description委任成功を含む残りの組合せは追加検証とする。名前発行がpendingなら成功と表示しない。実郵便処理は行わない。

ENS提出証跡: 親名・registry/resolver/controller・Sepolia explorerリンク・公式解決結果・権限拒否・失効・再現手順。名前を画面に固定表示しただけでは完成としない。

## GCP / Firestore追加受入テスト

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-37 | R-01/R-15 | 新規building、全65535枠境界、予約/未払い解放/発行 | 64shardのみ初期化。slotは必要時生成、issued再利用なし、quotaとbitmap整合 |
| A-38 | R-03/R-06/R-15 | transaction callback強制retry、同nonce別注文、並行approval | 外部API呼出0回/callback、guardで一意、最終適用一回 |
| A-39 | R-10/R-15 | outbox commit後enqueue前停止、task重複、worker応答喪失 | Scheduler回復、外部結果を照合、重複決済/名前登録なし、retry上限後manual_review |
| A-40 | R-10/R-15 | Cloud Run min=0復帰、worker実行中停止 | 状態保持、HTTP終了後CPU不要、claim切れだけで再送なし、cold/warm別計測 |
| A-41 | R-07/R-15 | 未認証worker、browser Firestore/GCS直接アクセス、別repo/refのCI、Terraform planに本アプリ所有外の更新/削除、共有`(default)` DB/rules/project IAM/API/予算の変更、他collection groupのindex変更を含める | IAM/rules/WIFでアクセス拒否。共存ゲートが非対象変更を拒否し、本アプリ専用SAへの限定的なIAM member追加は許可する。既存policy bindingの置換や他主体grantの削除を拒否し、専用prefixのリソースだけを許可。公開UI/World callbackは利用可、secret key JSON不要 |
| A-42 | R-10/R-15 | 本アプリのwriterだけ停止後に、本アプリ対象collectionだけをsnapshotしEmulatorへ復元→chain差分照合 | prefix付き本アプリのguards/bitmap/契約/暗号化宛先/冪等記録が一致。共有DB全体のread/restoreを要求せず、失われる更新期間を明記 |
| A-43 | R-15 | 新規契約上限へ並行要求、provider停止、大量pending | 原子的予算制限、未知決済は解放なし、既存照合は継続、全件scan/無限retryなし |
| A-44 | R-15 | eventの使用量測定・設定監査 | min=0、無料枠残/region/secret/image/通信/定期処理費を記録。課金額未反映を0円の証拠にしない |

A-37/A-38の代表的競合はEmulatorで確認する。実GCPへ提出用環境をdeployする前に、live inventory/ownership/rules/region確認とTerraform planの非対象変更拒否をA-41共存ゲートで確認する。実環境では専用prefixのmin=0復帰とIAM拒否を小規模に確認する。全枠境界、callback強制retryの全組合せ、本アプリ対象collectionのsnapshot復元、費用・性能の網羅測定は追加検証とする。共有DB全体のread/restoreは行わない。A-44の費用記録では予算通知が強制停止ではなく、既存サービスと合算評価することを明記する。未deploy・未計測の段階では未実行。

## 管理画面・フロント・AEOの代表チェック

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-45 | R-16 | 許可された管理ログイン、未認証/Agent資格情報で管理API呼出 | 許可運用者のみ管理sessionを得る。未認証/Agent/World人間sessionでは管理操作不可 |
| A-46 | R-16 | 拠点受付停止か安全な再照合要求1件と再送 | CSRF/version/理由を検査し一度だけ監査。決済成功・人間承認を手動上書きしない。宛先全文を返さない |
| A-47 | R-17 | 公開/利用者/管理画面を狭い幅と広い幅で目視 | 標準SaaSの共通部品、読める表/フォーム、pending/空/エラーを正しく表示 |
| A-48 | R-18 | 公開HTML/discoveryをJavaScriptなしでGET、private routeも確認 | 本文/link/canonicalと正確なmetadataあり。robots/sitemap/llms/OpenAPI一致。機密情報なし、privateは認可+no-store/noindex |
| A-49 | R-18 | ユーザーのDNS/TLS設定後に公開originとcallbackを確認 | address.chain.tokyoでHTTPS・同一origin API・callback/cookieを確認。未設定時は未検証のまま記録 |

上記は実装後に代表ケースで確認する。画面コード・DNS・公開到達はいずれも現時点では未実装/未検証。
