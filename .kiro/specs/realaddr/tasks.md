# 実装タスク

すべて未実装。チェックは対応テストの実行証跡を残してから付ける。順序は依存関係順。コマンドは実装すべきインターフェースであり、現在利用可能と主張するものではない。

- [ ] T-00 外部連携の最小疎通と設定確定
  - World discovery/portal client/HTTPS callback/fresh認証、Intercepta liveレスポンス/危険アドレス、x402 facilitator/asset/finality、MultiBaas Sepolia権限、ENSv2公式deployment/ABI/SDK・親名の制御・gasを確認。
  - 資格情報未取得はBLOCKEDとし、独立項目を継続。API methodやrisk enumを推測しない。
  - 成果: `docs/implementation-status.md`、秘密を除いた設定表、version/ADR。対応: R-04/R-06/R-08/R-11、A-20〜A-23/A-27。
- [ ] T-01 ワークスペースと実行基盤
  - React/Vite/Fastify/HTTP worker/Firestore Emulator、pnpm、strict TS、CI、schemaVersion/index管理、env validation、secretのない.env.exampleを作る。
  - `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:live`, `pnpm agent`を実装・READMEへ実コマンド記載。
  - 成果: clean cloneから起動、health/readiness、単一HTTPS origin。対応: R-10/A-18。
- [ ] T-02 ドメイン/DB/Agent認証/区画
  - 依存: T-01。全collection/guard/index/repository、wallet challenge、Bearer hash管理、tenant認可、冪等store。
  - 64shard bitmapと必要時のslot作成、並行予約、期限/状態遷移、reserve quota/日次予算を実装。65,535 documentをseedしない。
  - テスト: A-01〜A-04、A-17/A-37/A-38。R-01/R-02/R-15。
- [ ] T-03 World backendと人間session
  - 依存: T-00 World、T-02。owner challenge/署名、OIDC code+PKCE、JWKS検証、freshness、candidate binding、明示同意を実装。
  - CSRF、state再送、callback失敗、別World本人を拒否。OIDC成功のみではMailProfileを変えない。
  - テスト: A-10〜A-14、A-21。R-05/R-06。
- [ ] T-04 Intercepta policy adapterと署名器
  - 依存: T-00 Intercepta、T-02。実レスポンスに対応した正規化、allow/deny/hold、buyer/payTo・seller/payer判定、金額/asset/chain/domain制約、予算ledgerを実装。
  - 不明enumはhold、mainnet coverageを明示。ライブ理由の画面表示。
  - テスト: A-07〜A-09、A-20。R-04。
- [ ] T-05 x402注文/実決済/照合
  - 依存: T-00 facilitator、T-02、T-04。402 v2、固定価格、verify/screen/settle順、receipt確認、exactly-once相当の業務冪等性を実装。
  - 不明結果を永続化し照合、二重settle防止、更新、返金追跡。middlewareの配信順に依存しない。
  - テスト: A-05/A-06/A-19/A-22。R-03。
- [ ] T-06 郵便転送設定の最小機能
  - 依存: T-03、T-05。mail.enable承認URL、apply一回、enabled表示、人間専用フォーム、国内住所validation、暗号化、version競合、取消。
  - 実郵便処理・送料・配送APIは作らない。Agentはenabled/destinationConfiguredのみ参照。
  - テスト: A-10〜A-16。R-06/R-07。
- [ ] T-07 LeaseRegistryとMultiBaas
  - 依存: T-00 MultiBaas、T-02。role/slot/version/非譲渡registry、Foundryテスト、Sepolia deploy、MultiBaas ABI/read/write/events、outbox/reorg回復。
  - 宛先/World subjectなどPIIをchainへ出さない。
  - テスト: A-23/A-24。R-08。
- [ ] T-12 ENSv2 namespaceと契約別Resolver
  - 依存: T-00 ENS、T-01、T-07。親ENS名取得、UserRegistry deploy/親への接続、契約ごとのResolverをfactory生成。
  - role bitmapを固定し、顧客descriptionだけの委任とtransfer/契約record変更拒否を実コントラクトで確認。
  - 対応: R-11/R-13、A-27/A-29/A-30。
- [ ] T-13 ENS契約bindingとライフサイクル
  - 依存: T-12、T-05。NameController、ens_bindings、holderCommitment検証、発行/更新/停止outbox、receipt/read-back、再送/reorgを実装。
  - ENS発行待ちでも住所利用は可能、二重課金なし。古いresolver recordを有効証明にしない。
  - 対応: R-11/R-12/R-13、A-28/A-31〜A-34。
- [ ] T-14 ENS HTTP/署名器/CLI
  - 依存: T-13。public resolve、owner専用by-ens、ens status、description unsigned txと制限付き署名・read-back。
  - 転送先/World情報の非公開を維持。API/OpenAPIと実レスポンスを照合。
  - 対応: R-12/R-14、A-28/A-29/A-35/A-36。
- [ ] T-08 UIと共通CLI
  - 依存: T-03〜T-07、T-14。ダッシュボード、risk理由、World承認ページ、住所フォーム、JSON CLI/exit code/poll/再開、ENS名と検証状態を接続する。
  - 実API/DBから表示。pending/errorを成功に見せない。
  - テスト: A-15/A-16/A-25。R-09。
- [ ] T-16 GCP基盤とGitHub Actionsデプロイ
  - 依存: T-01、T-02。docs/infrastructure.mdに沿って2つのCloud Run、Firestore、private GCS、Tasks、Scheduler、Secret Manager、Artifact Registry、WIFを定義する。
  - 同じimage digestをdeploy、rules/index、IAM分離、永続outboxの配信/回復、min=0、retry上限、image/snapshot保持、予算通知を設定。
  - `pnpm test:infra`とbootstrap/deploy手順を実装し、OIDC制限と未認証拒否を検証する。T-05/T-07/T-13の外部効果runnerをrequest駆動へ接続する。
  - 対応: R-15、A-39〜A-41/A-43。
- [ ] T-09 復旧/機密/公開環境
  - 依存: T-05〜T-08、T-16。環境分離、HTTPS、書込停止snapshot/Emulator restore、再起動、失敗注入、rate limit、ログredaction、origin allowlist。
  - テスト: A-17〜A-19/A-26。R-10。
- [ ] T-15 ENSv2実接続の縦断検証
  - 依存: T-09。Sepolia実名の発行→公式解決→住所取得、許可description更新/禁止key拒否、失効時拒否を確認。
  - 3ツールで名前から住所契約へ到達し、公開動画・gas・latency・失敗証跡を保存する。
  - 対応: R-11〜R-14、A-27〜A-36。ベータ未接続を成功扱いしない。
- [ ] T-17 使用量・Firestore実環境・復旧検証
  - 依存: T-09。小規模live Firestoreで競合/guard、Tasks再配信、scale-to-zero復帰を確認。Emulator結果だけで実環境合格としない。
  - 使用量目標、定期処理分、外向き通信、secret/image容量を計測し、無料枠残と実請求を記録。snapshot復元/日次予算到達を試験する。
  - 対応: R-10/R-15、A-37〜A-44。
- [ ] T-10 3ツール横断とスポンサーlive検証
  - 依存: T-09、T-15、T-17。Codex/Claude Code/Kiro各々で購入→URL提示→人間承認/住所保存→Agent状態確認。
  - live Intercepta成功/拒否、World成功/拒否、x402 tx、MultiBaas query、ENSv2登録/解決を証跡化。未接続・テスト未実行をチェック済みにしない。
  - テスト: A-20〜A-36。
- [ ] T-11 提出パッケージ
  - 依存: T-10。公開リポジトリ、README起動手順、team/SNS、デモ動画、chain/contract URL、統合コードへのリンク、実測feedback。
  - 賞の最新条件を再確認。録画とliveの別、sandbox proof、郵便設定のみであることを明示。

## 完了報告フォーマット

タスクID / 変更ファイル / 実行コマンド / 合否 / 証跡パス / 未解決事項。未実行は「未実行」と書く。認証情報や個人住所を証跡に含めない。
