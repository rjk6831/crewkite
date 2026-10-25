# 0037. Push and open pull requests from the Changes tab

- Status: Proposed
- Date: 2026-10-24

## Context

Accept to branch (ADR 0008) leaves a local branch and a `git switch` line. Every thread then ends the same way: I open a terminal, push the branch, open a pull request and watch CI in a browser. That is three tools for one step, and the thread forgets what happened after Accept. ADR 0028 already plans controller-owned remote effects. The chat thread needs the smallest part of that now.

## Decision

- The Changes tab gets a commit message field above Accept to branch. It is prefilled from the thread title and the first line of the last reply, and I can edit it.
- After an accept, the tab offers Push branch, then Open pull request, then the branch's CI status.
- Push asks once in plain words before it sends: the branch, the remote, and that my own git credentials are used. The command carries `confirmed: true` only from that button.
- The controller runs `git push <remote> refs/heads/<branch>:refs/heads/<branch>` in the project with prompts off, a two-minute limit and bounded output. It never passes a force flag. It pushes only the commit the thread recorded at Accept and refuses when the branch moved since.
- A push and a pull request are journaled on the thread, the same way Accept is: a `lastPush` record and a system line.
- Open pull request runs `gh pr create` when gh is installed. Without gh, the controller builds the github.com compare link from the remote and the tab copies it.
- CI status reads `gh run list` for the branch every thirty seconds while the tab is open and the branch is pushed.

## Why

Agents in a thread can write files and run commands. They never get to publish. A push is the first action that sends my code off this machine, so it stays a click of mine, with credentials I already set up for git, and CrewKite stores none of them. Force is ruled out because the branch is new and a force push could only destroy work.

I chose gh because it already holds my GitHub sign-in and handles enterprise hosts. Talking to the API directly would mean a token in CrewKite. The compare link covers the case where gh is missing and still gets me to a pull request in one paste.

## Consequences

- A push that times out has an unknown outcome. The thread records nothing, and a second click pushes the same commit again, which git treats as up to date.
- CI status depends on gh and its sign-in. Without gh the tab says so and shows no runs.
- The compare link fallback covers github.com remotes only. Other hosts need gh or a terminal.
- The general command and GitHub journal in ADR 0028 still has to land. These three commands move onto it when it does.
