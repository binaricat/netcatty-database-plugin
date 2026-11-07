# AI parity checkpoint

Compared with DBX `b6c3d47`, in particular `apps/desktop/src/components/editor/AiAssistant.vue` and `crates/dbx-ai-provider`, against Netcatty main `4a55492` (`packages/plugin-sdk/src/index.ts`, both `PluginAIClient` and `PluginAgentClient`; generated contract; `electron/plugins/agent/agentService.cjs` and its tests).

## Implemented plugin behavior

- Generate, explain, optimize and fix tasks using allowlisted connected schema metadata, editor SQL and explicit user request. No result rows, credentials or database/session objects are sent.
- Bounded streaming, monotonic sequence validation, stop/cancel, generation isolation and chat/turn cleanup, including late asynchronous results.
- Last three completed turns available for follow-up within the mounted panel. Old context is dropped to retain the 12 KiB prompt limit. No transcript disk persistence; closing the panel clears it.
- Explicit new-conversation reset.
- Insert only an unambiguous SQL fenced block (or recognizable plain SQL); explanations and multiple blocks remain draft-only. Insertion never executes a query and explain-task responses cannot replace SQL.
- Feature presence does not prove model availability: the panel says the host model is checked when assistance runs. Failed model/permission requests report unavailable. Success labels the actual model returned by the host.

## Remaining differences, not claimed complete

DBX also has persisted conversation history, editing/retry/branching, provider and model configuration, attachments, selected skills, Ask/Agent tools with approval, rich chart/HTML output, query/explain tooling and execution-plan views. The plugin currently does not provide these. Some can be implemented as bounded plugin UI after associated database features exist; they are not blanket classified as host limitations.

## Corrected host-capability audit

The earlier audit of only `PluginAIClient` was incomplete. Its narrow draft API is **not the whole plugin system**. Netcatty main also exposes the following supported surfaces, so Agent sessions and durable host-owned chat history must not be labelled impossible:

| Main surface | Available behavior | Scope and qualifications |
| --- | --- | --- |
| `context.agent`, feature `ai.agent-sessions` | `listBackends`, `selectTargets`, `listChats`, `openChat`, `send`, `read`, `history`, `stop`, `closeChat` | Backend references and user-selected terminal targets are opaque, expiring host handles. Reopen with `conversationRef`; history is persisted by the host and scoped to plugin ownership. |
| `ai.agent.use` permission | Configured backend discovery, chat and own history | Backend records explicitly report supported/unsupported/unavailable and ready/not-configured/native-boundary-unverified/configuration-unavailable. A feature flag alone is not proof that any backend works. |
| `ai.agent.actions` permission | Host-gated tools and streamed activity started/completed/denied | Current fixed tool capabilities are `session.environment`, `terminal.execute`, `terminal.start`, `terminal.poll`, `terminal.stop`, `harness.terminal.read_context`. Tools are limited to the user's selected targets; permissions remain host-owned. Without action permission the service issues an empty capability set. |
| `host.interactions` | Host quick-pick and single-line input; separately permissioned clipboard and terminal-selection/proposal surfaces | Useful for choosing/reopening conversations and explicit user-mediated context/copy actions. Not a grant of arbitrary terminal execution or user data access. |
| `network.credential-lease` and `context.credentials.createLease` | Operation-bound short-lived credentials for supported network authorization | `network.request` can consume a credential lease for Basic/Bearer authentication. This is not a model picker, not proof of streaming-provider compatibility, and not a reason to expose raw secrets. |

The narrow draft API cannot choose a model, but the Agent API **can select a configured backend** using `backendRef`. Provider/model configuration and native resume identifiers remain host-owned. Backend selection is therefore an implementation opportunity, not a blanket host limitation.

The inspected Agent contract does not expose arbitrary registration of plugin database tools. Its fixed terminal tools are not equivalent to DBX's native query/schema/explain tools. Do not silently run model-generated SQL through a terminal as a substitute. Whether a safe, user-approved database-tool adapter can be implemented needs a separate design and acceptance test; until then this remains an unimplemented parity gap, not a proven platform impossibility.

### Next implementable slice

1. Add optional Agent mode, gated by `ai.agent-sessions` and declared `ai.agent.use`, while retaining draft-only mode. Enumerate backend status instead of assuming availability.
2. Use host `selectTargets`, never infer a target from focus. Provide new/resume chat list, host `history`, bounded transcript display, send/read activity and end reasons, stop and reliable handle disposal. Distinguish completed/cancelled/unavailable/budget-exceeded.
3. Default to conversation-only behavior with no `ai.agent.actions`; add action mode only through its explicit permission and native approval workflow, with selected-target and capability disclosures. User settings or denied permissions must not be overridden.
4. Test stale selection/backend handles, revocation, denied tools, reopen isolation, history bounds and cancellation against main services; then perform real configured-backend acceptance with user-authorized sample context.
5. Implement edit/retry and bounded conversation navigation as plugin UI where appropriate. Rich output, attachments/selected context, skills and database-aware tools need separate evidence and permission review, not premature claims of platform exclusion.

Source evidence: main `PluginAgentClient`; generated `PluginAgentBackend`, `PluginAgentEvent`, `PluginAgentOpenParams` and permission union; `agentService.cjs` capability issuance/tool dispatch; `agentService.test.cjs` durable own-history reopening and actual per-tool approval tests. No code or permissions were changed by this audit.

## Evidence limits

Unit tests use a mock AI stream to verify cancellation, sequence/output bounds, prompt allowlisting and safe draft extraction. Existing SQLite UI/native harness deliberately rejects `ai.openChat` and proves the unavailable path only. No live configured model invocation has been verified. This is **partial parity**, not a claim that real-model AI or DBX Agent parity has passed.
