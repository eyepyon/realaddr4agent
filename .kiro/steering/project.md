---
inclusion: always
---

# RealAddr project

共通指示はリポジトリルートの `AGENTS.md`。仕様本体は `.kiro/specs/realaddr/requirements.md`、`design.md`、`tasks.md`。API・外部連携・テスト・運用は `docs/` にある。これらを読んでから実装する。

World承認、Intercepta判定、x402決済、MultiBaasのオンチェーン照会を実接続で完成させる。郵便は人間承認後の転送可表示と人間用住所フォームまで。実発送は行わず、Worldを法的本人確認の代替としない。区画の重複、二重課金、承認の使い回しを禁止する。

ENSv2の契約別サブネーム・専用Resolver・期限/取消・名前からの住所契約照合は `docs/ensv2.md` に従う。転送先住所はENSへ書かない。

GCP / Cloud Run / Firestore / Cloud Storage / GitHub Actionsを採用。永続outboxはCloud TasksとSchedulerで実行する。低コスト設定とFirestoreの一意性・再試行規則は `docs/infrastructure.md` に従い、SQLや常駐workerを追加しない。

テストはハッカソン最小限とし、`docs/acceptance.md` の最小チェックを適用する。網羅テストや全受入ケースの自動化を必須にしない。

画面は白/薄いグレーと控えめな青の標準SaaSデザイン。`docs/frontend.md`、`docs/admin.md`、`docs/aeo.md`に従い、公開originはhttps://address.chain.tokyo。ドメイン設定はユーザー担当。

詳細仕様をこのファイルに複製しない。タスクの完了には実行した検証結果が必要。独自のKiroカスタムエージェントを使用する場合は、このsteeringと共通仕様をresourcesに明示的に読み込ませる。
