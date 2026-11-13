## Tool views: one detail per kind of tool

- **A tool row's detail is a view of that tool, built from the two strings the host already
  stores.** `DisplayItem.args` and `DisplayItem.content` are the whole input: there is no
  second payload, no `view` channel, and nothing is read from disk. `TOOL_KIND` (in
  `media/main.js`) maps a tool name to a kind, `buildToolViewer` renders that kind, and a tool
  this build has no kind for keeps the plain `<pre>` — that fallback is a compatibility path,
  not the normal one.
- **Every kind must be pinned by a real sample in `npm run check:webview`.** The renderers
  parse the tool's own result text (`File: … (N lines)`, `Directory: …`, `[exit 0 in 1.2s]`,
  `path:line: text`, numbered web results, `Sub-agent #id finished in 9.1s: …`), so a rewording
  in a tool is a **breaking change to a viewer** — the sample is what turns that into a red
  guard instead of a card that quietly empties. A kind with no sample is a bug even when the
  renderer looks right.

  | kind | tools | the surface |
  | --- | --- | --- |
  | `code` | `read_file`, `write_file` | line-number gutter + monospace rows, **virtualised** (fixed 16 px rows, only the visible window in the DOM, `CODE_OVERSCAN` above and below), no wrapping, the gutter `position: sticky` while the text scrolls sideways; the head path opens the file |
  | `diff` | `replace_in_file`, `append_file` | the same fixed-row grid, two gutters and a full-width tint per row; a `gap` row is git's "⋯"; the head path opens the file |
  | `terminal` | `exec_command`, `check/wait/kill_command` | `$ command`, the tool's own bracketed status line, then the output |
  | `entries` | `list_dir` | one row per entry (`/` marks a directory), the count in the head; a **file** row opens that file (the header's directory is joined on, and its ` (recursive)` mark is not part of the path), a directory row is not a jump |
  | `hits` | `search_files`, `search_transcripts` | path, line, text; the cap note and the scope echo stay in the head. **A row is a jump**: a click posts `openFile { path, line }` and the host opens that file at that line, so the path travels as the tool printed it (workspace-relative for `search_files`, absolute for a transcript dump) and the **host** resolves it (`resolvePath`), never the webview |
  | `results` | `web_search` | numbered title (a real link) + URL + date/snippet |
  | `document` | `web_fetch` | the URL and its HTTP facts, then the body — **the one view that wraps** |
  | `image` | `read_image` | the region the call sent (`rect` clipped by CSS), a click opens the source file; the host answers `imageUrl` with a data URL and the file's mtime, and a file rewritten after the call is flagged. A **whole** image is centred in its box (`plain`); a clipped one never is, because there the box **is** the crop and the picture is offset by the region's origin. The request carries the **call's own path**, which is usually workspace-relative, so the host resolves it (`resolvePath`) before reading — the same rule a jump follows, and the reason a relative read shows pixels instead of "could not be read". The **geometry** of that clip (the box is `rect`'s size, the picture is pushed by `rect`'s origin), both mtime verdicts and the `plain` class are pinned in `check:webview`; the host side (the data URL, the mtime, the cap, a directory, an empty path, a missing file, a relative path) is `check:dock`'s; the real crop (`overflow: hidden`) and the downscaled pixels need a window |
  | `agents` | `spawn_*`, `send_*` | one block per sub-agent, its final answer rendered as Markdown |
  | `count` | `list_nodes` | one sentence: `Checked N nodes in <session> (id)` |
  | `note` | `hop_session`, `finish_hop`, `rename_session` | the tool's own sentence |

- **The arguments are one line of plain words, never JSON.** `TOOL_ARG_SUMMARY` has a line per
  tool (`pattern "x" · src/ · glob *.ts`, `npm test`, `#3`); an unknown tool falls back to
  `scalarSummary`, which lists key/value pairs and never braces. A kind whose view already
  names the arguments (`KIND_HIDES_ARGS`) does not get the summary line above it. A call whose
  arguments are still streaming shows no line at all — partial JSON is not a display.
- **A file a card names is a jump, and the webview never resolves it.** The click posts
  `openFile { path, line? }` and the **host** resolves the path (`resolvePath`: the Git-Bash
  form onto its drive, a workspace-relative path against the agent root) and opens it, because
  a webview has no root to resolve against. `hits` rows carry a line; the code and diff heads
  and a listing's file rows do not (a read names no "that line"). The visible cue is one
  `jump` class (a pointer, and a hover), so plain text never looks clickable, and a
  **directory** row is never one: opening a folder opens a second window, which is not what a
  click on a line of text means.
- **The line diff is computed in the webview, from the call's own arguments.** `diffRows` (the
  edit script, hunks and gaps) runs in `media/main.js`, not in the tool: `replace_in_file`
  diffs `oldText` → `newText`, `append_file` builds pure additions and derives their numbers
  from the result's own "N lines total", and `write_file` shows **only the new content** (it
  has no old side anywhere). An edit anchored on text carries no line numbers — its place in
  the file is not known, so the gutters stay empty rather than invented. The collapsed chip
  still reads the `(+N -M)` sentence the tool already put in its result: the chip must exist
  before the row is opened, and `write_file` has no other source for it.
- **A thought is a step.** A reasoning row counts in its group's header (`updateStepsHead`
  counts `tool` **and** `thinking` rows) and lives **inside** the fold of the run it opens:
  `ensureThinkingRow` opens the group before the row is created, `tuckReasoningIntoRun` moves
  the row directly above a newly opened group into its body (live and repaint alike), and
  `paintFinishedItem` queues a thinking-only item into the group it belongs to. No reasoning
  row is ever loose in the flow. A thought that arrives **while** a run is open rides that run
  — the long-standing rule — which is why the split of steps between two runs is not pinned.
- **A completion notice that starts a round is a boundary.** `DisplayItem.round` (set by
  `renderSignalCards(..., startsRound)`) means "this notice ends the run above it and opens the
  next one": the live path closes the group and appends one accent line
  (`Sub-agent finished · 2 agents · 44s`, its batch summary folded behind a click), and the
  repaint path does the same. A notice **without** the flag is a step of the run that is
  already going and keeps the tool-row shape, indented inside the group.
- **The view owns its surface and its scroll.** A detail with a view gets `has-viewer`, which
  drops the box, the padding and the `max-height` the plain `<pre>` needs; nested scrollers
  fight the wheel. The code and diff surfaces measure themselves (`_paint`) on open, because a
  virtualised window can only be computed once the element is on screen.

## Where the pieces live

- `media/main.js`: `TOOL_KIND`, `TOOL_ARG_SUMMARY`, `buildToolViewer`, the viewers themselves
  (`codeViewer`, `diffViewer`, `terminalViewer`, `entriesViewer`, `hitsViewer`, `resultsViewer`,
  `documentViewer`, `agentsViewer`, `batchViewer`, `countViewer`, `imageViewer`), `diffRows`,
  `paintToolDetail`, `tuckReasoningIntoRun`, `addBackgroundNotice`, and the one place a `jump`
  is wired (each viewer posts its own `openFile`).
- `media/style.css`: the `.code-*` / `.diff-*` / `.term-*` / `.entries-*` / `.hits-*` /
  `.results-*` / `.doc-*` / `.agents-*` / `.image-*` / `.notice-line` blocks, one per kind.
- `tools/check-webview.js`: one real sample per kind, plus the repaint pass that must produce
  the same rows the live stream did.
