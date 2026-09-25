# HTTP / CLI契約

本書と[OpenAPI](openapi.json)は実装予定のv1契約。外部ベンダーAPIのschemaではない。郵便機能は承認・転送可表示・人間の転送先保存のみ。

## 共通

JSON、UUID、UTC ISO8601、token金額は整数文字列。未知のrequest fieldは拒否。
AgentはBearer認証、人間はHttpOnly/Secure/SameSite=Laxのserver session cookie。cookie mutationはCSRF + Origin検査。anonymous sessionは承認画面表示で作るが、wallet proofとWorld検証前は保護データを返さない。

AgentのmutationはIdempotency-Key必須（8〜128文字）。同キー別bodyは409。cookie mutationはversion/CASと一回限りchallenge/approvalで再送制御する。

200/201=成功、202=処理中、401=認証なし、403=権限/承認/リスク拒否、404=不可視/不存在、409=状態競合、410=期限切れ、422=入力不可、429=制限、503=依存停止。402は有効な支払い可能orderのみ。

共通エラー: {"error":{"code":"HUMAN_APPROVAL_REQUIRED","message":"…","retryable":false,"traceId":"…","resourceId":"…"}}。他者情報を漏らさない。全応答にX-Trace-Id。listはlimit 1..100/default20、opaque cursor、items/nextCursor。

## エンドポイント

| Method/path | 権限 | 内容 |
| --- | --- | --- |
| POST /v1/auth/challenges | public | wallet challenge |
| POST /v1/auth/sessions | public署名検証 | Agent token発行 |
| DELETE /v1/auth/session | Agent | 現token失効 |
| GET /v1/buildings | Agent | 公開拠点・plan |
| POST /v1/lease-orders | Agent | purchase/renew orderと区画予約 |
| GET /v1/orders/{orderId} | owner Agent | 状態・リスク・結果 |
| POST /v1/orders/{orderId}/execute | owner Agent | preconditions→402→決済→200/202 |
| GET /v1/leases | Agent | 自身の契約 |
| GET /v1/leases/{leaseId} | owner Agent | 住所/期限/chain/転送可/宛先有無 |
| POST /v1/leases/{leaseId}/mail-approval | owner Agent | mail.enable承認URL発行。forceReauthで人間session再取得も可 |
| POST /v1/approvals/{approvalId}/owner-challenge | browser session+CSRF | ownerWallet署名要求 |
| POST /v1/approvals/{approvalId}/owner-proof | browser session+CSRF | 一回限りwallet署名検証 |
| GET /v1/approvals/{approvalId} | wallet-proven human session | 承認対象表示 |
| POST /v1/approvals/{approvalId}/authenticate | wallet-proven human+CSRF | World OIDC開始URL |
| GET /auth/world/callback | state-bound browser | code/error処理→303固定same-origin画面 |
| POST /v1/approvals/{approvalId}/decision | World認証済みhuman+CSRF | approve/deny、actionHash/時刻検査 |
| GET /v1/leases/{leaseId}/mail-profile | 同一binding human | 状態と復号した転送先 |
| PUT /v1/leases/{leaseId}/mail-destination | 同一binding human+CSRF | expectedVersion付き宛先保存/更新 |
| POST /v1/leases/{leaseId}/mail-disable | 同一binding human+CSRF | enabledを取消 |

/approve/{approvalId}はUIルートでありOpenAPI対象外。新browser sessionに同じ責任者が戻る場合もowner-wallet + fresh Worldを通す。既存grantを再承認しても他のbindingへ変更しない。

人間だけが宛先を入力する。AgentのAPIレスポンスはdestinationConfiguredのみ。初回approveの応答はenabled/未登録を返し、UIがフォームを表示する。フォーム保存はreal DB writeであり、成功表示だけのモックは不可。

## 支払いwire

未払いexecuteは空JSON body。同じpath/body/Idempotency-KeyへPAYMENT-SIGNATUREを付けて再送する。PAYMENT-REQUIREDとPAYMENT-RESPONSEは公式x402 v2 SDKのencoder/decoderを使用する。

402を冪等cacheの最終結果にしない。支払い付き初回executeはFirestore outboxを保存してCloud Tasksへ配信し202、完了後の同一executeは200。enqueue失敗もoutboxから回復する。settling/reconcilingの202はorderId、pollUrl、retryAfterSecondsを返す。新nonceで払い直さない。確定200はstatus=fulfilledとleaseId、receiptを返す。

OpenAPIのpayment headerはencoded stringとして扱い、内部payload validationは固定したx402 SDK schemaを用いる。SDK schemaを独自に推測して再定義しない。

Firestore予約競合のretry枯渇は503 / RESERVATION_RETRY / retryable=true。同じ冪等キーで再試行する。全枠消費を確認した場合は409 / SOLD_OUT。日次新規契約上限は429 / DAILY_PURCHASE_LIMITとし、既存orderの照合・実行結果取得は止めない。内部task/sweep endpointは別Cloud Runの非公開APIであり、Agent向けOpenAPIに追加しない。

## CLI（実装予定）

入口: pnpm agent -- <command> --json。鍵は引数やpromptに渡さずsecret storeへ。

| command | 行動 |
| --- | --- |
| auth login | wallet challenge→Agent token |
| buildings list | 拠点/料金 |
| lease purchase --building <id> --idempotency-key <key> | reserve→screen→pay→lease |
| lease renew --lease <id> --idempotency-key <key> | 同区画更新 |
| lease status --lease <id> | 状態/chain/転送可表示 |
| mail enable --lease <id> --idempotency-key <key> | approvalUrlを返して人間待ち |
| mail status --lease <id> | enabledとdestinationConfiguredのみ |
| order status --order <id> | 不明決済の結果回収 |

stdoutはJSON一件、stderrはredacted diagnostics。
exit 0=成功、2=入力、3=認証、4=人間待ち、5=risk拒否、6=保留、7=予算、8=競合。
pollは5秒起点/最大30秒backoff+jitter、最大待機後もIDを返し再開可能。

開発エージェントには次の利用指示を与える:
「住所を購入し、転送設定の承認URLを提示してください。人間がブラウザで承認と住所入力を行った後、設定状態を確認してください。」
Agent自身に人間承認・フォーム代筆をさせる指示は出さない。

## 禁止

Agentにapproval.approve、mail-destination.writeを付与しない。clientのhumanApproved/riskPassed/paid fieldを採用しない。実発送endpoint・送料orderは存在させない。URLの存在、World認証成功、宛先入力済みを法的本人確認完了と同一視しない。

## ENSv2追加API

詳細は[ENSv2設計](ensv2.md)。以下もOpenAPIに含める。

| Method/path | 権限 | 内容 |
| --- | --- | --- |
| GET /v1/ens/resolve?name=... | public・rate limited | 公式ENSv2とcontroller/契約状態を照合しverified/pending/invalidを返す |
| GET /v1/leases/by-ens?name=... | owner Agent | verifiedな自分の契約を既存Lease shapeで取得 |
| GET /v1/leases/{leaseId}/ens | owner Agent | 名前発行・同期状態 |
| POST /v1/leases/{leaseId}/ens-description-transaction | owner Agent + Idempotency-Key | description更新のunsigned txを構築。送信/保存完了ではない |

public responseは内部lease UUID、営業所住所、転送先、World認証、郵便設定を含めない。verifiedは名前と有効契約の一致のみを意味する。RPC停止は503、実在するが同期中は200/pending、存在しない/期限切れ/検証不一致は200/invalidと理由を返す。by-ensは自分のbindingを確認後もpendingなら409、invalidなら410。他者/不明は404。

/leases/by-ensのstatic routeを/leases/{leaseId}より優先して登録する。成功したLease responseにはensフィールドを追加する。旧UUID指定は引き続き使用できる。

CLI追加: ens status --lease、ens resolve --name、lease status --name、ens describe --lease --text。describeは許可されたSepolia resolverのdescription setterだけを署名し、receipt/read-back後に成功を報告する。
