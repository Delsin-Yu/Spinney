#!/usr/bin/env node
/**
 * reload-window.mjs — ask *this* window to reload itself, from inside a turn.
 *
 *     node tools/reload-window.mjs --message "reload landed; carry on with the audit"
 *
 * Run as an ordinary `exec_command`: it queues a **deferred** reload and returns at
 * once. The window reloads the moment it is idle (no turn, no sub-agent, no node
 * background terminal) and the message is delivered to the node that ran the script
 * once the new instance is up, so the agent finishes its turn instead of being cut
 * off by its own reload.
 *
 * Only from inside Spinney's `exec_command`, because that is where the identity
 * comes from: the host puts SPINNEY_DISCOVERY_FILE (the file `port` + bearer token
 * live in), SPINNEY_INSTANCE_ID, SPINNEY_SESSION_ID and SPINNEY_NODE_ID in every
 * command's environment. A plain terminal has none of them and this script refuses
 * to guess — no discovery scan, no fallback — so it can never reload somebody
 * else's window.
 *
 * The ids come from the environment **never from an argument**: the reload is bound
 * to the node that ran the script, and an argument could name a different
 * conversation.
 *
 * Exit codes: 0 queued, 1 refused/unreachable, 2 usage, 3 not started by a command.
 * No retries, no polling, no waiting: one request, one answer.
 */
import fs from 'node:fs';
import http from 'node:http';

const USAGE =
  'usage: node tools/reload-window.mjs --message "<text>"\n' +
  '\n' +
  'Queues a reload of this window and returns at once; the window reloads when it\n' +
  'is idle and the message comes back to the node that ran this script.\n' +
  '\n' +
  'This script only works from inside a Spinney `exec_command` call: the discovery\n' +
  'file and the ids are read from that command\'s environment. No other argument is\n' +
  'accepted, and there is no fallback.';

/** Usage error: the caller got the shape wrong, nothing was sent. */
function usage() {
  console.error(USAGE);
  process.exit(2);
}

/** One POST, resolved with the status and the reply text. No retry, no redirect. */
function post(port, token, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/reload-window',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// `--message "x"` and `--message=x` are the only two shapes accepted; anything else is
// a usage error, so a typo cannot silently queue a reload with no message to come back to.
const argv = process.argv.slice(2);
let message = '';
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--message') {
    i += 1;
    message = argv[i] ?? '';
  } else if (arg.startsWith('--message=')) {
    message = arg.slice('--message='.length);
  } else {
    usage();
  }
}
if (!message.trim()) {
  usage();
}

// One sentence naming what is missing: "which of the four is absent" is the only
// useful thing to say about a script that will not go looking for a window.
const env = (name) => (process.env[name] ?? '').trim();
const missing = ['SPINNEY_DISCOVERY_FILE', 'SPINNEY_INSTANCE_ID', 'SPINNEY_SESSION_ID', 'SPINNEY_NODE_ID'].filter(
  (name) => !env(name),
);
if (missing.length > 0) {
  console.error(`not started by a Spinney exec_command (${missing.join(', ')} not set), so there is no window to reload.`);
  process.exit(3);
}

// `port` and `token` live only in the 0600 discovery file: a path a process must open is
// not a secret sitting in an environment every child of that shell can read.
const discoveryFile = env('SPINNEY_DISCOVERY_FILE');
const instanceId = env('SPINNEY_INSTANCE_ID');
let discovery;
try {
  discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
} catch (err) {
  console.error(
    `error: could not read the discovery file of ${instanceId} (${discoveryFile}): ${err.message}. ` +
      'The control plane is probably off; ask the user to reload the window.',
  );
  process.exit(1);
}
const port = Number(discovery?.port);
const token = typeof discovery?.token === 'string' ? discovery.token : '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error(`error: ${discoveryFile} carries no usable port/token for ${instanceId}.`);
  process.exit(1);
}

const nodeId = env('SPINNEY_NODE_ID');
const payload = JSON.stringify({
  continue: { message, sessionId: env('SPINNEY_SESSION_ID'), nodeId },
  idle: true,
});
let reply;
try {
  reply = await post(port, token, payload);
} catch (err) {
  console.error(`error: could not reach the control plane of ${instanceId} on 127.0.0.1:${port}: ${err.message}`);
  process.exit(1);
}

if (reply.status === 202) {
  console.log(`queued: the window reloads when it is idle; the message returns to node ${nodeId}`);
  process.exit(0);
}
// Anything else is the host's own refusal (a reload already queued, a bad body, a route
// it does not have): print its reply body as the error, exactly as it was sent.
console.error(reply.text.trim() || `error: the control plane answered ${reply.status} with no body.`);
process.exit(1);
