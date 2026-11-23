---
name: test-audit
description: >-
  Invoke whenever writing, changing, reviewing, or sweeping tests. Authoring gate for new tests and
  audit workflow for low-value, implementation-coupled, or duplicative tests and test-only seams.
---

# Test Audit

Adapted from `openclaw/openclaw` under the [MIT license](LICENSE.txt). Use authoring mode to gate
every new or changed test at write time, and audit mode to clean up low-value tests in coherent
follow-up batches.

## Authoring gate

Before adding or editing a test, answer all four questions; a missing answer means don't add it:

1. What observable behavior, invariant, or independent contract does it protect?
2. What credible regression makes it fail?
3. Why doesn't existing coverage catch that failure at its primary owner boundary? Prefer extending
   a table-driven test or shared fixture over adding a near-duplicate test.
4. Does it require a production seam (export, flag, wrapper, injection hook) no production caller
   needs? If yes, move the test to the real boundary instead.

Bug regression tests must demonstrably fail on pre-fix code for the intended reason and pass after
the owner-boundary fix. A test that never failed proves the mock, not the fix.

## Junk patterns

Reject new tests matching these patterns, and flag existing ones during audits (keep tests that
independently guard a public API, protocol, config, migration, security, or storage contract):

- assertion-free probes, self-comparisons, identity copiers, or copied static inventories;
- exact source/import/string greps where an executable behavior check exists;
- tests preserving test-only exports/wrappers or dead production code with no real callers;
- expected values computed by the helper under test, or mocks implementing the asserted behavior;
- fixtures supplying receipts/ordering the owner should produce, or checking unwritten stores;
- negative controls that pass for an unrelated guard/path than the scenario named;
- duplicate replays of the same contract across layers or trivial helper variations.

## Audit & validation

1. Before deleting any existing test, read the production owner, callers, sibling tests, and CI
   routing; record its exact location, what failure it detects, non-test callers of its seam, and
   what stronger proof remains. Delete unlocked dead helpers/seams in the same change.
2. Validate using the owning repo's `AGENTS.md` format, lint, type, and test commands — including
   exercising the real changed entry point, not only mocked unit tests.
