# 0040. Accept from the thread's base, whatever HEAD is

- Status: Accepted
- Date: 2026-10-25

## Context

[ADR 0008](0008-isolated-writers-local-branch-acceptance.md) makes acceptance a new local branch and leaves my checkout alone. A thread's scratch copy is cut from HEAD at its first turn, and that commit is the thread's base. Changes diffs the copy against it.

Accept refused with `base-moved` whenever HEAD differed from the base. That rule stranded work in two ways. After every Accept the Changes tab shows `git switch <branch>`, and following it moves HEAD to a commit that is not the base, so the next Accept in the thread was refused with "Start a new thread on the current commit". A commit I made in the checkout while a thread ran did the same. Either way the work sat in a scratch copy that could no longer reach a branch.

The scratch copy also refused any repository with a symlink, a submodule, a path that is not UTF-8 or more than 10,000 files. A link from one instruction file to another ended a thread on its first message.

## Decision

This record amends ADR 0008 and leaves its text as it is.

- Accept builds the commit on the thread's base, whatever HEAD is now, and points the new branch at it. It writes objects and one new ref. My checkout, index and HEAD stay as they are. When HEAD differs from the base, the result and the thread's system line say "The branch starts at this thread's base commit abc1234. HEAD stays where it is."
- After an Accept the thread's base becomes the accepted commit. The thread record stores it, so it survives a restart. The copy matches the new base, Changes starts empty, and a second Accept makes a branch on top of the first.
- `refs/crewkite/threads/<task>` points at the thread's current base. The controller writes it when it creates the scratch copy, on each turn and at each Accept, with `update-ref` and the old value, so a concurrent writer makes the write fail. It touches no working tree, index, HEAD or branch, and it goes when the thread is deleted. A thread from before the ref existed gets one on its next turn. A failed write does not fail the turn, and the next turn or Accept writes it again.
- The scratch copy holds the base's regular files and these other entries:
  - A symlink is written as a link when its target resolves inside the copy. The check follows each target the way the kernel does, through the other links that stay, with `..` taken from where a link leads, names folded for case and normalization, and at most 40 expansions. A link that fails the check is skipped.
  - A submodule (a gitlink, mode 160000) is skipped.
  - A path or a link target that is not UTF-8 is skipped.
  - A base with more than 100,000 entries fails with a message that names the count. The 64 MiB limit on file bytes stays. (Both limits are gone: ADR 0027 lifted the byte limit, and its amendment of 2026-10-31 replaced the file count with a free space check.)
- The thread record lists the first 64 skipped entries with a reason each, and the Changes tab shows "Skipped N entries the scratch copy cannot hold". Accept copies every link and every skipped entry into the new tree from the base, byte for byte, whatever the copy holds at that path. A held link the copy replaced, removed or pointed elsewhere still goes into the branch as the base has it, and Changes lists that path with the reason until I discard it. Accept refuses when the copy added a new link or a special file, or holds a `.git` folder.
- The writer path for tasks keeps its strict form: no links, no submodules and the 10,000 file limit.
- Each file in Changes has Discard. It asks first and names the file. It restores that path in the scratch copy to the base: a changed file gets the base bytes and mode, a file the thread added is removed, and a deleted file comes back. On a held link the copy changed, it removes whatever is at that path and makes the base link again, with the same checks the copy uses when it is first written. It refuses a skipped entry, a path that leads outside the copy through a link, a path blocked by another entry and a file that already matches the base. It waits while a turn runs, and it writes one system line. Accept then carries what is left. Discard works on whole files.

## Why

The diff I reviewed is against the base. A branch cut from the base holds exactly that diff. A branch cut from a newer HEAD would need a rebase I never saw, and that was the reason for the old refusal. Refusing took away the branch, though, and left no way to reach the work. Now the branch always exists, and if HEAD moved on I merge or rebase it in git, where I can see the conflicts. ADR 0008 still holds: Accept creates one new branch, never merges and never touches my checkout.

The base advances so the next diff shows only what changed since the last Accept. Without that, a second Accept would repeat every file of the first.

The ref exists because the accepted commit is the new base. If I delete the accepted branch and git collects, the base would vanish, and Changes could no longer diff against it.

The old scratch rules protected the strict path writers use. A thread copies a whole repository that I work in every day, and those repositories have links and submodules. Skipping what the copy cannot hold, listing it, and taking it from the base at Accept keeps the thread usable and the accepted tree complete. A link is copied only when it stays inside the copy.

Discard exists because Accept took everything in the copy. A thread with one wrong file meant editing the copy by hand or leaving the file in the branch. The copy keeps no other version of a file, so Discard asks first.

## Consequences

- A branch cut from the base may not apply cleanly to a HEAD that moved on. Git shows the conflicts when I merge it.
- The note about HEAD appears only when HEAD differs from the base.
- Each thread leaves one ref under `refs/crewkite/threads/` in my repository until I delete the thread. `git for-each-ref refs/crewkite` lists them. If a delete cannot remove a ref, it stays and holds one commit.
- If the ref write fails, the accepted branch or HEAD holds the base until I delete that branch.
- A skipped entry is invisible to the model. A submodule has no files in the copy, and the model cannot edit it.
- A base over 100,000 entries or 64 MiB cannot start a thread. (Superseded by the ADR 0027 amendment of 2026-10-31: a base of any size starts a thread when the disk has room.)
- The thread record keeps 64 skipped entries, so a longer list shows as "64 or more". The first turn writes no line about them, and the Changes tab is the only place they appear.
- Discard on a skipped entry is refused, because Accept takes it from the base whatever the copy holds. A held link the copy changed stays listed in Changes after Accept, since the copy still holds its own version, until I discard it.
- Hunk-level discard is not covered.
- The accept, base ref and discard paths have fixture coverage and no live run on record.
