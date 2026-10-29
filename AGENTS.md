# Pandoks.com

Personal monorepo. SST (`sst.config.ts`, `infra/`) manages all infrastructure: AWS and Cloudflare
for what needs high availability, rented machines (Hetzner in `infra/vps/`, moving to OVH) for raw
compute; the cluster is K3s with Kustomize and ArgoCD. `apps/desktop-template` and `apps/example`
are templates, but `apps/example/kube` is in every overlay, prod included. Apps import
`packages/svelte` by package name (`@pandoks.com/svelte/...`); inside it, use `#lib`.

## Principles

- Stay close to the metal with few providers and managed services. Simplest architecture, fewest
  moving parts, least code a human can still read; new files, helpers, options, env vars, and
  dependencies need a reason the change can't work without them.
- Use the native or industry-standard mechanism first (Kustomize, ArgoCD, GitHub Actions, Renovate,
  SST, mise, our formatters) and check how mature projects solve it. Work around only an unfixed
  upstream bug, with a `TODO:` linking the issue.
- Fail fast: no fallbacks, retries, shims, or guards for cases that can't happen, or for old data or
  deploy order during a rollout, which I fix by hand once.
- Scripts take explicit arguments, not env vars, except values the platform injects (provider
  credentials, SST-linked resources).
- My chat message wins over this file, except hazard 1. If a rule here or a lint, type, test, or
  scan check fights the task, ask before breaking, suppressing, or relaxing it, or piling on code to
  satisfy it.
- When I ask only for commands, reply with only the commands in a code block, even ones you may not
  run yourself.

## Ways to hurt yourself

1. **Changing production by hand.** Production (the SST `production` stage and the prod cluster)
   changes when `main` does. Read it to diagnose, but change it no other way: no SST command against
   it, not even `sst diff`, no `pnpm cluster deploy prod`, not even `--dry-run`, no
   `gh workflow run deploy-infra.yaml` (it deploys `production`, and its Kubernetes job
   hard-refreshes prod), and no `kubectl` write to prod, Argo refreshes, syncs, and restarts
   included. If production needs a manual fix, even when I say ship now, propose the exact command,
   target, and effect, then wait.
2. **Deploying a stage by accident.** Pass `--stage <stage>` (or `SST_STAGE`) to every `sst` and
   `pnpm cluster deploy` command; mine is `pandoks`. For the site, run `pnpm exec portless doctor`
   before `pnpm --filter web dev`, which can start a missing proxy with `sudo`; if doctor prints a
   `warn` or `fail` line (it exits 0 on a stopped proxy), give me its fix instead of starting the
   proxy or working around it with `PORTLESS=0`, `--force`, or `sudo`. If portless says the host is
   already registered, use `pnpm exec portless get web` only if that process runs from this
   checkout; otherwise tell me. `sst diff` evaluates `infra/`: on any stage it can write secrets,
   and with zero nodes it deletes Tailscale devices tagged for that stage's cluster; personal stages
   share the `dev` names. Tell me those effects and run `sst diff` only once I accept them; run
   `sst deploy` or `pnpm dev` (`sst dev`) only when I ask. If SST reports missing or expired AWS
   credentials, ask me to run `pnpm sso`.
3. **Editing my checkout from an experiment.** Use absolute paths in experiment copies;
   `mise exec -C <dir>` runs inside `<dir>`, so never point it at my checkout. Leave my staged and
   unstaged changes alone.
4. **Applying to the wrong cluster.** Don't switch the default current context;
   `pnpm cluster k3d up` does, so save `kubectl config current-context` first and switch back.
   Target k3d with `kubectl --context k3d-local-cluster` and
   `printf 'y\n' | mise exec -- pnpm cluster deploy local --stage <stage> --kubeconfig "$(mise exec -- k3d kubeconfig write local-cluster)"`.
5. **Leaking secrets.** `.env.<stage>` files, `sst.Secret` values, and
   `pnpm cluster deploy --dry-run` output are real credentials: never print, commit, or paste them,
   and inspect manifests with `kustomize build`. New secrets go in `infra/secrets.ts`; one without a
   value fails every deploy and diff of its stage, so set yours with
   `pnpm sst secret set <Name> <value> --stage <stage>` and ask me to set production's.

## How changes ship

- PRs run `checks.yaml`, `tests.yaml`, `security.yaml`, and `build-and-publish.yaml` (branch-tagged
  GHCR images and charts), a Cloudflare Pages preview of `apps/web`, and `claude-review.yaml` (one
  Agent SDK `/code-review` per PR, posted as one review with inline comments). Required checks are
  the `*-pass` aggregates.
- Merging to `main` runs `deploy-infra.yaml`: `sst deploy --stage production` for `sst.config.ts`,
  `infra/`, `apps/` (except `desktop-template` and `example`), and `packages/svelte/`, plus an Argo
  hard refresh only for `k3s/` and `scripts/cluster/` changes. Pages builds `apps/web` when a change
  matches `pathIncludes` in `infra/website.ts`. Argo auto-syncs everything `k3s/overlays/prod`
  renders but never prunes: a deleted resource stays in prod until pruned by hand.
- Every non-production stage gets `STAGE_NAME` `dev`, `dev.pandoks.com`, and the `dev` GitHub
  environment, so two non-production stages collide.
- Labeled PR previews are planned (#115), not built. Keep two cloud clusters, prod and dev: no
  staging tier, promotion step, or per-PR cluster.
- PRs get no infra diff: `sst diff` decrypts every secret, so never run it with production
  credentials off `main`.

## Commands

Tools are pinned in `mise.toml`: `mise install`, then `pnpm install`. Never install tools
system-wide. Agent shells usually don't activate mise, so `pnpm` is missing and `node` and `kubectl`
are unpinned globals; run repo commands, `kubectl` included, as `mise exec -- <cmd>` from inside the
checkout. The SST CLI is `pnpm sst`.

- `pnpm format <js|go|shell|all>` writes; `pnpm format check <...>` checks.
- Manage agent skills only with the skills CLI, for Claude Code, Codex, and opencode:
  `pnpm dlx skills add <source> -s <skill> -a claude-code codex opencode`, and
  `pnpm dlx skills update -p`.
- `pnpm lint <js|go|helm|docker|shell|actions|all>`; `js` needs `.sst/platform` from `pnpm install`,
  or `infra/` shows hundreds of false type errors.
- `pnpm check` type-checks every package, `infra/`, and `sst.config.ts`.
- Tests: `pnpm --filter "...<package>" test:unit` for `web`, `svelte`, and `desktop-template`;
  `pnpm --filter <package> test` for `prettier` and `valkey`.
- Scoped: `pnpm exec prettier --check <files>`, `pnpm exec eslint [--fix] <files>`, `shellcheck`,
  `shfmt -d`, `hadolint`, `actionlint`, `pnpm --filter "...[origin/main]" --if-present check`. That
  filter and the shell and Docker format and lint commands see only tracked files, so check new
  files with the file-level tools and `pnpm --filter <package> --if-present check`.
- Render without a cluster:
  `kustomize build k3s/overlays/<local|dev|prod> --load-restrictor LoadRestrictionsNone`.
- Local cluster: `pnpm cluster k3d deps up`, `pnpm cluster k3d up` (hazard 4),
  `pnpm local:build && pnpm local:push`, then hazard 4's deploy, once with `--bootstrap` on a fresh
  cluster and again without. `pnpm local:destroy` tears it down. See `scripts/cluster/README.md` and
  `k3s/README.md`.

## Verifying

- Prove changes through their real entry point:
  - Cluster behavior (`k3s/`, `apps/*/kube`, charts, cluster images): render, deploy to local k3d,
    and exercise it, including the failure paths you touched. k3d has no ArgoCD and skips
    `k3s/overlays/cluster` (Tailscale operator, upgrade controller); for those, render the `dev` and
    `prod` overlays and build the image instead of forcing them onto k3d.
  - `scripts/`: run the real CLI for each result and failure path you touched, argument errors
    included.
  - `infra/` or `sst.config.ts`: full `pnpm check` plus scoped lint after the last edit and before
    every commit or push; narrower checks don't replace it.
  - `apps/web`: `CI=1 pnpm --filter web test:e2e` (skips portless) for user-visible changes.
  - Workflows: the PR's CI once a PR exists.
- Before calling work done, run format, lint, type, and test commands for every language and package
  you touched, even for a one-line change, and report a configured checker exclusion only when it
  skips something you touched.
- Docs: when a change makes docs wrong or adds a command, package, CI check, or convention, tersely
  update whatever it affects: `README.md`, `k3s/README.md`, `scripts/cluster/README.md`, usage text,
  package READMEs, and this file.
- Fixtures and rendered YAML alone don't make a change tested. Fix scan and CI fallout your change
  causes; report failures that were already there separately instead of fixing them in the same
  change.
- Add a test only when you can name the behavior it protects, the regression that breaks it, and why
  existing tests miss it. No tests that restate the source, use mocks that implement the asserted
  behavior, or need a test-only export. A bug fix in a package with tests gets one regression test
  that fails before the fix; elsewhere, add no test setup.

## Hit every environment

Before calling infra, cluster, or tooling work done, check:

- **Environments:** no per-environment commands; local k3d, dev, and prod differ only in overlays,
  variables, and `isProduction` branches.
- **Wiring and pins:** the wiring and Renovate rules under Code Review Rules. New pins are exact
  versions (`pnpm add -E`). Pin each copy of a shared version and let Renovate sync them; never read
  or symlink one from another. Gate risky bumps behind Dependency Dashboard approval instead of
  disabling or capping them.

## Code style

- Match surrounding naming, abstraction, and layout; use descriptive names, even in callbacks.
- Reuse or extend before writing: check `scripts/lib/`, `packages/`, and sibling apps. Inline
  one-off wrappers; generic helpers belong in `scripts/lib/` or `packages/` even with one caller, so
  keep the existing ones.
- Comments are rare and never restate code: a short label above a block in a large function, a short
  comment for hard-to-follow code (upstream bug, workaround, invariant), usually `NOTE:`,
  `WARNING:`, or `TODO:`, or a doc comment on a function with hard-to-track inputs. Separate smaller
  blocks with blank lines; keep tool annotations like `# renovate:` and `# shellcheck`.
- No type errors, lint warnings, or `any` to silence a checker. Don't over-harden dev-only or
  maintainer-only paths.
- **Shell:** POSIX `sh`, `set -eu` in entrypoints, and function variables prefixed with the function
  name (no `local`; `main`'s dispatch `cmd` is the exception). Subcommand handlers start with
  `cmd_`; `usage*` and other helpers don't, even beside older ones that do. Quote as `"${var}"`,
  print colored output with `printf` (plain `echo` is fine), and report errors with `log_error` or
  `die` from `scripts/lib/log.sh`. CI-only scripts may use bash with `local` and no prefixes.
- **TypeScript/SST:** one `infra/` file per provider or responsibility, a directory once it outgrows
  one. Stage differences are `SCREAMING_SNAKE` constants from `isProduction ? a : b` at the top,
  plus `if (isProduction)` around production-only resources. Helpers are verb-named `function`
  declarations with destructured parameters. `Promise.all` instead of awaiting in loops.
- **Go:** justify every `#nosec` or `//nolint` inline.
- **Containers and manifests:** pin Dockerfile bases, third-party images, and chart defaults as
  `image:tag@sha256:…` in files a Renovate manager matches; no image lock files. Images in raw
  manifests in `k3s/` aren't matched yet, so add a `kubernetes` `managerFilePatterns` entry to
  `renovate.json` before pinning an image there. First-party images in `apps/*/kube` stay
  `${ImageRegistry}/<img>:${ImageTag}`. Prefer copying official binaries from official images. Use
  `.yaml`, with anchors only for values that must stay equal. Default unset or off-by-default
  `values.yaml` options to `~` (no `enabled` switch) under an `# options:` comment listing the
  choices.

## Git and pull requests

- Stage (`git rm` included), commit, push, or open a PR only when asked. Once asked to push to a PR,
  commit and push its follow-up fixes there without asking again. A check waiting on my approval
  doesn't hold an asked-for PR; open it and list the pending check. Never rewrite pushed history;
  leave merging to me.
- Commits and PR titles: Conventional Commits as `type(scope): short lowercase summary`, like
  `update(cluster): drop unused flag`. PRs are squash-merged, so the title is the commit that lands.
- Descriptions are short: what changes and how to use or verify it, describing the current diff, not
  its history, and updated in the same push as the code. Top-level architecture changes get a
  `mermaid` diagram; UI changes get screenshots or video uploaded to GitHub. Never commit PR-only
  assets, plans, or notes.
- One concern per PR, not split into the smallest pieces; unrelated findings go in a separate PR or
  a note.
- Review and fix loops cover correctness, least code, style match, tests, and docs, and stop when a
  full round finds nothing.
- Babysitting: poll checks and comments newer than the last push, fix real bot findings, dismiss
  false positives with a written reason, and resolve threads you addressed. Wait while a review bot
  is reviewing. If one stays silent on the latest push (no reaction, comment, or check) for 5
  minutes, request a review with the comment command it advertises on the PR, or by @-mentioning it
  if it advertises none; if it's still silent 30 minutes after the push, stop waiting for it and
  tell me. Otherwise stop when CI passes and every review bot has reviewed the latest commit with
  nothing left unhandled.

## Code Review Rules

Treat each change below as a high-severity finding that blocks merge, and a real secret as critical.
Lint and formatting belong to CI. Don't ask for comments, fallbacks, retries, or hardening for cases
that can't happen, or for compatibility code for old data or deploy order during a rollout.

- A new way to change production outside the `main` deploy, such as production commands added to
  scripts or workflows, weakened `protect` or `retain`, or stage checks that confuse production with
  other stages. The existing `deploy-infra.yaml` dispatch and `pnpm cluster deploy prod` recovery
  paths are intended; new callers of them aren't, except local `--dry-run` previews, tests that stub
  SST and `kubectl`, and Argo Applications in the `prod` overlay that render `main`. Safe path:
  `isProduction` in `infra/` and the `prod` overlay in `k3s/`.
- A new pin (a version or digest added where none was, not a bump) that Renovate can't update, or a
  new third-party download or image with no version (`releases/latest`, `:latest`). Exceptions: a
  chart's own `version:` in `Chart.yaml` and an `appVersion` that sets no image tag or download,
  server OS images like `ubuntu-24.04`, and vendor install scripts or generators like
  `tailscale.com/install.sh` and `shadcn-svelte@latest`. Also a version bump missing one of its
  synced copies, like a `Chart.yaml` bump without the `apps/*/kube` manifests using it. Safe path: a
  native Renovate manager (`helm-values` updates image strings under any `values.yaml` key ending in
  `image`, `kubernetes` those in `apps/*/kube` and chart templates; none matches raw manifests in
  `k3s/`) or a `# renovate:` comment a `renovate.json` custom manager matches; checksums Renovate
  can't compute are bumped by hand with their version.
- An attacker-controlled `${{ }}` value, like a branch name or PR title, in `run:` instead of
  `env:`.
- A real secret value in code, manifests, values, logs, or workflow output. References like
  `sst.Secret` names, `${...}` placeholders, and `${{ secrets.* }}` are fine.
- A swallowed failure in CI checks, scans, builds, or deploys, such as `|| true`, ignored exit
  codes, Trivy `exit-code: '0'`, or `continue-on-error`. Safe path: let the step fail. Intended
  exceptions: a known upstream bug with a `TODO:` linking the issue (like `sst refresh` in
  `deploy-infra.yaml`) and the best-effort `rollout status ... || true` waits in
  `scripts/cluster/deploy.sh`. Lint suppressions like `# hadolint ignore=` aren't swallowed
  failures.
- Missing wiring, because the thing silently never gets built, tested, deployed, or scanned, and a
  skipped path-filtered job still passes its required check:
  - a new `infra/` module outside `sst.config.ts`'s import graph;
  - a new app `kube/` directory missing from `k3s/base/apps`;
  - a new `${...}` manifest placeholder with no matching SST resource or computed variable in
    `scripts/cluster/deploy.sh`, which `pnpm cluster deploy` and Argo apply as literal text (fine
    for shell variables in embedded scripts);
  - a new first-party image or chart missing from `build-and-publish.yaml`'s path filters or matrix,
    or from the `branch-cleanup.yaml` and `maintenance.yaml` matrices, or a new first-party image
    missing from the `security.yaml` scan;
  - a new tested package missing its filter and job in `tests.yaml`, a new CI job missing from its
    `*-pass` aggregate's `needs` (scheduled-only jobs excepted), or a new aggregate missing from
    `requiredStatusChecks` in `infra/github.ts`;
  - a new SST or Pages build input missing from the `deploy-infra.yaml` filters or `pathIncludes` in
    `infra/website.ts`.
