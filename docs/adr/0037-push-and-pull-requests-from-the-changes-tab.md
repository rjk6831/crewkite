# 0037. Push and open pull requests from the Changes tab

- Status: Proposed
- Date: 2026-10-24

## Context

Accept to branch (ADR 0008) leaves a local branch and a `git switch` line. Every thread then ends the same way: I open a terminal, push the branch, open a pull request and watch CI in a browser. That is three tools for one step, and the thread forgets what happened after Accept. ADR 0028 plans controller-owned remote effects. The chat thread needs the part of that which covers a push, a pull request and the CI that follows.

## Decision

- The Changes tab gets a commit message field above Accept to branch. It is prefilled with a subject the commit policy accepts, `feat:` and the thread title, and an empty body, and I can edit it. Amended 2026-11-01: it used to add the first line of the last reply as the body, which read as the model talking.
- After an accept, the tab offers Push branch, then Open pull request, then the branch's CI status.
- Push asks once in plain words before it sends: the commit, the branch, the remote, that my own git credentials are used and that Git refuses the push if the branch moved there. The command carries `confirmed: true` and the commit that question showed, so a thread that accepted again since refuses it.
- The controller runs `git push <remote> <commit>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<expected>` in the project with prompts off, a two-minute limit and bounded output. The commit is the object ID the thread recorded at Accept, so a local branch that moved later changes nothing. The expected value is the commit this thread last pushed to that branch, or empty for a branch that was never pushed. A remote branch someone else moved or created refuses, so a push only ever replaces what this thread pushed itself.
- Push and Open pull request are writes in the remote write journal from ADR 0028. The journal records a write as sent the moment before its process starts, through the same process owner as project commands, and then as applied with what the remote made, refused with the remote's own reason, or unknown. One write of each kind is in flight per thread. The push question is the confirmation, so a push proposes and confirms in one step. A push that applied is also journaled on the thread as a `lastPush` record and a system line.
- Open pull request, with gh installed, proposes a pull request from the pushed branch into the remote's default branch and shows its preview in place: title, description, base, draft or ready, and the exact command. Nothing is sent until I confirm that preview. The confirm runs `gh api --method POST /repos/<owner>/<repo>/pulls` with the JSON body in a file, and the journal records the number GitHub answers with. An empty description is built from the thread's plan and the files the branch changes. Without gh, the controller builds the github.com compare link from the remote and the tab copies it, which writes nothing.
- CI status reads `gh run list --commit <accepted commit>` every thirty seconds while the tab is open and the branch is pushed, and `gh run view` for the attempt and jobs of each run. The status says when the remote branch points at a newer commit, and an unreadable remote, an empty run list or a job it could not read is never shown as a pass. CI status stays a read.
- A write that times out, whose process dies or whose answer the controller cannot read is unknown, and nothing sends it again on its own. Check reads the remote: the branch tip for a push, an open pull request from the branch at the pushed head for a pull request. A read that finds nothing settles the write as refused only once its process is proven gone. A remote that cannot be read leaves it unknown. Startup marks a write that was being sent as unknown and never signals its recorded process group, since that number may belong to another process by then.
- When Check cannot tell, I can look at GitHub myself and mark the write as done or as not sent, with a short note. The journal records it as applied or refused on my word, with the time and the note, and sends nothing.

The same journal carries the other writes the tab offers once a pull request is open: update, ready for review, back to draft, a reply to a review comment, a rerun and a merge. [Task operations](../project-operations.md#write-to-github) lists their commands.

## Why

Agents in a thread can write files and run commands. They never get to publish. A push is the first action that sends my code off this machine, so it stays a click of mine, with credentials I already set up for git, and CrewKite stores none of them. Plain force is ruled out because it could destroy someone else's work. The lease limits a push to replacing the commit this thread pushed there, which a rebase-method merge needs.

I chose gh because it already holds my GitHub sign-in and handles enterprise hosts. Talking to the API directly would mean a token in CrewKite. I call the pull request endpoint through `gh api` because its answer names the number and the head, which the journal needs to settle the write, and because a long description goes in a file where the process owner's per-argument limit would cut it. The compare link covers the case where gh is missing and still gets me to a pull request in one paste.

A push names one commit the question showed and lands under a lease, so the button is enough. A pull request publishes a title and a description that CrewKite may have written, under my name, so I read the preview before it goes.

A push or a pull request that timed out may still have reached GitHub. Recording nothing and letting a second click try again would open a second pull request. The journal keeps such a write unknown and holds its kind until a read of the remote proves what happened. Some writes no read can settle, such as when GitHub stays out of reach. Without a way to settle them by hand, the kind and the thread delete would stay held forever, so I accept my own word there, with a note, after the controller's read failed.

## Consequences

- A push or a pull request that times out has an unknown outcome. The journal records it as unknown, and the next write of that kind on the thread waits until a read of the remote, or my own word, settles it. The thread cannot be deleted under it.
- A pull request I mark as done has no number in CrewKite. Open pull request asks once more, and GitHub's answer names the one that is open. A push I mark as done reaches the thread at the next Push, which sends nothing.
- The lease's expected value comes from the thread's last push. A branch pushed outside CrewKite refuses until I check it.
- A remote whose URL does not name a host, an owner and a repository, such as a local path, cannot be pushed to or get a pull request from the tab.
- CI status depends on gh and its sign-in. Without gh the tab says so and shows no runs.
- The compare link fallback covers github.com remotes only. Other hosts need gh or a terminal.
- A push does not check the commit policy again. A branch accepted before a policy change can still be pushed.
