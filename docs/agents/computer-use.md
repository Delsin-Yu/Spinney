# Computer use (Windows desktop GUI)

A local, stateless CLI can drive the Windows desktop (mouse, keyboard,
screenshots, window list/focus, UI Automation trees). It is **not** part of this
repo — it lives with the user's Cursor skills:

- Binary: `C:\Users\DE-YU\.cursor\skills\computer-use\bin\computer-use.exe`
  (also on `PATH` as `computer-use`; use the absolute path if `PATH` is not
  available in the current shell).
- Full docs: `C:\Users\DE-YU\.cursor\skills\computer-use\SKILL.md` (usage) and
  `reference.md` (complete CLI surface + response shapes). Read them before a
  non-trivial session.
- **Artifacts go to the workspace scratch space** (never `C:\Temp`): pass
  `--path .agent-harness/screenshots` so every capture lands in the same
  gitignored folder as the rest of the agent's scratch (see "Agent scratch space"
  below).

Every invocation runs **one action** and prints one JSON object on stdout
(`ok`, `command`, plus payload fields). Exit codes: `0` ok, `1` bad arguments,
`2` runtime error. Parse the JSON; do not treat stderr text as the result.

**When to use it:** only when a task genuinely needs the GUI (click/type, inspect
on-screen UI, focus a window, capture a screenshot, drive an app with no CLI).
Prefer a real CLI/API — this repo's tools or `exec_command` — whenever one
exists; the desktop is the last resort, not the first.

**The loop:**

1. `computer-use window find --title "*App*"` (or `window list`) → pick `hwnd`.
2. Explore: `computer-use window snapshot --hwnd <hwnd> --focus` → read the YAML
   `snapshot` and pick a `ref` (prefer this over `uia dump`).
3. Act, preferring UI Automation actions over synthetic clicks:
   `uia set-value --hwnd <hwnd> --ref eN --value "…"`, `uia invoke`, `uia toggle`,
   `uia select`; fall back to `mouse click --hwnd <hwnd> --ref eN --focus`.
4. Verify with a fresh `window snapshot` — refs change after the UI updates.
5. Screenshots: `screenshot --path .agent-harness/screenshots --hwnd <hwnd> --focus`
   (or `--ref eN --pad 12` for a POI crop), then `read_image <png>` to actually
   look at it. Prefer a crop over a full-screen shot.

**Safety / shared desktop (the user is often active):**

- Never assume the foreground window, cursor position, or window bounds persist
  between tool calls or turns — the user may move the mouse or the window.
- Do **not** run parallel `exec_command` calls that mutate or depend on desktop
  state (focus, click, type, screenshot of an hwnd).
- Prefer `--hwnd`/`--ref` (or `--coord window|client` offsets resolved *in the
  same script*) over absolute screen points; re-resolve `hwnd`/bounds inside the
  script instead of reusing coordinates from an older screenshot.
- Do not use `mouse drag` or destructive key chords unless the user asked for it.
- When UIA is empty (games/D3D/canvas), stop retrying UIA: chain focus +
  screenshot in one command, click by `--coord window|client` from a fresh find,
  and read a crop.
- Close apps you launched when the user asked to finish; don't leave helper
  processes running.

**Common commands:**

```text
computer-use window list
computer-use window find --title "*Notepad*"
computer-use window snapshot --hwnd 0x00040C1A --focus
computer-use uia set-value --hwnd 0x00040C1A --ref e3 --value "hello"
computer-use uia invoke --hwnd 0x00040C1A --ref e15
computer-use mouse click --hwnd 0x00040C1A --ref e12 --focus
computer-use mouse click --hwnd 0x00040C1A --coord window --x 40 --y 45 --focus
computer-use key tap --hwnd 0x00040C1A --key a
computer-use screenshot --path .agent-harness/screenshots --hwnd 0x00040C1A --focus
computer-use uia from-point --x 640 --y 360
```

`--hwnd` accepts `0x` hex or decimal; `--ref` accepts `e12` or `12`;
`--coord window` = offsets from the outer window rect, `--coord client` = client
area. One **logical** step per decision; when the user may be active, chain
focus + act + verify in a single command so intermediate state cannot drift.

