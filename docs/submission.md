# ETHGlobal prize submission / 応募回答

[日本語README](../README.md) / [English README](../README.en.md) / [Integration feedback](feedback.md)

対象はWorld **Best Use of World ID for Agents**、ENS **Best Use of ENSv2**、Curvegrid **Best AI Agent Project**、Intercepta **Safe Agent-to-Agent Payments with x402**。以下は実装の役割を説明する1〜2文の回答であり、実接続デモの合否は[実装状況](implementation-status.md)と[最小受入](acceptance.md)で管理する。公式条件は[賞ページ](https://ethglobal.com/events/tokyo2026/prizes)を参照。

These short answers describe the integration code. Live-demo evidence is tracked separately in [implementation status](en/implementation-status.md). Event World proofs are mocked; payments use Base Sepolia, while ENSv2 and lease attestations use Ethereum Sepolia. The mail demo covers approval and destination settings only.

## World — Best Use of World ID for Agents

**How are you using this Protocol / API? — 日本語**

AIエージェントの住所契約に付随する郵便転送設定を、人間だけが承認できるようWorld ID for Agentsを利用しています。backendでfreshなOIDC認証結果を検証し、owner walletの証明、契約・宛先version、明示同意を結び付けることで、ログインだけでは設定を有効にしません。

**English**

We use World ID for Agents to keep approval of an AI agent's mail-forwarding settings in human hands. Our backend validates fresh OIDC authentication and binds it to owner-wallet proof, lease and destination versions, and explicit consent, so signing in alone cannot enable forwarding.

**Link to the line of code**

- [OIDC result validation](../packages/world/src/index.ts#L79)
- [Request, callback, and explicit decision](../apps/api/src/world.ts#L37)
- [Agent-to-human CLI handoff](../packages/agent-cli/src/index.ts#L106)

**Additional feedback**

日本語: OIDCとPKCEで本人認証をアプリの同意から分離できました。取消・期限切れ・再送を含むfresh認証から明示承認までの実行例があると、統合をさらに進めやすくなります。

English: OIDC and PKCE let us separate authentication from application consent. A complete fresh-authentication example covering explicit consent, cancellation, expiry, and replay would make integration easier.

## ENS — Best Use of ENSv2

**How are you using this Protocol / API? — 日本語**

ENSv2の親名・拠点・契約名のregistry階層と契約別Permissioned Resolverで、住所利用権を名前から照合する仕組みを実装しています。利用者にはdescriptionだけの更新権限を与え、Universal Resolverの結果を支払済み契約、controller、期限と照合することで、単なるtext recordを利用権の証明として扱いません。

**English**

We use ENSv2's parent, location, and lease registry hierarchy with a dedicated Permissioned Resolver for each purchased name. Users receive description-only editing rights, while Universal Resolver results are checked against the paid lease, controller, and expiry, so a text record alone cannot prove entitlement.

**Link to the line of code**

- [Per-lease resolver, registration, and permissions](../contracts/src/RealAddrNameController.sol#L133)
- [Exact hierarchy and Universal Resolver verification](../packages/ens/src/index.ts#L209)
- [Public name lookup](../apps/api/src/ens.ts)

**Additional feedback**

日本語: registry階層とrecord単位の権限が、契約情報と利用者descriptionの分離に適していました。親から子の登録、専用resolver、最小権限、Universal Resolver照合を通した例があると助かります。

English: Registry hierarchy and record-level permissions fit our separation of protected lease data and user descriptions. An example covering child registration, a dedicated resolver, minimal permissions, and Universal Resolver checks would help.

## Curvegrid — Best AI Agent Project

**How are you using this Protocol / API? — 日本語**

RealAddrは、共通CLIから住所契約を扱い、郵便転送設定の承認を人間へ引き渡すAIエージェント向けサービスです。MultiBaas adapterでEthereum SepoliaのLeaseRegistryを照会し、独立RPCの同じfinalized blockと照合して、契約version・期限・状態を確認する仕組みを実装しています。

**English**

RealAddr gives AI agents a shared CLI for address leases while handing mail-setting approval to a human. Our MultiBaas adapter reads LeaseRegistry on Ethereum Sepolia and compares it with an independent RPC at the same finalized block to verify lease versions, expiry, and state.

**Link to the line of code**

- [MultiBaas contract read and same-block comparison](../apps/worker/src/registry-reader.ts#L90)
- [Agent CLI](../packages/agent-cli/src/index.ts)
- [LeaseRegistry](../contracts/src/LeaseRegistry.sol)

**Additional feedback**

日本語: ABI登録・contract link・read-backを一つの流れで扱えました。deployment UIでtransactionが返らずwalletが開かないケースがあったため、生成失敗・署名待ち・送信結果不明を区別する案内があると助かります。

English: ABI registration, contract linking, and read-back fit a single workflow. One deployment attempt returned no transaction or wallet prompt; clearer distinctions between generation failure, awaiting signature, and unknown submission would help.

## Intercepta — Safe Agent-to-Agent Payments with x402

**How are you using this Protocol / API? — 日本語**

AIエージェントの住所利用料に対する決済準備adapterからIntercepta Quick Scanを呼び出し、支払先と支払者を評価します。危険・不明・期限切れの結果を理由付きで止めるgateを設け、必須の安全判定が揃わないまま支払い準備へ進まない設計です。

**English**

Our pre-settlement adapter calls Intercepta Quick Scan to assess the recipient and payer for AI-agent address fees. A reasoned gate blocks prohibited, unknown, or stale results, preventing payment preparation until the required security assessments are satisfied.

**Link to the line of code**

- [Live Quick Scan API call](../packages/intercepta/src/index.ts#L65)
- [Recipient and payer gate before settlement preparation](../apps/api/src/payment-screening.ts#L39)

**Additional feedback**

日本語: 認証付きQuick Scanでschemaに一致する応答を取得できました。数値スコアの意味、endpoint別mainnet coverage、安全・危険の参照例を一つのガイドにまとめると、決済policyを確定しやすくなります。

English: Authenticated Quick Scan returned a schema-valid response. A single guide covering score semantics, endpoint-specific mainnet coverage, and safe/risky reference cases would make payment-policy configuration easier.

## Form ratings / 使いやすさの点数

「How easy is it to use the API / Protocol?」は1（難しい）〜10（簡単）の本人評価を入力する。実測していない導入時間や、チームが選んでいない点数は補わない。各スポンサーの長めのfeedbackは[こちら](feedback.md)。

Enter the team's own 1–10 ease-of-use rating. Do not substitute request latency for time to first integration success. Longer feedback is provided in the [bilingual feedback notes](feedback.md).

## Demo sequence / 実演の組み立て

1. Agentが住所契約の見積を選び、Interceptaのmainnet履歴による評価と理由を確認する。安全なtestnet決済一本と、危険先への署名前停止を示す。
2. 30日の支払済み契約と、ENSが別料金であることを示す。ENS追加の確定後に名前を発行し、開発者ページの照合フォームまたはCLIで公式名前解決とbindingを示す。
3. MultiBaasの同じfinalized blockによるread-backで契約を照合し、Agentから状態を取得する。
4. CLIの`mail request`で人間用URLを出し、owner proof→Worldのfresh認証→明示同意→宛先入力を通す。取消または期限切れでは保護操作が起きないことを示す。
5. 各結果を動画と再現手順へまとめる。wallet secret、World subject、完全な転送先住所は映さない。実演はtestnet / official event dev環境と明記する。

The judging flow is screening → testnet payment → lease/optional ENS issuance → authoritative name and contract read-back → human approval. Show a meaningful refusal as well as success, using real provider responses. Keep private forwarding data and credentials out of the recording.

## Before submitting / 提出前の仕上げ

- World: 支払済み契約で公式event環境の認証成功・明示承認と、取消または期限切れを通す。
- ENS: 拠点namespace接続、支払済み名前の発行、公式解決と権限拒否を通す。照合フォーム自体は名前発行の代わりにならない。
- Intercepta/x402: providerの判定条件・coverageを確定し、facilitatorのverify/settle/照合を既存の永続注文へ接続する。実APIによるholdの確認だけで成功決済の要件を満たしたことにはしない。
- Curvegrid: Agent操作とMultiBaas利用箇所、再現手順をREADMEから辿れるようにする。チーム紹介・公開SNSを本人情報で記載する。
- 共通: 動作する公開デモ、公開repo、動画、コード行リンク、feedbackを揃える。独自コードは[MIT](../LICENSE)、依存ライブラリのライセンスは各配布元のまま維持する。

Finish the connected World success/refusal, ENS issuance/resolution, and Intercepta-controlled successful/blocked payment demonstrations before declaring prize requirements complete. Add the team's public biography/social handles and measured debrief details. MIT covers this project's original code; third-party licenses remain unchanged.
