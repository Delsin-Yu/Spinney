import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Shell selection for the exec_command tool.
 *
 * Priority (best first): Git Bash > PowerShell Core (pwsh) > Windows
 * PowerShell 5.1 > cmd.exe.
 *
 * Rationale (verified on a zh_CN / GBK(936) Windows host):
 *  - Git Bash / MSYS2 is an end-to-end UTF-8 stack, so shell messages and
 *    Chinese literals never get mangled when captured as UTF-8.
 *  - PowerShell Core (pwsh) defaults to UTF-8 output.
 *  - Windows PowerShell 5.1 is still bound to the console OEM code page (GBK),
 *    so we force its output encoding to UTF-8, but it is worse than pwsh.
 *  - cmd.exe is the last-resort fallback.
 *
 * Before a process is spawned we call `spawn(shell.file, shell.buildArgs(cmd))`
 * — never `exec` through cmd — so the command line reaches the shell binary as
 * a Unicode argv instead of being re-encoded by cmd's GBK command-line parser.
 */

export type ShellKind = 'bash' | 'pwsh' | 'posh5' | 'cmd';

export interface ShellInfo {
  kind: ShellKind;
  file: string;
  /** Human-readable label, surfaced to the agent via the tool description. */
  label: string;
  /** Build the argv for spawning this shell with the given command. */
  buildArgs: (command: string) => string[];
  /** Environment to inherit; may carry locale overrides. */
  env: NodeJS.ProcessEnv;
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the first match of `name` on PATH (where.exe on Windows, which elsewhere). */
function onPath(name: string): string | undefined {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const r = spawnSync(probe, [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch {
    /* shell probe unavailable; ignore */
  }
  return undefined;
}

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (exists(p)) return p;
  }
  return undefined;
}

/** Well-known Git for Windows / MSYS2 bash locations. */
function gitBashCandidates(): string[] {
  const out: string[] = [];
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramW6432'],
    process.env['ProgramFiles(x86)'],
    process.env.SystemDrive ? path.join(process.env.SystemDrive, 'Program Files') : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter(Boolean) as string[];

  for (const root of roots) {
    out.push(path.join(root, 'Git', 'bin', 'bash.exe'));
    out.push(path.join(root, 'Git', 'usr', 'bin', 'bash.exe'));
  }
  return out;
}

function pwshCandidates(): string[] {
  const out: string[] = [];
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramW6432'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft') : undefined,
  ].filter(Boolean) as string[];
  for (const root of roots) {
    out.push(path.join(root, 'PowerShell', '7', 'pwsh.exe'));
  }
  return out;
}

function posh5Candidates(): string[] {
  const windir = process.env.SystemRoot || 'C:\\Windows';
  const v1 = path.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // For 32-bit consumers on 64-bit Windows, the real one lives under Sysnative.
  const sysnative = path.join(windir, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return [v1, sysnative];
}

/** Prefix for PowerShell -Command that forces UTF-8 on output (and to native programs). */
const PWSH_UTF8_PREFIX =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ';

function detectShell(): ShellInfo {
  // 1) Git Bash (prefer the known install), then any bash on PATH.
  const gitBash = firstExisting(gitBashCandidates());
  const bash = gitBash || onPath('bash');
  if (bash && exists(bash)) {
    const isWin = process.platform === 'win32';
    return {
      kind: 'bash',
      file: bash,
      label: 'Git Bash',
      buildArgs: (cmd) => ['-c', cmd],
      env: {
        ...process.env,
        // zh_CN.UTF-8 is shipped by Git for Windows; keeps messages in Chinese
        // while guaranteeing UTF-8 (no GBK mojibake). Only forced on Windows.
        ...(isWin ? { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } : {}),
      },
    };
  }

  // 2) PowerShell Core (pwsh) — UTF-8 by default, cross-platform.
  const pwsh = firstExisting(pwshCandidates()) || onPath('pwsh');
  if (pwsh && exists(pwsh)) {
    return {
      kind: 'pwsh',
      file: pwsh,
      label: 'PowerShell 7 (pwsh)',
      buildArgs: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', PWSH_UTF8_PREFIX + cmd],
      env: { ...process.env },
    };
  }

  // 3) Windows PowerShell 5.1 — GBK-bound, so force UTF-8 output.
  const posh5 = firstExisting(posh5Candidates()) || onPath('powershell');
  if (posh5 && exists(posh5)) {
    return {
      kind: 'posh5',
      file: posh5,
      label: 'PowerShell 5.1',
      buildArgs: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', PWSH_UTF8_PREFIX + cmd],
      env: { ...process.env },
    };
  }

  // 4) Last resort: cmd.exe.
  return {
    kind: 'cmd',
    file: process.env.ComSpec || 'cmd.exe',
    label: 'cmd.exe',
    buildArgs: (cmd) => ['/d', '/s', '/c', cmd],
    env: { ...process.env },
  };
}

let cached: ShellInfo | undefined;

/** Cached shell selection. */
export function getShell(): ShellInfo {
  if (!cached) {
    cached = detectShell();
  }
  return cached;
}

/** Fresh detection (does not read the cache); exported for tests/diagnostics. */
export function detectShellForTest(): ShellInfo {
  return detectShell();
}
