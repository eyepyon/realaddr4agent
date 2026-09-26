# World sandbox接続と人間承認

T-00/T-03/T-06の接続準備と実装範囲。公式[docs](https://sandbox.auth.world.org/docs)・[discovery](https://sandbox.auth.world.org/.well-known/openid-configuration)の取得は確認済み。Worldのlive認証、token交換、実際の有効なpaid leaseでの人間承認・宛先保存は未検証であり、タスク完了を意味しない。eventは模擬proofを使用する開発環境。本物のOrb認証済みや法的KYC完了とは表示しない。

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

登録済みclient、callback、4つの保護設定を揃えてから、owner署名→公式World認証→検証済みauth_time→明示同意→宛先保存と、拒否・取消時に保護操作が起きない代表経路を確認する。有効なpaid leaseは実支払いで発行し、DBの手動paid化や模擬成功で代用しない。結果は[実装状況](implementation-status.md)へ記録する。実郵便受領・発送・送料決済は対象外。
