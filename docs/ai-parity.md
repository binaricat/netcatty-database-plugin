# AI parity checkpoint

Compared with DBX `b6c3d47`, in particular `apps/desktop/src/components/editor/AiAssistant.vue` and `crates/dbx-ai-provider`, against Netcatty main `4a55492` (`packages/plugin-sdk/src/index.ts`, `PluginAIClient`).

## Implemented plugin behavior

- Generate, explain, optimize and fix tasks using allowlisted connected schema metadata, editor SQL and explicit user request. No result rows, credentials or database/session objects are sent.
- Bounded streaming, monotonic sequence validation, stop/cancel, generation isolation and chat/turn cleanup, including late asynchronous results.
- Last three completed turns available for follow-up within the mounted panel. Old context is dropped to retain the 12 KiB prompt limit. No transcript disk persistence; closing the panel clears it.
- Explicit new-conversation reset.
- Insert only an unambiguous SQL fenced block (or recognizable plain SQL); explanations and multiple blocks remain draft-only. Insertion never executes a query and explain-task responses cannot replace SQL.
- Feature presence does not prove model availability: the panel says the host model is checked when assistance runs. Failed model/permission requests report unavailable. Success labels the actual model returned by the host.

## Remaining differences, not claimed complete

DBX also has persisted conversation history, editing/retry/branching, provider and model configuration, attachments, selected skills, Ask/Agent tools with approval, rich chart/HTML output, query/explain tooling and execution-plan views. The plugin currently does not provide these. Some can be implemented as bounded plugin UI after associated database features exist; they are not blanket classified as host limitations.

The narrow main `PluginAIClient` offers open/start/read/stop/close only. Model/provider configuration stays with the host; the plugin cannot choose a model through this API. Arbitrary provider secrets or native CLI tools are not added as workarounds. Agent execution must not be inferred from this draft-only API.

## Evidence limits

Unit tests use a mock AI stream to verify cancellation, sequence/output bounds, prompt allowlisting and safe draft extraction. Existing SQLite UI/native harness deliberately rejects `ai.openChat` and proves the unavailable path only. No live configured model invocation has been verified. This is **partial parity**, not a claim that real-model AI or DBX Agent parity has passed.
