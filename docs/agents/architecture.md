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

1. `extension.ts::activate` creates the sidebar `TreeView` (`spinney.sessions`)
   and the commands (`spinney.openChat`, `openSession`, `newSession`,
   `deleteSession`, `clear`, `focus`).
2. The webview (`media/main.js`) sends messages (`userMessage`, `checkout`,
   `setModel`, `setThinkingEffort`, `stop`, `clear`, `pickImage`, `setNodeSize`).
   It streams in a sandboxed iframe and loads the vendored
   `media/vendor/markdown-it/markdown-it.min.js` plus
   `media/tree.js` (pure layout), which uses the vendored pinned engine
   `non-layered-tidy-tree-layout@2.0.2` (loaded first, same CSP nonce).
3. `ChatViewProvider` owns the `Agent` instance and one **session** per
   conversation. Each session persists its own `messages` (API history) and
   `displayItems` (UI transcript) and is restored from `vscode.Memento`.
4. Window recovery: `extension.ts` registers a `WebviewPanelSerializer` for the
   `spinney.chatTree` viewType. VS Code serializes the chat tab at shutdown
   and hands it back on the next activation → `ChatViewProvider.restorePanel`
   adopts it (`ChatPanel.revive` re-sets the HTML and re-hooks the events), binds
   it to the session the webview remembered via `vscode.setState({ sessionId })`
   and repaints on the webview's `ready`. `ChatViewProvider.dispose()` therefore
   must **not** dispose the panel: closing the editor tab would kill the tab
   itself.
5. `Agent.sendUserMessage` pushes a user message and runs the loop: stream an
   assistant turn → if it emits `tool_calls`, execute each tool (emitting
   `toolStart`/`toolEnd`) and append `tool` results → loop → until a plain-text
   answer.
6. `Agent` emits `AgentEvent`s (`streamDelta`, `reasoningDelta`, `toolCall*`,
   `usage`, `status`, `done`, `interrupted`, `error`); the provider forwards them
   to the webview and mutates the session's `displayItems`.

