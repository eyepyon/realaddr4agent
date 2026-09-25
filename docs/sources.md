# 一次資料・確認状況

確認日: 2026-09-25（JST）。リンク先は変更されるため実装開始・提出前にも再確認する。公式資料の事実と、このリポジトリ独自の設計判断を区別する。

## 賞への対応

出典: [ETHGlobal Tokyo 2026 prizes](https://ethglobal.com/events/tokyo2026/prizes)。本項は条件の要約であり、応募時には原文を確認する。

| 目標 | 確認した主要条件 | このプロジェクトの対応 |
| --- | --- | --- |
| World: Best Use of World ID for Agents | 公式event dev連携、成功/不成功の保護操作、backend検証、feedback | mail.enableをWorld+明示同意で解放。拒否時はフォーム保存不可 |
| Curvegrid: Best AI Agent Project | 技術実装、公開repo、READMEの説明/チーム/起動・検証手順。MultiBaas必須ではない | Agentの住所購入・オンチェーン契約照会。設計ではMultiBaasも実使用 |
| ENS: Best Use of ENSv2 | SepoliaでENSv2を中核に使用、実動作、live demo、公開repo | 契約別名・権限分離・期間同期・名前から契約照合 |
| Intercepta: Safe Agent-to-Agent Payments with x402 | 決済前の実API判断、mainnetアドレス評価、成功/停止デモ、公開repoとfeedback | buyer payToとseller payerを実判定し、testnet決済を制御 |

Worldにはproofのmock化告知がある。公式event環境への実接続を使い、その認証保証を商用proofと混同しない。Continuity向けの別枠もあるためチームの参加trackを確認する。Curvegrid RWA賞は将来候補で、今回の主対象はAI Agent賞。

## World

- [Public docs](https://sandbox.auth.world.org/docs): HTTPで本文を直接取得して確認。OIDCのpairwise subject、issuerとsubjectの組での識別、fresh authenticationとアプリ側権限の分離を確認。
- [OIDC discovery](https://sandbox.auth.world.org/.well-known/openid-configuration): HTTP 200のJSONを直接取得。実際のendpoint/claim/algorithmを[integrations.md](integrations.md)に記録。
- [公式agent plugin](https://github.com/worldcoin/world-id-agent-plugin): Codex/Claude Codeのsandbox MCPと開発者向けclient登録、HTTPS callbackを確認。pluginの利用とアプリ自身の認可は別。
- [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html): World docsが参照する標準。実装時に採用OIDCライブラリの検証範囲も確認する。

公開docs/discoveryの確認のみ。client登録、token交換、World本人の操作は未実施。plugin READMEとイベントmock告知の差は当日確認項目として残す。

## 決済と安全性

- [x402 buyer quickstart](https://docs.x402.org/getting-started/quickstart-for-buyers): 公式クライアント/署名器/支出制御の入口。
- [x402 seller quickstart](https://docs.x402.org/getting-started/quickstart-for-sellers): 402要求とEVM exact方式。永続orderと二重課金防止は本アプリ側設計。
- [Intercepta API key](https://intercepta.io/ethglobal): 賞ページから案内されている取得先。未申請。
- [Quick Scan Address](https://docs.web3antivirus.io/reference/quick-scan-address): payTo/payerの高速評価。
- [Deep Scan Address](https://docs.web3antivirus.io/reference/scan-address): 詳細なwallet risk。
- [Scan Message](https://docs.web3antivirus.io/reference/scan-message): EIP-712解析。
- [Scan Token](https://docs.web3antivirus.io/reference/scan-token): token risk、chainId指定。

Interceptaの認証付きレスポンスschemaや既知危険アドレスの当日リストは未取得。実装時に固定して契約テスト化する。scoreやrisk enumを想像で決めない。

## Curvegrid

- [MultiBaas概要](https://docs.curvegrid.com/multibaas/): contract操作、イベント、SDKの提供を確認。
- [API](https://docs.curvegrid.com/multibaas/api/multibaas-api/): RESTとBearer認証。
- [Networks](https://docs.curvegrid.com/multibaas/networks/supported-networks/): 対応networkとevent indexingに差がある。公開抽出結果だけでは本案件のdeployment上のchain対応を確定できないためT-00で実確認。

## 開発エージェント

- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md): リポジトリ共通指示の入口として使用。
- [Claude Code memory](https://code.claude.com/docs/en/memory): CLAUDE.mdの@AGENTS.md importを使用。Windowsでsymlinkを前提にしない。
- [Kiro steering](https://kiro.dev/docs/steering/): .kiro/steeringのalways指示、AGENTS.md対応を確認。
- [Kiro specs](https://kiro.dev/docs/specs/quick-spec/): requirements/design/tasksの構成を採用。

この仕様作成時点では各ツールを起動した読み込み・利用試験は未実施。ファイル構成を公式形式に合わせ、実クライアント検証はA-25とする。

## 商用郵便との境界

[経済産業省: 郵便物受取サービス業者への行政処分（2026-04-03）](https://www.meti.go.jp/press/2026/04/20260403004/20260403004.html)を直接HTTP取得し、取引時確認、確認記録、疑わしい取引に関する指摘を確認した。匿名的人間認証だけで法的本人確認を代替できるという根拠ではない。今回は実郵便処理を行わないため、商用の個別適法性判断やKYC実装は対象外。

## ENSv2（今回追加）

- [概要](https://docs.ens.domains/ensv2/overview/): Sepoliaのbeta。APIはmainnet前に変更されうる。
- [Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry/): 登録・更新・取消と期間付き所有。token IDは固定identityとして扱わない。
- [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/): record keyによる委任。権限は同じinstanceが扱う名前を横断するため、本アプリは契約別instanceを採用。
- [Universal Resolver V2](https://docs.ens.domains/ensv2/universal-resolver-v2/): 階層探索とexact owner/canonical registry確認。ancestor fallbackだけを契約証明にしない。
- [Contract developer guide](https://docs.ens.domains/ensv2/tutorial-contract-developers/): subregistryを親名へ接続する必要がある。チュートリアルのERC20課金をそのまま導入せず既存x402と分離。
- [App developer guide](https://docs.ens.domains/ensv2/tutorial-app-developers/): Sepolia設定と読み書きの入口。
- [Deployments](https://docs.ens.domains/learn/deployments/): 実装開始時に正確なaddress/ABIを採取する公式表。
- [SDK readiness](https://docs.ens.domains/web/ensv2-readiness/): 対応版を選定してlockfileへ固定。
- [ENSIP-26](https://docs.ens.domains/ensip/26/): draft。agent-context/agent-endpointは追加候補で、今回の必須契約pointerとは別。

公開資料の確認に基づく実装可能性判断。親名取得・read/write実接続は未検証。独自text keyやNameController interfaceを公式ENS標準の機能と混同しない。

## GCP・GitHub Actions（ユーザー指定構成）

- [Cloud Run料金](https://cloud.google.com/run/pricing): request-based無料枠、min instance待機課金、region/通信費。
- [Firestore料金](https://firebase.google.com/docs/firestore/pricing): 日次quota、1個の無料対象DB、TTL/PITR/backupの別課金。
- [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions): multi-document atomicity、callback retry、read-before-write。
- [GCP無料枠](https://docs.cloud.google.com/free/docs/free-cloud-features): GCSの対象US regionとstorage/operations。
- [Tasks料金](https://cloud.google.com/tasks/pricing) / [Runからの利用](https://docs.cloud.google.com/run/docs/triggering/using-tasks): 非同期HTTPと配信操作の費用。
- [Scheduler料金](https://cloud.google.com/scheduler/pricing): billing accountあたり無料3job。
- [Artifact Registry料金](https://cloud.google.com/artifact-registry/pricing) / [Secret Manager料金](https://cloud.google.com/secret-manager/pricing): 容量とsecret versionを含む保管費。
- [Actions料金](https://docs.github.com/en/billing/concepts/product-billing/github-actions): 公開repoの標準runnerとprivateのplan枠。
- [WIF deployment](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines): GitHub OIDCによる短期credential。
- [予算と通知](https://docs.cloud.google.com/billing/docs/how-to/budgets): alerts-only予算は強制的な利用上限ではない。

確認日2026-09-25。公開資料に基づく仕様であり、GCPリソース作成・負荷試験・請求実測は未実施。具体的な構成と使用量目標は[infrastructure.md](infrastructure.md)に記載。
