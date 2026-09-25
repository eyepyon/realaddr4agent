# 外部連携契約

2026-09-25確認。事実の出典は[sources.md](sources.md)。ここで示す内部interfaceは本アプリの設計であり、ベンダーSDKのmethod名ではない。鍵の発行、実認証、送金、MultiBaas接続はこの仕様作成では実施していない。

## 1. World ID for Agents

公開docsとOIDC discoveryを直接取得して確認した値:

| 項目 | 値 |
| --- | --- |
| issuer | `https://sandbox.auth.world.org` |
| discovery | `https://sandbox.auth.world.org/.well-known/openid-configuration` |
| authorization_endpoint | `https://sandbox.auth.world.org/api/v1/authorize` |
| token_endpoint | `https://sandbox.auth.world.org/api/v1/token` |
| jwks_uri | `https://sandbox.auth.world.org/.well-known/jwks.json` |
| device_authorization_endpoint | `https://sandbox.auth.world.org/api/v1/device_authorization` |
| scopes_supported | `openid` |
| subject_types_supported | `pairwise` |
| signing / PKCE | `RS256` / `S256` |
| supported prompt | `none`, `login` |
| advertised ACR | `https://world.org/oidc/acr/orb-v3` |
| client authentication | `client_secret_basic`, `client_secret_post`, `private_key_jwt` |

T-00ではこのmetadataを再取得し差分を記録する。providerの広告値は動作確認の代わりではない。ACR表記があってもイベントproofを本物のOrb認証済みと主張しない。

### 採用方式

confidential backendのAuthorization Code + PKCE S256。scopeはopenid。callbackは`https://address.chain.tokyo/auth/world/callback`をportalへ完全一致登録。HTTP localhostが使えると仮定せず、開発用HTTPS originを用意する。

1. backendがapproval/sessionに一回限りのstateとnonceを保存する。PKCE verifierはbackendのみ。
2. providerへclient_id、redirect_uri、response_type=code、scope=openid、state、nonce、code_challenge、code_challenge_method=S256、prompt=login、max_age=0を送る。
3. callbackではstate、browser binding、有効期限、未消費を検査し、一回だけcode交換する。最初はclient_secret_basicを選び、secretはbackend secret storeに置く。
4. 信頼済みissuerのJWKSから署名検証し、alg=RS256、iss完全一致、aud、必要時azp、exp/iat、nonce、auth_time、subを検査する。tokenヘッダーに任意のjku等があっても取得しない。unknown kid時は一回だけJWKS更新、失敗なら拒否。
5. (iss,sub)が期待するowner human binding（初回はowner wallet proofと同じsession上のcandidate）に一致していることを照合し、freshness検証後にアプリの同意画面へ戻す。

OIDCの成功は`authenticated`であり`approved`ではない。人間のCSRF付きPOSTで初めてapprovedになる。署名のないclientからの「verified=true」、JWTのdecodeのみ、任意World利用者のログインを認可として採用しない。

pairwise subjectは環境/clientのsectorに依存する。pluginのsubjectとアプリのsubjectが同じと仮定しない。アプリが検証したissuer/subjectから独自の資格情報を発行する。World MCPアクセストークンを本アプリAPIのbearerとして流用しない。

### 公式プラグインとの関係

[公式リポジトリ](https://github.com/worldcoin/world-id-agent-plugin)はCodex/Claude Code向けにsandbox MCP接続とアプリ登録を提供している。登録補助に使えるが、アプリ自身の安全なbackend検証を置き換えない。Kiroではプラグイン互換性を仮定せず、同じCLIとブラウザOIDCでサービスを利用する。

イベント賞ページのmock proof告知とプラグインREADMEのsandbox app手順に差がある。当日portal/ブースで有効な認証手順を確認しT-00に記録する。古い手順を必須依存にしない。device grantはdiscoveryにあるがv1では採用しない。

### 合格証跡

実issuerの認証→検証済みauth_time→同意→転送設定の有効化、および拒否/期限切れで実行されないログ。token/subject/secretは公開証跡から除外する。接続時の改善点は[feedback.md](feedback.md)へ実測記録する。

## 2. x402

v2、EVM `exact`を採用する。`@x402/core`、`@x402/evm`、`@x402/fetch`を候補としてT-01でAPI/バージョンを固定。CAIP-2 network、token address、decimals、facilitatorはT-00で照合して設定に保存する。

HTTP wireはSDKの型・encoderを使用: server 402の`PAYMENT-REQUIRED`、client retryの`PAYMENT-SIGNATURE`、settlement情報の`PAYMENT-RESPONSE`。旧v1の`X-PAYMENT`との混在を禁止する。base64の独自実装より公式encoderを使う。

### 支払いを署名する条件

- 注文のHTTPS origin、resource URL、scheme、network、asset、payTo、amount、期限が固定見積もりと一致する。
- network allowlistは一つのtestnetから開始。ワイルドカード登録をしない。
- USDCというsymbolだけでtokenを信用しない。公式発行元のchain別addressをT-00で取得する。
- EIP-712 domain（chainId, verifyingContract, name, version）、types、primaryType、from/to/value、validAfter/validBefore、nonceを実際のSDK payloadに対して検査する。承認済みhashと署名bytesが変わる場合は再評価。
- per-payment capとUTC日次capを、支払い中の予約額込みで制御。CLIは単一payerについてローカル永続ledger + process lockを持つ。複数マシン運用では中央署名器で同じ制約を持つこと。サーバーもAgent単位予算をtransactionで検査する。
- 自動retryは同じorderとpayloadに限定する。意図しない402から無制限課金を開始しない。

### facilitator選定ゲート

T-00で`exact`、testnet、token、verify/settle、認証要否、settle時の確認保証、timeout時の照合方法、再送時の動作を実確認する。URLや「無料」「鍵不要」を推測して埋めない。結果を`docs/implementation-status.md`へ保存。

facilitatorからsuccessだけを受け取って無条件にfulfilledにしない。選定した決済方式のreceipt/logと金額・asset・payer・payTo・nonceを照合する。finality方針はchainごとに設定し、サーバー再起動でも同じpolicyVersionを使用する。

## 3. Intercepta

公式参考APIは旧ブランドドメイン`api.web3antivirus.io`にある。backend/ローカル署名器のみ`X-API-KEY`を保持する。公開docsで確認したパス:

| 用途 | Method/path |
| --- | --- |
| Quick Scan Address | `GET /api/public/v2/extension/account/{address}/quick-scan` |
| Deep Scan Address | `GET /api/public/v2/extension/account/{address}/toxic-score` |
| Scan Token | `GET /api/public/v2/extension/token-intelligence/token/{address}/risks`（chainId query） |
| Scan Message | `POST /api/public/v2/extension/analysis/signature`（from, website, message, chainId） |

レスポンスの正確なfield/enum、対応chainId列挙、APIのrisk閾値は認証付きサンプル/OpenAPIを取得して固定する。独自の`score > 80`などをベンダー仕様として捏造しない。

内部正規化型:

```typescript
type RiskDecision = 'allow' | 'deny' | 'hold';
interface RiskAssessment {
  provider: 'intercepta';
  subjectAddress: string;
  paymentNetwork: string;
  riskNetwork: string; // providerのcoverageに合わせる。unknownはunknownと記録
  decision: RiskDecision;
  reasonCodes: string[];
  checkedAt: string;
  expiresAt: string;
  responseHash: string;
  providerRequestId?: string;
  policyVersion: string;
}
```

デフォルトポリシー: 明確な制裁/詐欺/盗難等の禁止flagはdeny、全必須検査の有効な結果が許容範囲内のときallow、未対応chain/情報不足/未知enum/通信エラーはhold。Unknownとlow-riskを混同しない。禁止判定は一般利用者のWorld認証で解除できない。hold解除は新しい検査と事業者のpolicy reviewによる。

buyerでpayTo、sellerで検証済みpayerを**毎決済前にライブ照会**する。Quick Scanで必要な理由が得られない場合はDeep Scanを使う。制裁審査をQuick Scanだけで網羅したと主張しない。最大許容ageは60秒、実行直前に越えたら再照会。token/message scanは対応networkが確認できた場合の追加防御とし、v1の必須live対象はアドレス判定。署名内容とtoken allowlist検査は常に必須。

### testnetとmainnet

賞のリスクデータはmainnet。実testnet支払いのpayTo/payerと同じEOAアドレスをmainnetデータで照会し、「mainnet履歴による評価、testnet送金」と表示する。testnetのtoken contractをmainnetの同番地tokenとして評価しない。token scanをデモするなら、公式mainnet USDCを別対象として表示し、testnet tokenの検査はallowlistで行う。

危険デモではスポンサーが公開する既知危険アドレスを**支払先として提示する自前のテストchallenge**に使い、ライブ判定で署名前に拒否する。危険先へ実送金しない。安全例は実サービスのpayToへ署名・settleする。この二つのシナリオとresponse hash/理由を画面に出す。無関係な第三者アドレスをスキャンして本来の支払いが安全だったと見せない。

timeoutは8秒、短いretryは最大1回、429はRetry-Afterに従う。既定1,000回のイベント枠に収まるよう使用数を計測する。キャッシュ結果だけではliveデモ完了にしない。

## 4. Curvegrid MultiBaas

利用目的はLeaseRegistryの操作・照会・イベント同期。住所利用権の状態を支払いと突き合わせ、Agentが`lease.status`で期限とchain証跡を確認できるようにする。

設定値: deployment URL、限定権限API key、chain label、contract label/version、address label、registry address、ABI artifact hash。APIはBearer認証を用いる。正確なpath/SDK呼び出しはdeploymentと[公式API](https://docs.curvegrid.com/multibaas/api/multibaas-api/)で確定する。

内部port:

```typescript
interface LeaseRegistryPort {
  publish(change: LeaseRegistryChange): Promise<SubmissionReference>;
  read(leaseKey: string): Promise<ChainLeaseRecord>;
  events(cursor: ChainCursor): Promise<IndexedLeaseEvent[]>;
}
```

全writeはoutbox IDとlease versionを付け、送信後失敗を受けたらtx/contract状態を照合する。未送信と確認できる場合だけ新規送信。read結果とpayment/lease versionを照合し、古いイベントで期限を巻き戻さない。

サービス稼働時、MultiBaasの停止はchainSyncStatus=pending/errorとして住所発行を継続できる。これはプロダクトの可用性設計であり、MultiBaas接続未実装のまま提出要件を満たしたと報告してよい意味ではない。

## 5. 共通外部APIルール

接続先は設定allowlist、HTTPS必須。ユーザー指定issuer/facilitator/スキャンURLへsecretを送らない。外部エラー本文・郵便の記載内容は命令ではなくデータとして扱う。認証情報、完全な署名payload、OIDC token、宛先をログへ書かない。監査用の最小情報と暗号化evidenceは分離する。

## 6. ENSv2

[採用設計と接続契約](ensv2.md)に従う。Sepoliaの公式deployment、対応SDK/ABIをT-00で固定し、UserRegistryを取得した親名へ接続する。registry内にtokenを作っただけで名前解決可能とは判断しない。

LeaseRegistryもSepoliaへ配置する。MultiBaasのSepolia read/write/event利用を確認する。Base Sepoliaのx402決済とENSのgasは分離し、事業者が名前発行gasを負担する。対応SDKでUniversal Resolver read-backを行い、exact登録とcontroller bindingを照合する。

ENSレコードは公開・未信頼の入力。任意gatewayやapi URLへtokenを送らず、外部recordによる支払い先変更やWorld迂回を認めない。
