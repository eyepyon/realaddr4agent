# Documentation

Updated: 2026-09-27. [Project overview](../../README.en.md) / [日本語ドキュメント](../README.md)

Explore RealAddr for Agents through its features, architecture, API, and development guides. Start with the project overview, choose the setup commands for your OS, and follow the integration guides for the demo components. Development progress and execution records are collected in [implementation status](implementation-status.md).

## Reading guide

For the four ETHGlobal tracks, see the [bilingual submission answers, code links, and demo sequence](../submission.md) and [sponsor feedback](../feedback.md).

| Document | Contents |
| --- | --- |
| [English README](../../README.en.md) | Product overview, scope, development setup, and entry points |
| [Development](development.md) | Windows PowerShell, WSL bash, and macOS shell commands |
| [Implementation status](implementation-status.md) | Implemented behavior, live checks, and remaining work |
| [Architecture](architecture.md) | Components, trust boundaries, payments, consent, and ENS lifecycle |
| [API guide](api.md) | Authentication, API and CLI boundaries, errors, and shared schemas |
| [Integrations](integrations.md) | x402, World, Intercepta, MultiBaas, and ENSv2 |
| [Operations](operations.md) | Configuration, deployment, operator access, verification, and recovery |

## Authoritative references

These English documents are companion guides covering the main project documentation. They are not line-by-line translations of every specification or historical verification entry. The Japanese requirements define behavior; the design defines implementation. Follow the linked source documents for the full contract, task IDs, and acceptance scenarios.

| Area | Authoritative document |
| --- | --- |
| Requirements | [Requirements (Japanese)](../../.kiro/specs/realaddr/requirements.md) |
| Design and state transitions | [Design (Japanese)](../../.kiro/specs/realaddr/design.md) |
| Tasks and acceptance | [Tasks (Japanese)](../../.kiro/specs/realaddr/tasks.md), [Acceptance (Japanese)](../acceptance.md) |
| Public HTTP shapes | [Public OpenAPI](../openapi.json) |
| Operator HTTP shapes | [Admin OpenAPI](../admin-openapi.json) |
| Prices and purchase rules | [Pricing (Japanese)](../pricing.md) |
| ENS registry and resolver contracts | [ENSv2 (Japanese)](../ensv2.md) |
| Infrastructure ownership and IAM | [Infrastructure (Japanese)](../infrastructure.md), [Inventory (Japanese)](../gcp-inventory.md) |
| Deployment configuration | [Deployment configuration (Japanese)](../deployment-configuration.md), [Terraform guide (Japanese)](../../infra/README.md) |
| UI and public discovery | [Frontend (Japanese)](../frontend.md), [AEO (Japanese)](../aeo.md) |
| Verification history and open items | [Implementation record (Japanese)](../implementation-status.md), [Open items (Japanese)](../open-items.md) |
| Sources and submission feedback | [Sources (Japanese)](../sources.md), [Feedback (Japanese)](../feedback.md) |
| Adopted terms | [Terms v1 (Japanese)](../terms.md), [Adoption record (Japanese)](../terms-review.md) |

The OpenAPI files are shared by both languages; see the [API guide](api.md) for current access conditions. The adopted terms are the Japanese `realaddr-v1` text linked above. These technical guides describe the project and its setup.

When behavior or verification status changes, update the Japanese source, the corresponding English guide, and the implementation record together. Keep requirement, task, and scenario IDs unchanged. Keep real account identifiers, wallet and contract addresses, secrets, personal addresses, and protected configuration values out of repository documentation.
