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
| **Send** | Sends the message and starts a turn. Spinney marks this button when the setup changed (section 3.4). |
| **Stop** | Ends the turn at the checked-out node. It kills the background terminals and the sub-agents of that node too. Nothing continues. The tooltip is `Stop this turn` or `Stop this node: kill its background tasks and sub-agents (nothing is sent to the model)`. |
| Prompt snippets | Opens a menu of pre-written instructions. A click inserts the text into the input box. Nothing is sent. Spinney ships `Plan` and `Implement Parallel`. Add your own rows with `spinney.promptSections` (section 11). |
| **Attach image** | Opens a file picker. You can also paste an image into the input box. See section 9. |
| Model dropdown | Picks the model card for a new node. A send that continues this conversation asks first (section 3.4). The list groups the cards by provider. |
| Gear button | Opens the model-cards page. The tooltip is `Manage model cards…`. |
| Thinking-effort dropdown | Picks the thinking level. The list is the list of the active card. |

**Send** and **Stop** are one button with two meanings. The button shows **Stop** while the checked-out node runs a turn, or while that node still owns unfinished work.

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
| `Shift`+wheel | Pans sideways. |
| Middle-button drag | Pans. |
| Right-button hold | Pans toward the pointer. |
| Drag the bottom-right corner of a card | Resizes that card. |
| Right-click a card header | Opens the card menu. It holds `Copy node ID`. |

A manual pan or zoom switches that button off.

Each card header carries the turn title, a status chip, and a **🗑** button. The button deletes the branch at that turn (section 4).

The body of a card has three parts, from top to bottom.

The first part holds your message. Spinney always shows this part, and it never folds it. Spinney renders this part as Markdown.

The second part is the work log. It holds the reasoning blocks, the tool cards, the notices, the background-job notices, the `HARNESS` blocks, and the text that the model wrote before a tool call. The work log scrolls. It is the only part that carries a green lock dot. The dot controls auto-scroll. The live turn starts locked. When a turn completes, the work log folds by itself into a one-line header. The header shows a chevron and a label. The label reads `Work log · 3 steps`. The number is the count of the tool cards. With no tool card, the label reads `Work log`. Click the header to unfold the work log again. A header that you clicked once stays as you left it. The automatic fold never overrules your click. The lock dot keeps the same rule. When you release the light of a card, the automatic fold stops folding or unfolding the work log of that card. The work log unfolds by itself again while a turn runs. The work log stays open when the card has no answer to show. Set `spinney.foldWork` to `false` to turn the automatic fold off (section 11). The blocks in the work log keep their own fold behaviour (see `spinney.foldThinking` and `spinney.foldToolCalls` below and in section 11).

The third part is the answer. It holds the final message of the model. Spinney shows it at the bottom of the card, renders it as Markdown, and never folds it. The answer carries no lock dot. Spinney shows the answer only when the turn is at rest and the last item of the work log is the message of the model. The answer goes away when a newer item arrives in the work log, for example a background job, a sub-agent that reports in, a `HARNESS` block from **▶ Continue** or **↻ Retry**, or a new tool call. That message is in the work log again at that point. The text of an interrupted turn shows as the answer. The text of an errored turn does not show as the answer. The error stays in the work log.

When the card shows an answer and the work log stays open, the answer comes first, and the height of the answer alone makes the card taller. The work log keeps a strip of about 360 pixels, and it scrolls inside that strip. Drag the bottom-right corner of the card to make that strip taller. While a turn runs, there is no answer yet, and the card keeps that same strip height instead of growing with each tool call. The answer sits on its own surface under a divider line.

A card can now be up to 1200 pixels high. The limit was 600 pixels before. Dragging the bottom-right corner of a card still resizes it.

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

Each answer and each tool card carries its own token line: `tokens {0} (prompt {1} + completion {2}) · cache hit {3} / miss {4}`.

Tool cards hold the call, the arguments, and the result. Each tool card shows how long the call took, and the number stays after the call ends. A `HARNESS` block holds the exact text that the harness sent to the model. The reasoning blocks, the tool cards, and the `HARNESS` blocks sit in the work log. Click a block header to fold or unfold it. `spinney.foldThinking` and `spinney.foldToolCalls` set the resting state of those blocks (section 11).

Codes that stay in English on purpose: `SUB`, `BG`, `CTX`, `HARNESS`, `Delivered`.

### 3.4 The frozen setup and the trees

A conversation is frozen on the setup it started with. The setup holds the model card, the thinking level, the reply language, and the shipped system prompt. A plain send always uses the frozen setup.

A pick of another model card, thinking level, or reply language makes the live setup differ from the frozen one. The composer then shows both setups, one line each:

- `Sending with: {0}`. The setup that a send uses.
- `New setup: {0}`. The setup that a new node freezes.

The value holds the card, the thinking level, and the reply language. Example: `Sending with: deepseek-flash · medium · English`.

Spinney asks one question before a setup changes. The question is `Continue with current setup` or `Continue with latest setup`. It appears in three cases:

- A change of the model dropdown, the thinking-effort dropdown, or `spinney.replyLanguage` (section 11). Spinney marks the **Send** button. The tooltip is `Send will ask before using the old setup (the one this node froze)`.
- A change on the harness side: the shipped system prompt, the workspace `AGENTS.md`, the tool set, or the endpoint. Spinney adds a hint entry beside the prompt snippets. The entry carries the `⧉` glyph, and its tooltip is `Continue with the latest setup (forks this tree and sends there)`. A click on it opens the same question.
- A continue in a new context window (section 10.3). An empty context makes the latest setup free, so Spinney asks there too.

| Answer | What happens |
|---|---|
| `Continue with current setup` | The send uses the frozen setup. Spinney discards your pick. The model dropdown and the thinking-effort dropdown show the frozen values again. |
| `Continue with latest setup` | Spinney copies this tree into a new tree. The new tree starts with the latest setup. The old tree keeps its own setup, and its prompt cache. |

Press `Escape`, or click the close button, to dismiss the question. A dismissed question sends nothing, and Spinney keeps your text in the input box.

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
| `concurrency` | How many requests can be in flight against this endpoint. `0` means no limit. |

| `balance` value | Request | Result |
|---|---|---|
| `none` | No request. | No wallet figure. This is the default for a new row. |
| `deepseek` | `GET /user/balance` | The total, the granted part, and the topped-up part. |
| `openrouter` | `GET /credits` | The remaining credit, in USD. |
| `moonshot` | `GET /users/me/balance` | The available balance, in CNY. |

A row that leaves `balance` out is read by its host: `api.deepseek.com` gives `deepseek`, anything else gives `none`.

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
| `efforts` | The thinking levels of this card, in dropdown order. The names are free. |
| `defaultEffort` | The level a new session starts on. It must be one of the `efforts` of this card. |

Spinney probes nothing. The context window, the image support, and the transport are your declarations. A wrong `contextWindow` mis-sizes the `ctx` readout.

Built-in rows cannot be deleted. You can edit them.

### 6.3 Choose a model

The model and the effort belong to the node, not to the tab:

1. A turn stores the card and the level it ran with.
2. A follow-up uses the card and the level of the nearest ancestor.
3. A new session starts on `spinney.model`, or on the built-in `deepseek-flash` card.

A pick in a dropdown sets the live setup. A new node freezes the live setup. A send that continues a frozen conversation keeps the frozen setup, and it asks first (section 3.4). A checkout drops the pick, and the dropdowns follow the checked-out node.

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

A sub-agent batch waits at most `spinney.commandMaxForegroundDuration` as well. When the batch still runs at the limit, `spawn_agents` in `sync` mode (the default) and `send_agent_message` return the agent ids. Every summary then arrives later as one batch notice.

You cannot type into a sub-agent card. To continue a finished sub-agent, ask the parent agent to do it.

On **Stop**, Spinney kills the whole sub-agent subtree of that node. It writes the pending notices into the history of the node. A stopped sub-agent never resumes on its own.

After a restart, a sub-agent that was running shows as `killed`.

### 8.2 Background terminals

A background terminal holds a long command while the turn continues. The agent starts one through `exec_command` with `timeout_behavior`.

Nothing holds a turn longer than `spinney.commandMaxForegroundDuration` (300 seconds, 5 minutes). The `timeout` of `exec_command` is the whole budget of the command: its foreground time plus its background time, with no ceiling. A `timeout` longer than the limit is refused before anything starts, unless the call also asks for a background value.

`timeout_behavior` gives the call its identity. It has four values:

| Value | What Spinney starts | What it costs |
|---|---|---|
| `stop_when_timeout` | Nothing. Spinney kills a command that still runs at the timeout. This value is the default. | Nothing. |
| `background_when_timeout` | A job on that node. The command runs in the foreground up to the 5-minute limit, then Spinney moves it to the background. The rest of the budget is the budget of the job. The call must give a `timeout`. | The node cannot send a message until the job ends. Spinney sends a completion notice at the end. |
| `start_in_background` | A job on that node, at once. The whole budget is the deadline of the job. The call must give a `timeout`. | The same as the row above. |
| `start_detached` | A detached job, at once. The job locks no node. The `timeout` is optional. | The node stays free, and the job never sends a notice, so the agent learns its result only when it asks. Any node in the session can read the job or kill it. |

Spinney kills a job when its budget runs out. `background_when_timeout` and `start_in_background` need a `timeout`: without one, Spinney refuses the call before anything starts. A job with no deadline keeps its node busy until it ends, so that job belongs to `start_detached`. The refusal names the value that the call asked for, says that nothing was started, and gives both ways out: give a `timeout`, or use `start_detached`. Only `start_detached` can have no deadline, because it locks no node. `join_background` must not hold a turn past the limit either: while the job has more budget left than the limit, or no deadline at all, the join is refused and the agent is told to end its turn, so the completion notice reaches it later. Spinney also refuses a join of a detached job: that job has no deadline and sends no notice, so there is nothing to wait for. The agent reads a detached job with `check_background_terminal`, and ends it with `kill_background`. `check_background_terminal` and `kill_background` work for every job.

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

A sub-agent can start a background terminal, but it cannot manage one. Only you can kill it.

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
- A break in the middle of a stream. A retry would repeat output.
- An image upload.
- A wallet read.

**Stop** during a wait ends the retry at once.

A stalled request is bounded. Spinney waits 20 s for the first byte, 20 s for the first chunk, and 60 s between chunks. A stalled request shows `Thinking…` with `tok/s` at 0.

### 10.2 The card buttons

A card can carry one of three buttons, or two of them at once. The buttons depend on the state of the node.

| Node state | Button | What it does |
|---|---|---|
| `interrupted` | **▶ Continue** | Sends a harness message and resumes the turn in the same card. The partial output stays. |
| `error` | **↻ Retry** | Sends a harness message and runs the turn again from that node. The partial output of the failed turn is discarded. |
| `error`, context at or above 90%, but not full | **↻ Retry** and **⧉ Continue in a new window** | Two buttons. Retry runs the turn again in this window. The other one offers a new window. Its tooltip shows the percentage. See section 10.3. |
| `interrupted`, context at or above 90% | **⧉ Continue in a new window** | Offers a new context window. The tooltip shows the percentage. See section 10.3. |
| `error`, context full | **⧉ Continue in a new window** | Starts a new context window. The window can be full by tokens or by image bytes. See section 10.3. |

A button carries the work. You do not type the instruction yourself.

### 10.3 A full context window

A context window is full when the provider answers with a context-length error. A request also carries its images as uploaded bytes, and the provider caps these bytes at 200 MB for one request. A refusal for that reason is also a full window. For example, the message reads `Total image size exceeds the limit: max 200 MB per request, got 203 MB`. Spinney does not guess a limit from the `ctx` readout. The card shows a **⚠️** message, and the button becomes **⧉ Continue in a new window**.

Spinney offers this button before a failure too. A card whose turn ended without an answer offers it from about 90% of the `contextWindow` of the card. The tooltip carries the number, for example `Context 93% full - continue in a new window`. This offer is a suggestion, not a repair. Nothing failed, so the button stands alone. A card that failed at or above 90% shows it beside **↻ Retry** instead: the provider refused nothing, so both actions stay open.

In both cases, Spinney asks which setup the new node must start with (section 3.4):

- `Continue with current setup`. The new node keeps the setup of the conversation above it.
- `Continue with latest setup`. The new node freezes the latest setup.

Both answers are free here. A new context window starts empty, so it has no cached prefix to lose.

1. Click **⧉ Continue in a new window**. If the node still owns running work, a modal asks first. It names the work that will stop.
2. Spinney opens a new card below that node. The edge is dashed, the title is `Context window {0}`, and the badge is `CTX`.

The new window starts with the system prompt and one harness message. That message holds your last request and the last answer, in a shortened form. Nothing else goes to the model. Attachments cannot cross, so the message names them instead.

The old branch stays usable. You can send into it again, or press **▶ Continue** there, until it overflows again.

The `CTX` tooltip is `This node starts a new context window; the branch above it is not sent to the model any more`.

Two details that are not faults:

- The new card carries no pinned user message. A harness-opened turn has none.
- The harness text is English, whatever the display language.

## 11. Settings reference

All keys start with `spinney.`. Open the Settings UI, or edit `settings.json`.

| Key | Default | Meaning |
|---|---|---|
| `spinney.model` | `deepseek-flash` | The card id a new session starts on. It is an id, not a model name. |
| `spinney.providers` | `{}` | The endpoint rows. Edit them on the model-cards page. |
| `spinney.modelCards` | `{}` | The model rows. Edit them on the model-cards page. |
| `spinney.replyLanguage` | `auto` | The language of the answers of the agent. `auto` follows the VS Code display language. The new value applies to the next new node; a frozen conversation keeps its own language. |
| `spinney.foldThinking` | `true` | Fold the reasoning blocks of the work log by default. The live block stays open. |
| `spinney.foldToolCalls` | `true` | Fold the tool-call cards of the work log by default. The running call stays open. |
| `spinney.foldWork` | `true` | Fold the work log into its one-line header by default when a turn completes; a header that you clicked, or a card whose light you released, stays as you left it. |
| `spinney.promptSections` | `{}` | Extra prompt snippets, keyed by the name in the menu. A name that matches a shipped snippet replaces its text. |
| `spinney.commandMaxForegroundDuration` | `300` | The longest time anything may hold a turn, in seconds. 300 is 5 minutes. The limit caps only the foreground part of a command. A command that still runs at the limit leaves the turn only when the call asks for a background value: `background_when_timeout` or `start_in_background`. A `timeout` longer than the limit must ask for one of them. Both of those values need a `timeout` of their own, or Spinney refuses the call. `start_detached` never holds a turn, and it can have no deadline. |
| `spinney.maxInlineToolOutput` | `32768` | The size limit of a tool result, in bytes. A larger result goes to a file. `0` turns the limit off. |
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

A change applies at once, with one exception: `AGENTS.md` needs a window reload (section 13).

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
| `Spinney: Show User Manual` | Opens this manual in an editor tab. |
| `Spinney: Reload Chat Webview` | Builds the chat tab again from the state of the session. |
| `Spinney: Test Web Search Backends` | Sends one test query to every search backend, and opens a table of the results. |

Spinney adds no default keyboard shortcut.

## 13. Workspace instructions

Spinney reads `AGENTS.md` in the workspace root and adds it to the system prompt. Use it for the rules of your project, such as the test command or the code style.

Two facts to know:

- Spinney reads the file once, when the extension host starts. An edit does not reach a running window. Reload the window after you change the file.
- With no folder open, Spinney reads nothing.

Run **`Spinney: Show System Prompt`** to read the exact prompt that the model receives. The content follows the current model card, the thinking effort, the reply language, and the `AGENTS.md` snapshot of the session.

## 14. Privacy and data

Spinney sends no telemetry. It connects only to the provider endpoints that you configure.

A request carries your messages, the tool results, and the images. The wallet read adds one request to the provider. An image goes to the provider as an upload or inside the request body, based on the transport of the card.

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
- Spinney reads no `AGENTS.md`, because there is no workspace root.
- A spilled tool result goes to `<scratch folder>/.spinney/tool-output/`.

Open a folder in the same window, or close one, and Spinney switches the mode at once.

## 17. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No API key configured for this provider.` | Set the key with `Spinney: Set API Key`, or on the model-cards page for a named provider. |
| A request fails at once, with no retry | A `400`, `401`, `403`, `404`, or `422`. Read the message. The usual causes are a wrong key and a wrong model name. |
| The status line repeats `retrying` | A network fault, a `429`, or a `5xx`. The status line cannot tell a dead socket from a provider error. Press **Stop** to end the wait. |
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

The agent can search the web, and it can read one page. Both tools work without an API key and without a setting.

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
