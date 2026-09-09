# What this is

A minimal VS Code extension that puts an **agentic coding assistant** in the
Activity Bar sidebar. It drives an autonomous agent via the **official DeepSeek
API** (OpenAI-compatible `chat/completions`, streaming + function calling). The
agent can read/write/edit files, list directories, and run shell commands, and
the user can interrupt it at any time.

**Design ethos:** intentionally small — no framework, no external runtime
dependencies. TypeScript + the VS Code API + Node's global `fetch` +
`child_process`. Every non-trivial behavior belongs in a single place.

