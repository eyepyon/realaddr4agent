# Interceptaの接続準備

T-00/T-04の初期実装。認証付きQuick Scanのlive照会でHTTP 200と必須schemaを確認した。安全基準・coverage・評価対象chainは未確認のため判定はhold。公開購入・決済は有効化していない。

## 実装と診断

`packages/intercepta/src/index.ts`のserver-only clientは公式Quick Scan Address endpointだけを呼ぶ。`X-API-KEY`は未追跡の`.env`の`INTERCEPTA_API_KEY`へ設定する。URLを利用者入力から選ばず、redirectも許可しない。応答は64 KiBまで、1照会の総期限は8秒。429のRetry-Afterが短時間で満たせる場合だけ最大1回再試行し、それ以外は保留する。生の応答・description・APIキーは出力しない。

repository rootで次を実行する。`$env:INTERCEPTA_SCAN_ADDRESS`には検査対象の公開EOA addressを指定する。診断だけを行い、署名・送金・注文変更はしない。

```powershell
pnpm intercepta:scan --address "$env:INTERCEPTA_SCAN_ADDRESS" --json
```

JSONと終了codeだけを機械処理したい場合は`node node_modules/tsx/dist/cli.mjs scripts/intercepta-scan.ts --address "$env:INTERCEPTA_SCAN_ADDRESS" --json`を使う。codeはallow=0、deny=2、hold=3、不正引数=1。現在の未確定policyではallowを返さない。`requestsAttempted`はそのclientの試行数で、キー全体の累積残枠ではない。共有の利用数ledgerとevent環境への配備は未実装。

## 確認できたschemaと暫定policy

認証付きlive診断は公開EOA一件に対して成功した。HTTP 200、`toxicScore=0`、`traits=[]`、総時間約1.6秒、schema一致を確認した。初回の通信制限による失敗を含め試行2回、成功応答1回。結果は`hold/provider_policy_unconfirmed`であり、実際の支払い先・支払者の検査や決済許可の証拠ではない。Deep Scanは実行していない。

公式[Quick Scan](https://docs.web3antivirus.io/reference/quick-scan-address.md)と[Deep Scan](https://docs.web3antivirus.io/reference/scan-address.md)のOpenAPIは、`toxicScore:number`と`traits:array`を必須とする。各traitは`risk:number`、既知の`name` enum、`txsCount:number`、`description:string`を必須とする。数値の許容範囲・安全の閾値・検査網羅性・endpoint別chain attributionは未確認。Deep Scanへ切り替えるだけで安全判定の不足が解消するとは扱わない。

現在のアプリpolicyは`intercepta-address-v1-pending-review`。構造不正や未知enumはhold。有効な構造に`known_scammer`、`sanction_address`、`blacklist`のtraitがあれば、保守的なアプリ判断としてdenyにする。数値スコアの独自閾値は設けず、その他はhold。ゼロスコア・空traitsも安全の証明にしない。これはproviderが返すallow/deny enumではなく、本アプリの暫定判断である。

レスポンスにchain属性がなくcoverageも未確認のため、現在は`riskNetwork=unknown`を保持する。意図する接続はBase Sepoliaの支払い先/支払者と同じEOAに対するEthereum mainnet履歴の評価であり、testnetの評価済みと表示しない。許可判定を導入するには、実レスポンス、providerによるスコア・traitの意味、必要検査の網羅性、chain範囲を確認してpolicy versionを更新する。

## 決済との境界

`apps/api/src/payment-screening.ts`は購入・更新の内部準備関数。owner認可済み注文の固定見積と、別adapterで検証済みの支払い認可を照合してから、payToとpayerを検査する。両者がallowで対象・network・60秒以内の有効期限を満たす場合だけ既存repositoryのsettlement準備へ渡す。DB transaction内では外部APIを呼ばず、repositoryでも区画・注文・期限を再検査する。deny/hold・未知判定・通信失敗・古い結果では準備を呼ばない。

この関数はHTTP pay routeや実署名器へ未接続。EOA署名・x402認可の検証を代替せず、既存の未実装外部連携を成功にしない。deny/holdの永続audit、buyer署名前の実接続、settle直前の再検査、危険challengeによるlive拒否・安全な実決済は残件。
