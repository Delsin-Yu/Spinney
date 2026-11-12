# Spinney user manual

Spinney is a VS Code extension. It puts an agent in an editor tab, and it keeps the conversation as a tree you can branch.

Version: 0.0.2.

## 1. Install and first run

1. Install **Spinney** from the Visual Studio Marketplace.
2. Open the **Spinney** container in the Activity Bar. It holds the **Sessions** view.
3. Click **New Session** in the view title bar. A tab opens with the title `Agent Chat Tree — New session`.
4. Set an API key (section 2). Then write your first message in the box at the bottom and press **Enter**.

`Shift+Enter` starts a new line. `Enter` sends.

Spinney works with a folder open and with no folder open. See section 16.

A fresh profile runs the built-in model card `deepseek-flash`. You can change it (section 6).

## 2. Set an API key

Spinney keeps the key in VS Code secret storage, never in `settings.json`.

1. Open the Command Palette with `Ctrl+Shift+P`.
2. Run **`Spinney: Set API Key`**.
3. Paste the key at the prompt and confirm.

VS Code confirms with `Spinney: API key saved.` The key is live at once. You do not reload the window.

Run **`Spinney: Clear API Key`** to erase the key.

Two special rules:

- The built-in provider also accepts the `DEEPSEEK_API_KEY` environment variable. Spinney uses that variable only when no stored key exists.
- With more than one provider, set each key on the model-cards page (section 6), in the row of that provider.

Without a key, each request fails with `No API key configured for this provider.` Spinney shows a `Set API Key` button once per window.

## 3. The chat window

The tree holds one card per turn. A new turn goes below the turn it answers. The composer is the input dock. It sits inside the card you checked out.

### 3.1 The composer

| Control | What it does |
|---|---|
| Input box | Holds your message. `Enter` sends, `Shift+Enter` adds a line. |
| **Send** | Sends the message and starts a turn. The button is disabled in four cases: the input box is empty, the context window is full (section 10.3), this window is read-only, or the checked-out node is a sub-agent branch. `Enter` sends only through this button, so it does nothing while the button is disabled. |
| **Continue with new context** | The one entry for a change of epoch (section 3.4 and section 10.3). The button shows only when Spinney can start a new epoch: the setup changed, the context window is near full, or the context window is full. The label is `Compact and Continue` while the input box is empty. A click asks one question first, and a dismissed question sends nothing. |
| **Stop** | Ends the turn at the checked-out node. It kills the background terminals and the sub-agents of that node too. Nothing continues. The tooltip is `Stop this turn` or `Stop this node: kill its background tasks and sub-agents (nothing is sent to the model)`. |
| Prompt snippets | Opens a menu of pre-written instructions. A click inserts the text into the input box. Nothing is sent. Spinney ships `Plan` and `Implement Parallel`. Add your own rows with `spinney.promptSections` (section 11). |
| **Attach image** | Opens a file picker. You can also paste an image into the input box. See section 9. |
| Model dropdown | Picks the model card for a new node. A send that continues this conversation keeps the frozen setup (section 3.4). The list groups the cards by provider. |
| Gear button | Opens the model-cards page. The tooltip is `Manage model cards…`. |
| Thinking-effort dropdown | Picks the thinking level. The list is the list of the active card. |

**Send** and **Stop** are one button with two meanings. The button shows **Stop** while the checked-out node runs a turn, or while that node still owns unfinished work. **Stop** replaces both other buttons, so **Send** and **Continue with new context** go away while it shows.

A node owns unfinished work while a background terminal or a sub-agent batch runs, or while a completion notice waits for it. You cannot send into such a node. There is no queue. Press **Stop** first, or send from another node.

Another branch or another session can run at the same time. It does not block this composer.

A sub-agent card has no composer. Its branch is read-only, and the banner says `Sub-agent branch (read-only) — driven by the main agent through spawn_agents / send_agent_message`.

### 3.2 The tree toolbar and the gestures

The toolbar holds two buttons:

- **Follow the active node** (`⦿`). The view keeps the streaming node on screen.
- **Fit the tree to view** (`⤢`).

| Gesture | Result |
|---|---|
| Wheel | Scrolls the view. |
| `Ctrl`+wheel | Zooms. |
| `Alt`+wheel | Pans up and down. It also works over a card or the input area. |
| `Shift`+wheel | Pans sideways. |
| Middle-button drag | Pans. |
| Right-button hold | Pans toward the pointer. |
| Drag the bottom-right corner of a card | Resizes that card. |
| Right-click a card header | Opens the card menu. It holds `Copy node ID`. |

A manual pan or zoom switches that button off.

Each card header carries the turn title, a status chip, and a **🗑** button. The button deletes the branch at that turn (section 4).

The body of a card has two parts, from top to bottom.

The first part holds your message. Spinney always shows this part, and it never folds it. Spinney renders this part as Markdown.

The second part is the work log. It is the only part that scrolls. The work log holds every line of the turn in the order that the turn made them. The final answer is the last block of the work log, and it is Markdown.

The steps fold. A turn can show one group of steps or more. A tool line starts a group. A text block of the model ends it. The header of a group is `Ran N steps`, or `Ran 1 step` for one call. A group holds the reasoning lines, the tool lines, the notices, the background-job notices and the `HARNESS` blocks. The text that the model writes on the way stays in the work log, between the groups. A group is open while the turn runs. Each group folds when the turn ends. Click the header to open that group, or to close it. A group that you opened or closed stays as you left it. The work log carries a green dot. The dot shows the follow mode. When the dot is green, Spinney follows the newest content. You can scroll while the dot is green. When you scroll up, the dot goes dim and Spinney stops following. When you scroll back to the end, the dot becomes green again. To follow again at once, click the dim dot. Click the green dot to stop the follow mode. A live turn starts with the dot green. A finished turn starts with the dot dim.

Two kinds of line carry the work of the turn.

A reasoning line holds the thinking of the model. While the turn runs, the line shows the whole paragraph. The paragraph uses the same text style as the rest of the card. It is not dim, and it is not italic. The paragraph has a maximum height. Scroll inside the paragraph to read the rest. The open paragraph has its own green dot at the bottom right. The dot shows the follow mode of the paragraph. When you scroll the paragraph up, its dot goes dim. The next text does not move the paragraph back. Click the dim dot to follow the newest text again. A click on that dot does not open or close the line. When the turn ends, the line becomes one line. Click the line to open it. The open line shows the whole text and the token line. Click it again to close it. A line that you clicked stays as you left it.

A tool line holds one tool call: a verb, a label, and a time. A bold verb starts the line, for example `Read`, `Wrote`, `Ran` or `Searched`. The label is the short name that the agent gave to the step. When the agent gave no name, the label is the path, the command, or the pattern. The verb and the label use the dim text colour. The label of a command or a pattern uses a monospace font and a smaller size. The time is the duration of the call. It moves while the call runs, and it stops when the call ends. Click the line to open the call. The first line starts with `> ` and shows the command or the arguments. The result follows in a code block. The arguments and the result use a smaller, dimmer font. The error text follows when the call returned an error. The token line comes last. Click the line again to close it.

The card does not grow with each step. It scrolls inside the work log. Drag the bottom-right corner of the card to make the work log taller.

A card can be up to 840 pixels high.

A sub-agent card or a background job card is a compact monitor. It is 200 pixels high. It shows the live progress of that sub-agent: the status, the counters and the tail of the work log. It does not show the whole transcript. Spinney opens the sub-agent card that you are reading at its full height, and that card shows everything. The other cards stay compact. Spinney puts three of the cards beside one node into one column, and starts a new column to the right when the column is full. The cards of the sub-agents that those sub-agents spawned stand in their own columns to the right. The conversation below a node is therefore not pushed far down by the sub-agents it spawned. A sub-agent card shows the colour of the family it belongs to. The cards that this sub-agent spawned use the same colour, with more saturation and less lightness. A sub-agent card uses a warm colour. A background job card uses a cold colour.

Press `Ctrl+Alt+D` to write a layout diagnostic to the output channel.

### 3.3 The status row

The row under the input box shows the state of the session.

| Item | Meaning |
|---|---|
| Status dot | Dim when the session is idle. Amber and pulsing while anything streams. |
| Status line | `Ready`, `Thinking…`, `Uploading images…`, `Stopping…`, `Interrupted`, `Error`, or a retry message (section 10). |
| `ctx N%` | The context window usage. It divides the prompt tokens of the **previous** request by the `contextWindow` of the card. It is a readout, not a limit. It can be wrong. |
| `bal …` | The wallet of the answering provider. `bal –` means that no number exists, for example on a provider with the `none` balance dialect. Spinney reads the wallet once and never retries. |
| `tok/s` | The output speed. It is a local estimate, not the count of the provider. |

Each step carries its own token line: `[Prompt: 1200 + Completion: 340, Cache Hit: 1000, Cache Miss: 200]`. It shows the prompt tokens, the completion tokens, the cache hits and the cache misses of that request.

A `HARNESS` block holds the exact text that the harness sent to the model. The `HARNESS` blocks sit in the work log with the other steps.

Codes that stay in English on purpose: `SUB`, `BG`, `CTX`, `HARNESS`, `Delivered`.

### 3.4 The frozen setup and the trees

A conversation is frozen on the setup it started with. The setup holds the model card, the thinking level, the reply language, and the shipped system prompt. A plain send always uses the frozen setup.

A pick of another model card, thinking level, or reply language makes the live setup differ from the frozen one. The composer then shows both setups, one line each:

- `Sending with: {0}`. The setup that a send uses.
- `New setup: {0}`. The setup that a new node freezes.

The value holds the card, the thinking level, and the reply language. Example: `Sending with: deepseek-flash · medium · English`.

Spinney does not ask this question on a plain send. A plain send always uses the frozen setup. The two identity lines say so, and the frozen setup keeps the prompt cache of the provider.

The composer holds one button for every change of epoch: **Continue with new context**. It shows in three cases:

- A change of the model dropdown, the thinking-effort dropdown, or `spinney.replyLanguage` (section 11).
- A change on the harness side: the shipped system prompt, the global or workspace `AGENTS.md`, the tool set, or the endpoint.
- A context window that is near full or full (section 10.3).

A click on **Continue with new context** asks one question. The question depends on the case:

- Setup change only: `Continue with the new workspace or model configuration?` The text names the size of the history in tokens. The answer is **Continue**. Spinney copies this tree into a new tree, and the new tree starts with the latest setup. The old tree keeps its own setup and its prompt cache.
- Near-full or full context window: `Continue in a new context window?` The answers are **Write a handoff summary** and **Just continue** (section 10.3).

Press `Escape`, or click the close button, to dismiss the question. A dismissed question sends nothing, kills nothing, and Spinney keeps your text in the input box. Spinney checks the state again before it acts, so a change during the question sends nothing and shows a message.


A session can hold several trees. Spinney places the new tree beside the current one. The view shows the trees side by side, moves to the new tree, and each tree stays interactive. Check out a node of the tree that you want to continue, then send.

### 3.5 Reload the chat webview

A chat tab can show an old picture of the conversation. For example, a card stops changing, or only one part of the tree shows. The conversation is correct, and a running turn continues.

Run **`Spinney: Reload Chat Webview`** to build the tab again from the state of the session. Use the command when the tab shows a frozen picture, or when a card does not change.

The command does not change the conversation. It does not stop a running turn. With no chat tab open, Spinney answers `Spinney: no chat tab is open for this window.`

## 4. Branches

### 4.1 Branch from a turn

1. Click the header of the turn you want to branch from. The card expands, and the composer moves into it.
2. Write the new message. When the turn already has a child, the banner shows `⤷ branching from {0} — your reply starts a new branch`.
3. Press **Enter** or click **Send**.

The new turn becomes a sibling branch. Spinney deletes nothing. The old line stays in the tree as dimmed one-line cards. One click brings it back.

A checkout is free. You can check out another turn while a turn streams. The checkout moves the view, not the running turn.

### 4.2 Delete a branch

1. Hover the header of the turn that starts the branch.
2. Click **🗑**. The tooltip is `Delete this branch — this turn and everything below it`.
3. Read the confirmation. It names the turn count, the transcript dumps that go away, and the background terminals that Spinney kills. Click **Delete Branch**.

The palette command `Spinney: Delete Branch at Checked-out Turn` does the same for the checked-out turn.

Spinney refuses the delete in two cases:

- A turn runs in the session: `Cannot delete a branch while the agent is running. Wait for the turn to finish.`
- A sub-agent runs inside the branch: `Cannot delete a branch that contains a running sub-agent. Kill it first.`

After the delete, the checkout moves to the parent of the branch. Deletion is permanent. Transcript dumps leave the disk too, so `search_transcripts` no longer finds them.

### 4.3 Stop

**Stop** is one action with one meaning: a stop of everything the node owns.

| What runs | What Stop does |
|---|---|
| The turn of the node | Aborts it. The partial output stays in the card. |
| Its sub-agents | Kills the batch and its depth-2 children. |
| Its background terminals | Kills the process trees. |
| A queued completion notice | Writes the notice into the history of the node instead. The model sees it with your next prompt or with **▶ Continue**. |

Stop touches one node. Other branches and other sessions keep running.

## 5. Sessions and tabs

The **Sessions** view lists every session, newest change first. Each row shows the title, a state icon, and a line `{0} node(s) · <time>`. A session that runs a turn or a background job shows a spinner.

One session owns exactly one tab. Opening a session focuses its tab. It never opens a second one.

| Action | How |
|---|---|
| New session | Click **New Session** in the view title bar. |
| Open a session | Click its row in the list. |
| Rename | Right-click the row, then `Spinney: Rename Session…`. A manual rename locks the title. |
| Auto-rename | Right-click the row, then `Spinney: Auto-rename Session`. This drops the lock and generates the title again now. |
| Copy the session id | Right-click the row, then `Spinney: Copy Session ID`. |
| Delete one session | Hover the row, then click **🗑**. |
| Delete many sessions | `Ctrl`-click or `Shift`-click the rows, then click **🗑** on any selected row. Spinney deletes the whole selection behind one confirmation. |
| Clear a conversation | Run `Spinney: Clear Conversation`. |

With `spinney.autoSessionTitles` on, Spinney names a session from its conversation after the first turn, and again as the conversation grows. The wait between two names is at least two minutes. A rename stops the automatic naming.

A session keeps its history in the session data folder of the extension, as plain files: one folder per session, one file per node.

| Action | What happens |
|---|---|
| Export the data | `Spinney: Export Session Data` copies the folder where you say. The deleted sessions and the internal locks stay behind. |
| Import data | `Spinney: Import Session Data` adopts the sessions of another folder into this window. A session already here is not replaced. |
| Keep the data on a synced drive | Set `spinney.dataDir` to that folder. It applies on the next window reload. |

| Event | What happens |
|---|---|
| Window reload, or a restart of VS Code | The sessions and the open tabs come back. |
| Close a tab | The session stays. Only the tab goes away. A running turn continues. |
| A second window opens the same folder | One window owns the sessions of a folder. The other window shows the same sessions, and you can browse and read them there. It refuses every change: send, continue, new session, delete, rename, and clear. The message is `Another window owns this workspace’s sessions, so this window is read-only. Close that window (or use it) to continue here.` |
| Delete a session | Spinney removes the history, deletes the transcript dumps, and kills the background terminals. It refuses while a turn runs. |
| Delete the last session | Spinney creates a fresh empty one. |
| Move to another computer | `Spinney: Export Session Data`, then `Spinney: Import Session Data` on the other one. |

## 6. Models and providers

A **model card** is one selectable model. A **provider** is one endpoint. A card always names one provider.

Open the model-cards page with **`Spinney: Open Model Cards`**, or with the gear button beside the model dropdown of the chat. The page draws the providers as roots and their cards as branches. Select a node to open its form.

The page holds your edits as a draft. It shows `* ` in the tab title and `You have unsaved changes.` in the status strip. **Save** writes everything at once. **Revert** drops the draft.

Spinney checks the draft in the page and again in the host. A refused save writes nothing.

The page saves at the **Global** scope of `settings.json`, so the cards belong to your VS Code profile. Every other `spinney.*` key is window-scoped.

### 6.1 Provider fields

| Field | Meaning |
|---|---|
| id | The key in `spinney.providers`. It never changes. A row with the id `default` replaces the built-in provider. |
| `name` | The display name. Spinney shows it in the model dropdown groups, in the wallet line, and in the API key prompt. |
| `baseUrl` | The API root, for example `https://api.deepseek.com`. A request goes to `POST <baseUrl>/chat/completions`. |
| `balance` | How Spinney reads the remaining credit. See the table below. |
| `sessionHeader` | How Spinney tells the endpoint which conversation a request belongs to. `none` sends no such header. `opencode` sends `x-opencode-session`. |
| `concurrency` | How many requests can be in flight against this endpoint. `0` means no limit. |

| `balance` value | Request | Result |
|---|---|---|
| `none` | No request. | No wallet figure. This is the default for a new row. |
| `deepseek` | `GET /user/balance` | The total, the granted part, and the topped-up part. |
| `openrouter` | `GET /credits` | The remaining credit, in USD. |
| `moonshot` | `GET /users/me/balance` | The available balance, in CNY. |

A row that leaves `balance` out is read by its host: `api.deepseek.com` gives `deepseek`, anything else gives `none`.

`sessionHeader` has two values. `none` sends no header. `opencode` sends `x-opencode-session: ses_…`, which the OpenCode Console gateway requires. A row that leaves `sessionHeader` out is read by its host too: `opencode.ai` gives `opencode`, anything else gives `none`. Spinney sends one value for each context window. A new window or a fork starts a new value. A sub-agent sends its own value.

### 6.2 Model card fields

| Field | Meaning |
|---|---|
| id | A generated id. It never changes, so a rename is safe. Sessions and transcripts store the id. |
| `name` | The label in the model dropdown. Two cards cannot share a name. |
| `providerId` | The provider this card talks to. |
| `oaiModel` | The wire model name that goes into the request. A new card is not valid before you set it. |
| `contextWindow` | The token budget of the card. The `ctx` readout divides by it. It is not the output cap of the API. |
| `concurrency` | How many requests this card can have in flight. `0` means no limit. A card never exceeds the limit of its provider. |
| `vision.enabled` | Whether the card accepts images. |
| `vision.transport` | `deepseek` uploads an image to `POST /files` and references the returned id. `openai` puts a `data:` URL in the request body. |
| `searchProvider` | Which engine leads web search. `builtin` uses the built-in backends. `deepseek` uses the search API of the provider of this card. The built-in card `deepseek-flash` uses `deepseek` when the field is absent, also after you change its other fields. A card you create uses `builtin`. See section 19.1. |
| `efforts` | The thinking levels of this card, in dropdown order. The names are free. |
| `defaultEffort` | The level a new session starts on. It must be one of the `efforts` of this card. |

Spinney probes nothing. The context window, the image support, the transport, and the search engine are your declarations. A wrong `contextWindow` mis-sizes the `ctx` readout.

Built-in rows cannot be deleted. You can edit them. The page always shows the built-in provider and the built-in `deepseek-flash` card. A fresh profile has no rows in `settings.json`. The page shows both rows, and the first save writes them into `settings.json`.

### 6.3 Choose a model

The model and the effort belong to the node, not to the tab:

1. A turn stores the card and the level it ran with.
2. A follow-up uses the card and the level of the nearest ancestor.
3. A new session starts on `spinney.model`, or on the built-in `deepseek-flash` card.

A pick in a dropdown sets the live setup. A new node freezes the live setup. A send that continues a frozen conversation keeps the frozen setup (section 3.4). A checkout drops the pick, and the dropdowns follow the checked-out node.

A model, effort, or reply-language change never rewrites the setup of a frozen conversation. The new value applies to the next new node.

The two dropdowns are disabled while any turn runs in the session.

## 7. Thinking effort

The thinking-effort dropdown holds the levels of the active card. Each card owns its list. A switch of the card switches the list with it.

The level `none` is special. It sends no `reasoning_effort` at all, and the system prompt loses the effort sentence.

Spinney never sends a level that the card does not declare. A level that the card does not offer falls back to the `defaultEffort` of that card, without a message.

## 8. Sub-agents and background terminals

### 8.1 Sub-agents

The agent starts a sub-agent with the `spawn_agents` tool. Each sub-agent runs its own conversation in parallel. Its card sits beside the parent card, with a `SUB` badge.

| Fact | Detail |
|---|---|
| Depth | Two levels. A sub-agent cannot start a deeper one. |
| Count | `spinney.maxConcurrentSubagents` level-1 sub-agents at a time (default 15). Extra tasks wait in a queue. |
| Second level | Each sub-agent starts at most `spinney.maxLevel2Subagents` children (default 2). |
| Mode | A writable sub-agent can change files and run commands. A read-only sub-agent can only read. |
| Card | The badge line shows the depth, the model, and `write` or `ro`. The **✕** button kills it. The card also shows how long the run takes. The number ticks while the sub-agent runs, and it stays on the card after the run ends. |
| Result | When the sub-agent finishes, Spinney delivers a notice to the parent. The notice carries the duration of the run. The card shows `Delivered`. |
| Report | Spinney delivers the notice at the next tool boundary of the parent turn. While the parent is idle, Spinney injects the notice into the parent node. It never makes a new node. |

A sub-agent batch waits at most `spinney.subAgentSyncSeconds` (300 seconds by default) as well. When the batch still runs at that time, `spawn_agents` in `sync` mode (the default) and `send_agent_message` return the agent ids. Every summary then arrives later as one batch notice.

You cannot type into a sub-agent card. To continue a finished sub-agent, ask the parent agent to do it.

On **Stop**, Spinney kills the whole sub-agent subtree of that node. It writes the pending notices into the history of the node. A stopped sub-agent never resumes on its own.

After a restart, a sub-agent that was running shows as `killed`.

### 8.2 Background terminals

A background terminal holds a long command while the turn continues. The agent starts one through `exec_command` with `run_type`.

A command that still runs after `spinney.execForegroundSeconds` (30 seconds by default) moves to the background by itself. Nothing is lost and nothing is killed. The result of the tool gives the id of the job, and the agent can continue its work or end the turn.

`run_type` gives the call its identity. It has three values:

| Value | What Spinney starts | What it costs |
|---|---|---|
| `foreground` | Nothing at first. The command runs in the turn. After `spinney.execForegroundSeconds`, Spinney moves it to the background. This value is the default. | Nothing, while the command ends in time. After the move, the same as the row below. |
| `background` | A job on that node, at once. | The node cannot send a message until the job ends. Spinney sends a completion notice at the end. |
| `detached` | A detached job, at once. The job locks no node. | The node stays free. The job never sends a notice, so the agent learns its result only when it asks. Any node in the session can read the job or kill it. |

No job has a deadline. A job runs until the command ends, or until Spinney or you kill it. There is no `timeout` argument and no `timeout_behavior` argument. A call that still gives one of them gets an error, and nothing starts.

The agent reads a job with `check_command`. The answer gives the status and the output so far. A status check does not wait, so the agent must not check a running job many times. The agent waits with `wait_for_command`: the tool waits at most the number of seconds it gives, and it returns as soon as the job ends. When the wait ends first, the agent can wait again. The agent ends a job with `kill_command`. A sub-agent that can run a command also has these three tools.

When the agent starts a job or moves it to the background, Spinney tells the agent that it can continue its work or end the turn: the completion notice arrives when the job ends.

The agent does not start a process in the background itself, for example with `&` or `Start-Process`. Spinney cannot track such a process, and you cannot stop it from a card.

The card shows `#<id>`, the status, the elapsed time, the command, and the last output lines. The elapsed time ticks while the command runs, and it stays on the card after the command ends. The result of the command also tells the agent how long the command took. A detached job shows the `shared` badge: the badge means that the job is fire-and-forget, so the card never waits for the agent.

| Status | Meaning |
|---|---|
| `running` | The command runs. The **kill** button is live. |
| `pending delivery` | The command finished. The notice waits for the agent. |
| `exit {0}` | The exit code of the command. |
| `killed` | Spinney or you killed the process tree. |
| `finished` | The end of the record. |

A detached job never shows `pending delivery`, because it sends no notice.

A background job belongs to the node that started it. It does not lock another branch or another session. The `#id` is a session counter, not an operating-system pid.

When the job ends, Spinney delivers a notice the same way it delivers a sub-agent notice. After that the card stays as a record with a `Delivered` badge.

Spinney kills a running job in these cases:

- You press **Stop** on the owning node.
- You delete the branch or the session, or you clear the conversation. A modal asks first.
- You close the window.

After a restart, a job that was running shows as `interrupted`. A card never claims to be live when it is not.

A sub-agent can start and manage a background terminal of its own. A read-only sub-agent cannot run a command at all.

### 8.3 Session handoff

The agent can give a self-contained task to a new session. The tool is `hop_session`. The new session runs the task, and Spinney can bring the answer back to this conversation.

| Fact | Detail |
|---|---|
| Start | The hop waits for the current turn to end. Then Spinney creates a new session and sends the task there. The new session cannot see this conversation, so the task must be complete. |
| Answer | Spinney sends the final reply of the new session back to the node that started the hop, as a new branch. A `returnNodeId` names another node. Spinney sends the answer when the new session has no work left. If the new session still runs a background command, Spinney waits for that command. |
| Quiet delivery | The answer does not open or focus the tab of this session. It does not move the checked-out node. It does not clear the input box. It does not ask the frozen-setup question. |
| Busy node | If the node that must receive the answer is busy, Spinney holds the answer and delivers it when the node is free again. |
| No answer | The `mode` argument selects the behaviour. The default mode is `return_when_finished`. With `mode: "fire_and_forget"` no answer comes back, and Spinney writes nothing into this conversation. |
| One per session | A session has one hop in flight at a time. A hop in another session does not block it. |
| Limit | A hop is refused while the session has a running background terminal. |
| Settings | `spinney.hopSession.enabled` turns the tool on and off. The default is on. `list_nodes` and `rename_session` stay available when it is off. |
| Reload | The hop list lives in memory. A window reload drops a hop that is in flight. The new session keeps its history. |

### 8.4 The terminal dock

The terminal dock shows every background terminal of the window. It is at the top right of each chat tab. You can see and control a job from any tab, whatever session owns it.

The header shows the count of running jobs, for example `Terminals · 1 running`. Click the header to fold or unfold the list. With no job, the dock is not shown. Each row shows the session title, the job number, the status, the elapsed time, the command, and the last output lines. A row shows the same facts as the card of that job.

| Row or button | Action |
|---|---|
| A running job | The **kill** button ends the process tree of the job. |
| A finished job | The **✕** button removes the row from the dock. |
| **Clear finished** | Removes all finished jobs from the dock. |

The **✕** button and **Clear finished** do not delete the job card. The card stays beside its node, with its status and its `Delivered` badge. To delete the card, use the delete button of the card, or delete the branch.

Spinney saves the removal in the session. A removed row stays away after a reload.

You cannot remove a running job from the dock. Terminate it first, and then remove it.

## 9. Images

Attach an image with the **Attach image** button, or paste one into the input box. Pending attachments show as small pictures with an **×** button.

Only a card with `vision.enabled` accepts an image. Spinney ships `deepseek-flash` with image support on.

| Situation | What happens |
|---|---|
| The card has no image support | The attachment is refused: `Switch to an image-capable model ({0}) to attach an image.` |
| No card has image support | `No image-capable model is configured — add vision to a model card to attach an image.` |
| You switch to a card without image support | Spinney hides the images in the history. It keeps the data and restores it when an image-capable card comes back. |
| The transport is `deepseek` | Spinney uploads the image first. The status line then reads `Uploading images…`. **Stop** aborts that send. |
| The upload fails | `Could not upload: {0}. Those images were omitted.` |

An image can be up to 64 MiB. The formats are JPEG, PNG, GIF, and WebP. Spinney reads the format from the content, not from the file name.

An image of 4000 px costs the same as a small one. The agent reads an image with the `read_image` tool. Spinney crops the image and makes it smaller before the upload, so the model sees a longest side of 1024 px. The argument `rect` keeps one region at full detail. If the request already carries too many image bytes, the tool refuses the image. The tool then tells the agent to let a sub-agent look at the image.

An uploaded image cannot move to another provider. The `file_id` is private to the provider that made it. The card shows `[image hidden: it was uploaded to a provider that this model cannot read from]`. An `openai` transport has no such problem.

## 10. Errors, retries, and Continue

### 10.1 Automatic retries

Spinney retries a request up to 10 times. The waits are 1 s, 2 s, 4 s, and so on, capped at 30 s.

The status line shows `Model call failed ({0}/{1}); retrying in {2}…`. The first number is the attempt that failed.

Spinney retries these failures:

- A network error.
- HTTP `408`, `429`, or any `5xx`.
- A `200` answer with an empty body.

Spinney does not retry these failures:

- HTTP `400`, `401`, `403`, `404`, or `422`. These cannot fix themselves.
- A break in the middle of a stream. This retry would repeat output. Spinney sends the whole request again instead (see below).
- An image upload.
- A wallet read.

**Stop** during a wait ends the retry at once.

A stalled request is bounded. Spinney waits 20 s for the first byte, 20 s for the first chunk, and 60 s between chunks. A stalled request shows `Thinking…` with `tok/s` at 0.

Those ten attempts belong to one request. A failure that survives them does not end the turn. Spinney sends the same whole request again by itself, up to 3 more times, inside about 6 minutes for the whole turn.

The agent learns nothing about those attempts. Spinney sends the conversation exactly as it stands. When the answer had already started, Spinney keeps the half-written answer as a message of the model, and sends the request again after it. No text arrives twice.

A network error, a stalled stream, an HTTP `408`, an HTTP `429`, and a `5xx` get the new request. A refusal ends the turn at once.

The card shows one marker line while Spinney sends the request again, for example `⟳ Silent retry 1/3`. Spinney rewrites that line as the attempts advance, so the work log holds one line, not one line for each attempt. The agent never reads that line.

The status line reports the failed attempts and the waits, as it did before.

When every attempt fails, the turn still ends in an error, and the card keeps its button (section 10.2).

### 10.2 The card buttons

A card can carry one of two buttons. The button depends on the state of the node.

| Node state | Button | What it does |
|---|---|---|
| `interrupted` | **▶ Continue** | Resumes the turn in the same card. The partial output stays. The agent is told nothing. When **Stop** stopped a tool call in the middle, the agent gets one short note that names that call, and the card shows the note. |
| `error` | **↻ Retry** | Resumes the turn in the same card, from where it stopped. The finished rounds of the turn stay, so the agent does not repeat that work. The agent is told nothing. |

A card never holds a button for a new context window. The composer holds that entry, for every change of epoch (section 3.4 and section 10.3).

A button carries the work. You do not type the instruction yourself. A **Stop** followed by a new message behaves as before: your message starts a normal turn (section 4.3).

### 10.3 A full context window

A context window is full when the provider answers with a context-length error. A request also carries its images as uploaded bytes, and the provider caps these bytes at 200 MB for one request. A refusal for that reason is also a full window. For example, the message reads `Total image size exceeds the limit: max 200 MB per request, got 203 MB`. Spinney does not guess a limit from the `ctx` readout. The card shows a **⚠️** message. The composer shows **Continue with new context**, and **Send** is disabled.

Spinney offers this button before a failure too. The button shows from about 90% of the `contextWindow` of the card. Nothing failed there, so the click is your own decision. A plain send at that point is still a normal send.

1. Click **Continue with new context**. The composer sends your message into the new window. If the node still owns running work, a modal asks first. It names the work that will stop.
2. Answer the question `Continue in a new context window?`:
   - `Write a handoff summary`. Spinney sends one extra request to the same model card. The request reads only the messages of the previous window, up to 60000 characters. The new agent receives the summary first. The summary holds the requests, the files and the code sections, the errors, the pending tasks, and the current work. It also holds the record path, the key file paths, and the stopped jobs. Every code section is marked `re-read before editing`, because your workspace can change. The summary is English, whatever the display language. The composer shows `Preparing the handoff summary…` during the request. If the request fails, or the answer has no required headings, Spinney continues like `Just continue`. The harness message then says that the summary is not available. The rollover does not fail.
   - `Just continue`. Spinney points the new agent at the previous branch. The agent reads the transcript on disk when it needs a detail.
3. Spinney opens a new card below that node. The edge is dashed, the title is `Context window {0}`, and the badge is `CTX`.

The new window starts with the system prompt, one harness message, and your message. The harness message names the transcript file of the previous window, the work that stopped, and the size of the previous window. With `Just continue`, it also holds your last request and the last answer, in a shortened form. With `Write a handoff summary`, it starts with the summary, and your last request in your own words follows it. Attachments cannot cross, so the message names them instead.

The old branch stays usable. You can send into it again, or press **▶ Continue** there, until it overflows again.

The `CTX` tooltip is `This node starts a new context window; the branch above it is not sent to the model any more`.

Two details that are not faults:

- The pinned user message of the new card is your message.
- The harness text is English, whatever the display language.

## 11. Settings reference

All keys start with `spinney.`. Open the Settings UI, or edit `settings.json`.

| Key | Default | Meaning |
|---|---|---|
| `spinney.model` | `deepseek-flash` | The card id a new session starts on. It is an id, not a model name. |
| `spinney.providers` | `{}` | The endpoint rows. Edit them on the model-cards page. |
| `spinney.modelCards` | `{}` | The model rows. Edit them on the model-cards page. |
| `spinney.replyLanguage` | `auto` | The language of the answers of the agent. `auto` follows the VS Code display language. The new value applies to the next new node; a frozen conversation keeps its own language. |
| `spinney.promptSections` | `{}` | Extra prompt snippets, keyed by the name in the menu. A name that matches a shipped snippet replaces its text. |
| `spinney.execForegroundSeconds` | `30` | The time a command runs in the turn, in seconds, before Spinney moves it to the background. 30 seconds is the default. The minimum is 10. The command is not killed: it continues as a background job, and the agent receives its id. |
| `spinney.subAgentSyncSeconds` | `300` | The time a `spawn_agents` or `send_agent_message` call in `sync` mode can hold the turn, in seconds. 300 is 5 minutes. The minimum is 30 and the maximum is 1800. A batch that still runs at the end of this time returns the agent ids, and every summary arrives later as one batch notice. |
| `spinney.maxInlineToolOutput` | `32768` | The size limit of a tool result, in bytes. A larger result goes to a file. The answer shows a preview of not more than 2048 characters. `0` turns the limit off. |
| `spinney.searchTimeoutSeconds` | `10` | The time limit of one search, in seconds. It applies to `search_files` and `search_transcripts`. The minimum is 1 second and the maximum is 600 seconds. The limit covers the whole call. A search that reaches the limit returns an error and no results. Then make the search smaller: use a narrower path, a tighter pattern, a glob, or less context. |
| `spinney.hopSession.enabled` | `true` | Let the agent send a self-contained task to a new session with `hop_session`. A conversation that is already frozen keeps the tool, and Spinney refuses the call. |
| `spinney.maxConcurrentSubagents` | `15` | How many level-1 sub-agents can run at once. Extra tasks wait. |
| `spinney.maxLevel2Subagents` | `2` | How many children one sub-agent can start. |
| `spinney.autoSessionTitles` | `true` | Name sessions from their conversation. |
| `spinney.saveSessionTranscripts` | `true` | Write each finished turn to disk as JSONL. |
| `spinney.saveSubAgentTranscripts` | `true` | Write each finished sub-agent conversation to disk as JSONL. |
| `spinney.subAgentTranscriptDir` | `""` | The folder for the transcript files, relative to the agent root. Empty means the extension storage. |
| `spinney.dataDir` | `""` | The folder that keeps the sessions. Empty means a fixed folder in the extension storage, which is not named after the extension id — renaming or reinstalling never moves your history. Set it to a folder you back up to keep the history outside this machine profile. Applied on the next window reload. |
| `spinney.diagnostics.log` | `true` | Write a diagnostics log for this window. It holds timings, counters and paths — never your conversation. Every line ends with a timestamp. A command also writes one line when it starts, a heartbeat line every 30 seconds, and one line when it ends. One file per window, oldest removed, rotating at 2 MiB. |
| `spinney.httpApi.enabled` | `false` | Turn on the local HTTP control plane. See section 14. |
| `spinney.httpApi.port` | `0` | The port of that control plane. `0` lets the system pick one. |

A change applies at once, with one exception: the `AGENTS.md` files need a window reload (section 13).

## 12. Commands reference

Every command lives in the Command Palette under `Spinney: `.

| Command | What it does |
|---|---|
| `Spinney: New Session` | Opens a new session. |
| `Spinney: Open Session` | Focuses the tab of a session. |
| `Spinney: Rename Session…` | Renames a session and locks its title. |
| `Spinney: Auto-rename Session` | Drops the title lock and names the session again. |
| `Spinney: Copy Session ID` | Copies a session id to the clipboard. |
| `Spinney: Delete Session` | Deletes the current session. |
| `Spinney: Export Session Data` | Copies your session data folder to a folder you choose. |
| `Spinney: Import Session Data` | Adopts the sessions of a folder you choose into this window. |
| `Spinney: Open Diagnostics Log` | Shows the diagnostics log of this window, and offers to reveal it. |
| `Spinney: Delete Branch at Checked-out Turn` | Deletes the branch at the checked-out turn. |
| `Spinney: Clear Conversation` | Empties the conversation of the current session. |
| `Spinney: Open Model Cards` | Opens the model-cards page. |
| `Spinney: Set API Key` | Stores an API key for a provider. |
| `Spinney: Clear API Key` | Erases a stored API key. |
| `Spinney: Show System Prompt` | Opens the exact prompt that the model receives. |
| `Spinney: Open Global AGENTS.md` | Opens the instruction file for all workspaces, and creates it when it does not exist. |
| `Spinney: Show User Manual` | Opens this manual in an editor tab. |
| `Spinney: Reload Chat Webview` | Builds the chat tab again from the state of the session. |
| `Spinney: Test Web Search Backends` | Sends one test query to every search backend, and opens a table of the results. |

Spinney adds no default keyboard shortcut.

## 13. Instructions for the agent

Spinney adds two instruction files to the system prompt.

| File | Applies to |
|---|---|
| `~/.spinney/AGENTS.md` | Every workspace on this machine. |
| `AGENTS.md` in the workspace root | The open workspace. |

The global file holds the rules that you want everywhere. The workspace file holds the rules of the project, such as the test command or the code style. Spinney puts the global instructions first and the workspace instructions second. When the two conflict, the workspace file wins.

Four facts to know:

- Spinney reads each file once, when the extension host starts. An edit does not reach a running window. Reload the window after you change a file.
- Run **`Spinney: Open Global AGENTS.md`** to edit the global file. The command creates the file when it does not exist.
- The global file applies to every workspace, and to a window with no folder open.
- With no folder open, Spinney reads no workspace file, because there is no workspace root.

Run **`Spinney: Show System Prompt`** to read the exact prompt that the model receives. The content follows the current model card, the thinking effort, the reply language, and the two instruction snapshots of the session.

## 14. Privacy and data

Spinney sends no telemetry. It connects only to the provider endpoints that you configure.

A request carries your messages, the tool results, and the images. It also carries the name and the version of Spinney, as its user agent, so that the provider can identify the client. A provider whose row sets `sessionHeader` also receives the identifier of the context window. The wallet read adds one request to the provider. An image goes to the provider as an upload or inside the request body, based on the transport of the card. A card that selects `deepseek` for web search also sends the search query to the provider of that card, and it sends the address of a page there only when that page has no readable text (section 19.1).

The extension keeps no copy of the uploaded image bytes.

| What | Where |
|---|---|
| Conversations | Files, in the session data folder of the extension: one folder for each session and one file for each node. `spinney.dataDir` moves that folder. An older build's state database is a migration source only. |
| Transcripts | JSONL files, one per finished turn and one per sub-agent. Folder: the extension storage, or `spinney.subAgentTranscriptDir`. |
| A large tool result | `<agent root>/.spinney/tool-output/`. |
| API keys | VS Code secret storage, encrypted by the operating system. Never in `settings.json`. |
| Settings | `settings.json`. The model-cards page writes at the Global scope. |

Spinney writes nothing into your `.gitignore`. Add the `.spinney/` folder yourself if you do not want the spilled tool output in a commit.

The conversations stay on disk after an uninstall. They are in the data folder of the extension. Section 15 removes them.

### 14.1 The HTTP control plane

The control plane is off by default. It listens on `127.0.0.1` and it needs a bearer token.

It exists for an external controller. `POST /continue` makes the agent run an instruction that comes from the caller. Treat the port as a trust boundary of your machine. Turn it on only if you need it.

With the plane on, Spinney writes the port and the token to `<extension storage>/http/<instanceId>.json`.

## 15. Uninstall and clear data

1. Run **`Spinney: Clear API Key`** for each provider, or accept that the secrets stay.
2. Uninstall Spinney from the Extensions view.
3. Delete the folder `<extension storage>/de-yu.spinney` by hand. It holds the conversations, the transcripts, the backups, the diagnostics logs, and the control-plane file.
4. Delete the rows of an older build, if you ever ran one. That build kept the conversations in the state database. The key is `DE-YU.spinney`: one row in `globalStorage/state.vscdb`, and one in each `<workspaceStorage>/<hash>/state.vscdb`. The current build keeps the conversations in files, so step 3 removes them.

Note the two spellings: the folder name is lower case, and the row key keeps the case of the extension id.

Files that you directed to your own folders are outside these steps. Check `spinney.dataDir`, `spinney.subAgentTranscriptDir`, and any `.spinney/` folder.

## 16. No-folder mode

Spinney works in a window with no folder open.

- Relative paths in a tool call resolve against a scratch folder in the extension storage, `<extension storage>/no-workspace`. The agent reaches your real files by absolute path.
- The sessions live in the profile instead of the workspace. Every no-folder window of the profile shows the same sessions. Use one window at a time.
- Spinney reads the global `AGENTS.md` and no workspace `AGENTS.md`, because there is no workspace root.
- A spilled tool result goes to `<scratch folder>/.spinney/tool-output/`.

Open a folder in the same window, or close one, and Spinney switches the mode at once.

## 17. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No API key configured for this provider.` | Set the key with `Spinney: Set API Key`, or on the model-cards page for a named provider. |
| A request fails at once, with no retry | A `400`, `401`, `403`, `404`, or `422`. Read the message. The usual causes are a wrong key and a wrong model name. |
| The status line repeats `retrying` | A network fault, a `429`, or a `5xx`. The status line cannot tell a dead socket from a provider error. Press **Stop** to end the wait. Spinney sends the whole request again by itself, up to 3 times, before the turn ends (section 10.1). |
| `Thinking…` and `tok/s` at 0 for a long time | The stream stalled. The watchdogs end it after 20 s to 60 s. |
| `ctx N%` looks wrong | It divides the prompt tokens of the **previous** request by the `contextWindow` of the card. Check the value of the card. |
| No wallet figure | The `balance` value of the provider is `none`, or the read failed. Spinney reads the wallet once and never retries. |
| The agent ignores a new rule in `AGENTS.md` | Reload the window. Spinney reads the file once per activation. |
| An image does not attach | The active card has no image support. Add `vision` to the card, or switch to an image-capable card. |
| A turn waits before it starts | A concurrency gate. The status line names the wait. Raise `concurrency` on the provider or on the card, or wait. |
| The model dropdown is grey | A turn runs in this session. Stop it or wait for it. |
| The view stops at an old card | A manual pan or zoom switched the follow mode off. Click **Follow the active node**. |
| Spinney is absent from the Activity Bar | The window is in Restricted Mode. Spinney does not support an untrusted workspace, so VS Code keeps it disabled. Trust the folder, then reload the window. |

The **Spinney** output channel holds the diagnostics. Open it with View → Output, then select `Spinney` in the list. It names the display language, the model configuration problems, and the layout and performance lines.

Run **`Spinney: Show System Prompt`** to see the exact prompt, and **`Spinney: Show User Manual`** to reopen this manual.


## 18. Report a slow or broken session

Spinney keeps one diagnostics log per window. It holds timings, counters and paths — never anything you typed, and never an API key.

Every line of the log ends with a timestamp, for example ` | at=2026-09-21T04:14:48.123Z`. The log also holds one line when a command starts, a heartbeat line every 30 seconds while a command runs, and one line when a command ends. A command that hangs is therefore visible in the log after the fact. The log also holds the budget of a background job: one line when Spinney registers the job (`bg register … budget=…`), and one line when the budget runs out (`bg expire …`).

| Step | How |
|---|---|
| 1 | Reproduce the problem. |
| 2 | Run `Spinney: Open Diagnostics Log`, then **Show in Explorer**. |
| 3 | Send that one file to the person who supports you. |

A copy that you take from the Output panel is not the same file: it has no header line, and that line names the build, the process and the start time of the window.

The log stops if you set `spinney.diagnostics.log` to `false`.

A process that Spinney did not start can stay behind. This happens when a command hands its work to another program, for example an editor, a build server, or a test bridge. The child of that program is outside the process tree of Spinney. **Stop** cannot reach it, and its output never comes back. Spinney cannot find such a process for you. Use the Task Manager, or run this command in PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "name like '<program>%'" | Where-Object { $_.CreationDate -lt (Get-Date).AddHours(-2) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Replace `<program>` with the name of the program that stayed behind. The filter matches a process that started more than two hours ago.

## 19. Web search

The agent can search the web, and it can read one page. The built-in backends need no API key and no setting.

| Tool | What it does |
|---|---|
| `web_search` | Sends the query to a list of search backends. Returns a numbered list of results: title, URL, and snippet. |
| `web_fetch` | Fetches one URL and returns the text of the page. An HTML page becomes Markdown. |

The search backends are built in. Spinney tries them in this order: Bing (RSS), 360, Baidu, Sogou, Bing (HTML), Hacker News, StackExchange, and GitHub. The result names the backend that answered, and the outcome of each other one.

Two rules keep a search useful:

- A backend that answers with a captcha or a check page is marked. Spinney skips it for a while, and longer after a repeated failure.
- A different network changes which backends work. DuckDuckGo, Google, Mojeek, and Wikipedia do not answer from some regions. Baidu, Sogou, and 360 answer with a captcha from other regions.

Run **`Spinney: Test Web Search Backends`** when a search returns nothing. Spinney sends one test query to each backend, and opens a table with the outcome, the time, and the number of hits. The command measures only. It changes no setting.

`web_fetch` follows a redirect, reads at most 2 MB, and uses the character set of the page. It runs no JavaScript. A page that builds its content in the browser returns little text, and the result says so. `web_fetch` refuses private addresses, such as `localhost` and `127.0.0.1`.

The text of a page is not an order to Spinney. Spinney treats it as information from a stranger. If a page tries to give Spinney an order, Spinney reports it to you.

### 19.1 Search through the provider

A model card can lead the search with the search API of its own provider. The field is `searchProvider`.

- `builtin` is the default for a card you create. Spinney uses the built-in backends only. It sends no request to a search API.
- `deepseek` adds the DeepSeek Search API as the first backend. The built-in backends stay as the fallback. Each result then carries the longer summary of the page, its date, and its score.

The built-in `deepseek-flash` card is set to `deepseek`. You do not have to set it again: if you change another field of that card, the search still goes through the DeepSeek Search API. Every other card starts on `builtin`, and keeps it when the field is absent.

The request goes to the address of the provider of that card, and the key of that provider is the token. Use the **Search token** field on the Model Cards page when the search must use a different token. That field is one token for all cards, and the page names the address the request goes to. An empty field means that Spinney uses the key of the provider.

The provider charges for each search request. One `web_search` call makes one request, and the number of results does not change the price. The provider also limits the account to a small number of requests each second. Spinney spaces its requests to stay under that limit.

Three answers need you, not a retry: a rejected token, an account without balance, and a provider that does not serve the search address. Spinney reports each one in one sentence, and it stops using that API for a few hours.

A card on `builtin` changes nothing: the tools work without a key, and no query goes to a search API. On `deepseek`, `web_fetch` can send the address of a page to that API. It does that only when the local reader finds no text in the page, and it never sends a private address.
