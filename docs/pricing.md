# 住所利用とENS追加オプションの料金契約

更新: 2026-09-26。これは実装・販売予定の設定契約であり、決済機能、mainnet環境、ENSv2 mainnetは未稼働・未検証。金額はすべてUSDC。実決済に用いるasset address、network、facilitator、receiptとfinalityは環境ごとに確認して固定する。

## 利用者向け料金

| 環境 | 住所利用30日 | ENS標準名の初回追加 | ENSカスタム名の初回追加 |
| --- | ---: | ---: | ---: |
| 将来のmainnet | 55 USDC (`55000000`) | 10 USDC (`10000000`) | 30 USDC (`30000000`) |
| testnet/dev | 0.55 USDC (`550000`) | 0.10 USDC (`100000`) | 0.30 USDC (`300000`) |

括弧内はすべてUSDC 6 decimalsの整数atomic額。ENS追加価格は確定した利用者向け**販売価格**であり、未測定のENSv2 mainnet原価やgasの予測値ではない。

カスタム名は標準名との選択料金であり、mainnetは30 USDC（10+30=40 USDCではない）、testnet/devは0.30 USDC（0.10+0.30=0.40 USDCではない）。

mainnet 55 USDCは将来の価格設定値であり、mainnet決済を解禁する指定ではない。testnet/devのUSDCは接続するtest tokenを明示し、実資産のmainnet USDCや商用住所提供と混同しない。期間は1回の確定決済につき30日。住所renewも同じ環境の住所料金を使用する。期限内更新は旧期限に30日を加え、期限切れ更新は確定時刻から30日を加える。自動課金はしない。

各leaseで未解決のrenew注文は同時に一つだけ。renew quoteは価格・lease version・旧期限を固定し、結果不明の決済はquote期限後も排他を維持する。renewは新しい区画や新規契約の日次枠を使わない。人間は契約期間に関与せず、確定x402支払いが住所利用期間を決める。同じ宛先への適用済みmail同意は無期限で、lease期限切れは同意を保持したままeffective enabledだけを停止する。同じleaseのpaid renewal/revival後は再承認なしで再開する。取消・security suspensionをrenewで解除せず、宛先変更には変更先versionへの新たな人間承認が必要。未適用approvalはlease version変更時に失効するが、10分のapproval URL期限と適用済み同意は別である。ENS購入済みの場合は同じ名前の期限同期を住所料金内で行う。

住所購入・更新とENS初回追加は、任意取消や通常運用では返金しない。ただし決済確定後、照合と安全な再試行を経ても対象商品の発行が復旧不能と確定した場合は、その注文の元payerへ同じnetwork/USDC assetで支払額全額を自動返金する。ENS追加の発行失敗ならENS追加料金だけを対象にし、住所契約・住所代金を巻き込まない。住所renewの発行失敗ならそのrenew注文だけを対象にし、それ以前の有効期間・権利を維持する。不明なchain結果や一時的な障害は直ちに返金とせず、証跡と権利を保持して照合・復旧を続ける。ガスは運営負担で返金額から控除しない。サービス終了時に残る前払い分の対象条件・方法・時期は、その時点で別途案内する。

ENSは住所利用に含まれず、owner Agentが有効な自分のleaseへ任意で追加する。標準名は`f00042.<location-slug>.<parent>.eth`のようにfloorから決まり、カスタム名は同じ拠点名の下でlabelを指定する。`POST /v1/payment-intents`の`kind=ens_addon`、`subscriptionId`、`nameType=floor|custom`（省略時floor）、custom時だけ`customLabel`を使う。初回追加料金の確定決済後だけENS entitlementを一回有効化する。未購入はENS status=`not_purchased`とし、発行・resolver deploy jobを作らない。購入後のrename・2つ目の名前はv1対象外。購入後の技術retry、再照合、発行失敗の再実行では追加料金を再請求しない。住所renewには既購入ENS名の期限同期と通常維持を含め、追加料金は初回一回だけ。住所契約が終了・停止したらENSの有効表示も止め、同じleaseの期限切れ更新では同じ名前の復活を試みる。親名・拠点名・network・公式仕様・gas等の制約があるため、永久維持や即時復活は保証しない。ENSが`pending`でも住所利用は続く。LeaseRegistryへの記録はENSオプションの有無にかかわらず全契約で行う。[ENS設計](ensv2.md)

ENS追加の販売価格は上表の環境・nameType別に固定する。設定欠落・0・表と不一致、network/assetとの不整合ならその組合せを販売不可とし、支払い可能なintent/402を生成しない。親名または拠点名の残存期限が不足する場合や上位/拠点registry/controllerなど発行設定が整っていない場合も、料金を受け取る前に販売停止する。0額のENS権利や発行成功を作らない。mainnetは今回の販売allowlistから外し、価格の定義だけで解禁しない。

## 見積と決済の固定条件

- serverが環境と`nameType`ごとに上表の価格、6 decimals、USDC contract、payment network、payTo、期間、ENS entitlementの対象leaseを確定し、intentにsnapshotする。ENS追加ではcanonical label、正規化済みFQDN、name policy versionも固定する。見積の期限は10分後とlease期限の早い方で、新slot holdや新規lease日次quotaを使わない。正規化済みFQDNの決定的guardを支払い前に予約し、送金不明なら期限だけで解放しない。未払い確定だけで予約を解放し、支払済み名は別leaseへ永久に再利用しない。clientの金額・環境・asset指定を信用しない。確定済みintentの金額を運用者が任意編集しない。価格改定は新しいintentから適用し、既存snapshotを変更しない。
- payerは登録されたAgent walletと一致させる。payToのbuyer側評価、payerのseller側評価、asset/network/署名内容検査、reserve・screen後のsettle、結果不明の照合、冪等性は住所決済とENS追加決済の両方で維持する。ENS追加intentは対象leaseのowner・有効性・未購入をsettle直前にも検査する。
- payment signerはintentの環境とnetwork/asset/amountを完全一致で検査し、mainnet signerがtestnet/devの低価格またはtest tokenを受け付ける組合せを拒否する。環境の異なるwallet/API origin/payToへの流用も拒否する。mainnet接続に必要な検証と承認が完了するまでmainnet実行を起動しない。
- ENS追加料金の確定paymentとentitlementは一回のFirestore transactionで結び、同一paymentが複数のleaseまたは複数の追加購入を有効化しない。送金結果不明なら見積期限後もguardを保持し、照合前に再課金しない。確定後にleaseが停止・期限切れなら支払済み権利を保持して発行を保留し、同じleaseの有効な更新で回復する。不明・再試行可能な発行障害はpaid証跡と名前guardを保持してmanual_reviewで照合する。復旧不能な発行失敗が確定し、提出済みtxの結果と名前の無効化をfinality付きで検証した場合だけ、ENS追加注文の全額を元payerへ自動返金する。返金後も名前guardと履歴を保持し、有効なENSとして解決せず自動再購入も許さない。ENS発行のchain結果不明時は照合してからretryし、新しい課金や別名の発行で埋め合わせない。

## ENS費用の見方

2026-09-26時点、ENSv2はEthereum SepoliaのBetaで、mainnetの公開時期・最終contract・料金は未確定。[ENSv2公式概要](https://docs.ens.domains/ensv2/overview/)、[Beta告知](https://ens.domains/blog/post/ensv2-beta-public-testing)。現在のEthereum mainnet `.eth`親名の登録・更新料は年額で、5文字以上$5、4文字$160、3文字$640に変動するgasが加わる。[ENS公式料金案内](https://support.ens.domains/en/articles/12238910-pricing-fees)。これは現行`.eth`登録の案内であり、将来ENSv2 mainnetの価格保証ではない。ENSv2のETH Registrarでは許可されたstablecoinを使い、実額はその時点の`getRegisterPrice`/`getRenewPrice`で確認する。[ENSv2 ETH Registrar](https://docs.ens.domains/ensv2/eth-registrar/)。

事業者の親名に独自UserRegistryを接続して発行する子名は、1件ごとに公式`.eth`年額を払う仕組みとは分けて考える。ENSv2は親名のsubregistryと独自registrarの価格設定を許す。[Registry Template](https://docs.ens.domains/ensv2/registry-template/)、[Contract Developer Tutorial](https://docs.ens.domains/ensv2/tutorial-contract-developers/)。親名の登録・更新は事業者側の共有固定費。親から拠点labelを実登録し、拠点別UserRegistryをdeploy/接続/更新する費用も拠点単位の費用。希望者の想定契約数で按分するか事業者が負担する。契約ごとのresolver deploy・契約label登録・binding・record/role設定、住所更新時の期限同期、失効/停止処理はそれぞれgasを要しうる。発行・維持のchain gasは事業者負担とし、Agentが自分で送信するdescription編集txのgasだけAgent負担とする。支払い先・親名取得費・将来のmainnet gasを推測値で確定しない。固定販売価格10/30 USDCが将来のgasを上回る保証はなく、超過時の運営marginリスクを実測してからmainnet解禁を判断する。

以下は**実測ではない単なる原価感度例**。合計1,000,000 gas、ETH価格$3,000/ETHを仮定すると、gas price 1 gweiなら約$3、5 gweiなら約$15、20 gweiなら約$60。式は`gasUsed × gasPrice(gwei) × 10^-9 × ETH/USD`。1件発行だけのgas量を1,000,000と主張するものではなく、将来のgas・ETH価格も保証しない。実原価はSepoliaの拠点namespace作成、契約名の発行・更新・停止receiptから各`gasUsed`を測定し、mainnet ENSv2が公開された後に親名の実価格、許可token、gas見積、継続コストを再確認する。10/30 USDCは確定した販売価格であり、この例から導いた推奨価格ではない。
