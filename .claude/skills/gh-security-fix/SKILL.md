---
name: gh-security-fix
description: Scan every surface of the GitHub Security tab (code-scanning, Dependabot, secret-scanning) plus `.trivyignore.yaml`, then attempt to fix each finding with a local working-tree edit. Edits are applied unstaged — never committed, never pushed, never sent to remote PRs. For Dependabot alerts, attempt the package-manager bump (pnpm/go). For code-scanning, propose source edits or trivyignore entries. For secret-scanning, surface findings prominently and describe rotation steps (never auto-fixable). Also flags expired or stale `.trivyignore.yaml` entries. Use when the user asks about security findings, CVE triage, "anything fixable?", "what's in the Security tab", trivyignore drift, leaked secrets, or expiring suppressions.
context: fork
agent: general-purpose
allowed-tools: Bash(gh *) Bash(cat *) Bash(grep *) Bash(awk *) Bash(sed *) Bash(date *) Bash(find *) Bash(git status *) Bash(git diff *) Bash(pnpm *) Bash(go *) Read Edit Write Grep Glob WebFetch WebSearch
---

# Security audit

Scan the three GitHub Security tab surfaces plus `.trivyignore.yaml`, then attempt a working-tree fix for each finding. Edits land unstaged; the user reviews `git diff` before deciding what to commit. This skill is local-only: it never opens PRs, comments on PRs, pushes branches, or modifies remote state.

## Live state (pre-fetched)

### Code-scanning alerts (Security tab → Code scanning)
```!
gh api "/repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page=100" \
  --jq '[.[] | {number, rule_id: .rule.id, severity: .rule.severity, description: .rule.description, file: .most_recent_instance.location.path, url: .html_url}]' 2>&1 || echo "[]  (code-scanning not enabled or no SARIF uploads yet)"
```

### Dependabot alerts (Security tab → Dependabot)
```!
gh api "/repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100" \
  --jq '[.[] | {number, severity: .security_vulnerability.severity, package: .security_vulnerability.package.name, ecosystem: .security_vulnerability.package.ecosystem, ghsa: .security_advisory.ghsa_id, summary: .security_advisory.summary, vulnerable_range: .security_vulnerability.vulnerable_version_range, fixed_in: .security_vulnerability.first_patched_version.identifier, manifest: .dependency.manifest_path, url: .html_url}]' 2>&1 || echo "[]  (dependabot alerts not accessible)"
```

### Secret-scanning alerts (Security tab → Secret scanning)
```!
gh api "/repos/{owner}/{repo}/secret-scanning/alerts?state=open&per_page=100" \
  --jq '[.[] | {number, secret_type: .secret_type_display_name, created_at, url: .html_url, locations: .locations_url}]' 2>&1 || echo "[]  (secret-scanning not enabled or no findings)"
```

### Current `.trivyignore.yaml`
```!
cat .trivyignore.yaml 2>&1 || echo "(no .trivyignore.yaml found)"
```

### Expired or near-expiry trivyignore entries
```!
TODAY=$(date -u +%Y-%m-%d)
SOON=$(date -u -v+14d +%Y-%m-%d 2>/dev/null || date -u -d '+14 days' +%Y-%m-%d)
echo "Today: $TODAY | 14-day window ends: $SOON"
grep -oE 'exp:[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}' .trivyignore.yaml 2>/dev/null | \
  awk -v t="$TODAY" -v s="$SOON" '
  {
    d = substr($0, length($0)-9, 10)
    if (d < t)      print "EXPIRED:  " $0
    else if (d < s) print "EXPIRING: " $0
    else            print "OK:       " $0
  }' || echo "(no exp: dates found, or .trivyignore.yaml absent)"
```

### Package-manager manifests in this repo
```!
find . -maxdepth 4 \( -name 'package.json' -o -name 'pnpm-lock.yaml' -o -name 'go.mod' -o -name 'Cargo.toml' -o -name 'requirements.txt' \) -not -path '*/node_modules/*' 2>&1
```

### Workspace cleanliness (before any edits)
```!
git status --porcelain 2>&1 | head -20
echo "---"
git branch --show-current 2>&1
```

## Your task

For each finding across the three Security-tab surfaces and `.trivyignore.yaml`, **attempt a working-tree fix**. The default action is *try to fix*, not *defer to Renovate*. Only fall back to suppression or rotation guidance when a fix isn't possible.

### Surface 1 — Dependabot alerts (npm, go, etc.)

For each open Dependabot alert:

1. **Identify the manifest.** The `manifest` field tells you which package-manager file owns this dependency (`pnpm-lock.yaml`, `apps/web/package.json`, `packages/valkey/reconciler/go.mod`, etc.).

2. **Apply the bump.** Use the package manager that owns the manifest:
   - **npm/pnpm** (any `package.json` / `pnpm-lock.yaml`): use **`pnpm`** — never `npm` or `npx`. This repo is pnpm-only per user preference. For direct deps (listed in a `package.json`'s `dependencies` / `devDependencies` / `peerDependencies`), run `pnpm update <pkg>@<fixed-version>`. For transitive deps (not in any `package.json`'s direct lists), add an entry to `pnpm.overrides` in the root `package.json` — keep alphabetical order with the existing entries and update the `//TODO` comment line above `overrides` to document why the override exists (which upstream package still pins the vulnerable version). After editing, run `pnpm install --lockfile-only` to regenerate `pnpm-lock.yaml`; leave both the `package.json` and lockfile change unstaged. Do NOT run a full `pnpm install` (which would write `node_modules`) — the user owns that step.
   - **go**: identify the directory containing the relevant `go.mod` from the `manifest` field (e.g. `packages/valkey/reconciler/go.mod`). Run `go get <module>@<fixed-version>` in that directory, then `go mod tidy`. Verify the bump landed by `grep` of `go.sum` — if the old version still appears in `go.sum` after `tidy`, something else in the module graph still requires it and the bump won't take effect at runtime. For transitive go deps with no direct path, use a `replace` directive in `go.mod` as the fallback (`replace <module> => <module> <version>`), documented with a comment line above. Leave `go.mod` and `go.sum` unstaged.
   - **GitHub Actions** (any `manifest` ending in `.github/workflows/*.yaml`): action vulnerabilities surface here too. Bump the `uses:` ref by replacing the SHA pin with the new vulnerable-free SHA from `gh api /repos/<owner>/<action>/git/refs/tags/<tag>`. Keep the `# vX.Y.Z` comment in sync. Renovate's `helpers:pinGitHubActionDigests` may already auto-PR these — note in the report if Renovate's `customManagers` already covers it.
   - **Other ecosystems** (Cargo, pip, gem, etc.): the action exists but isn't pre-configured here. Describe the exact command (`cargo update -p <crate>`, `pip install <pkg>==<ver>` + lockfile regen, etc.) in the report and leave the edit unapplied — the user will run it manually because the lockfile regen pattern varies.

3. **Group bumps by package.** If a single package has 13 open CVEs (e.g., axios), one `pnpm update axios@<latest-fixed>` resolves them all. Don't apply 13 separate edits.

4. **Verify the fix exists.** Before bumping, confirm the fixed version is actually published: `pnpm view <pkg> versions --json | tail -5` for npm, `go list -m -versions <module>` for go. Never recommend a version from memory.

5. **If a fix exists but the bump would cause a major-version break** (e.g., the patched version is in the next major), **do not apply the bump silently** — note it in the report as "fix requires major upgrade, deferred to human review."

6. **If no fix is published yet**, mark the finding as "no patched version yet — wait for upstream" and move on. Do not add a Dependabot alert to `.trivyignore.yaml` (that file is for Trivy, not Dependabot).

### Surface 2 — Code-scanning alerts (Trivy SARIF, CodeQL, etc.)

For each open code-scanning alert:

1. **Classify the alert source by `rule_id`:**
   - `CVE-YYYY-NNNNN` → Trivy CVE (image or filesystem scan)
   - `AVD-KSV-NNNN` or `AVD-DS-NNNN` → Trivy misconfiguration (Helm chart, Dockerfile, IaC)
   - `js/...`, `py/...`, `go/...`, `actions/...` → CodeQL query
   - Other prefixes → check the rule's `description` field for the source tool; if unknown, flag as "unknown rule source" and let the user disambiguate

2. **For Trivy CVE findings (image/filesystem scan):**
   - **Identify the affected file** from the `file` field (a Dockerfile, a `pnpm-lock.yaml`, etc.) and the specific package/binary from the rule `description` and `most_recent_instance.message`.
   - **Try the upstream fix first.** Check whether a patched version exists:
     - If it's an OS package (`apt`/`apk`): `gh api /repos/<distro-package-source>/...` or `WebFetch` the distro's security tracker. If a patched version is in the distro repo, edit the Dockerfile's `apt-get install` line to pin the patched version (`<pkg>=<patched-version>`).
     - If it's a base image vuln (`FROM debian:12` carries a CVE): check the upstream registry for a newer digest. Either update the `FROM` digest directly or note "Renovate's `dockerfile` manager with `pinDigests: true` will auto-PR this — check `dependencyDashboard`."
     - If it's a vendored Go stdlib in a downloaded binary (like kubectl): the only fix is waiting for upstream to rebuild. `gh api /repos/<upstream>/.go-version` on the release branch to confirm Go version is still vulnerable. If unfixable, fall through to suppression.
   - **If no upstream fix exists yet**, add a justified entry to `.trivyignore.yaml`:
     - Required fields: `id` (exact CVE), `paths` (scoped to the affected binary path, e.g. `usr/local/bin/kubectl`), `statement` (one-line exploitability assessment for *our* usage — never just "no fix"), `exp` (~90 days out, YYYY-MM-DD).
     - **Group related CVEs**. If Trivy reports 5 stdlib CVEs in the same binary (e.g., Go 1.26.2 reports CVE-2026-33811, 33814, 39820, 39836, 42499), add all five entries in one edit with shared justification. Half-suppressing a multi-CVE finding leaves CI red.
     - Add a leading comment block above the entries explaining the upstream blocker, exploitability for our usage, and what would close it (so a future audit knows what condition to re-check).

3. **For Trivy misconfiguration findings (AVD-KSV / AVD-DS):**
   - **Read the affected file** (Helm template, Dockerfile, IaC config) and identify what triggered the rule.
   - **Common patterns and fixes:**
     - `AVD-KSV-0014` (root user in container) → add `USER` directive to Dockerfile with a non-root UID; if already non-root, this is a false positive from base-image inheritance — note in trivyignore.
     - `AVD-KSV-0109` / similar (ConfigMap "secrets"): false positive when values are placeholders substituted at runtime — add to `misconfigurations:` section of `.trivyignore.yaml` with `paths:` scoping.
     - `AVD-DS-NNNN` (Dockerfile best practices): apply the fix directly to the Dockerfile (pin tag, drop `--no-cache`, etc.).
   - Suppression in `.trivyignore.yaml` under `misconfigurations:` is the fallback when the finding is a structural false positive. Same shape as vuln entries but no `exp:` if the false-positive condition is permanent (per the existing AVD-KSV-0109 entry's pattern).

4. **For CodeQL findings:** **do not auto-edit source code.** CodeQL queries can have false-positive rates >50% in some patterns (taint analysis, regex DoS detection). Propose a fix in the report — quote the rule, describe the suggested change, link to the alert URL — and let the user decide. The only exception is `actions/missing-workflow-permissions` or similar pure-config rules where the fix is deterministic; for those, edit the workflow file directly.

### Surface 3 — Secret-scanning alerts (NEVER auto-fixable)

Secret-scanning findings are different: a leaked secret needs to be **rotated and revoked**, not edited out. Code edits don't fix the underlying credential exposure.

For each open secret-scanning alert:

1. **Surface it prominently at the top of the report.** Leaked secrets are higher-urgency than CVEs because the credential may already be in attacker hands. List them above the working-tree edits in the report.

2. **Fetch the full alert context.** The `locations_url` field points to where in git history the secret appears. Pull that via `gh api <locations_url>` to get the specific file, commit SHA, and line range. This is non-optional — without the location you can't tell the user where to look or which git history range to scrub.

3. **Identify the rotation surface from `secret_type_display_name`.** Common types and where the credential needs to be rotated:
   - `Anthropic API Key`, `OpenAI API Key`, `Google API Key` → rotate at the provider's console.
   - `AWS Access Key ID` → rotate via `aws iam create-access-key` + `aws iam delete-access-key`; if it's an IAM role's static key, also audit CloudTrail for unauthorized use during the exposure window.
   - `GitHub Personal Access Token` / `GitHub Fine-grained Token` → revoke at github.com/settings/tokens and issue a replacement.
   - `Slack Token`, `Discord Token`, `Stripe API Key`, etc. → look up the provider's revocation flow; never guess the procedure from memory — `WebFetch` the provider's docs first.
   - Database connection string with embedded password → rotate the database password at the database (`ALTER USER`/`pg_password`/cloud console) and update every consumer.
   - **Unknown type** → flag in the report, do not invent a rotation procedure.

4. **Describe the full remediation sequence**, in this order (rotation FIRST, history scrub LAST):
   1. **Rotate at the issuer**: revoke the leaked credential, issue a new one. The leak is exploitable until this step completes.
   2. **Update the new credential in every consumer**: `.env`, CI secrets (GitHub Actions secrets, `gh secret list`), K8s secrets, SST/Terraform/Pulumi config, password manager, local dotfiles. Enumerate likely consumers by `grep`-ing the repo for the secret type's env-var pattern (e.g. `ANTHROPIC_API_KEY`, `AWS_ACCESS_KEY_ID`).
   3. **Verify the new credential works** by exercising it (a curl, an SDK call, a deploy). A leak followed by a broken rotation is worse than the original leak.
   4. **Scrub git history** if the secret was committed: link to https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository (`git filter-repo` is the current recommended tool; BFG is older). **Do not run the scrub command** — that rewrites every collaborator's clone and requires coordination. State the command, let the user run it after notifying anyone else with a clone.
   5. **Dismiss the alert** at the GitHub URL with reason "revoked" — the user does this manually in the UI, the skill never closes alerts via the API.

5. **Never edit source code to "remove" a secret.** The secret is already public the moment it hit GitHub. Removal from current HEAD doesn't undo the leak; only rotation does. The skill *should* propose a follow-up edit to *prevent the next leak* (e.g., adding the file to `.gitignore`, switching from `.env.example` with real values to a clean template) — but that's not a "fix" for the existing alert, it's a hardening step.

6. **Audit the blast radius** in the report: how long was the secret exposed? (use the `created_at` field to estimate). What services or data could it access? This isn't a fix step but it's load-bearing for the user's incident-response decisions (do they need to check logs for unauthorized use, notify users, file a disclosure, etc.).

### Surface 4 — `.trivyignore.yaml` housekeeping

For each entry in the *Expired or near-expiry* list above:

- **EXPIRED:** the `exp:` date is past today. Action sequence:
  1. **Re-derive the original blocker** from the entry's leading comment block — what condition was supposed to clear? ("upstream k8s rebuilds with Go 1.26.3+", "false-positive resolves when KSV-0109 supports inline ignores", etc.)
  2. **Verify the current state of that condition** using primary sources. Don't trust memory or the entry's comment alone — comments rot.
     - For CVE-on-binary entries: check the upstream project's current release version and what dependency version it ships (e.g., `gh api /repos/kubernetes/kubernetes/releases | jq '.[0].tag_name'` then check `.go-version` on that release branch).
     - For library CVE entries: check whether a fixed version is published and whether the chain leading to it has bumped.
     - For misconfig false-positives: check whether Trivy has released a version that handles the case correctly (`WebFetch https://github.com/aquasecurity/trivy/releases`).
  3. **If blocker cleared** → remove the entry, apply the underlying fix (bump the binary, update the chart, etc.) in the same audit. Don't leave a "you can remove this now" note without removing it; the whole point is to keep the file lean.
  4. **If blocker not cleared** → bump `exp:` to today + 90 days, update the `statement:` with the *current* observed state (e.g., "as of 2026-05-15, k8s release-1.36 still pins .go-version=1.26.2"), and update the leading comment block if the situation has materially changed.

- **EXPIRING (within 14 days):** flag in the report. Same re-evaluation logic as EXPIRED, but the action is preventive rather than reactive. Better to bump or remove now than after CI starts failing.

- **OK:** no action, but spot-check 1 random entry per audit anyway: pick the entry with the closest expiry, re-verify its blocker condition. This catches entries whose stated blocker quietly cleared between audits.

- **Entries with no `exp:`** (permanent false-positives like AVD-KSV-0109): no action by default. But once per audit, re-verify the false-positive condition still holds — e.g., for KSV-0109, confirm the affected ConfigMaps still use envsubst placeholders rather than real secrets. False-positive entries can silently become genuine bugs when surrounding code changes.

## Hard rules

- **Working-tree edits only.** Apply edits via `Edit`/`Write` so they land unstaged. **Never** run `git add`, `git commit`, `git push`, `gh pr edit`, `gh pr comment`, `gh pr review`, `gh pr merge`, `git checkout`, `git stash`, `git reset`, or anything that mutates git history, remote state, or other branches. Per `feedback_no_external_actions.md`, Claude scope is local file changes only.
- **The default is unstaged.** Only commit if the user explicitly says "commit those" in a follow-up turn.
- **Before any edit, check the workspace state** (the *Workspace cleanliness* injection above). If there are already-modified files unrelated to this audit, mention them in the report so the user knows the working tree had existing changes before the audit started.
- **Never invent CVE IDs, package versions, or "upstream shipped" claims.** Every factual claim in the report needs a verification-log entry (URL or command + what it confirmed).
- **Prefer a real fix over a suppression.** Add a `.trivyignore.yaml` entry only when no fix exists upstream. If you can't justify the entry in writing, leave the finding open and say so in the report.
- **Don't recommend `severity: CRITICAL`-only filtering as a workaround.** The existing `trivy.yaml` gate (`CRITICAL,HIGH` + `ignore-unfixed: true` + `exit-code: 1`) is the canonical setup; this skill operates within it, not against it.
- **Use `pnpm`, not `npm` or `npx`.** This repo is pnpm-only per `feedback_pnpm.md`.
- **For Dependabot alerts on transitive dependencies** (not direct deps in your `package.json`), use `pnpm.overrides` in the root `package.json` rather than trying to bump them at the leaf. Document the override in the report.

## Report template

Produce a single markdown report:

```
# Security audit (YYYY-MM-DD)

## 🚨 Leaked secrets (N findings) — URGENT, requires rotation
For each secret-scanning alert: type → location → rotation steps. Code edits cannot fix these.

## 🟢 Fixes applied to working tree (N edits)
For each: finding → file changed → exact bump applied → primary source confirming the version exists. Group multi-CVE-per-package edits.

## 🟡 Fixes that need human review (N findings)
For each: finding → why automatic fix wasn't safe (major version bump, CodeQL judgment call, etc.) → proposed action.

## 🟠 Trivyignore entries updated (N entries)
For each: previous state → new state → why.

## 🔴 No fix available yet (N findings)
For each: finding → confirmed via primary source that no patched version exists yet → suggested re-check date.

## ⚠️ Pre-existing working-tree changes
List unrelated modified files that were already present before the audit started.

## Verification log
A short list of every primary-source lookup performed (URL or command + what it confirmed).
```
