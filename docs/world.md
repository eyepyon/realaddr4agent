# World sandbox接続と人間承認

Node/pnpmの共通commandとWindows PowerShell・WSL bash・macOS zshの環境変数、hash、起動手順は[開発環境](development.md)を参照する。各OSのnative toolchainと依存関係を使用する。

T-00/T-03/T-06のWorld sandbox接続と人間専用承認フォームの手順。eventは模擬proofを使用する開発環境であり、本物のOrb認証や法的KYCとは区別する。実装・接続状況は[実装状況](implementation-status.md)を参照する。

## World ID for Agents賞との対応

[ETHGlobal Tokyo 2026のWorld賞](https://ethglobal.com/events/tokyo2026/prizes/world)は、公式event開発環境への接続、要求から検証済み結果と保護操作までの一連の体験、拒否・期限切れ・取消等で操作されない経路、安全なbackend検証、短い実測feedbackを要求する。2026-09-27確認時点では主催者がproofをmockし、sandbox appは不要と告知している。これは公式providerのevent方式であり、アプリがJWT検証・owner proof・明示同意・paid lease検査を省略したり、成功をローカル生成したりする許可ではない。

本アプリの保護操作は、Agentの住所購入とは別の`mail.enable`と人間専用の宛先保存である。Worldで認証しただけでは有効化せず、対象Agent・契約・policy・nonce・宛先versionを固定した要求にowner humanが同意して初めて適用する。実郵便の取扱い、本番本人確認、法的KYCを提供するとの主張はしない。

| 賞の確認項目 | 現在の実装と証跡 | 残るlive確認 |
| --- | --- | --- |
| 要求と人間の完了 | Agentのapproval URL、人間のowner wallet proof、公式OIDCへの遷移を実装 | 実支払済み契約から人間が完了する一本の操作 |
| backendでの結果検証 | `packages/world/src/index.ts`のcode交換・RS256/JWKS・issuer/audience/nonce/auth_time検査、`apps/api/src/world.ts`のcallbackとsession処理 | 公式event providerのcode交換とfreshnessの実応答 |
| 保護操作 | `packages/db/src/world.ts`のtransactionがpaid lease、owner、World candidate、明示同意、対象versionを検査 | 承認後の有効表示、本人による宛先保存と再読込 |
| 不成功経路 | adapter・API・DBの重点検査と公開後の未認証/Agent拒否を記録済み | 同じ公式providerでの取消・拒否または要求期限切れと、操作されない画面 |
| integration debrief | 実装・配備結果は実装状況に記録済み | 初回成功までの実測時間、実際の摩擦、不足、最大効果の改善案 |

公開後の未認証smokeやローカルfixtureは、公式providerでの成功・不成功経路の代わりにはならない。提出説明は機能、操作方法、sandbox区分と実際に取得した結果を中心に構成し、一律の「未検証」表記を求めない。ただし実施していない公式providerの成功・有料lease承認を成功例として紹介せず、T-00/T-03/T-06/T-10/T-11の完了判定は実装状況の証跡に基づく。feedbackの未測定欄は測定後だけ更新する。公式docsとplugin READMEにあるsandbox app手順は当日のprovider画面・ブース案内と照合し、古いアプリ導入手順を必須条件にしない。

## Portal登録と設定

[Portal](https://sandbox.auth.world.org/portal)でGoogleログインし、`Create app`からアプリ名、完全一致のHTTPS Redirect URI `https://address.chain.tokyo/auth/world/callback`、`Client secret (Basic)`を登録する。Client IDと一度だけ表示されるsecretは保護された設定へ直接保存する。secretをチャット・リポジトリ・ブラウザbundleへ載せない。HTTP localhost callbackは使用しない。公式pluginの登録補助を使う場合も、アプリ自身のbackend検証は必要。

| キー | 設定契約 |
| --- | --- |
| `WORLD_ENABLED` | 既定`false`。eventの接続を明示的に有効化する |
| `WORLD_REDIRECT_URI` | 上記HTTPS callbackの完全一致。webのみ |
| `WORLD_CLIENT_ID` | 登録されたOIDC client ID。eventではwebのSecret Manager参照 |
| `WORLD_CLIENT_SECRET` | Basic認証用secret。webのみ |
| `WORLD_SESSION_KEY` | canonical base64で表した32byte鍵。sessionに束縛したWorld subjectとPKCE verifierの暗号化・識別に使用 |
| `MAIL_ENCRYPTION_KEY` | 別のcanonical base64で表した32byte鍵。転送先の暗号化に使用 |

issuerは`https://sandbox.auth.world.org`に固定し、利用者指定issuerは受け付けない。Terraformの`world_enabled`も既定false。有効化には4つの専用web secret参照と数値versionが必要。設定不足は起動・配備を拒否し、未構成の業務routeは`world_unavailable`で保留する。workerへこれらのsecretを渡さない。[event設定](deployment-configuration.md)を参照。

## 実装された境界

`@realaddr/world`はAuthorization Code + PKCE S256、scope `openid`、`prompt=login`、`max_age=0`、Basic token交換を実装する。RS256の信頼済みJWKSで署名・issuer・audience/azp・nonce・subject・exp/iat/auth_timeを検証する。認証開始前30秒を超える古いauth_time、現在から5分を超える認証、将来30秒を超える時刻は拒否する。HTTP総期限8秒、応答64 KiB、redirect拒否、JWKS cacheとunknown kid時の一回更新を適用する。

APIとFirestore repositoryはapproval/session/stateの一回消費、owner wallet challenge、World candidate binding、明示同意、宛先version競合、宛先暗号化を扱う。OIDC成功だけではmailを有効にしない。人間sessionのcookie・Origin・CSRFを検査するPOSTで同意を適用する。Agent credentialは人間操作や転送先全文の読書きに使用できない。宛先変更には新しい明示承認を要求し、人間disableやsecurity suspensionをpaid renewalで解除しない。適用済み同意と短命の未適用approvalは分離する。

Cloud Runのcallback request URLにはcode/stateが含まれるため、専用webの`/auth/world/callback` request logだけを除外する設定を追加した。他のサービスや他routeのlogを変更しない。token、code、state、World subject、宛先は通常logへ出さず、診断は秘匿値を除いた状態と理由だけを扱う。

## 残る接続確認

Agentは`mail request --subscription <id> --idempotency-key <key> --json`で既存の`POST /v1/subscriptions/:subscriptionId/mail-approval`を呼び、返された同一originの承認URLを人間へ提示する。既適用の同意を再認証して宛先フォームへ戻る場合は`--force-reauth`を明示する。CLIは人間のdecisionや宛先全文の読書きを行わない。retryには同じidempotency keyを使う。このCLIのローカルwire検査は公式World認証の証拠ではない。

登録済みclient、callback、4つの保護設定を揃えてから、owner署名→公式World認証→検証済みauth_time→明示同意→宛先保存と、拒否・取消時に保護操作が起きない代表経路を確認する。有効なpaid leaseは実支払いで発行し、DBの手動paid化や模擬成功で代用しない。結果は[実装状況](implementation-status.md)へ記録する。実郵便受領・発送・送料決済は対象外。
