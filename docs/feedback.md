# Integration feedback

応募フォーム向けの短いフィードバック。実装と接続記録から説明できる内容を記載し、改善案は提案として示す。導入開始から最初の成功までの時間と使いやすさの点数は、計測記録・本人評価から追記する。約1.6秒という値は一回のHTTP応答時間であり、導入所要時間ではない。

## World

日本語:

- OIDCのdiscovery、PKCE、JWKSを使い、本人認証とアプリの操作同意を分離しました。
- owner wallet、契約、nonce、宛先versionを承認要求へ結び付け、ログインだけで転送設定が変わらない設計にしています。
- イベントのmock proofと本番の本人確認保証を区別する説明が重要でした。
- 改善提案は、fresh認証から明示承認までの例に、取消・期限切れ・再送と期待するclaimを含めることです。

English:

- OIDC discovery, PKCE, and JWKS let us separate authentication from application consent.
- We bind requests to the owner wallet, lease, nonce, and destination version; signing in alone cannot enable forwarding settings.
- Clear distinctions between event mock proofs and production identity assurance are important.
- We suggest a fresh-authentication example covering explicit consent, cancellation, expiry, replay, and expected claims.

## Intercepta

日本語（README掲載用、4行）:

- 認証付きQuick ScanでHTTP 200とschema一致を確認し、一回の成功応答は約1.6秒でした。
- typed adapterで危険trait・未知の応答・通信失敗を、決済準備を止める理由へ変換しました。
- 数値スコアの意味とendpointごとのmainnet coverageを対応付ける説明が、判定policyの確定に必要です。
- 改善提案は、安全・危険の参照例、推奨policy、testnet決済時のmainnet照会例を一つのガイドにまとめることです。

English (four lines for the README):

- An authenticated Quick Scan returned HTTP 200 and matched the schema; one successful request took about 1.6 seconds.
- A typed adapter converts prohibited traits, unknown responses, and transport failures into reasons to stop settlement preparation.
- Policy configuration needs a clear mapping between score semantics and each endpoint's mainnet coverage.
- We suggest one guide with safe/risky reference cases, recommended policies, and mainnet screening for testnet payments.

## Curvegrid / MultiBaas

日本語:

- LeaseRegistryのABI登録・link・read-backと、Ethereum Sepoliaのstatus照会を確認しました。
- MultiBaasと独立RPCの同じfinalized blockで契約状態を突き合わせるadapterを実装しました。
- UIでdeployment時にtransactionが返らずwallet確認画面が開かないケースがあり、署名とreceipt確認を分けて対処しました。
- 改善提案は、transaction生成失敗・署名待ち・送信結果不明を区別するUIと、historical block指定の最小例です。

English:

- We confirmed ABI registration, contract linking, read-back, and Ethereum Sepolia status queries for LeaseRegistry.
- Our adapter compares MultiBaas and an independent RPC at the same finalized block.
- A deployment UI attempt returned no transaction and opened no wallet prompt, so we separated signing from independent receipt verification.
- We suggest clearer transaction-generation, signature-waiting, and unknown-submission states, plus a minimal historical-block example.

## ENSv2

日本語:

- 階層registryとrecord単位の権限により、契約名・保護record・利用者descriptionを分離する構成を作りました。
- 親名・上位registry・controllerの接続では、receipt、コード、権限と最終確定を個別に照合しました。
- wallet wrapperの取引形式と、過去blockを取得できるRPCの範囲が、主な調整点でした。
- 改善提案は、親から子の登録、専用resolver、最小権限、Universal Resolver照合を通した実行例です。

English:

- Hierarchical registries and record-level permissions let us separate lease names, protected records, and user descriptions.
- Parent, upper-registry, and controller setup required independent checks of receipts, code, permissions, and finality.
- Wallet-wrapper transaction formats and historical-block availability were the main integration adjustments.
- We suggest an example covering parent-to-child registration, a dedicated resolver, minimal permissions, and Universal Resolver verification.

実施範囲と残る実演は[実装状況](implementation-status.md)と[受入条件](acceptance.md)で管理する。改善提案を実決済・名前発行・承認の成功証跡として扱わない。
