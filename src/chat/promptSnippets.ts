/**
 * The composer's prompt snippets: pieces of pre-written instruction text the chat
 * offers on a button, addressed by their **display name** (`"Plan"` → the text).
 *
 * Two sources, one list:
 *
 *   - the **shipped** snippets ({@link SHIPPED_PROMPT_SNIPPETS}) belong to the
 *     extension — they are refined with it, and they are always there, so the
 *     button is never empty;
 *   - `spinney.promptSections` holds the user's own rows, and a row whose name
 *     matches a shipped one **replaces that snippet's text**. That is the only way
 *     to reword a shipped snippet: an absent row means "use the shipped text", so
 *     nothing can delete the two the extension guarantees.
 *
 * The name *is* the display name — the menu label and the `settings.json` key are
 * the same string, so the two can never drift (and no separate label field has to
 * be kept in sync).
 *
 * A snippet is **user-turn text**: the webview inserts it into the composer's input
 * box, the user may edit it, and it travels as the message they send. Nothing here
 * reaches the system prompt, which is why the texts are not templates and have no
 * placeholders.
 *
 * Invariant (see `docs/agents/invariants/system-prompt.md`, hard rule 1): the
 * shipped text carries **no workspace fact** — no path, no script name, no repo
 * layout — because this extension is installed into unrelated workspaces.
 */

export interface PromptSnippet {
  /** What the menu shows; also the `settings.json` key of a user row. */
  name: string;
  /** The text inserted into the composer. */
  text: string;
}

/**
 * The snippets the extension ships. The order is the menu order; the user's own
 * rows follow.
 */
export const SHIPPED_PROMPT_SNIPPETS: readonly PromptSnippet[] = [
  {
    name: 'Plan',
    text:
      'This is a planning task: we will go several rounds of back-and-forth on the topic below until its plan is final. ' +
      'Do not start implementing — answering one or all of the still-open points in your plan is not approval and does ' +
      'not grant permission to implement; it only moves the discussion forward. Keep refining until I explicitly say to start.',
  },
  {
    name: 'Implement Parallel',
    text:
      'Start implementing the topic we discussed. Parallelize aggressively: split the work into independent parts and ' +
      'hand them to sub-agents — nested ones where a part is itself splittable — then merge their results yourself. ' +
      'Do not fan out what a few files can answer, and change nothing you were not asked to change.',
  },
];

/**
 * Resolve the `spinney.promptSections` value into the menu's list: the shipped
 * rows first, then the user's own in declaration order.
 *
 * The setting is user data, so anything unusable is skipped rather than thrown
 * (an empty name, a non-string value, text that is only whitespace) — a typo in
 * `settings.json` must not take the composer's button down with it. A row that
 * cannot be read simply does not appear.
 */
export function resolvePromptSnippets(setting: unknown): PromptSnippet[] {
  const out = SHIPPED_PROMPT_SNIPPETS.map((snippet) => ({ name: snippet.name, text: snippet.text }));
  const rows: Record<string, unknown> =
    setting && typeof setting === 'object' && !Array.isArray(setting) ? (setting as Record<string, unknown>) : {};
  for (const [rawName, rawText] of Object.entries(rows)) {
    const name = rawName.trim();
    if (!name || typeof rawText !== 'string') {
      continue;
    }
    const text = rawText.trim();
    if (!text) {
      continue;
    }
    const shipped = out.findIndex((snippet) => snippet.name === name);
    if (shipped >= 0) {
      // Same name = the user's wording of a shipped snippet (its position stays).
      out[shipped] = { name: out[shipped].name, text };
    } else {
      out.push({ name, text });
    }
  }
  return out;
}
