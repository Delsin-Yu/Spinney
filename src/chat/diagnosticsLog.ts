/**
 * The diagnostics log: where it lives, how it stays bounded, and why it exists at all.
 *
 * The `[perf]` lines go to the Spinney output channel, and VS Code has no API to read an
 * output channel back — so a user who reports a stutter can only send what reaches a **file**.
 * This module is that file's keeper, and it is deliberately vscode-free: the rotation and
 * retention rules are the part that can be wrong, and being able to drive them from a plain
 * node script (`tools/diagnostics-log-acceptance.js`) is what keeps them right.
 *
 * The rules, all three chosen to make "send me that one file" a sentence a user can follow:
 *
 *  - **One file per window** (`perf-<pid>.log`): two windows never interleave, and the newest
 *    file is the one to send. A single long-lived window would otherwise grow without end.
 *  - **Rotate at {@link DIAGNOSTICS_MAX_BYTES}**: the current file becomes `<file>.prev` and a
 *    fresh one starts, so a file that is sent is bounded and a crashed window still leaves the
 *    previous generation behind.
 *  - **Keep the newest {@link DIAGNOSTICS_KEEP} windows**: older window files (and their
 *    `.prev`) are deleted, so the folder cannot accumulate forever on a machine nobody looks at.
 *
 * What the file contains is a promise, not a hope: only `perf()`/`harnessLog()` lines reach it
 * — timings, counters and **paths**. The conversation never does (a session title, for
 * instance, is written to the output channel directly, not through the perf sink), and neither
 * does an API key (`[config] api keys` says "set"/"missing" only).
 */
import * as fs from 'fs';
import * as path from 'path';

/** Rotate the current window's log once it reaches this size (2 MiB). */
export const DIAGNOSTICS_MAX_BYTES = 2 * 1024 * 1024;
/** Keep at most this many window logs (newest first) in the folder. */
export const DIAGNOSTICS_KEEP = 5;
/** The file name of one window's log. */
export function diagnosticsFileName(pid: number): string {
  return `perf-${pid}.log`;
}

/** The lines written at the top of a fresh log: what it is, and how to stop it. */
export function diagnosticsHeader(file: string, build: string, now = new Date()): string {
  return (
    `# Spinney diagnostics log — send this whole file back.\n` +
    `# build ${build} · pid ${process.pid} · started ${now.toISOString()}\n` +
    `# ${file}\n` +
    `# turn it off with "spinney.diagnostics.log": false\n`
  );
}

/**
 * Prepare this window's log and return the path to append to. Rotation and retention happen
 * here, before the caller opens the stream, so a failed rotation can never leave the tee
 * writing into a file it thinks is fresh.
 */
export function prepareDiagnosticsLog(
  dir: string,
  pid: number,
  options: { maxBytes?: number; keep?: number } = {},
): string {
  const maxBytes = options.maxBytes ?? DIAGNOSTICS_MAX_BYTES;
  const keep = Math.max(1, options.keep ?? DIAGNOSTICS_KEEP);
  const file = path.join(dir, diagnosticsFileName(pid));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return file; // the caller's stream will fail and be swallowed: no log, no crash
  }
  // Rotate **this window's** file only: another window's log is not ours to touch.
  try {
    if (fs.statSync(file).size >= maxBytes) {
      fs.rmSync(`${file}.prev`, { force: true });
      fs.renameSync(file, `${file}.prev`);
    }
  } catch {
    /* no file yet, or it could not be rotated: keep appending is the honest degradation */
  }
  // Create this window's file **before** trimming: retention counts it as the newest, so the
  // steady state is exactly `keep` files (the first version trimmed first, which left `keep + 1`
  // once the fresh file appeared), and the file the tee is about to write to can never be the
  // one that was just deleted.
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '');
    }
  } catch {
    /* the caller's stream will fail and be swallowed: no log, no crash */
  }
  // Retention: the newest `keep` window files survive, with their `.prev` generations.
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('perf-') && entry.name.includes('.log'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        let at = 0;
        try {
          at = fs.statSync(full).mtimeMs;
        } catch {
          /* raced away */
        }
        // A generation belongs to the file it rotates from: key it by its base name so the
        // pair is kept or dropped together.
        const base = entry.name.endsWith('.prev') ? entry.name.slice(0, -'.prev'.length) : entry.name;
        return { full, base, at };
      });
    const newest = new Map<string, number>();
    for (const entry of entries) {
      newest.set(entry.base, Math.max(newest.get(entry.base) ?? 0, entry.at));
    }
    const survivors = new Set(
      [...newest.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, keep)
        .map(([base]) => base),
    );
    for (const entry of entries) {
      if (!survivors.has(entry.base)) {
        fs.rmSync(entry.full, { force: true });
      }
    }
  } catch {
    /* retention is housekeeping: never a reason to lose the log */
  }
  return file;
}

/**
 * The newest log **that has content**, or null — what `Spinney: Open Diagnostics Log` reveals.
 *
 * An empty file does not count: opening a fresh window creates one, and a user asking for "the
 * log of the session that was slow" must not be handed the near-empty file of the window they
 * happen to be sitting in.
 */
export function newestDiagnosticsLog(dir: string): string | null {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('perf-') && name.endsWith('.log'))
      .map((name) => {
        const full = path.join(dir, name);
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          /* raced away */
        }
        return { name, full, size, at: size > 0 ? fs.statSync(full).mtimeMs : 0 };
      })
      .filter((entry) => entry.size > 0)
      .sort((a, b) => b.at - a.at);
    return files.length ? files[0].full : null;
  } catch {
    return null;
  }
}
