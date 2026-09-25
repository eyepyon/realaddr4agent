# 受入テストと提出デモ

本書は実装後の検証計画。現時点のテスト結果ではない。unit testのmockとevent live証跡を明確に分ける。

## 必須テスト

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-01 | R-01 | slot 0/-1/1/32768/65535/65536/小数 | 1〜65535の整数のみ許可。Firestore repositoryでも拒否 |
| A-02 | R-01/R-03 | 100並行購入予約 | 異なる区画、重複契約なし |
| A-03 | R-01 | 最後の一枠へ同時要求、または全枠消費 | 一件だけreserve、他はSOLD_OUT、課金なし |
| A-04 | R-02 | 別tenant ID、期限切れBearer、使い回しwallet nonce | 401/404、他者情報なし、session再発行なし |
| A-05 | R-03 | 無料要求→402→有効payload | 順序通りverify/screen/settle/確認/発行。一契約のみ |
| A-06 | R-03 | 同キー再送、別キー同payload、同キー別body、応答喪失 | 再課金なし、同契約または409 |
| A-07 | R-04 | buyerでlive risk deny | signer呼び出し0、txなし、理由表示 |
| A-08 | R-04 | sellerでpayer deny、429、timeout、未知enum | settle呼び出し0、deny/hold表示 |
| A-09 | R-04 | 金額増額、偽USDC、chain/payTo/domain/nonce変更、並行予算消費 | 署名前拒否または保留、日次上限超過なし |
| A-10 | R-05/R-06 | 承認URLのみ、別wallet、wallet challenge再送 | owner proof不可、enabled不可 |
| A-11 | R-05/R-06 | 正しいowner proof+World fresh認証+approve | DBのbinding/approval/profileを一回だけ更新、転送可表示 |
| A-12 | R-06 | World cancel/deny/expired/無効state | enabledにならず住所保存403 |
| A-13 | R-06 | JWT改変/誤iss/aud/nonce/期限/alg/kid、古いauth_time、既存bindingと別sub | backend拒否。JWKS更新も失敗なら拒否 |
| A-14 | R-06 | World callback成功だけ、CSRFなし、同時approve、lease version変更 | 同意前はdisabled、CSRF拒否、二重適用なし、古いapprovalは409/410 |
| A-15 | R-07 | 人間が承認後住所入力→保存→reload | 暗号化DBに永続化し本人画面で復元。転送可/登録済み表示 |
| A-16 | R-07 | Agentから宛先書込/全文取得、別human、無効郵便番号、過長文字、古いversion | 拒否。Agentはstatus/登録有無だけ。XSSなし |
| A-17 | R-01/R-07 | lease失効/停止、mail-disable、期限切れrenew | 転送可停止。再開は新承認。cron遅延でも期限判定 |
| A-18 | R-10 | API/worker停止・Firestore接続断とsnapshot restore | 契約・approval・住所・cursor・冪等記録を保持 |
| A-19 | R-03 | settle成功直後DB停止、timeout後遅延receipt、reorg | reconcilingから照合回復。未知状態でslot解放/再課金なし |
| A-20 | R-04 | 実Intercepta key、mainnet安全/危険アドレス | 実レスポンスでpay/blockを制御。理由と時刻を表示。危険先送金0 |
| A-21 | R-06 | 公式World devで人間成功と拒否/期限切れ | 実callback検証、成功のみenabled。event fake proofを表示 |
| A-22 | R-03 | 実testnet token/facilitator | explorer/receiptで金額・payer/payTo照合。住所発行 |
| A-23 | R-08 | 実MultiBaasとregistry | write/read/eventから同じlease/version/期限を表示 |
| A-24 | R-08 | 無権限writer、slot0、同version別内容、重複event、reorg | revert/冪等/巻戻しが仕様通り。chainにPIIなし |
| A-25 | R-09 | 3開発ツール各々で同じCLIシナリオ | JSON解釈・人間待ち・状態再取得が成功。専用plugin必須でない |
| A-26 | R-07/R-10 | full E2Eとログ/ブラウザbundle検査 | 秘密漏洩なし、Agentに転送先なし、実発送/送料決済0 |

R-07の合格はフォーム保存と表示まで。現物発送・郵便局APIをテストしない。フォームをモックで成功表示するだけではA-15不合格。

## テスト階層

unit: policy、canonical hash、address validation、state transition。integration: Firestore Emulatorでrace、決定的ID/guardとversion transaction、rollback、再起動、暗号化、reconciler。小規模live Firestoreでも競合/IAMを確認しEmulatorとの差を記録。contract: Foundryの境界/role/version。E2E: 実API/DBとブラウザ、外部失敗の制御fixture。live: providerへ実接続する別コマンドでA-20〜A-23を通す。

live検証の結果はrunId、commit、時刻、環境、chain、公開可能なtx/contract、redacted provider evidenceで記録。自動テストでWorld本人操作を人間になりすまして代行しない。UIを人間が操作した箇所は手動ステップとして記録する。

## 5分デモ

1. 0:00–0:40: 「AIのリアル住所」と65,535区画を説明。Agentが住所契約を注文して402を受信。
2. 0:40–1:30: Interceptaのlive allow→署名→testnet settle→実住所区画発行。txとMultiBaas registry readを表示。
3. 1:30–2:10: 同じAgentがmail.enableを要求。まだ転送不可・フォーム保存不可であることを示す。
4. 2:10–3:20: 人間がwallet proof、World認証、明示承認。「郵便転送可」になり、人間自身が住所フォームへ入力・保存。reloadし永続化を確認。実発送なしを明示。
5. 3:20–4:10: 別の依頼でWorld取消/期限切れを示し、設定不可のままであることを表示。
6. 4:10–4:45: 自前の危険支払先challengeに対する実Interceptaのdenyを表示。署名も送金も起きない。
7. 4:45–5:00: 同じ購入のretryでも一契約・一支払いであること、3ツール共通利用の証跡を表示。

外部確認が長引いたら202とpollをそのまま見せる。録画をlive成功のように見せない。課金はtestnet、危険例は署名前停止。

## 提出証跡

- 公開repoと再現可能なsetup、lockfile、Firestore schema/index/rulesとbootstrap、tests、contract source。
- World: 成功/拒否、backend検証のコード、freshnessと同意の区別、実測feedback。
- Intercepta: live API呼び出し箇所、riskが署名/決済を止める箇所、理由、3〜5行feedback。
- Curvegrid: AI Agentがオンチェーンの契約状態を扱う説明、MultiBaasコード/証跡、team/SNS、実測feedback。
- demo URL、動画、設定制限、各SDK/chain/provider version。秘密/World subject/個人住所は非公開。

## ENSv2追加受入テスト

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-27 | R-11 | 公式Sepolia deploymentに親名/registry/専用resolver接続 | Universal Resolverからexact子名を実解決。ローカルDBだけで合格にしない |
| A-28 | R-12 | 名前でpublic lookupとowner Agent lookup | publicはpointer/検証結果のみ。ownerだけ契約営業所住所へ到達。他者404 |
| A-29 | R-13 | Agentがdescription更新、他のrealaddr key/addr/link/upgrade変更 | descriptionのみchainで成功。禁止keyはrevert。別leaseのresolverも変更不可 |
| A-30 | R-13 | ownerとoperatorがtransfer/registry差し替えを試行 | 顧客権限では拒否。admin保持範囲を記録 |
| A-31 | R-13 | lease/name/parentの期限切れ、suspend/revoke、worker停止 | verified activeにならない。古いtext/祖先fallback/直resolver readを証明にしない |
| A-32 | R-11/R-13 | 決済後ENS RPC停止、tx応答喪失、再起動 | 住所利用可能、ENS pending、二重課金/二重名発行なし |
| A-33 | R-12 | 偽suffix、Unicode混同、偽controller/pointer、owner不一致 | canonical登録とbindingの検査でinvalid。任意URLへsecret送信なし |
| A-34 | R-13 | renew/reorg/古いoutbox/同じname別lease | version整合、expiry上限、冪等、別lease再利用拒否 |
| A-35 | R-14 | 公開record/response/ブラウザ/ログのPII検査 | 転送先/World情報/承認URL/内部lease UUIDなし。名前・walletは公開と明示 |
| A-36 | R-14 | Codex/Claude Code/Kiroから同じENS CLI | 名前解決→owner契約取得。署名器は許可description txとgas capのみ送信 |

A-27/A-29/A-31はlive Sepoliaの証跡も必要。A-31のliveは実取消を行い、期限境界の網羅試験はローカルchainで時刻を進めて行う。通常30日契約をDBだけ短くしてchain失効を偽装しない。liveとローカルの結果を明確に区別する。

## ENSを含むデモ差分

従来の5分デモのchain照会場面へ「発行済みENS名→公式名前解決→自分の住所契約取得」を追加。description委任成功と禁止key拒否、取消後の照合拒否は補足動画またはliveで提示する。名前発行がまだpendingの場合は成功と表示しない。実郵便処理は引き続き行わない。

ENS提出証跡: 親名・registry/resolver/controller・Sepolia explorerリンク・公式解決結果・権限拒否・失効・再現手順。名前を画面に固定表示しただけでは完成としない。

## GCP / Firestore追加受入テスト

| ID | 要件 | Given / When | Then |
| --- | --- | --- | --- |
| A-37 | R-01/R-15 | 新規building、全65535枠境界、予約/未払い解放/発行 | 64shardのみ初期化。slotは必要時生成、issued再利用なし、quotaとbitmap整合 |
| A-38 | R-03/R-06/R-15 | transaction callback強制retry、同nonce別注文、並行approval | 外部API呼出0回/callback、guardで一意、最終適用一回 |
| A-39 | R-10/R-15 | outbox commit後enqueue前停止、task重複、worker応答喪失 | Scheduler回復、外部結果を照合、重複決済/名前登録なし、retry上限後manual_review |
| A-40 | R-10/R-15 | Cloud Run min=0復帰、worker実行中停止 | 状態保持、HTTP終了後CPU不要、claim切れだけで再送なし、cold/warm別計測 |
| A-41 | R-07/R-15 | 未認証worker、browser Firestore/GCS直接アクセス、別repo/refのCI | IAM/rules/WIFで拒否。公開UI/World callbackは利用可、secret key JSON不要 |
| A-42 | R-10/R-15 | writer停止snapshot→Emulator復元→chain差分照合 | guards/bitmap/契約/暗号化宛先/冪等記録一致。失われる更新期間を明記 |
| A-43 | R-15 | 新規契約上限へ並行要求、provider停止、大量pending | 原子的予算制限、未知決済は解放なし、既存照合は継続、全件scan/無限retryなし |
| A-44 | R-15 | eventの使用量測定・設定監査 | min=0、無料枠残/region/secret/image/通信/定期処理費を記録。課金額未反映を0円の証拠にしない |

A-37/A-38の網羅はEmulator、代表的競合はlive Firestore。A-39〜A-41は実GCPの最小fixtureでも確認。A-44では予算通知が強制停止ではないことを記録する。未deploy・未計測の段階では未実行。
