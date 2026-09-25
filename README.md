# RealAddr for Agents

AIエージェントがx402で実住所の利用区画を契約し、ENSv2名で住所契約を参照し、World IDによる人間承認後に郵便転送設定を有効化するサービス。

**現在の成果物は実装仕様一式です。アプリケーション、外部サービス接続、デプロイは未実装・未検証です。** 仕様作成日: 2026-09-25。初回リリースは実サービス接続と永続化を伴う縦断フローを完成させます。

## 読む順序

1. [要件・受入条件](.kiro/specs/realaddr/requirements.md)
2. [設計・状態遷移・データモデル](.kiro/specs/realaddr/design.md)
3. [外部連携仕様](docs/integrations.md)
4. [API契約](docs/api.md) / [OpenAPI](docs/openapi.json)
5. [実装タスク](.kiro/specs/realaddr/tasks.md)
6. [受入テスト・デモ](docs/acceptance.md)
7. [運用・設定・未確定事項](docs/operations.md)
8. [一次資料と確認状況](docs/sources.md)
9. [ENSv2連携・住所契約の紐づけ](docs/ensv2.md)
10. [GCP構成・Firestore設計・低コスト運用](docs/infrastructure.md)

## 3つの開発エージェントから使う

| ツール | 入口 | 共通の仕様本体 |
| --- | --- | --- |
| Codex | `AGENTS.md` | `.kiro/specs/realaddr/` と `docs/` |
| Claude Code | `CLAUDE.md`から`AGENTS.md`を読み込み | 同上 |
| Kiro | `AGENTS.md`、`.kiro/steering/project.md`、Specs | 同上 |

各ツールに次を渡してください。

```text
AGENTS.mdとREADME.mdから仕様を読み、.kiro/specs/realaddr/tasks.mdの
依存関係を満たす最初の未完了タスクを実装してください。
完了には対応する受入テストの実行証跡が必要です。
外部APIの未確認部分を捏造せず、実接続できない項目はBLOCKEDとして記録し、
独立して進められる作業を続けてください。
```

仕様の自動読み込みと、実サービスを利用するエージェントの接続は別です。実装後は3ツールとも同じCLI/HTTP APIを使用し、Worldの公式プラグインが使えないクライアントでもブラウザ承認URLを介して利用できます。

## スコープ

- Cloud Run（最小instance数0）、Firestore、Cloud Storage、GitHub Actions。非同期処理はCloud Tasks、回復はScheduler。無料枠中心の運用を設計し、完全0円は保証しない。
- 1拠点につき1〜65,535の仮想区画。住所表記は実際の建物階数と区別する。
- 安全性判定 → x402決済 → 永続的な住所利用契約 → オンチェーン記録。
- World再認証と人間の明示承認 → 「郵便転送可」表示 → 人間が転送先住所を入力・保存。
- 今回、実郵便の受領・発送・送料決済は行わない。
- 契約ごとのENSv2名をSepoliaで発行し、名前から有効な住所契約を照合。期限・取消・編集権限を同期する。
- World、Intercepta、MultiBaas、ENSv2の接続結果と失敗経路を画面・監査ログに表示。

Curvegridは**Best AI Agent Project**を主対象とする設計です。RWA Tokenizationは追加候補ですが、初回スコープにNFT市場や不動産所有権の表現を追加しません。ENSは**Best Use of ENSv2**も対象とし、親名取得・Sepolia実接続は実装時に確認します。賞への適合方針は[資料一覧](docs/sources.md)を参照。

## 完成の意味

単体テストのモックは許可しますが、提出デモでは公式World開発環境・実Intercepta API・テストネット決済・実MultiBaas照会・公式ENSv2の登録/名前解決を通します。再起動後にも契約が残り、二重課金と未承認の転送設定を防ぎます。

Worldのイベント環境は主催者側の模擬proofを利用する旨が告知されています。公式環境への実接続と、本番の本人確認保証は区別します。World IDの認証だけで法的本人確認が完了するとは扱いません。

## テキスト形式とコミット前チェック

すべてのテキストはUTF-8・BOMなし・LFに統一します。`.editorconfig`で編集時、`.gitattributes`でGitの改行処理を設定します。バイナリは対象外です。

```sh
git config core.hooksPath .githooks
node scripts/check-text-format.mjs
node scripts/check-text-format.mjs --staged
```

初回clone後にhookを有効化してください。Linux/macOSでは必要に応じて `chmod +x .githooks/pre-commit` も実行します。既存hookがある場合は置き換えず検査を統合します。pre-commitはステージ済みの実データを検査し、不正なUTF-8・BOM・CR/CRLFがあればコミットを拒否します。改行の自動変換だけでは文字コードやBOMを保証できないため、検査も必須です。これらはアプリ実装前から利用できるリポジトリ管理用コマンドです。

## 実装後にREADMEへ追記するもの

起動・テストの実コマンド、公開デモURL、デプロイ情報、コントラクト、各スポンサー呼び出し箇所、チーム紹介・SNS、実測した連携フィードバック。未実行のコマンドや未取得の成功結果を掲載しないこと。
