---
name: sync-coverage
description: MUST be invoked via the Skill tool (not inlined as procedure recall) whenever ANY of these happen — adding a new file or directory under apps/, packages/, infra/, k3s/, scripts/ (including brand-new files no rule cites yet — this IS the MISSING-COVERAGE category); renaming or moving a cited file; inserting lines into a cited file; deleting a file or symbol cited by `path:line`; introducing a new external/OS dependency or CLI tool the setup script doesn't yet install (NEW-DEPENDENCY); the user saying "rules might be stale" / "update rules" / "audit rules" / "check rules" / "revise rules" / "sync coverage"; finishing a multi-file change touching apps/**, packages/**, infra/**. Keeps the repo's code-tracking surfaces in sync with the code: `.claude/rules/**` citations, the `scripts/setup/` dependency installer, and the README dependency list. Invoking-the-Skill-tool is REQUIRED even if you remember the procedure; the tool call is the audit trail and the load-bearing artifact, not the work itself. Skipping the Skill tool because "I can do it inline" or "the procedure is small" defeats the purpose — every future session needs to see that sync-coverage ran, with its standardized output format. The skill audits every `path:line` citation in `.claude/rules/**/*.md`, classifies drift (DEAD / STALE / CONTRADICTED / GLOB-MISMATCH / MISSING-COVERAGE / NEW-DEPENDENCY), applies minimal edits when invoked programmatically. The single most-missed drift category is MISSING-COVERAGE — a brand-new file like `apps/functions/src/api/<noun>/handler.ts` or `packages/<name>/` with NO existing citation IS the finding, not "no drift to fix"; the absence of a citation is the drift. Skip ONLY when changes are pure README/comment edits, are inside `.claude/` itself, or are test-only files no rule cites.
when_to_use: Triggers — any prompt mentioning a file path under apps/packages/infra/k3s/scripts combined with a verb (added/created/renamed/moved/deleted/refactored/shifted/inserted/wired/registered); adding a new top-level subdirectory under apps/functions/src/api/, packages/, infra/, infra/sandbox/, scripts/lib/, scripts/cluster/; user phrases "rules might be stale", "rules are out of date", "audit rules", "revise rules", "check rules", "update rules". ALSO triggers when a new external/OS dependency or CLI tool is introduced — a new `command -v <tool>`, a new entry on a `brew install` / `apt-get install` / `pacman -S` line, or any binary called in scripts/CI that `scripts/setup/` doesn't already install (NEW-DEPENDENCY, §3b): the dependency must be wired into the setup installer + `check.sh` inventory + the README dependency list. Failure modes to recognize and override in your own reasoning — "no path:line cites the new file so no drift" (WRONG — MISSING-COVERAGE doesn't require an existing cite, the new file IS the drift), "I made no edits so no drift to fix" (WRONG — drift comes from the code change in the prompt, not from your edits), "the existing rule covers this pattern generically" (WRONG — still MISSING-COVERAGE until the specific new instance is named in body), "I'll flag this for the user to run" (WRONG — apply now), "I'll do it inline without invoking the tool" (WRONG — the Skill tool call is mandatory for the audit trail), "rules drift is out of scope for this task" (WRONG — it's the task's natural completion). If you find yourself constructing any of these rationales, you have already failed the check — invoke the Skill tool immediately.
allowed-tools: Read Grep Glob Edit Write Bash(git diff:*) Bash(git log:*) Bash(git status) Bash(find:*) Bash(ls:*) Bash(sed:*) Bash(rg:*)
---

# Sync coverage

Keep the repo's code-tracking surfaces in sync with the code: audit
`.claude/rules/**/*.md` citations for drift, scan for uncovered new code/files,
and wire newly-introduced dependencies into `scripts/setup/` + the README. Apply
minimal edits to fix what's drifted.

## When to invoke (recall checklist)

If any of these is true, this skill applies — even partially:

- Files referenced by `path:line` in any rule have been edited, renamed, or moved since the rule was written.
- A new pattern appears in code that contradicts a rule (e.g., a Svelte component using slots when `conventions/svelte.md` says snippets-only).
- A new directory exists at a top-level scope (`apps/<new>`, `packages/<new>`, `infra/<new>.ts`, `k3s/<new>`, `scripts/<new>`) with no rule covering it.
- A rule's frontmatter `paths:` glob no longer matches anything, or now matches files outside its intended scope.
- The user mentions a refactor, rename, restructure, migration, version bump, or "the rules are stale."
- A new gotcha was just hit during development and is not yet captured in `.claude/rules/gotchas/`.
- A new SST resource, Helm chart, Lambda handler, Go subcommand, or shell library was added.

## Procedure

### 1. Establish scope

```sh
git diff --name-only main...HEAD
git log --oneline -20
```

If the user named a specific area (e.g., "check the web rules"), narrow to that rule file's `paths:` glob.
Otherwise, audit every rule file under `.claude/rules/`.

### 2. Line-citation deep pass (primary detection)

**Always Read every rule file fresh** — never trust prior context or memory of file contents. The on-disk version is the only ground truth.

For each rule file under `.claude/rules/`:

- `Grep` (or `rg`) the rule body for `path:line` references — pattern `[a-zA-Z0-9_./-]+:[0-9]+`.
- For each citation:
  - File doesn't exist → **DEAD** finding.
  - File exists, `Read` at cited line. Symbol/pattern the rule describes is present within ±5 lines → **OK**. Move on, even if line drifted by 1-5.
  - File exists, cited symbol is gone OR moved >5 lines → **STALE** if same symbol nearby (within 30 lines); **CONTRADICTED** if the surrounding code actively does the opposite of what the rule claims.

The ±5 line tolerance applies to **every** rule file, including frontmatter-less ones (`universal.md`, `architecture.md`, `workflows.md`).

### 3. Missing-coverage scan (mandatory — do NOT skip)

The most-missed drift category. Walk the code surface and check it against rule coverage:

```sh
# Top-level directories
ls -d apps/* packages/* infra/* k3s/* scripts/* 2>/dev/null

# Lambda handler families (each subdirectory under api/ or src/api/)
find apps/functions/src -mindepth 2 -maxdepth 3 -type d

# Infrastructure modules
find infra -maxdepth 2 -name '*.ts'

# Top-level packages and charts
find packages -maxdepth 2 -name 'Dockerfile' -o -name 'Chart.yaml'
```

For each surface element discovered:

1. Does **any** rule's frontmatter `paths:` glob match it?
2. Does **any** rule's body actually mention it by name or describe its pattern?

If both answers are no → **MISSING-COVERAGE** finding. Examples that have historically been missed: new Lambda handler subdirectories (`apps/functions/src/api/<noun>/`), new package types under `packages/`, new sandbox modules under `infra/sandbox/`, new shell library files under `scripts/lib/`.

A `paths:` glob matching a file but the body never naming the pattern is still **MISSING-COVERAGE**, not coverage. "Globbed but unmentioned" is the same as "uncovered" for the purposes of guiding future Claude.

### 3b. New-dependency scan (setup script + README wiring)

A new OS-level tool/dependency the project now relies on is a special kind of
MISSING-COVERAGE: it must be **installed by `pnpm setup`** and **listed in the
dependency README**, or fresh machines break. Detect and wire it in.

**Detect** — a new external tool is in play if the diff (or current code) does any of:

- invokes a binary in shell/CI not already installed by `scripts/setup/`
  (e.g. a new `command -v <tool>`, a `<tool> ...` call in `scripts/**`,
  `.github/workflows/**`, a `package.json` script, or an SST `$ <tool>` shell-out);
- adds a `<tool>` to a `brew install` / `apt-get install` / `pacman -S` line anywhere;
- references a tool in `scripts/cluster/**` or a template filter (like `htpasswd`
  for `${VAR | bcrypt}`) that the setup script doesn't yet install.

Cross-check the candidate against the tools `scripts/setup/` already handles:

```sh
# Tools the setup script installs / inventories today:
grep -hoE "'[a-z0-9-]+\|" scripts/setup/check.sh | tr -d "'|"     # the 19-tool inventory
grep -rhoE 'install_packages (brew|apt-get|pacman) [a-z0-9 @-]+' scripts/setup/install.sh
```

If the tool is genuinely new (not in that set, not a default-OS builtin like
`git`/`curl`/`sed`), it is a **NEW-DEPENDENCY** finding.

**Wire it in** (apply when programmatic / user-approved — same gate as MISSING-COVERAGE).
A new dependency has up to four touchpoints in `scripts/setup/`:

1. **Installer** — add it to the right `install_<group>` function's `brew` /
   `apt-get|pacman` cases (`install_quality` for linters/formatters,
   `install_cluster` for k8s tooling, or a tool-specific installer). If it's
   not in apt/pacman repos, use the `install_release_binary` helper (GitHub
   release) or a vendor installer, mirroring `hadolint`/`k3d`/`helm`.
2. **Inventory** — add a `'<name>|<name> --version'` spec to the `cmd_setup_check`
   list in `check.sh` so `setup check` reports it.
3. **Fast-path guard** — add it to the relevant `all_present ...` call (or
   `pinned_tool_ok` if version-pinned) so the installer short-circuits when present.
4. **Pin drift** (only if a specific version is required) — add a case to
   `check_pin_drift` (use `check_major_match` if the rule is "major must match").

**Then update the README dependency list.** The root `README.md` has a
`<details><summary>Dependencies</summary>` block (an `<li>` per tool + a
`brew install ...` one-liner) — add the new tool there with a link and a one-line
purpose. Also add it to the "Required tools" line in
`.claude/rules/workflows.md` if that rule is in scope.

**Verify** — after wiring, run `pnpm lint shell` (shellcheck) + `sh -n` on the
edited scripts, and `pnpm setup check 2>&1 | grep <tool>` to confirm the new
inventory line resolves.

Report each as a `### NEW-DEPENDENCY` block naming the tool, where it's used, and
the touchpoints edited. Do NOT edit code to make a *rule* match (the Constraints
ban that) — but wiring a real new dependency into the setup script IS in scope
here, because the dependency already exists in the code; you're making the
installer cover it, not fabricating a rule.

### 4. Glob pre-check (secondary)

Now check each rule's frontmatter `paths:` globs:

- Does each glob match at least one file under the repo root?
- Does the rule body actually discuss the directories the glob covers?

Globs that match zero files OR are wildly out of scope with the body get a **GLOB-MISMATCH** finding.

### 5. Per-rule status summary

Emit a one-line status per rule:

```
| Rule                          | Cites | Status |
| ----------------------------- | ----- | ------ |
| conventions/svelte.md         | 8     | ⚠️ 1 stale line |
| gotchas/web.md                | 17    | ❌ 9 dead citations — orphaned from code |
| gotchas/cluster.md            | 6     | ⚠️ glob mismatch + 2 stale |
| universal.md                  | 12    | ✅ all resolve |
| (missing coverage)            | -     | ❌ apps/functions/src/api/analytics/ — no rule |
```

### 6. Drift categories (reference table)

| Category             | Signal                                                                       | Fix                                                       |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| **DEAD**             | File no longer exists or cited symbol removed                                | Delete the citation or rewrite around current state       |
| **STALE**            | File exists, cited symbol moved >5 lines                                     | Update line number in the rule                            |
| **CONTRADICTED**     | Code now does the opposite of what the rule says                             | Surface to user — could be drift OR a bug in the new code |
| **GLOB-MISMATCH**    | `paths:` glob matches zero files OR matches files the rule doesn't describe  | Adjust the `paths:` list                                  |
| **MISSING-COVERAGE** | Code surface (handler dir, package, sandbox module) with no rule covering it | Propose a new rule file or extend an existing one         |
| **NEW-DEPENDENCY**   | A new external tool the code now calls that `scripts/setup/` doesn't install | Wire into the installer + `check.sh` inventory + README deps list (§3b) |

### 6. Cross-check with universal invariants

Re-read `.claude/rules/universal.md` and `.claude/rules/architecture.md`. These are the load-bearing facts. If anything in them is contradicted by current code (e.g., the "current node counts are 0" claim in `gotchas/cluster.md` and `architecture.md`), flag it explicitly — these are highest-priority.

### 7. Report findings, then apply

Output a structured report:

```
## Drift report

### conventions/svelte.md
- L34 cite `apps/web/src/routes/+layout.svelte:28` — symbol moved to line 31. Propose: update line.
- L60 cite `apps/web/src/routes/+layout.svelte:80` — file no longer contains this pattern. Propose: rewrite section or delete.

### gotchas/cluster.md
- Frontmatter `paths:` includes `packages/postgres/**` but no rule body mentions postgres. Propose: drop glob OR add postgres-specific gotcha section.

### MISSING coverage
- `apps/functions/src/api/analytics/track.ts` (`trackHandler`) exists but no rule covers it. Propose: extend `gotchas/functions.md` OR new `gotchas/analytics.md`.

### CONTRADICTED
- `conventions/svelte.md` says snippets-only. `apps/web/src/routes/foo/+page.svelte:42` uses `<slot>`. Either rule needs updating OR the new code violates convention — needs human judgment.
```

**Apply mode** depends on how the skill was invoked:

- **User invoked the skill interactively** ("audit the rules", "sync coverage", `/sync-coverage`): output the full report, then **wait for user confirmation** before editing. The user picks which categories to apply.
- **Skill invoked programmatically** (called by another agent / task says "audit and apply" / commit hook): output the report, then **apply immediately** in the same turn — caller-granted tools and explicit instructions override the wait. Always show the report alongside the edits so the caller can audit.

For **CONTRADICTED** findings, never auto-apply. Always surface to user even in programmatic mode — could be drift, could be a bug in the code.

For **MISSING-COVERAGE**, propose a new file but only create it when (a) the caller said "auto-approve missing coverage" or (b) the user confirms.

Apply edits one rule file at a time, citing the new `path:line` for each replaced reference.

### 8. Verify after edits

After applying edits, re-verify every `path:line` citation in the modified rules:

```sh
# For each citation in each modified rule:
sed -n '<line>p' <file>   # confirm cited symbol is at the cited line
```

Every `path:line` in the modified rules must resolve to the intended content. Report any that still don't resolve.

## Constraints

- **Always Read the rule file fresh** before classifying drift. Injected system reminders or prior conversation context may not reflect on-disk state.
- **Never edit code to make rules match.** Rules describe code, not the other way around. If code contradicts a rule, the rule is stale OR the code is wrong — surface the conflict, do not silently "fix" it.
- **Never invent rules.** A "missing coverage" finding is a _proposal_ to the user, not a license to write new rules unilaterally. New rule files require explicit go-ahead OR caller-granted permission.
- **Minimal diffs.** Update only the citations / claims that drifted. Don't rewrite a rule's prose because phrasing could be tighter.
- **Preserve frontmatter ordering and YAML style.** Match the existing `paths:` list shape (block scalar with `- 'glob'` entries).
- **Cite `path:line` for every claim in the report.** This skill's whole value is verifiability — a finding without a citation is noise.
- **±5 line tolerance applies universally.** Citations off by 1-5 lines are OK (not STALE). Update only when drift is >5 lines OR the cited symbol is no longer present.
