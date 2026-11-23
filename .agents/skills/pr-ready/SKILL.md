---
name: pr-ready
description: >-
  Use before handing the user a diff or calling a PR ready, final, done, or mergeable, for
  self-review, after fix rounds, and when asked to review from every angle or babysit.
---

# PR Ready

Inspect the full change against its base, never just the last commit: from the repo root,
`git diff -U0 <merge-base>` for a PR and `git diff -U0 HEAD` for local work, plus untracked files.
For a local handoff, report the diff on the existing branch. Create a branch or commit only if the
user asks for that action. Finish after verification and review unless the user requested
monitoring. For a small, straightforward change (under ~50 changed lines, any number of files), run
steps 1, 2, and 5 plus one fresh correctness review (a subagent if available, told to change nothing
in the repo and test only in its own scratch copy; else a cold reread; no loop), and give a compact
≤8-line report without tables. A docs typo or comment-only fix (no code or config) needs no review
or report shape: check the diff and reply in a sentence or two. Always apply `test-audit` when tests
change and step 4 when a PR exists.

## Checklist

1. **Comments:** From the repo root, pipe that diff (untracked text files as new-file diffs) to
   `sh <this-skill-dir>/scripts/added-comments.sh`. Its output is advisory: inspect each listed line
   in context and remove only redundant comment text, never executable code, literals, requested
   notes, or tool directives (`# renovate:`, `# shellcheck`, `//nolint`, `# options:`, EmmyLua). A
   comment stays only if it states a non-obvious why (upstream bug with `TODO: <url>`, invariant, or
   constraint), on one line, with no file header, version, history, or restatement. Put chat Q&A
   answers in chat, not new code comments.
2. **Additions, names, layout, and budgets:** For each added file, helper, option, env var, guard,
   retry, or doc section, name what fails without it or delete it. Trace callers/consumers before
   deleting or moving code. Prefer the tool's native feature (with a docs link) over custom code.
   Use full-word names matching neighbors, rename stale identifiers, inline single-use helpers when
   readable, and separate logical blocks with blank lines. Instruction files (`AGENTS.md`,
   `SKILL.md`) must stay net `<= 0` lines unless the user asked to add lines (report before →
   after).
3. **Review loop:** For a PR, a complex or high-risk change, or ~50+ changed lines, run a fresh
   `orchestrate` review across correctness, simplicity, this checklist, repo rules, and tests until
   one round is clean; a completed `orchestrate` review of this revision counts. Reviewers apply
   this checklist themselves, write only in their own scratch copies, and never start another review
   loop. Never invent new nits in late rounds.
4. **Bot findings & PR state (when a PR exists):** Fix real bot findings; dismiss asks for hardening
   that the repo's fail-fast rule excludes, citing the rule. Confirm the PR description (with a
   terse `change | why | deleted/moved` table) matches the final diff, head is current with base,
   required CI checks and intended path-filtered jobs passed on the current head SHA, and zero
   unresolved threads remain. Follow the repo's review triggers and wait policy (by default, stop
   waiting on missing bots 30 minutes after the last push) and name which reviews missed the head.
5. **Final verification:** Run repo format/lint/type/test checks on the final revision and verify
   through the user's real entry point (real CLI, keybinding, screenshot, curl, reload, or deploy).

## Handoff

Send one final report, with no interim status text, in this shape (omit empty optional lines),
always ending with a `**tldr:** <1–2 sentences>` line of its own after the list:

- `Ready:` PR link + head SHA, or for local work the current branch with the change left as it is,
  uncommitted unless the user asked for a commit (or `Not ready:` + exact blocker)
- `Changed:` up to 7 grouped rows (`change | why needed | deleted or moved to`)
- `Dismissed:` rejected bot findings + cited rule and the concrete reason in one clause (if any)
- `Verified:` entry point, input, and observed output (`test-audit` note if tests changed)
- `Not verified:` material untested path and exact blocker (if any)
- `Needs you:` copy-pasteable numbered commands flagging interactive prompts (if any)
