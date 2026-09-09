# Architecture & data flow

```
User (editor WebviewPanel) <--postMessage--> ChatViewProvider (src/chat)
                                                    | holds per-session Agent + tree
                                                    v
                                        Agent (src/agent/agent.ts)
                                           | streaming loop
                                           v
                                        DeepSeekClient (src/agent/deepseek.ts)
                                           |  tools (function calls)
                                           v
                                        ToolRegistry (src/tools/index.ts)
                                           |  v
+ Sidebar (native TreeView)  SessionsProvider  reads  ChatViewProvider
+                                           +  exec_command -> shell detection (src/tools/shell.ts)
```

1. `extension.ts::activate` creates the sidebar `TreeView` (`agentHarness.sessions`)
   and the commands (`agentHarness.openChat`, `openSession`, `newSession`,
   `deleteSession`, `clear`, `focus`).
2. The webview (`media/main.js`) sends messages (`userMessage`, `checkout`,
   `setModel`, `setThinkingEffort`, `stop`, `clear`, `pickImage`, `setNodeSize`).
   It streams in a sandboxed iframe and loads a vendored `markdown-it.min.js` plus
   `media/tree.js` (pure layout).
3. `ChatViewProvider` owns the `Agent` instance and one **session** per
   conversation. Each session persists its own `messages` (API history) and
   `displayItems` (UI transcript) and is restored from `vscode.Memento`.
5. `Agent.sendUserMessage` pushes a user message and runs the loop: stream an
   assistant turn → if it emits `tool_calls`, execute each tool (emitting
   `toolStart`/`toolEnd`) and append `tool` results → loop → until a plain-text
   answer or `maxTurns` is exceeded.
6. `Agent` emits `AgentEvent`s (`streamDelta`, `reasoningDelta`, `toolCall*`,
   `usage`, `status`, `done`, `interrupted`, `error`); the provider forwards them
   to the webview and mutates the session's `displayItems`.

