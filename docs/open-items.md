# 未解決事項一覧

このリポジトリは仕様のみで、アプリ、provider接続、GCP resource、公開deployはいずれも未実装・未検証。以下は現時点で実作業前に確認が必要な項目であり、すべての開発を止めるものではない。詳細契約・運用手順・受入条件は参照先を正本とする。

最優先はU-02の返金仕様とU-03〜U-07の外部疎通。GCPへのapply前にU-08、公開・提出までにU-01/U-09〜U-11を完了する。画面/DBなど独立部分は並行して実装できる。

| ID | 項目 | 種別と完了時点 | 正本 |
| --- | --- | --- | --- |
| U-01 | 運営者が公開を許可する事業者名、拠点住所/郵便番号、slug、表示名と公開文言を確定する。 | 運営判断。住所表示・公開前 | [operations O-01/O-14](operations.md)、[frontend](frontend.md) |
| U-02 | 返金規約、実行責任者、payerへの送金経路と署名権限、冪等性・結果不明時の照合手順を決める。管理画面から返金送金は行わない。 | **仕様不足**。live決済・返金実装前 | [operations O-02](operations.md)、[pricing](pricing.md) |
| U-03 | World client設定、callback登録、eventで使うproof/auth手順とfresh認証確認を取得・検証する。 | 外部設定/実接続。T-03 live前 | [operations O-03](operations.md)、[integrations](integrations.md) |
| U-04 | Intercepta live key、実schema/verdict、対象network、test addressのallow/denyを取得・検証する。 | 外部資格情報/実接続。T-04前 | [operations O-04](operations.md)、[integrations](integrations.md) |
| U-05 | Base SepoliaのUSDC contract/decimals、facilitatorと認証、finality、送金結果不明時の照合経路を固定・実測する。 | 外部設定/実接続。T-05 live前 | [operations O-05](operations.md)、[pricing](pricing.md)、[acceptance](acceptance.md) |
| U-06 | MultiBaas Sepolia deployment、必要role/permission、署名方式、read/write/eventの実接続を確認する。 | 外部設定/実接続。T-07完了前 | [operations O-06/O-11](operations.md)、[ensv2](ensv2.md) |
| U-07 | ENS parent名と運営鍵、公式deployment/ABI/SDK、親→拠点→name registry接続、gas実測と拠点別registry登録receiptを確定する。 | 外部設定/実接続。T-12/13完了前 | [operations O-09–O-11](operations.md)、[ensv2](ensv2.md)、[pricing](pricing.md) |
| U-08 | 共有GCP projectの実resource/owner、Firestore location/rules/index、IAM/API、予算・quotaと専用名の空きをlive inventoryで調べる。 | 読み取り確認。apply前の必須共存ゲート。未調査で、GCP変更は未実施 | [operations O-12](operations.md)、[infrastructure](infrastructure.md)、[acceptance A-41](acceptance.md) |
| U-09 | 本アプリ専用Google OIDC client/callbackと初期運用者allowlistを設定する。 | 外部設定。T-18前 | [operations O-13](operations.md)、[admin](admin.md) |
| U-10 | 運営者がDNS/TLSを設定し、Worldとadmin callback登録、同一origin cookie/API経路を確認する。 | ユーザー側DNS/TLSと実接続。公開/E2E前 | [operations O-07](operations.md)、[acceptance A-49](acceptance.md) |
| U-11 | 提出時点のtrack条件、チーム/SNS、live証跡・feedback、動画を揃える。 | 提出準備。提出前 | [operations O-08](operations.md)、[acceptance](acceptance.md)、[sources](sources.md) |

## 確定済みの前提

ここに未決事項として重複登録しない。住所は30日あたり55 USDC（mainnet想定）/0.55 USDC（testnet-dev）、購入と更新は同額。ENS初回add-onは標準10/0.10 USDC、custom 30/0.30 USDC（mainnet想定/testnet-dev、6 decimals）。mainnet決済は今回無効。住所購入でENSを付与せず、未購入でも住所を利用できる。ENSは初回のみ別決済で、住所更新には購入済みENSの期間同期を含む。名前形式は標準`f00042.<location-slug>.<parent>.eth`、custom`<customLabel>.<location-slug>.<parent>.eth`。予定ドメインは`https://address.chain.tokyo`、スタックはReact/Vite/Fastify/Firestore/GCPである。設定欠落やchain/network不整合はfail closedとする。

詳細設計と対象外スコープに従い、実郵便処理や商用の法的本人確認/KYCは今回の未解決blockerに含めない。秘密やcredential値はこの一覧・README・repositoryへ記録せず、secret manager等の指定保管先を使う。
