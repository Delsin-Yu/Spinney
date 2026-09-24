/**
 * Command-line redaction for the diagnostics log.
 *
 * The diagnostics log is the file a user is asked to send back, and its contract
 * (`src/chat/diagnosticsLog.ts`) is that it carries **timings, counters and paths**
 * — never the conversation. Writing a command line into it is the one place where
 * that promise can be broken by accident: a `curl -H "Authorization: Bearer …"`,
 * a `--api-key=…`, a `docker login -p …`. The evidence that made this worth doing
 * (a customer's 30-minute `exec_command` calls that could not be attributed to any
 * command at all) needs the command, so the rule is: **write it, masked, clipped**.
 *
 * Two transformations, in this order:
 *  - **Mask** a value that follows a secret-looking name (`token`, `key`,
 *    `api-key`, `secret`, `password`, `authorization`, …) and a `Bearer <token>`
 *    anywhere. Masking is textual and best-effort by design: a secret that is
 *    passed in an unexpected shape (a bare base64 blob) survives, which is why the
 *    manual says the file may contain the first line of a command.
 *  - **Clip** to `max` characters with a visible `…(+N chars)` tail, and collapse
 *    whitespace (a heredoc's command is often multi-line and would otherwise write
 *    a dozen log lines).
 *
 * Deliberately vscode-free and dependency-free (its one import, `./text`, is
 * itself dependency-free): the rules are the part that can be
 * wrong, and `tools/diagnostics-log-acceptance.js` drives them from a plain node
 * script.
 */

import { sliceText } from './text';

/** Name → value shapes that hold a secret (`--api-key=…`, `Authorization: …`). */
const SECRET_NAME = /\b(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|bearer)\b(\s*[:=]\s*)(\S+)/gi;
/** `Bearer <token>` as a standalone phrase (a header written without a `:`). */
const BEARER = /\b(bearer)\s+[A-Za-z0-9._\-+/=]{8,}/gi;

/**
 * The command as one log-safe line: whitespace collapsed, secrets masked, clipped.
 *
 * `max` is the number of characters kept (default {@link REDACT_MAX}); the tail
 * reports how many were dropped so a reader can tell a clipped command from a
 * short one.
 */
export function redactCommand(command: string, max = REDACT_MAX): string {
  const collapsed = String(command ?? '').replace(/\s+/g, ' ').trim();
  const masked = collapsed.replace(BEARER, '$1 ***').replace(SECRET_NAME, '$1***');
  if (masked.length <= max) {
    return masked;
  }
  return `${sliceText(masked, max)}…(+${masked.length - max} chars)`;
}

/** How much of a command reaches the log (see `redactCommand`). */
export const REDACT_MAX = 120;
