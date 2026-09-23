#!/usr/bin/env node
/**
 * One place owns the artifacts layout.
 *
 * Three different toolchains build three different things — `vsce` writes the
 * extension package to the repository root, `dotnet publish` writes the relay deep
 * under `remote/server/bin/`, and Gradle writes the APK under
 * `remote/android/app/build/`. Nothing in common, and in practice three places to
 * look. This script collects them into one gitignored `artifacts/` directory with a
 * predictable name, so "the build output" is one answer instead of three.
 *
 * It **collects, it does not build**. Running three toolchains from one script turns
 * a build script into a black box that nobody dares touch; each build stays its own
 * documented command and this script only decides where its output lands.
 *
 *   node tools/collect-artifacts.mjs                  # whatever exists, warn on the rest
 *   node tools/collect-artifacts.mjs --vsix --strict   # the closing paths: no vsix, no pass
 *
 * The `.vsix` is **moved** out of the repository root (its source is our own output,
 * and leaving it behind is what let six stale packages pile up there). The relay and
 * the APK are **copied**, because their source is the toolchain's own output tree and
 * deleting from it would confuse an incremental build.
 *
 * Dev-only: `.vscodeignore` excludes `tools/**`, so nothing here ships.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const PUBLISH = path.join(ROOT, 'remote', 'server', 'bin', 'Release', 'net10.0', 'linux-x64', 'publish');

/**
 * One kind per build output. `build` is printed when the input is missing, so a reader
 * is told what to run rather than just that something is absent.
 */
const KINDS = {
  vsix: {
    label: 'extension package',
    build: 'npm run package  (or: powershell -File build-deploy.ps1)',
    move: true,
    // vsce's own default name, in the repository root.
    sources: [path.join(ROOT, `spinney-${version}.vsix`)],
    target: (name) => `spinney-${name}.vsix`,
    // Everything this kind owns in artifacts/, so the previous build cannot linger.
    slot: /^spinney-.*\.vsix$/i,
  },
  relay: {
    label: 'relay (linux-x64)',
    build: 'dotnet publish -r linux-x64 -c Release   (in remote/server)',
    move: false,
    sources: [path.join(PUBLISH, 'spinney-relay')],
    target: (name) => `spinney-${name}-relay-linux-x64`,
    // The relay is not one file: ASP.NET loads `appsettings.json` **by that exact name**
    // from the executable's own directory, so it is collected flat beside the binary
    // under its canonical — not version-stamped — name. A deployment renames the
    // executable and keeps this file as it is. Missing while the binary is present is a
    // relay that would start on defaults by accident, so it is reported like a missing
    // input (a failure under `--strict`).
    companion: { source: path.join(PUBLISH, 'appsettings.json'), name: 'appsettings.json' },
    // The AOT publish also emits a ~55 MiB `spinney-relay.dbg`. It is deliberately
    // **not** collected: it stays in the toolchain's publish tree, which is where anyone
    // symbolizing a crash report should look. This directory holds the deployable pair.
    slot: /^spinney-.*-relay-linux-x64(\.dbg)?$/i,
  },
  apk: {
    label: 'Android debug APK',
    build: './gradlew :app:assembleDebug --offline   (in remote/android)',
    move: false,
    sources: [path.join(ROOT, 'remote', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')],
    target: (name) => `spinney-${name}-debug.apk`,
    slot: /^spinney-.*-debug\.apk$/i,
  },
};

function parseArgs(argv) {
  const kinds = [];
  let strict = false;
  let help = false;
  for (const arg of argv) {
    if (arg === '--strict') strict = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--') && Object.hasOwn(KINDS, arg.slice(2))) kinds.push(arg.slice(2));
    else {
      console.error(`collect-artifacts: unknown argument ${JSON.stringify(arg)}`);
      console.error('usage: node tools/collect-artifacts.mjs [--vsix] [--relay] [--apk] [--strict]');
      process.exit(2);
    }
  }
  return { kinds: kinds.length ? kinds : Object.keys(KINDS), strict, help };
}

/** Readable size, so the report is skimmable without arithmetic. */
function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Copy (or move) through a `.partial`, so an interrupted run cannot leave a truncated
 *  file under the artifact's real name. */
function place(source, target, move) {
  const partial = `${target}.partial`;
  if (move) fs.renameSync(source, partial);
  else fs.copyFileSync(source, partial);
  fs.renameSync(partial, target);
}

function collect(kind, spec, strict) {
  const source = spec.sources.find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
  if (!source) {
    const where = spec.sources.join('\n                 ');
    if (strict) {
      console.error(
        `collect-artifacts: no ${spec.label} to collect — looked for:\n                 ${where}\n` +
          `                 build it with: ${spec.build}`,
      );
      return false;
    }
    console.log(`[skip] ${spec.label} — not built (${spec.build})`);
    return true;
  }

  const name = spec.target(version);
  const target = path.join(ARTIFACTS, name);

  // Replace the previous file of this kind, whatever version it was: a stable answer
  // to "the artifact" is worth more than keeping last week's package around.
  for (const entry of fs.readdirSync(ARTIFACTS)) {
    if (spec.slot.test(entry) && entry !== name) {
      fs.rmSync(path.join(ARTIFACTS, entry), { force: true });
      console.log(`       replaced the previous ${spec.label}: ${entry}`);
    }
  }

  place(source, target, spec.move);
  console.log(`[ok  ] ${kind}: ${name}  ${human(fs.statSync(target).size)}  sha256 ${sha256(target).slice(0, 16)}…`);

  if (spec.companion) {
    const { source: from, name: companionName } = spec.companion;
    if (!fs.existsSync(from)) {
      const message = `${kind}: ${companionName} is missing from the publish directory — the relay would start on built-in defaults`;
      if (strict) {
        console.error(`collect-artifacts: ${message}`);
        return false;
      }
      console.log(`[warn] ${message}`);
      return true;
    }
    const companionTarget = path.join(ARTIFACTS, companionName);
    place(from, companionTarget, false);
    console.log(
      `       ${companionName}  ${human(fs.statSync(companionTarget).size)}  ` +
        `sha256 ${sha256(companionTarget).slice(0, 16)}…  (loaded by name from the relay's own directory)`,
    );
  }

  return true;
}

const { kinds, strict, help } = parseArgs(process.argv.slice(2));
if (help) {
  console.log('usage: node tools/collect-artifacts.mjs [--vsix] [--relay] [--apk] [--strict]');
  console.log('');
  console.log('Collects the built artifacts into artifacts/ with a predictable name.');
  console.log('With no kind flag, every kind is collected and a missing one is a warning.');
  console.log('--strict turns a missing input into a failure (the closing paths use it).');
  process.exit(0);
}

fs.mkdirSync(ARTIFACTS, { recursive: true });
console.log(`collect-artifacts: version ${version} -> ${path.relative(ROOT, ARTIFACTS)}/`);

let ok = true;
for (const kind of kinds) {
  ok = collect(kind, KINDS[kind], strict) && ok;
}
if (!ok) process.exit(1);
