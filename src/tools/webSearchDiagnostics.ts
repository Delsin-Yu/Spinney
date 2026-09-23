import * as vscode from 'vscode';
import { perf } from '../perf';
import { WEB_BACKENDS, probeAllBackends, type Attempt } from './webBackends';

/**
 * `Spinney: Test Web Search Backends` — probe every backend once and report what
 * this machine's network actually allows.
 *
 * Why it is a command and not a setting: reachability is a **region** fact that no
 * configuration in this extension can know. The measured truth is that the same
 * backend list is half-dead on one side of a national firewall and healthy on the
 * other (DuckDuckGo, Mojeek and Wikipedia do not connect from the target region;
 * Baidu, Sogou, 360 and Bing answer there and hand a captcha to a foreign IP), and
 * a user who switches their VPN sees all of that change. So the honest interface is
 * not "pick your engines" but "measure, then tell me" — this command is that
 * measurement, and it is also the first thing to run when `web_search` comes back
 * with nothing.
 *
 * It deliberately ignores the runtime cooldowns: the point is to measure, not to
 * respect what the last ten minutes decided, and it records nothing either — a
 * probe must not punish a backend the agent might need a minute later.
 */
export async function runWebSearchSelfTest(): Promise<void> {
  const query = 'deepseek';
  const attempts = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Testing web search backends…'),
      cancellable: false,
    },
    () => probeAllBackends(query, { timeoutMs: 9_000 }),
  );

  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const lines: string[] = [];
  lines.push(`# ${vscode.l10n.t('Web search backends')}`);
  lines.push('');
  lines.push(vscode.l10n.t('Query: {0}', query));
  lines.push('');
  lines.push(
    [
      `| ${vscode.l10n.t('Backend')} | ${vscode.l10n.t('Outcome')} | ${vscode.l10n.t('Time')} | ${vscode.l10n.t('Hits')} | ${vscode.l10n.t('Notes')} |`,
      '| --- | --- | --- | --- | --- |',
    ].join('\n'),
  );
  for (const backend of WEB_BACKENDS) {
    const attempt: Attempt | undefined = byId.get(backend.id);
    const outcome = attempt?.outcome ?? 'aborted';
    const time = attempt ? `${(attempt.ms / 1000).toFixed(1)}s` : '—';
    const hits = attempt && attempt.outcome === 'ok' ? String(attempt.count) : '—';
    const note = escapeCell([backend.note, attempt?.detail].filter(Boolean).join(' — '));
    lines.push(`| ${backend.label} \`${backend.id}\` | \`${outcome}\` | ${time} | ${hits} | ${note} |`);
  }
  lines.push('');
  lines.push(
    vscode.l10n.t(
      'ok = results parsed · blocked = captcha or verify wall · rate-limited = HTTP 429/403 · timeout = no answer in time · parse-empty = the page loaded but no result could be read (the upstream markup changed) · unexpected = the body was not the format this backend publishes · http-error = the request or its status failed',
    ),
  );
  lines.push('');
  lines.push(
    vscode.l10n.t('Nothing needs configuring: web_search tries these in order and skips the ones that recently failed.'),
  );
  lines.push('');
  lines.push('```');
  for (const backend of WEB_BACKENDS) {
    lines.push(`${backend.id} → ${backend.build(query, 5)}`);
  }
  lines.push('```');

  perf(() => `web-search self-test ${attempts.map((attempt) => `${attempt.id}=${attempt.outcome}(${attempt.ms}ms)`).join(' ')}`);

  const document = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: false });
}

/** A Markdown table cell cannot contain a raw `|`. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}
