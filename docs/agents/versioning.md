# Versioning and releases

The version number is the developer's decision. The agent prepares everything up to that
number and nothing of it: the number is the one part of a release that is never inferred
from "we are preparing to ship", from a CHANGELOG state, or from what the previous release
happened to be.

## 1. What counts as the developer naming the number

The number appears in the developer's own message: *"this version should be 0.7.0"*,
*"ship 0.8.0"*, *"bump to 0.7.1"*. That sentence authorises the four actions of §2 **for
that one version**, and nothing beyond it.

Not authorisation, on their own: *"ship it"*, *"release it"*, *"prepare the release"*,
*"what is left before we ship"*, *"the next version"*, a request to check a release, or the
fact that some other version number is already sitting in `package.json`. Ask which number
it takes and wait; one short question is cheaper than a wash.

A standing grant of another kind (the magic phrases for public or permissioned actions)
never covers a bump made on the agent's own initiative: this rule is about **who chooses
the number**, not about who is allowed to run the command.

## 2. The four actions a named version authorises

| Action | Where | What it does |
| --- | --- | --- |
| the version field | `version` in `package.json`, and the two `version` rows in `package-lock.json` (the root, and `packages[""]`) | brings the package to `X.Y.Z` |
| the release heading | `CHANGELOG.md` | `## [Unreleased]` becomes `## [X.Y.Z] - YYYY-MM-DD`; the `[Unreleased]` link reference is replaced by `[X.Y.Z]: …/releases/tag/vX.Y.Z` |
| the fold | `CHANGELOG.md` | the entries accumulate under `[Unreleased]` while the work happens and move under the new heading in this one step, never before |
| the tag | git | an annotated `vX.Y.Z`, message `Spinney X.Y.Z`, on the release commit |

They land as one local commit, `chore(release): X.Y.Z`, whose body is the release summary.
Everything before that commit is ordinary work; everything after it is the next release's
`[Unreleased]` accumulating again.

## 3. A bump that appeared without the number

Report it and stop. One sentence, naming the commit(s) and the version(s):

> `chore(release): 0.7.1` and `chore(release): 0.8.0` were committed without a number from
> you; nothing is tagged or published. Which one is it?

Then do **not** bump again to "correct" it, do not tag, do not push, and do not rewrite the
history. Two bumps in one afternoon are a symptom of the same mistake being repeated, and
the second one is never the fix. The developer decides: name the version (then §2 applies,
including a second commit that reaches the same state), or have the bump removed (§4).

## 4. Removing a bump (the repair)

Only on an explicit instruction that names the version(s) or the commit range. The rewrite
itself is a **Local Action**; what makes it safe or not is what it touches.

**Never touch a commit a remote already has.** Take the range boundary as `origin/main` (or
the last published tag): if the boundary stays an ancestor of the rewritten branch, the
later push is a normal fast-forward and no force push is ever needed. A rewrite that
crosses the boundary changes published history and turns an ordinary push into a
destructive one.

The shape of the repair, as run for the 0.7.1/0.8.0 wash:

1. **Safety net.** `git branch backup/pre-rewashN` at the current tip, before anything else.
   The reflog is the second net (90 days) and it is not expired as part of a wash.
2. **Decide the drop set.** The `chore(release): X.Y.Z` commits to remove, by sha. The one
   release commit being kept stays.
3. **A normaliser.** A script under `.spinney/` (gitignored, never tracked) that takes a
   checkout and makes it self-consistent: the version fields, the CHANGELOG sections folded
   into the surviving heading, merge link references dropped, and any prose that dated a
   change to a removed version renumbered. It must be idempotent and must leave a snapshot
   that predates the release alone.
4. **One filtered pass.** `git filter-branch --tree-filter <normaliser> --commit-filter` over
   `origin/main..HEAD`, with `skip_commit "$@"` for the drop set. Dropping a commit is not
   enough on its own: its tree survives inside every descendant snapshot, which is why the
   tree filter reruns over the whole range.
5. **The messages.** A second pass with `--msg-filter` for any commit message that cites a
   removed number, and a hand `--amend` for the one whose body explains the arc (a blind
   substitution turns "0.8.0 had packed X" into a false claim about the surviving version).
6. **The branch refs.** Merged local branches still point at pre-rewrite commits; translate
   them through the old-to-new map written by the commit filter. `backup/*` is excluded on
   purpose.
7. **The tags.** Delete the removed version's tag; re-point the survivor at its rewritten
   release commit with the same message.
8. **Verify, then stop.** `git log --grep` and `git log -S '"version": "<removed>"'` must
   both come back empty across the range, `git grep` over the tree must leave only the
   legitimate hits (a dependency's `"node": ">=0.8.0"` is not a version), the rewritten tip
   must differ from the old tip only in the ways the wash intended, and `git fsck` must be
   clean. Push and publish stay separate decisions with their own class.

What the repair may not do: rewrite past the boundary, delete a branch that holds work the
range does not, expiring the reflog "to finish the job", or treat a tag move as part of the
wash rather than a decision of its own.

## 5. Shipping

- The gate is `npm run vscode:prepublish` (compile plus the guards). A release does not ship
  when it fails.
- `npm run package` (or `build-deploy.ps1` on Windows) leaves the `.vsix` in `artifacts/`,
  and installing it needs the reload of the extension host before anything is claimed live.
- `git push` is a **Permissioned Action**: proposed, then acted on one plain yes. Pushing
  the tag with the branch is what makes the CHANGELOG's `releases/tag/vX.Y.Z` links resolve.
- `vsce publish` is a **Public Action**: the developer's own sentence authorises that one
  publication, and the credential is never harvested. A PAT is handed over by the developer
  (an environment the agent runs in, or a file they name) or the developer publishes.
