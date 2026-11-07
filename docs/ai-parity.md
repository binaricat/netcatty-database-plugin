# AI parity checkpoint

Compared with DBX `b6c3d47`, in particular `apps/desktop/src/components/editor/AiAssistant.vue` and `crates/dbx-ai-provider`, against Netcatty main `4a55492` (`packages/plugin-sdk/src/index.ts`, both `PluginAIClient` and `PluginAgentClient`; generated contract; `electron/plugins/agent/agentService.cjs` and its tests).

## Implemented SQL draft mode

- Generate, explain, optimize and fix tasks using allowlisted connected schema metadata, editor SQL and explicit user request. No result rows, credentials or database/session objects are sent.
- Bounded streaming, monotonic sequence validation, stop/cancel, generation isolation and chat/turn cleanup, including late asynchronous results.
- Last three completed turns available for follow-up within the mounted panel. Old context is dropped to retain the 12 KiB prompt limit. No transcript disk persistence; closing the panel clears it.
- Explicit new-conversation reset.
- Insert only an unambiguous SQL fenced block (or recognizable plain SQL); explanations and multiple blocks remain draft-only. Insertion never executes a query and explain-task responses cannot replace SQL.
- Feature presence does not prove model availability: the panel says the host model is checked when assistance runs. Failed model/permission requests report unavailable. Success labels the actual model returned by the host.

## Implemented SDK Agent conversation mode

`SqlAssistant` now offers a mode selector which mounts `AgentAssistant`. `AgentSession` adapts the actual main SDK `context.agent` contract. This implementation is no longer merely a proposed next slice:

- Explicit backend checking and selection; no permission request or provider invocation on initial render.
- Host-mediated target selection, new/reopened conversation references, host-owned durable history access, lists paginated at eight conversations and one bounded history message at a time.
- Send/read lifecycle, completion/cancellation/unavailable/budget end reasons, stop/close, stale-response isolation and handle cleanup.
- Permission errors remain visible without automatic retries. Input/output/event/history budgets are bounded; omitted history is disclosed.
- Optional `ai.agent.use` integration, conversation-only operation without `ai.agent.actions`. Unexpected tool activity is rejected and the session is stopped. The actual prevention boundary is the manifest and host permission enforcement, not the UI wording or activity detector.
- The current schema metadata, connection label, SQL and explicit request are disclosed before sending. No result rows are added. Unique SQL draft extraction inserts into the editor only, without executing.

**Implemented against the SDK does not mean verified with a real configured provider.** Host persistence is supported by the contract and service; the plugin UI/controller integration is implemented, but full-App real-provider create/resume/history acceptance remains pending.

## Remaining differences, not claimed complete

The draft assistant now has explicit Retry and Edit-last-request branches, described below. General transcript branching/editing, provider/model configuration UI, attachments, selected skills, Agent database tools with approval, rich chart/HTML output, query/explain tooling and execution-plan views remain incomplete here. Durable Agent conversation history is no longer classified as absent: its SDK integration exists, with real-provider acceptance pending. Some remaining features can be implemented as bounded plugin UI after associated database features exist; they are not blanket classified as host limitations.

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

### Next acceptance and implementation work

1. Run the integrated Agent mode in the actual full App with a configured supported backend and explicitly authorized sample context. Verify the native permission flow, target selection, create/send/resume/history, unavailable states and stop/disposal. No provider is currently configured in that full-App test environment.
2. Extend deterministic remote-DOM interaction tests beyond empty backend discovery to full Agent create/resume/send/history flows. Existing controller mock tests cover permission errors, expired selections, bounded history/output and cancellation races; these are not real-provider evidence.
3. Keep conversation-only mode without `ai.agent.actions`. Any future action mode needs its own explicit permission/approval workflow and selected-target disclosure, without overriding denied settings.
4. Design and test an explicit database-tool registry/adapter boundary. The current SDK's fixed terminal tools are not DBX's schema/query/explain tool registry. This remains a documented integration gap; do not substitute automatic SQL execution through terminal tools.
5. Continue plugin-side edit/retry/branching, richer context and output work with independent tests and data-sharing review. Do not treat missing product code as proven host impossibility.

Source evidence: main `PluginAgentClient`; generated `PluginAgentBackend`, `PluginAgentEvent`, `PluginAgentOpenParams` and permission union; `agentService.cjs` capability issuance/tool dispatch; `agentService.test.cjs` durable own-history reopening and actual per-tool approval tests. The original capability audit was read-only; the Agent UI/controller implementation and optional permission integration were added afterward.

## Evidence limits

- The parent integration reports **63+ passing unit tests** across the plugin. AI-specific tests use deterministic mock SDK/provider responses for prompt allowlisting, SQL extraction, output budgets, permissions, lifecycle and cancellation. This count is not a count of live-provider tests.
- `scripts/ui-regression.mjs` now tests both the unavailable-model path and a deterministic fake-provider success path: generation, follow-up context, reset, insertion, and assertion that insertion did not execute SQL. It uses real main remote-DOM validation, but injected storage/view/provider transport. Agent-mode UI coverage currently includes mode selection and explicit empty backend discovery, not full real Agent conversation acceptance.
- Earlier SQLite/native screenshots using the deliberately unavailable AI fixture prove that unavailable path only. A fake-provider UI pass must not be relabelled a live-model or complete native-App AI pass.
- The actual full-App environment currently has no configured provider. No live configured draft model or Agent backend has passed end-to-end acceptance there. DBX Agent/database-tool parity is not complete.

Current status: **SDK draft and Agent conversation integrations implemented; deterministic checks passing; real provider acceptance pending; DB-tool registry integration still missing.**


## Explicit draft Retry / Edit-last candidate

Retry reuses the captured task/request/prompt including the original schema/SQL,
with a visible warning that it may differ from the current editor. It does not
silently send new context. Edit-last restores the request and preceding history
without calling a provider; the next explicit Run uses then-current context. A
successful retry replaces that branch rather than duplicating history. Stop and
failed requests do not become completed history, and generation guards reject
late output. New conversation clears the retained request snapshot.

`scripts/ai-branch-regression.mjs` mounts the real React component/hook and dispatches
click/input events with an injected provider. Ten simulated invocations exercise
original-context retry, non-sending edit, subsequent new context, nonduplicated
history, stop/retry late-stream isolation, failure retry and reset. This is not a
real configured model or native permission test. Native/provider acceptance remains
pending. No database tools or automatic query execution were added.
