# 運営管理画面・API契約（実装予定）

本書はハッカソン用の最小運営機能を定義する。現在は仕様のみで、管理画面、Googleログイン、管理API、DNS、デプロイは未実装・未検証。公開Agent APIの正本は `docs/openapi.json`、運営APIのHTTP shapeは `docs/admin-openapi.json` とする。運営者画面は同じ公開origin `https://address.chain.tokyo/admin` のReact/Vite UIとして配信する。ドメイン/DNS設定はサービス運営者が行い、新しいCloud Run、ロードバランサ、IAPは追加しない。

## 画面と情報境界

| 画面 | 表示 | 操作 |
| --- | --- | --- |
| 概要 | testnet/sandboxラベル、契約・未確定決済・同期保留・失敗件数、最終更新時刻 | 手動更新 |
| 拠点 | 公開エリア、提供住所、plan、販売状態、version、発行済み契約数 | 作成、編集、販売停止・再開 |
| 決済 | payment intent ID、仮想区画、金額、risk判定、支払い・照合状態、traceId、時刻 | 状態確認のみ |
| 契約とENS | subscription ID、仮想区画、期限、契約状態、ENS種別・canonical name・registry同期、mail enabledと宛先登録有無 | 状態確認のみ |
| 処理と監査 | 未完了outbox/jobの安全な要約、最終error code、次回実行時刻、運営操作履歴 | 対象を指定した読取照合の再要求 |

一覧はserver側でカーソルページングし、limitは1〜100、既定20件。概要は全件scanせず、権威的な状態遷移と同じtransactionで更新する小さな `ops_metrics/current` 集計documentから読む。このdocumentは `schemaVersion`、`version`、`asOf`、`locationCount`、`activeSubscriptionCount`、`uncertainPaymentCount`、`syncPendingCount`、`manualReviewCount`を持ち、`GET /v1/admin/overview` の同名fieldへ写す。`asOf` を表示し、集計が未作成・破損・更新失敗なら `available=false`、`asOf=null`、該当counterを `null` として「取得不可」と表示する。欠損を0件に見せず、古い集計は時刻を明示する。この集計を決済・権限判定に使わない。自動pollingせず手動更新する。pending、unknown、reconciling、manual_reviewを成功として表示しない。支払いはBase Sepolia、ENSとLeaseRegistryはEthereum Sepoliaと明記する。区画番号1〜65535は「仮想区画 V00042」のように表示し、物理階数と区別する。住所提供拠点の表示と、人間が入力した転送先住所は別物である。

管理API・UIは転送先住所の平文、World issuer/subject、OIDC token、wallet署名、支払いauthorization/receiptのraw値、秘密鍵を一切返さない。Agentのmail状態と同等の `enabled` / `destinationConfigured` だけを契約一覧に出せる。運営者は `mail.enable` の承認・取消、宛先の読取・入力・修正を代行できない。World認証を法的KYCと表示せず、KYC審査画面は設けない。実郵便、サポートCMS、返金実行、手動の決済済み化・契約発行・ENS verified化を含めない。

## 運営者認証

`GET /auth/admin/start` でサーバーが一回限りのstate、nonce、PKCE verifierを作り、短命HttpOnly/Secure/SameSite=Laxのログインcookieに結び付けてGoogle OIDCへ遷移する。`GET /auth/admin/callback` はstateと同じbrowser login cookieを照合してからcodeをサーバーで交換し、署名済みID tokenのissuer、audience、nonce、iat、期限、`email_verified=true`、subjectを検証する。ログインcookieとstate/nonceは一回使用で失効させる。初回はFirestoreの有効な `admin_principals` email entryとの一致を確認し、検証済みの(issuer, subject)をそのentryへ固定する。次回から同じemailだけで別subjectへ再結合しない。各管理requestでsessionの(issuer, subject)が現在 `active` なentryの固定値と一致することを再確認し、entry失効・削除で即時拒否する。emailやdomainだけの一致では権限を与えない。初期principal未登録、OIDC設定不備、検証不能はfail closed。loginと管理者sessionはWorldの人間承認session、Agent bearerから完全に分離する。

運営者session cookie名は `realaddr_admin_session`。opaque IDをFirestoreで検証し、idle 15分・absolute 60分、ログイン時にrotateする。`GET /v1/admin/session` は認証済みの表示名、role、期限、session用CSRF tokenだけを返し、subjectをclientへ返さない。`DELETE /v1/admin/session` で失効させる。v1はallowlistの単一 `operator` roleのみとし、読み取りと本書の限定操作を許す。別roleや同意代行権限は定義しない。

設定名は `ADMIN_GOOGLE_CLIENT_ID`、`ADMIN_GOOGLE_CLIENT_SECRET`、`ADMIN_OIDC_REDIRECT_URI`（このoriginの `/auth/admin/callback` と完全一致）、`ADMIN_SESSION_SECRET` とする。`ADMIN_ALLOWED_EMAILS` は保護された初回bootstrap入力だけに使い、稼働中の認可正本にはしない。OIDC/session設定が欠ける環境、または有効なFirestore principalが存在しない環境ではadmin login/APIをfail closedにする。実値はserver側のSecret Manager等から注入し、clientやTerraform stateには置かない。

Firestoreの `admin_principals/{emailGuard}` は正規化emailの決定的hashをguard IDにし、`emailLower`、`issuer`、`subject`、`role=operator`、`status=active|revoked`、`boundAt`、`version`、`schemaVersion`を保存する。保護されたbootstrap入力で未結合entryを作り、以後このcollectionを認可正本とする。初回bindingは `active` かつ未結合entryをFirestore transactionで比較・確定する。並行する別subjectへの結合や、既存結合の上書きを拒否する。失効は保護された運用手順でentryを `revoked` にし、既存sessionを含め次requestで拒否する。再bootstrapは結合や失効を上書きしない。`admin_oidc_sessions/{loginIdHash}` はstate/nonceのhash、暗号化したPKCE verifier、login cookie hash、作成・期限・消費時刻を持ち、callbackで一回だけ消費する。`admin_sessions/{sessionIdHash}` はprincipal guard ID、issuer/subject、CSRF token hash、作成・最終利用・absolute期限・失効時刻、schemaVersionを持つ。`ADMIN_SESSION_SECRET` を鍵とするdomain-separated HMAC-SHA256で現在のopaque session cookie IDからsession専用CSRF tokenを決定的に導出し、cookie IDそのものは返さない。DBにはそのtokenのhashだけを保存し、session GETで再導出、mutationでは受け取ったtokenをconstant-timeで照合する。生tokenやcookie値はDBに保存しない。idle期限とabsolute期限の両方を毎requestで検査し、最終利用時刻を更新する。ログインcallbackで外部code交換をFirestore transaction内で実行しない。

全 `/v1/admin/*` はserver側でoperator sessionを再検証する。Agent bearer、World/human cookie、URL token、共有passwordでは入れない。管理用cookie mutationは厳密な同一Origin検査、CSRF token、JSON content typeを要する。CORSは許可しない。読み取りの応答は `Cache-Control: no-store`、管理HTML/assetはnoindex。ヘッダー、query、bodyに自己申告されたactorは採用しない。異なる認証種別からのアクセスは401/403で拒否し、存在を秘匿すべきIDは404とする。認証情報やGoogleの生エラーを通常ログへ記録しない。

Googleの[OpenID Connect検証手順](https://developers.google.com/identity/openid-connect/openid-connect)は署名・issuer・audience・expiryのserver検証を要求し、[OIDC claim仕様](https://developers.google.com/identity/openid-connect/reference)は変更可能なemailでなく安定したsubjectを識別子に使うよう示す。[web server OAuth手順](https://developers.google.com/identity/protocols/oauth2/web-server)に従いcallback前のstateを照合する。使用SDKとmethodはT-00/T-18で実際のversionを検証して固定する。

## 書込規則

拠点の `locationId` はserver生成UUID、`slug` は別の決定的unique guardで一意にする。slugは作成後常に不変。新規拠点は住所、公開エリア、固定plan参照、販売状態を登録し、`floor` の総数を個別に設定しない。運営画面で料金、期間、通貨、atomic amountを任意編集する機能は設けない。住所planは30日55/0.55 USDC、ENS初回add-onは標準10/0.10、custom30/0.30 USDC（mainnet想定 / testnet-dev、6 decimals）。plan料金は実行環境の固定設定から導出し、allowlist/network/asset/rateと一致しない場合は起動・intent作成を拒否する。testnet/dev価格をmainnetで使えず、環境変数だけでmainnetを有効化できない。ENS add-onの名前型ごとの環境設定が欠落またはchain不整合なら販売不可。表示名、公開エリア、販売状態は更新できるが、更新後のplanと住所表示は新しいpayment intentだけに使い、既存intentの固定価格・期間・住所snapshot、既存契約を変更しない。住所renewは住所30日料金のみで、購入済みENSの期限同期を含む。ENS初回料金を住所料金へ混ぜない。ENS名の変更や同一leaseへの2つ目のENSは初回購入後に許可しない。active hold、settling/reconcilingのorder、または発行済み契約が一つでもある拠点の郵便番号・正確な提供住所は不変。住所を変える場合は新しい拠点を登録する。販売停止は新規予約を止める。停止前に作成済みの未払いintentも支払い前の可用性検査で止め、決済中・結果不明の照合や成立済み契約の権利は消さない。再開も安全性判定や在庫競合を迂回しない。

拠点create/update/pause/resumeは理由（3〜500文字）、`Idempotency-Key`、更新時 `expectedVersion` を必須とする。Firestore transactionでversion比較・状態更新・監査record・outboxを一緒に確定し、外部効果はtransaction外で実行する。同じキーと同じbodyは同じ結果、別bodyは409。失敗した競合は409で現在versionを返すが、他者情報は返さない。拠点の削除endpointは作らない。

再照合は `payment`、`registry`、`ens` 種別で、既存の未確定・照合待ち・manual_review operation IDだけを対象にする。`POST /v1/admin/operations/{operationId}/reconcile` は理由、対象の `expectedVersion`、`Idempotency-Key` を要求し、Firestoreに監査付きの読取照合要求を永続化して202を返す。workerは既存tx hash、authorization、receipt、registry/ENS read-backを参照して事実を確認し、既存の状態遷移規則だけを適用する。この運営者操作を根拠にsettle再実行、別nonce支払い、返金送金、chain書込/ENS再登録、強制発行、hold解放を開始しない。不確かな結果は引き続き保留し、新たな支払いを求めない。配送キューへの配信失敗は永続outboxから回復する。結果の確認は処理一覧を再取得する。

全書込の監査には `eventId`、UTC日時、verified operator subjectを内部IDとして固定した `actorId`、action、targetType/targetId、理由、前後version、idempotency keyのhash、結果（requested/applied/rejected/failed）、traceIdを保存する。個人情報や認証token、転送先、raw receipt、秘密は含めない。外部照合の「要求」と「検証完了」を別eventにし、要求だけで成功を示さない。監査はappend-onlyとしUIから削除・編集できない。

## 実装・受入れ

T-08のUI、T-16の同一origin配置に合わせて管理画面を追加する。Firestore server SDKはSecurity Rulesを迂回するので、operator認可と全更新条件をAPI/repositoryで強制する。adminの認証設定が未確定なら管理画面/APIの保護データと書込を提供しない。最小確認は運営者ログイン、Agent/human/未認証の拒否、拠点の停止または再開を1件、対象があれば読取再照合を1件とし、監査とversion競合を確認する。実接続していない結果を成功扱いしない。実施・未実施を `docs/implementation-status.md` に記録する。
