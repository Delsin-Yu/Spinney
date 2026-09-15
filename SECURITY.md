# Security Policy

## Supported versions

Only the latest 0.0.x release gets fixes. Spinney is pre-1.0.

## Report a vulnerability

Use GitHub private vulnerability reporting:

https://github.com/Delsin-Yu/Spinney/security/advisories/new

Do not open a public issue for a vulnerability. Include the Spinney version, the VS Code
version, the platform, the steps you took, what happened, and what you expected.

## What to expect

- An acknowledgment within a few days.
- A fix in a patch release, and a public advisory after that release ships.
- Credit in the advisory, if you want it.

## In scope

- The extension host: command execution, file access, path handling, transcript and state files.
- The chat webview: a way to run script in it, or to break its Content-Security-Policy.
- The local HTTP control plane: authentication, token handling, and the `/continue` endpoint.
- The vendored bundles: a mismatch with their recorded hashes or integrity values.

## Out of scope

- What the model writes or decides. Prompt injection from workspace content is a design
  property of an agent that has tools.
- Risk you accepted by turning the local HTTP control plane on, or by working without
  workspace trust.
- Anything that needs a malicious extension or a modified VS Code build.

## Notes

The API key lives in VS Code SecretStorage. The HTTP control plane is off by default and
listens on `127.0.0.1` only. The README documents both, and what Spinney writes to disk.
