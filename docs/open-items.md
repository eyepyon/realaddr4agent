# 未解決事項一覧

このリポジトリは仕様のみで、アプリ、provider接続、GCP resource、公開deployはいずれも未実装・未検証。以下は現時点で実作業前に確認が必要な項目であり、すべての開発を止めるものではない。詳細契約・運用手順・受入条件は参照先を正本とする。

最優先はU-03〜U-07の外部疎通。GCPへのapply前にU-08、公開・提出までにU-01/U-09〜U-11を完了する。U-02の通常返金方針と発行失敗時の自動返金条件は決定済みで、実鍵・asset・finalityの疎通はU-05に含める。画面/DBなど独立部分は並行して実装できる。

| ID | 項目 | 種別と完了時点 | 正本 |
| --- | --- | --- | --- |
| U-01 | 販売開始前に、権限のある管理画面から運営者が提供拠点の住所・郵便番号・slug・表示名・公開エリア/文言を登録し、公開許可と表示内容を確認する。これは通常の運用入力であり、事前にチャットで住所を提示したり、実住所をコード/seedへ固定したりする必要はない。 | 運営者による登録・検証。販売開始前 | [operations O-01/O-14](operations.md)、[管理仕様](admin.md) |
| U-03 | World client設定、callback登録、eventで使うproof/auth手順とfresh認証確認を取得・検証する。 | 外部設定/実接続。T-03 live前 | [operations O-03](operations.md)、[integrations](integrations.md) |
| U-04 | Intercepta live key、実schema/verdict、対象network、test addressのallow/denyを取得・検証する。 | 外部資格情報/実接続。T-04前 | [operations O-04](operations.md)、[integrations](integrations.md) |
| U-05 | Base SepoliaのUSDC contract/decimals、facilitatorと認証、finality、送金結果不明時の照合経路を固定・実測する。 | 外部設定/実接続。T-05 live前 | [operations O-05](operations.md)、[pricing](pricing.md)、[acceptance](acceptance.md) |
| U-06 | MultiBaas Sepolia deployment、必要role/permission、署名方式、read/write/eventの実接続を確認する。 | 外部設定/実接続。T-07完了前 | [operations O-06/O-11](operations.md)、[ensv2](ensv2.md) |
| U-07 | ENS parent名と運営鍵、公式deployment/ABI/SDK、親→拠点→name registry接続、gas実測と拠点別registry登録receiptを確定する。 | 外部設定/実接続。T-12/13完了前 | [operations O-09–O-11](operations.md)、[ensv2](ensv2.md)、[pricing](pricing.md) |
| U-08 | 共有GCP projectの実resource/owner、Firestore location/rules/index、IAM/API、予算・quota、専用名の空き、`DEPLOY_SERVICE_ACCOUNT`で指定したデプロイ用service accountの所有者・binding・実効権限をlive inventoryで調べる。専用web/worker/Tasks/Scheduler identityと専用WIFは設計済み。apply前に設定・IAM計画とFirestore client Rulesの直接アクセス可否を確認し、専用runtime主体の作成後・業務データ取扱い前にその実IAM権限を別途確認する。 | apply前の共存ゲートと、専用SA作成後の稼働前ゲート。いずれも未実施で、GCP変更も未実施 | [operations O-12](operations.md)、[infrastructure](infrastructure.md)、[acceptance A-41](acceptance.md) |
| U-09 | 本アプリ専用Google OIDC client/callbackと初期運用者allowlistを設定する。 | 外部設定。T-18前 | [operations O-13](operations.md)、[admin](admin.md) |
| U-10 | event公開経路はCloud Runの直接domain mappingとmanaged TLSに決定。対応region/ドメイン所有権を確認し、運営者がDNSを設定する。固定originのHTTPS health（redirect不可、30秒、応答上限4 KiB）、同一origin API/cookie、World/admin callbackを実接続で確認する。 | ユーザー側DNSと実接続。公開/E2E前。方式の決定だけでは完了しない | [operations O-07](operations.md)、[infrastructure](infrastructure.md)、[acceptance A-49](acceptance.md) |
| U-11 | 提出時点のtrack条件、チーム/SNS、live証跡・feedback、動画を揃える。 | 提出準備。提出前 | [operations O-08](operations.md)、[acceptance](acceptance.md)、[sources](sources.md) |

## 確定済みの前提

ここに未決事項として重複登録しない。事業者の正式表記は**国立日本総合研究センター株式会社**、公式URLは[https://jgrec.jp/](https://jgrec.jp/)である。提供拠点の値は販売前に運営者が認可管理画面から登録・確認する通常運用入力であり、事前に住所をチャットで提示したり、実住所をコード/seedへ固定したりする必要はない。事業者の公式住所から提供拠点住所を推定しない。住所は30日あたり55 USDC（mainnet想定）/0.55 USDC（testnet-dev）、購入と更新は同額。ENS初回add-onは標準10/0.10 USDC、custom 30/0.30 USDC（mainnet想定/testnet-dev、6 decimals）。mainnet決済は今回無効。住所購入でENSを付与せず、未購入でも住所を利用できる。ENSは初回のみ別決済で、住所更新には購入済みENSの期間同期を含む。名前形式は標準`f00042.<location-slug>.<parent>.eth`、custom`<customLabel>.<location-slug>.<parent>.eth`。予定ドメインは`https://address.chain.tokyo`、スタックはReact/Vite/Fastify/Firestore/GCPである。設定欠落やchain/network不整合はfail closedとする。

U-02（決定済み）: 任意取消・通常運用では返金しない。決済確定後、発行失敗が照合で確定し復旧不能な場合だけ、対象注文の支払額全額を元payerへ同一network/assetでworkerが自動返金する。ENS追加の失敗はその追加料金だけ、住所renewの失敗は当該renew料金だけが対象。chain結果不明・再試行可能な障害は返金せず照合する。サービス終了時の前払い分の対象条件・方法・時期は、その時に別途案内する。詳細は[料金仕様](pricing.md)、[設計](../.kiro/specs/realaddr/design.md)。

## 今回具体化した内容

- 本アプリ専用のweb/worker/Tasks/Scheduler service accountとrepository制限付きWIFを作る。デプロイ用service accountは保護された`DEPLOY_SERVICE_ACCOUNT`設定で指定し、accountの作成・import・削除は本アプリのstate対象外とする。所有者・現在のgrant・実効権限を確認し、本アプリresourceへの必要grantと限定WIF impersonation memberだけを追加する。そのaccountの実効権限が本アプリに限られるとは仮定しない。
- 共有Firestoreのcollection prefixは名前衝突対策であり、権限分離ではない。apply前に既存client Security Rulesの許可とIAM計画を審査し、広い許可を解消できなければapplyしない。新設したserver runtime service accountの実IAM検査は作成後・業務データ取扱い前に別途実施する。
- eventの公開接続方式はCloud Run直接domain mappingとmanaged TLSに固定した。公開originの固定HTTPS healthとcallback/同一origin動作を確認するが、region対応・所有権・DNS/TLSのlive結果はU-10として残る。
- U-01は提供拠点情報を運営者が認可管理画面へ登録し、公開許可と表示内容を確認する販売開始前の運用タスクとして残る。管理画面の権限と入力項目は[管理仕様](admin.md)を正とする。U-09の本アプリ専用管理者OIDC/bootstrapは引き続き未実施。U-02の通常方針・発行失敗時の例外は決定済みである。

詳細設計と対象外スコープに従い、実郵便処理や商用の法的本人確認/KYCは今回の未解決blockerに含めない。秘密やcredential値はこの一覧・README・repositoryへ記録せず、secret manager等の指定保管先を使う。
