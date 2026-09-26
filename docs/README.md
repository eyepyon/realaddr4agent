# ドキュメント案内

更新: 2026-09-27。[プロジェクト概要](../README.md) / [English documentation](en/README.md)

RealAddr for Agentsの機能、構成、API、開発・運用手順を目的別にまとめています。概要はREADME、起動はOS別開発手順、詳細な契約は要件・設計から参照できます。開発の進捗と実行記録は[実装状況](implementation-status.md)にまとめています。

## 目的別の入口

ETHGlobalの4賞向けには、[日英の応募回答・コード行・デモ手順](submission.md)と[スポンサーfeedback](feedback.md)を参照してください。

| 目的 | 日本語の正本・手順 | 英語ガイド |
| --- | --- | --- |
| 概要とローカル起動 | [README](../README.md) | [English README](../README.en.md) |
| Windows・WSL・macOSの開発手順 | [OS別の開発手順](development.md) | [Development](en/development.md) |
| 実装済み・確認済み・残件 | [実装状況](implementation-status.md)、[未解決事項](open-items.md)、[タスク](../.kiro/specs/realaddr/tasks.md) | [Implementation status](en/implementation-status.md) |
| 要件と状態遷移 | [要件](../.kiro/specs/realaddr/requirements.md)、[設計](../.kiro/specs/realaddr/design.md) | [Architecture](en/architecture.md) |
| HTTP API・CLI・管理認可 | [API](api.md)、[管理仕様](admin.md) | [API guide](en/api.md) |
| 料金・契約期間・ENS追加購入 | [料金](pricing.md) | [Architecture](en/architecture.md)、[Integrations](en/integrations.md) |
| 外部サービス | [統合仕様](integrations.md)、[World](world.md)、[Intercepta](intercepta.md)、[LeaseRegistry](lease-registry.md)、[ENSv2](ensv2.md) | [Integrations](en/integrations.md) |
| 設定・配備・運用 | [運用](operations.md)、[配備設定](deployment-configuration.md)、[インフラ](infrastructure.md)、[Terraform手順](../infra/README.md)、[inventory](gcp-inventory.md) | [Operations](en/operations.md) |
| UIと公開情報 | [フロントエンド](frontend.md)、[AEO](aeo.md) | [Architecture](en/architecture.md)から原本へ参照 |
| 最小受入・提出 | [受入条件](acceptance.md)、[資料](sources.md)、[feedback](feedback.md) | [Implementation status](en/implementation-status.md)から原本へ参照 |
| 確定した利用規約 | [利用規約v1](terms.md)、[採用記録](terms-review.md) | 正式な英語版規約は未採用。日本語原本を参照 |

## 正本と更新方法

- 日本語の要件が挙動、設計が実装方針を定義します。識別子と機械契約は英語です。
- 公開HTTP shapeは[公開OpenAPI](openapi.json)、管理HTTP shapeは[管理OpenAPI](admin-openapi.json)を日英共通で使用します。現在の利用条件は[API案内](api.md)を参照してください。
- 英語版は主要項目を対応させたガイドです。仕様全体や過去の検証履歴の逐語訳ではありません。各ガイドの参照先と日本語の正本を同時に確認します。
- 挙動や状態を変えた場合は、関連する日本語原本・英語ガイド・実装状況を同時に更新します。タスクのチェックは実装と検証の根拠が揃ってから付けます。
- `realaddr-v1`の採用済み規約本文は、この文書整理では変更しません。英語ガイドは規約への新しい同意や版の変更を意味しません。
- 実account識別子、wallet/contract address、secret、個人住所、保護設定の実値は文書へ追加しません。検証証拠と署名状態は保護された保管先で管理します。
