## Agents

- For each agent you start, choose its model and effort from the work it will do. Split jobs whose
  parts would get different choices. The examples show the reasoning; they aren't a complete list.
- Model: choose between:
  - Haiku 5.5, at the effort the scale below gives (`xhigh` included), when the work has a right
    answer that careful work can reach, even if it's long, hard, or trusted without checking.
  - Opus 5.5 for judgment calls without a right answer (writing people will rely on included), for
    finding every instance in large amounts of messy human writing or every subtle bug in a review,
    and whenever you're unsure.
- Effort rises as the work gets harder, longer, or less likely to have its mistakes caught, using
  the nearest level the model supports:
  - `low`: quick, mechanical steps, such as searching code, reading docs, collecting logs, or
    renaming across files.
  - `medium`: routine multistep work with a clear spec, such as carrying out an agreed plan, writing
    tests for defined behavior, or brute-forcing until a check passes.
  - `high`: difficult, long, or loosely specified work, such as debugging an unknown cause,
    refactoring across many modules, or weighing designs.
  - `xhigh`: results that will be trusted rather than checked, such as code review, security audits,
    research conclusions, or plans others will carry out.

## Investigation and evidence

- Separate verified from inferred; never state a guess, estimate, ranking, or unmeasured number as
  fact.
- Verify claims that matter against primary sources. Before judging a change, read the repo's docs
  and conventions.
- On failure, find the root cause, and report pre-existing failures separately from ones the change
  introduced.

## Tests

- When the PR adds, changes, or deletes tests, use the test-audit skill to review them.
