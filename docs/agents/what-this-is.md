# What this is

A minimal VS Code extension whose **agentic coding assistant** lives in an editor
tab, one tab per session (`src/chat/ChatPanel.ts`, `CHAT_VIEW_TYPE =
'spinney.chatTree'`); the Activity Bar sidebar only lists the sessions. It is
**multi-provider**: the endpoints are the rows of `spinney.providers`
(`name` / `baseUrl` / `concurrency`) and the models the rows of
`spinney.modelCards` (a `providerId`, the wire name `oaiModel`, the context
window, the effort levels, and the image capability with
`vision.transport: openai|deepseek`) — OpenAI-compatible `chat/completions`,
streaming + function calling. The agent can read/write/edit files, list
directories, and run shell commands, and the user can interrupt it at any time.

**Design ethos:** intentionally small — no framework, no external runtime
dependencies. TypeScript + the VS Code API + Node's global `fetch` +
`child_process`. Every non-trivial behavior belongs in a single place.

