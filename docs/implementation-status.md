# 実装状況

実装開始: 2026-09-26。仕様上の完成条件と、実装・検証できた範囲を区別する。[タスク一覧](../.kiro/specs/realaddr/tasks.md)のチェックはタスク全体の証跡が揃ったときに更新する。

## 現在の作業

| 対象 | 状態 | 範囲 |
| --- | --- | --- |
| T-01 実行基盤 | 実装中 | pnpm workspace、strict TypeScript、Fastify、web/worker、共通CLI、CI workflowとローカル`.env.example`を作成。全経路の起動確認は未完了 |
| T-02 認証・Firestore・区画 | 部分実装・Emulator基礎チェック済み | wallet challengeの一回消費、Bearer hash、全collectionのprefix mapper、拠点、64 shardのtransaction予約・一意性。支払確定後のlease発行、hold解放、決済照合は未実装 |
| T-08/T-18/T-19 UI | 部分着手 | 公開HTML/AEO、標準SaaSの画面、実APIへの接続。業務統合・実管理者ログインは別途 |
| T-00 外部連携 | 実接続未実施 | MultiBaasは利用準備済みとのユーザー確認あり。接続値はユーザーが未追跡`.env`へ登録する方針を選択済み。入力完了・実値・権限・実疎通は未確認。World、Intercepta、x402、ENSは引き続き確認が必要 |
| T-16 GCP | 未適用 | live inventory、IAM/Rules、専用resource作成、DNS/TLSが必要。現在の作業で実GCPへ変更していない |

## 検証の記録

Node.js 22.21.0、pnpm 11.19.0を確認。Firestore Emulator 1.22.0をGoogle公式配布物から取得し、SHA-256 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`を検証した。Java 21でローカルの`127.0.0.1:8085`へ起動し、架空project `demo-realaddr-local`を使用する。実GCPのFirestoreや利用者データには接続していない。Emulatorを指定した`pnpm test`は2件通過、skip 0。内容はfloor境界/prefix拒否、challenge再使用拒否、tenant所有権、同一floorの並行予約、rate bucketと空き数である。payment・World・ENSの実接続結果を含まない。

rootの`pnpm typecheck`は全6 package、`pnpm build`はAPI/worker/CLI/Webで通過した。Web buildには`VITE_APP_ENV=local`を指定した。`node scripts/check-text-format.mjs`も通過した。Emulatorへ接続したHTTP smokeでは`/health`・`/ready`が200、未認証のlocationsが401、未知routeが404、テスト用EOAのchallenge/sessionが201、認証済みlocationsが200、challenge再使用が403、credential失効が204で旧tokenが401、worker内部routeの未認証アクセスが401だった。build済み共通CLIを直接`node`で起動した`health --json`も確認した。HTTP header確認では`/admin`が200・`no-store`、`/auth/admin/start`が503・`no-store`、`/developers`が200・service descriptionへの`Link`付き、存在しないassetが404・`no-store`だった。ブラウザでは白・青の公開ホーム、`/developers`、`/faq`の遷移と`/app`・`/admin`の認証前ゲートを確認し、新しいbuild済みserver tabでwarn/error logは記録されなかった。wallet UI操作とGoogle管理者ログイン成功は未検証。これらはlocalだけの結果であり外部スポンサー連携を含まない。CIの`pnpm test`は現状Firestore Emulatorを起動しないため、DB transactionテストはskipされる。ローカルで`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`を渡した実行結果とCI結果を混同しない。Docker daemonは利用できず、container imageの検証は未実施。

外部スポンサーの認証・決済・発行、Google管理者認証、GCP公開、3ツールからの縦断デモは未実施。

## 次の接続条件

- World client/callbackとfresh認証、Intercepta keyと実schema、x402 facilitator/USDC/finalityを確認する。
- MultiBaasの権限とSepolia接続、ENS親名の管理権限・公式deployment・署名方法・gasを確認する。
- 専用Google OIDC clientと初期運用者、GCPのinventory/必要権限、公開ドメインのDNS/TLSを用意する。
- 提供拠点住所は認可された管理画面の完成後に登録する。実郵便処理は今回の範囲外。
