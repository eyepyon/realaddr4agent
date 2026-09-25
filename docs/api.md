# HTTP / CLI契約

本書と[OpenAPI](openapi.json)は実装予定のv1契約。外部ベンダーAPIのschemaではない。郵便機能は承認・転送可表示・人間の転送先保存のみ。

## 共通

JSON、UUID、UTC ISO8601、token金額は整数文字列。未知のrequest fieldは拒否。
AgentはBearer認証、人間はHttpOnly/Secure/SameSite=Laxのserver session cookie。cookie mutationはCSRF + Origin検査。anonymous sessionは承認画面表示で作るが、wallet proofとWorld検証前は保護データを返さない。

AgentのmutationはIdempotency-Key必須（8〜128文字）。同キー別bodyは409。cookie mutationはversion/CASと一回限りchallenge/approvalで再送制御する。

200/201=成功、202=処理中、401=認証なし、403=権限/承認/リスク拒否、404=不可視/不存在、409=状態競合、410=期限切れ、422=入力不可、429=制限、503=依存停止。402は有効な支払い可能intentのみ。

共通エラー: {"error":"human_approval_required","message":"…","retryable":false,"traceId":"…","resourceId":"…"}。errorは安定したlower_snake_caseの機械判定用codeであり、messageは表示用。他者情報を漏らさない。全応答にX-Trace-Id。listはlimit 1..100/default20、opaque cursor、locations/subscriptions/paymentIntentsとnextCursor。その他のlistはitems/nextCursor。

location/payment intent/subscription本体の識別子はid。参照先とpath parameterはlocationId/intentId/subscriptionIdを使い、payment intentのpayPathから支払い先pathを取得する。

公開用語はlocation（内部Building）、virtual floor（内部slotNumber）、payment intent（内部Order）、subscription（内部Lease）とする。floorは建物の物理階ではなく1..65535の仮想区画。購入時にfloorを指定でき、未指定ならサーバーが空き区画を自動割当する。指定したfloorが保持・発行済みなら409 / slot_unavailable。認証・決済・契約状態はこのAPI固有の契約に従う。

## エンドポイント

| Method/path | 権限 | 内容 |
| --- | --- | --- |
| GET /health | public | process起動確認。外部依存の疎通保証ではない |
| GET /openapi.json | public | このOpenAPI 3.1契約 |
| POST /v1/auth/challenges | public | wallet challenge |
| POST /v1/auth/sessions | public署名検証 | Agent token発行 |
| DELETE /v1/auth/session | Agent | 現token失効 |
| GET /v1/locations | Agent | 公開拠点・plan。locations/nextCursorを返す |
| GET /v1/locations/{locationId}/floors/{floor} | Agent | 仮想区画の現在の空き状態。availableのみ返し、予約の確約はしない |
| POST /v1/payment-intents | Agent | purchase/renewまたは既存契約への一回限りのens_addon intent。区画予約はpurchaseのみ |
| GET /v1/payment-intents | Agent | 自分のintent一覧。createdAt降順、paymentIntents/nextCursor。署名payloadは返さない |
| GET /v1/payment-intents/{intentId} | owner Agent | 状態・リスク・結果 |
| POST /v1/payment-intents/{intentId}/pay | owner Agent | preconditions→402→決済→200/202 |
| GET /v1/subscriptions | Agent | 自身の契約。subscriptions/nextCursorを返す |
| GET /v1/subscriptions/{subscriptionId} | owner Agent | 住所/期限/chain/転送可/宛先有無 |
| POST /v1/subscriptions/{subscriptionId}/mail-approval | owner Agent | mail.enable承認URL発行。forceReauthで人間session再取得も可 |
| POST /v1/approvals/{approvalId}/owner-challenge | browser session+CSRF | ownerWallet署名要求 |
| POST /v1/approvals/{approvalId}/owner-proof | browser session+CSRF | 一回限りwallet署名検証 |
| GET /v1/approvals/{approvalId} | wallet-proven human session | 承認対象表示 |
| POST /v1/approvals/{approvalId}/authenticate | wallet-proven human+CSRF | World OIDC開始URL |
| GET /auth/world/callback | state-bound browser | code/error処理→303固定same-origin画面 |
| POST /v1/approvals/{approvalId}/decision | World認証済みhuman+CSRF | approve/deny、actionHash/時刻検査 |
| GET /v1/subscriptions/{subscriptionId}/mail-profile | 同一binding human | 状態と復号した転送先 |
| PUT /v1/subscriptions/{subscriptionId}/mail-destination | 同一binding human+CSRF | expectedVersion付き宛先保存/更新 |
| POST /v1/subscriptions/{subscriptionId}/mail-disable | 同一binding human+CSRF | enabledを取消 |

/approve/{approvalId}はUIルートでありOpenAPI対象外。新browser sessionに同じ責任者が戻る場合もowner-wallet + fresh Worldを通す。既存grantを再承認しても他のbindingへ変更しない。

人間だけが宛先を入力する。AgentのAPIレスポンスはdestinationConfiguredのみ。初回approveの応答はenabled/未登録を返し、UIがフォームを表示する。フォーム保存はreal DB writeであり、成功表示だけのモックは不可。

## 支払いwire

intent作成bodyは購入なら`{"locationId":"…","floor":42}`（floorは省略可、kind省略時はpurchase）、更新なら`{"kind":"renew","subscriptionId":"…"}`、ENS初回追加の標準名なら`{"kind":"ens_addon","subscriptionId":"…"}`、独自名なら`{"kind":"ens_addon","subscriptionId":"…","nameType":"custom","customLabel":"my-agent"}`。`nameType`省略時は`floor`で、`nameType=custom`では`customLabel`必須、`floor`では指定不可。同じAgentの同じintentへの再送は同じ結果を返す。購入時に指定floorを予約する場合も、未指定の自動割当と同じFirestore transactionで区画・quota・冪等記録を確定する。

住所planは30日・USDC 6 decimalsを固定し、event test/dev価格は0.55 USDC=`550000` atomic。将来mainnet価格は55 USDC=`55000000` atomicの別profileだが、現仕様の支払いchainはBase Sepoliaだけでmainnet販売は停止する。実asset address/decimals・facilitatorの接続はT-00で検証し、一致しない環境を起動しない。ENS初回追加feeは住所planと別で、event test/devの標準名が0.10 USDC=`100000` atomic、独自名が0.30 USDC=`300000` atomic。将来mainnetの標準名は10 USDC=`10000000` atomic、独自名は30 USDC=`30000000` atomicで、mainnet販売は現在停止する。設定が選択environment/nameTypeの固定額と一致しない・欠落する場合は503 / `ens_pricing_unavailable`でintentを作らず、402も返さない。ENS追加の価格・asset・network・payTo・pricingVersion・nameType・label・canonical FQDNは作成したintentに固定して決済前に表示する。`GET /v1/subscriptions/{subscriptionId}/ens`は価格を約束せず、未購入時も`status=not_purchased`を返す。

標準名のlabelは仮想区画番号を5桁ゼロ埋めした`f00042`で、`f00042.<locationSlug>.<parent>.eth`のように組み立てる。独自名も同じ拠点namespaceの`<customLabel>.<locationSlug>.<parent>.eth`を一契約のcanonical名とする。`customLabel`は小文字ASCIIのDNS label、3〜32文字、英数字で開始/終了し内部の`-`を許す。`f`に数字だけが続く全labelを標準用に予約する。初期`namePolicyVersion=1`のservice予約labelは正確に`admin`、`api`、`www`の3つで、serverは見積前にこの固定policyとENSIP-15でlabel/FQDNを検証する。見積snapshotのpolicy versionはNameControllerへ渡し、将来のpolicy変更でも支払済みの旧version/nameを遡って拒否・改名・再課金しない。正規化後のFQDNについて全契約で一意のguardを取る。衝突は409 / `ens_name_unavailable`とし、他契約情報を返さない。未払い確定のpending guardだけ原子的に解放し、結果不明/settlingは保持する。発行済み名は期限後も別leaseへ再利用しない。名前type/label/FQDN/feeは署名・pay再送時に変更できない。有料renameと二つ目の名前はv1対象外。

`ens_addon`はowner Agentの有効な既存subscriptionだけを対象に、`locationId`と`floor`をserver側で導出する。新しい区画holdや日次新規契約quotaは消費しない。同一subscriptionのpaid entitlementは一回限りで、同時に進行できるaddon intentも一つ。新しい冪等キーで購入済みなら409 / `ens_already_purchased`、進行中なら409 / `ens_purchase_in_progress`と既存`intentId`を`resourceId`で返す。既存キーの同一要求は通常の冪等結果を返す。未払い確定したintentだけ排他を解除して再購入を許し、決済結果不明を時間切れだけで解除しない。発行失敗で返金済みのentitlementも自動再購入を提供せず409 / `ens_repurchase_unavailable`。所有外/未知subscriptionは404、有効でなければ409 / `lease_not_active`。親名残存期間やregistry/ENSの必須設定を確認できない場合も503 / `ens_dependency_unavailable`で販売を止め、402は返さない。addon intentの`expiresAt`は見積もりから10分とsubscription期限の早い方であり、支払い署名前に契約有効性と購入状態を再検査する。既にsettling/reconcilingなら不明決済を同じintentで照合し、新nonce・新しいENS請求を求めない。risk評価、x402、支出上限、payer/nonce/receipt照合は住所決済と同じ規則を使う。

floor空き照会は`{"locationId":"…","floor":42,"available":true}`を返す。bitmapの現在状態を認可付きで読むが、照会と予約の間に他要求が入るため、購入はtransaction内で再判定する。未知locationは404、floorが整数1..65535以外なら422。他ownerや契約の情報は返さない。

未払いpayは空JSON body。同じpath/body/Idempotency-KeyへPAYMENT-SIGNATUREを付けて再送する。PAYMENT-REQUIREDとPAYMENT-RESPONSEは公式x402 v2 SDKのencoder/decoderを使用する。

402を冪等cacheの最終結果にしない。支払い付き初回payはFirestore outboxを保存してCloud Tasksへ配信し202、完了後の同一payは200。enqueue失敗もoutboxから回復する。settling/reconciling/manual_review/refund_pendingの202はintentId、pollUrl、retryAfterSecondsを返す。manual_reviewは決済済み未履行や結果不明の確認待ちであり、新nonce/再settle/新しい請求を要求しない。復旧した同じorderだけをfulfilledにする。確定200はstatus=fulfilledとsubscriptionId、receiptを返す。発行失敗による返金が確定した同じpayの再送は200 / `status=refunded`と返金receiptを返し、新たなsettleを開始しない。冪等記録のresourceIdは維持しつつ現在のorder状態から応答を組み立て、過去の200 fulfilled snapshotを後のrefundedに優先しない。`ens_addon`のfulfilledは既存subscriptionへ一回限りのpaid entitlementとENS発行outboxを永続化した意味であり、ENSがreadyになった意味ではない。settle後に契約が期限切れ/停止でもpaidを消さず発行を保留し、期限切れの同一subscriptionの住所renewで復旧する。不明・再試行可能なENS発行障害はpaid entitlementを保持して照合し、readyと偽らない。復旧不能な発行失敗が確定し、提出済みtxと無効化をfinality付きで確認した後だけENS追加料金全額を自動返金し、住所利用は維持する。技術的な発行retryと以後の住所renewに伴うENS同期は再課金しない。

OpenAPIのpayment headerはencoded stringとして扱い、内部payload validationは固定したx402 SDK schemaを用いる。SDK schemaを独自に推測して再定義しない。

Firestore予約競合のretry枯渇は503 / reservation_retry / retryable=true。同じ冪等キーで再試行する。全枠消費を確認した場合は409 / sold_out。日次新規契約上限は429 / daily_purchase_limitとし、既存intentの照合・実行結果取得は止めない。内部task/sweep endpointは別Cloud Runの非公開APIであり、Agent向けOpenAPIに追加しない。

## CLI（実装予定）

入口: pnpm agent -- <command> --json。鍵は引数やpromptに渡さずsecret storeへ。

| command | 行動 |
| --- | --- |
| auth login | wallet challenge→Agent token |
| locations list | 拠点/料金 |
| lease purchase --location <id> [--floor <n>] --idempotency-key <key> | reserve→screen→pay→subscription。floor省略時は自動割当 |
| lease renew --subscription <id> --idempotency-key <key> | 同区画更新 |
| lease status --subscription <id> | 状態/chain/転送可表示 |
| ens purchase --subscription <id> [--name-type custom --name <label>] --idempotency-key <key> | 標準名はoption省略、独自名はlabel指定。固定見積もりを確認し同じx402経路で一回購入。衝突・設定不備・既購入・進行中は機械判定可能なエラー |
| mail enable --subscription <id> --idempotency-key <key> | approvalUrlを返して人間待ち |
| mail status --subscription <id> | enabledとdestinationConfiguredのみ |
| intent status --intent <id> | 不明決済の結果回収 |

stdoutはJSON一件、stderrはredacted diagnostics。
exit 0=成功、2=入力、3=認証、4=人間待ち、5=risk拒否、6=保留、7=予算、8=競合。
pollは5秒起点/最大30秒backoff+jitter、最大待機後もIDを返し再開可能。

開発エージェントには次の利用指示を与える:
「住所を購入し、転送設定の承認URLを提示してください。人間がブラウザで承認と住所入力を行った後、設定状態を確認してください。」
Agent自身に人間承認・フォーム代筆をさせる指示は出さない。

## 禁止

Agentにapproval.approve、mail-destination.writeを付与しない。clientのhumanApproved/riskPassed/paid fieldを採用しない。実発送endpoint・送料orderは存在させない。URLの存在、World認証成功、宛先入力済みを法的本人確認完了と同一視しない。

## ENSv2追加API

詳細は[ENSv2設計](ensv2.md)。ENSを購入しなくても住所契約と郵便承認フローは利用できる。paid entitlementがないSubscriptionは`ens.status=not_purchased`を返し、進行中の支払いは別のpayment intentで確認する。paid後の発行障害は`ens.status=pending|error|disabled`で実状態を示し、再購入や新しい請求を求めない。返金中/返金済みentitlementは`ens.status=disabled`とし、確定後は`lastErrorCode=ens_refunded`で実状態を示して自動再購入させない。name/resolver/txHash等を捏造しない。ENS購入済みの住所renewでは名前とlease version/期限を追加料金なしで同期する。以下もOpenAPIに含める。

既存のENS GETはaddon価格や販売可否を返さない。利用者画面は架空の金額や購入可能表示を出さず、「ENS追加料金をCLIで確認」の導線を示す。CLIの`ens purchase`が作成したpayment intentの固定見積もりを署名前に表示し、料金未設定や依存設定不足は503のquote errorとして知らせる。

| Method/path | 権限 | 内容 |
| --- | --- | --- |
| GET /v1/ens/resolve?name=... | public・rate limited | 公式ENSv2とcontroller/契約状態を照合しverified/pending/invalidを返す |
| GET /v1/subscriptions/by-ens?name=... | owner Agent | verifiedな自分の契約を既存Subscription shapeで取得 |
| GET /v1/subscriptions/{subscriptionId}/ens | owner Agent | 名前発行・同期状態 |
| POST /v1/subscriptions/{subscriptionId}/ens-description-transaction | owner Agent + Idempotency-Key | description更新のunsigned txを構築。送信/保存完了ではない |

public responseは内部lease UUID、営業所住所、転送先、World認証、郵便設定を含めない。verifiedは名前と有効契約の一致のみを意味する。RPC停止は503、実在するが同期中は200/pending、存在しない/期限切れ/検証不一致は200/invalidと理由を返す。by-ensは自分のbindingを確認後もpendingなら409、invalidなら410。他者/不明は404。

/subscriptions/by-ensのstatic routeを/subscriptions/{subscriptionId}より優先して登録する。成功したSubscription responseにはensフィールドを追加する。内部lease UUIDがsubscriptionIdであり、IDによる直接照会も使用できる。

CLI追加: ens purchase --subscription、ens status --subscription、ens resolve --name、lease status --name、ens describe --subscription --text。describeは購入済みでreadyのSepolia resolverのdescription setterだけを署名し、receipt/read-back後に成功を報告する。

## 管理APIと画面の境界

管理者向け操作は[管理画面仕様](admin.md)と[管理OpenAPI](admin-openapi.json)で定義する。Agent BearerやWorld人間sessionに管理権限を追加しない。公開予定originはhttps://address.chain.tokyo。公開の/openapi.jsonは本書のAgent/人間向け契約を返し、管理操作や管理者情報を埋め込まない。

/appの利用者画面はブラウザwalletのchallenge署名で既存Agent認証を行い、tokenをメモリ内に保持してAgent APIへアクセスする。転送先の閲覧/保存は引き続き別の人間sessionだけを受け付ける。詳細は[画面仕様](frontend.md)。
