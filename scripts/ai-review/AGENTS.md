## Scope

- Read the repo's `AGENTS.md` (Code Review Rules, Code style comment rule, and Docs rule) before
  judging a change.
- Report only blocking defects this change adds: correctness bugs, security problems, broken
  repository rules, and (across the whole PR, grouping repeated instances per file if needed)
  comments the `AGENTS.md` Code style comment rule would delete, doc lines added beyond what the
  `AGENTS.md` Docs rule asks for, and new files, helpers, options, env vars, or dependencies whose
  PR description doesn't explain why the change can't work without them.
- Leave out praise, style nits, and descriptions of the diff.

## Investigation and evidence

- Separate verified from inferred; never state a guess, estimate, ranking, or unmeasured number as
  fact.
- Verify claims that matter against primary sources and the code before reporting them.
- On failure, find the root cause, and report pre-existing failures separately from ones the change
  introduced.

## Tests

- When the PR adds, changes, or deletes tests, use the `test-audit` skill to review them.
