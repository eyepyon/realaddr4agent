# Implementation status

[English index](README.md) · [Project overview](../../README.en.md) · [Architecture](architecture.md)

Snapshot: **2026-09-27**. Implementation and deployment have begun, but the connected sponsor/ENS demo is incomplete. **Sales remain closed and `namespaceReady=false`.** This current-state guide does not translate every historical experiment. Commands and chronological evidence remain in [the primary implementation log (Japanese)](../implementation-status.md). [Task IDs (Japanese)](../../.kiro/specs/realaddr/tasks.md) remain authoritative; partial work does not complete a task.

| Area / tasks | Implemented or verified | Remaining gate / limitation |
| --- | --- | --- |
| Workspace / T-01 | Pinned pnpm workspace, strict TypeScript, API/worker builds, CLI, React/Vite UI, health/readiness and CI | Integration and submission evidence remain separate |
| Persistence / T-02 | Wallet challenge/Bearer scope, owner reads, slot guards, durable payment uncertainty and internal purchase/renewal recovery | Confirmed-receipt internal fulfillment is not live public settlement |
| UI / T-08, T-19 | Crawlable public HTML, discovery assets, account reads, sandbox/testnet labels and terms version alignment | Connected mutations/full demo remain incomplete |
| GCP / T-16 | Dedicated named database, app infrastructure, public web/private worker, workflow, custom-origin TLS/HTTPS and representative refusals checked | Real Tasks/Scheduler OIDC delivery and an actual other-user Firebase client test remain unverified |
| Worker / T-09, T-16 | Persistent claims/retries, REST dispatcher, sweep recovery and confirmed-payment fulfillment recovery | Transfer handler is disconnected; chain reconciliation is disabled by default |
| Operators / T-18 | Google OIDC/allowlist, separate session, bounded summaries and paused-location form; user-reported successful login and persisted paused location checked | Sales reopening refuses while external payments are disconnected; read-reconciliation runner is disconnected |
| Intercepta / T-00, T-04 | Quick Scan adapter, internal gates and diagnostic CLI; authenticated HTTP 200/schema checked | Verdict is `hold/provider_policy_unconfirmed`; numeric policy/chain scope unresolved; public pay/signer path disconnected |
| x402 / T-00, T-05 | Internal order/receipt/idempotency and uncertainty handling | Live public settlement/signers are disconnected/unverified; public purchase/renewal refuse sale |
| LeaseRegistry / T-00, T-07 | Ethereum Sepolia deployment and independent RPC checks; MultiBaas read-only checks; local outbox/version/claim checks | Actual lease record/revoke, event enablement and indexed-event cursor/reorg recovery incomplete |
| World / T-00, T-03, T-06 | Sandbox OIDC adapter, human session, owner proof, explicit consent/destination versions and form deployed; unauthenticated/agent refusals checked | Live authentication/token exchange and real-paid-lease approval unverified; sandbox proof is not production identity assurance/legal KYC |
| ENS / T-00, T-12–T-14 | Reservations, one-time entitlement, controller/resolver logic, hierarchy validation and owner API/CLI; parent/upper hierarchy finalized; controller independently checked/finalized | User is progressing location transactions; no success is recorded here. Official resolution, app namespace enablement, paid issuance and live permission denial remain unverified |
| Submission / T-10, T-11, T-15, T-17 | Focused local/infrastructure evidence recorded | Full live happy path, representative sponsor/ENS denials, three-tool smoke and final submission package incomplete |

## Latest focused evidence

The Developers page now offers English/Japanese ENS name lookup through the existing public resolve endpoint. It displays actual verification or blocked results and validates returned public references; it does not purchase or issue names. The common CLI adds `mail request --subscription <id> --idempotency-key <key> [--force-reauth] --json` to retrieve a same-origin human approval URL or existing consent status. Human approval and full destination access remain exclusive to the human session.

Workspace typecheck and the event build passed, together with 11 focused checks (3 ENS response parser, 1 World CLI wire, 7 World adapter). All 2 agent-cli package checks (ENS and World) also passed. Browser checks confirmed the local API's `ens_dependency_unavailable` result and preservation of the input and result when switching languages. These local checks do not establish provider success. An MIT license and submission/feedback documents were added. Both READMEs include the supplied team introduction: chain.tokyo, member Masafumi Aida and the public social profile. Measured feedback still requires actual results. Public descriptions should explain operations and observed results without claiming unperformed successful flows. Real-paid-lease World approval, paid ENS issuance/resolution, Intercepta score/traits/coverage policy, and connected public x402 settlement remain gates; no whole-task completion was added.

The frontend now supports English (default) and Japanese across public, account, human-approval, and operator screens. Public pages have bilingual initial HTML and discovery metadata; adopted terms remain the Japanese original. Workspace typecheck, the event build, and 11 focused locale/HTML/cache checks passed. Browser checks covered switching, remembered language on another page, account/operator sign-in copy, and preserving an expanded FAQ. A hydration mismatch found during review was fixed with hydratable server markup. Authenticated form flows and new live World/payment/ENS operations were outside this change's checks; existing feature gates and task completion remain unchanged.

The documentation update added English companion guides and Windows/WSL/macOS command variants. Changed Markdown links, text encoding/line endings, and the diff were checked. No application code changed, so builds and business tests were not rerun for this update. Manual WSL/macOS startup, provider connections, and Terraform operations remain unexecuted; Linux CI evidence is a separate scope. This does not complete T-11 submission artifacts or the live demo.

Recent ENS location preparation records 20 focused location planner/flow/client/server checks, 6 Firestore Emulator registry checks, workspace typecheck and an event build with the formal terms version passing. It also records persistent building identity preparation, read-only creation simulation and initial signing-helper state with no sent operations. These prove preparation and local behavior; they do not prove the five location transactions, official resolution or paid issuance succeeded.

Parent acquisition, upper-registry connection and NameController deployment have separate independent-RPC/canonical-receipt/finalization evidence. Their completion cannot complete a location namespace or open sales. Even `locationConnected` would not prove official resolution, app readiness or paid issuance.

Earlier records cover representative slot/payment guards, mail approval/access controls, public/private responses, runtime identities and database refusals. Counts belong to their recorded run/scope; they do not claim every acceptance scenario passed or that checks were rerun for this documentation update.

Windows local execution and Linux CI results are recorded. Manual WSL/macOS startup is unverified. [Local setup](../../README.en.md#run-locally) lists Windows PowerShell, WSL bash and macOS zsh/bash commands with their environment-variable and hash-tool differences; documenting those commands does not add execution evidence.

## Remaining demo blockers

1. Resolve Intercepta policy/coverage and connect real allow/deny decisions to signer/payment paths.
2. Connect Base Sepolia x402 settlement/receipt reconciliation without repeating uncertain payments or releasing their reservations.
3. Complete and independently verify location registry/controller operations, official resolution, app configuration and paid issuance before enabling the namespace or sales.
4. Complete actual LeaseRegistry write/read and durable event/reorg recovery.
5. Run live World authentication and human approval/destination save/read against the real paid lease, with representative unauthorized access and consent denial.
6. Record persistent restart/recovery, deployment-delivery checks and common-CLI evidence from Codex, Claude Code and Kiro, then assemble the submission artifacts.

These conditions do not authorize fake provider successes, physical mail handling or mainnet. [Acceptance (Japanese)](../acceptance.md) permits focused checks/manual evidence; unexecuted coverage remains deferred. Tasks stay unchecked until implemented behavior and minimum evidence exist.
