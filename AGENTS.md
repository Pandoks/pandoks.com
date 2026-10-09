# Pandoks.com

Pandoks.com is a personal monorepo: apps, infrastructure, Kubernetes manifests, reusable packages,
and the scripts that tie them together. [SST](https://sst.dev/) manages all infrastructure
(`sst.config.ts`, `infra/`). AWS and Cloudflare run what needs high availability, rented machines
run raw compute (the cluster IaC in `infra/vps/` targets Hetzner and is moving to OVH), and
Tailscale plus GitHub handle access and automation. The cluster runs K3s, managed with Kustomize and
ArgoCD. We stay close to the metal and use as few providers and managed services as possible.

## A note from Pandoks

I want the simplest architecture with the fewest moving parts and the least code a human can still
read. Blank lines between logical blocks are free; new files, helpers, options, env vars, and
dependencies are not. Add one only when the change can't work without it.

Use the native or industry-standard mechanism before building anything: Kustomize, ArgoCD, GitHub
Actions, Renovate, SST, mise, and the formatters we already have. Look at how mature projects solve
the same problem. When something breaks, find the root cause and check upstream docs and issues.
Work around a bug only when it's upstream and unfixed, and add a `TODO:` that links the issue.

Fail fast. Don't add fallbacks, retries, compatibility shims, or guards for cases that can't happen,
or for old data and deploy order during a rollout, which I fix by hand once. Scripts take explicit
arguments instead of reading environment variables. The exceptions are values the platform injects
(provider credentials, SST-linked resources) and GitHub Actions `env:` entries that keep untrusted
`${{ }}` values, like branch names, out of `run:`.

Treat this file as good defaults. More specific instructions win: what I ask for in the
conversation, then this file, then your personal global instructions. If a rule here, or a lint,
type, test, or scan check, fights the task, ask me before you break, suppress, or relax it, or pile
on code to satisfy it.

- When I ask only for commands, return only the commands in a code block. Skip explanations and
  write-mode advice unless requested.

## Ways to hurt yourself

1. **Changing production by hand.** Production is the SST `production` stage and the prod cluster,
   and it changes when `main` does. Read it to diagnose, but don't change it any other way: no SST
   command against production, not even `sst diff` (evaluating `infra/` can call `sst secret set`,
   and CI already diffs production on every PR), no `pnpm cluster deploy prod`, no
   `gh workflow run deploy-infra.yaml` (its stage defaults to `production`, and on any stage its
   Kubernetes job hard-refreshes prod), and no `kubectl` write to the prod cluster, Argo refreshes,
   syncs, and restarts included. If production needs a manual fix, even when I ask to ship now,
   propose the exact command, target, and effect, then wait. Once I approve that action, run it
   without asking again.
2. **Deploying a stage by accident.** SST derives a stage from your OS username and refuses names
   like `dev` or `root`, so pass `--stage <your stage>` (or `SST_STAGE`) to every `sst` and
   `pnpm cluster deploy` command; my personal stage is `pandoks`. The root `pnpm dev` is `sst dev`,
   which deploys that stage, so run it only when asked. `PORTLESS=0 pnpm --filter web dev` runs the
   site without the portless proxy, which needs sudo to start, so leave that to me. `sst diff` also
   evaluates `infra/`: on any stage it can write secrets, and with zero nodes it deletes Tailscale
   devices tagged for that stage's cluster. Personal stages share the `dev` names, so before a diff,
   tell me those side effects and run it only once I accept them. When an SST command reports
   missing or expired AWS credentials, ask me to run `pnpm sso`, which waits for my browser
   approval.
3. **Writing to the developer's checkout from an experiment.** Run experiments in a separate
   worktree or a copy under `/var/tmp`, with absolute paths. `mise exec -C <dir>` runs the command
   inside `<dir>`, so pointing it at the real checkout edits it. In a new worktree or copy, inspect
   its mise config, parent configs, and referenced executable content before loading them; use
   command-scoped trust for reviewed effects and `mise exec --` there. Leave the developer's staged
   and unstaged changes alone.
4. **Applying to the wrong cluster.** `kubectl` and `pnpm cluster deploy` write to whatever cluster
   the kubeconfig in use points at (`--kubeconfig`, `KUBECONFIG`, or the current context), which can
   be a cloud cluster over Tailscale or another project's cluster. The default kubeconfig's current
   context is shared with my other projects, so don't switch it. `pnpm cluster k3d up` switches it
   when it creates the cluster, so save `kubectl config current-context` first and
   `kubectl config use-context` back to it. Target k3d explicitly with
   `kubectl --context k3d-local-cluster` and, since `pnpm cluster deploy` waits for `y` on stdin,
   `printf 'y\n' | mise exec -- pnpm cluster deploy local --stage <your stage> --kubeconfig "$(mise exec -- k3d kubeconfig write local-cluster)"`.
5. **Leaking secrets.** `.env.<stage>` files, `sst.Secret` values, and
   `pnpm cluster deploy --dry-run` output (it substitutes them into the manifests) are real
   credentials. Never print, commit, or paste them; inspect manifests with `kubectl kustomize`,
   which keeps the `${...}` placeholders. New secrets go in `infra/secrets.ts`. One without a value
   fails every deploy and diff of that stage, CI's production diff included, so set yours with
   `pnpm sst secret set <Name> <value> --stage <your stage>` and ask me to set production's.

## How changes ship

- **Pull requests** run `checks.yaml`, `tests.yaml`, `security.yaml`, and `build-and-publish.yaml`
  (branch-tagged images and charts in GHCR), plus `sst diff --stage production` and a Cloudflare
  Pages preview of `apps/web`. The required checks are the aggregates `checks-pass`, `tests-pass`,
  `security-pass`, and `build-and-publish-pass`.
- **Merging to `main`** runs `deploy-infra.yaml`, which runs `sst deploy --stage production` for
  changes to `infra/`, `apps/` (except `desktop-template` and `example`), or `packages/svelte/`.
  Cloudflare Pages builds `apps/web` itself when a change matches `pathIncludes` in
  `infra/website.ts`. Argo auto-syncs everything `k3s/overlays/prod` renders, `apps/*/kube`
  included, but never prunes, so a resource you delete stays in prod until it's pruned by hand
  (hazard 1); the workflow only hard-refreshes prod for `k3s/` and `scripts/cluster/` changes.
- **Stages:** `production` is live. Every other stage, including personal ones, gets `STAGE_NAME`
  `dev`, `dev.pandoks.com`, and the `dev` GitHub environment (`infra/dns.ts`, `infra/github.ts`), so
  two non-production stages collide on the same resource names.
- Labeled PR previews on one shared dev cluster are planned (#115) but don't exist yet. Keep to two
  cloud clusters, prod and dev: no staging tier, promotion step, or per-PR cluster.

## Commands

Tools are pinned in `mise.toml`. Install them with `mise install`, then `pnpm install`. Never
install tools system-wide. Agent shells usually don't activate mise, so `pnpm` and the linters are
missing and `node` or `kubectl` resolve to unpinned global versions. Run repo commands through mise
from inside the checkout, like `mise exec -- pnpm lint js`. The SST CLI is `pnpm sst <cmd>`.

- `pnpm format <js|go|shell|all>` writes; `pnpm format check <js|go|shell|all>` only checks.
- `pnpm lint <js|go|helm|docker|shell|actions|all>`. `pnpm lint js` needs `.sst/platform`, which
  `pnpm install` creates; without it, `infra/` reports hundreds of false type errors.
- `pnpm check` type-checks every package, `infra/`, and `sst.config.ts`; `pnpm check:infra` checks
  only the last two.
- Tests: `pnpm --filter "...<package>" test:unit` for `web`, `svelte`, and `desktop-template`, and
  `pnpm --filter <package> test` for `prettier` and `valkey`. In `web`, `test` adds the Playwright
  end-to-end suite.
- Scoped equivalents for the files you touched: `pnpm exec prettier --check <files>`,
  `pnpm exec eslint [--fix] <files>`, `shellcheck`, `shfmt -d`, `hadolint`, `actionlint`, and
  `pnpm --filter "...[origin/main]" --if-present check`. That filter and the shell and Docker
  `pnpm format` and `pnpm lint` commands only see files git tracks, so for new files run the
  file-level tools above and `pnpm --filter <package> --if-present check` for their package.
- Render manifests without a cluster:
  `kubectl kustomize k3s/overlays/<local|dev|prod> --load-restrictor LoadRestrictionsNone`.
- Local cluster, following "Applying to the wrong cluster": `pnpm cluster k3d deps up`, save the
  current context, `pnpm cluster k3d up`, switch back, `pnpm docker:build && pnpm dev:push`, then
  the deploy command there; on a fresh cluster run it once with `--bootstrap`, then again without
  it. `pnpm dev:destroy` tears it down. See `scripts/cluster/README.md` and `k3s/README.md`.

## Verifying

- Prove the change through its real entry point:
  - Cluster behavior (`k3s/`, `apps/*/kube`, charts, and images that run in the cluster): render the
    overlay, deploy to local k3d, and exercise the behavior, including the failure paths the change
    touches. Local k3d has no ArgoCD and skips `k3s/overlays/cluster` (Tailscale operator, upgrade
    controller), so for those, render the `dev` and `prod` overlays and build the image instead of
    forcing them onto k3d.
  - `scripts/`: run the real CLI for the documented distinct results and failure paths the change
    touches, including argument errors, before completion. State which checks used simulated
    external commands and which live checks were blocked; simulations do not verify Docker,
    Kubernetes, or production behavior.
  - `infra/` or `sst.config.ts`: full `pnpm check` and scoped lint, including single-line edits and
    each follow-up fix. Run them after the last code edit and before committing, pushing, or calling
    the work done; `pnpm check:infra` or package-scoped checks do not replace full `pnpm check`
    here. The PR's production diff covers `if (isProduction)` resources. A personal-stage diff can
    mutate shared dev resources; run it or deploy only when those side effects are authorized,
    following "Deploying a stage by accident".
  - `apps/web`: unit tests, plus `CI=1 pnpm --filter web test:e2e` (skips portless) for user-visible
    changes.
  - Workflows: `actionlint`, then the PR's CI run once a PR exists.
- Run the format, lint, type, and test commands for every language and package you touched before
  calling the work done, even for a one-line change.
- Retain checker diagnostics and report existing configured exclusions; ask before adding
  suppression flags or weakening checks to get a clean run.
- Mocks, fixtures, and rendered YAML alone don't make a change tested, so don't report them as if
  they did. Mention what didn't run only when it changes what I should do next.
- Fix every failure your change causes, including scan and CI fallout. Report failures that were
  already there separately instead of fixing them in the same change.
- Add a test only when you can name the behavior it protects, the regression that would break it,
  and why existing tests miss it. No tests that restate the source, use mocks that implement the
  behavior being asserted, or need a test-only export. A bug fix in a package that already has tests
  gets one regression test that fails before the fix; elsewhere, prove it through the entry point
  instead of adding a test setup.

## Hit every environment

The most common miss in this repo is a change that works where it was tested and is wrong everywhere
else. Before calling infra, cluster, or tooling work done, walk this list:

- **Environments.** Local k3d, dev, and prod. The same commands should work in all three;
  differences belong in overlays, variables, and `isProduction` branches, not in per-environment
  commands.
- **Wiring and pins.** Check the change against the wiring and Renovate rules under Code Review
  Rules. New pins are exact versions of the latest stable release; add npm packages with
  `pnpm add -E`, since plain `pnpm add` writes a `^` range. When the same version lives in several
  places, pin each one and let Renovate keep them in sync; never read or symlink one from another.
  Gate risky bumps behind Dependency Dashboard approval instead of leaving them untracked.
- **Docs.** Update anything the change makes wrong: `README.md`, `k3s/README.md`,
  `scripts/cluster/README.md`, usage text, package READMEs, and this file. Keep it terse; don't
  explain what a command already makes obvious.

## Code style

- Match the surrounding code: how it names things, how much it abstracts, and how it is laid out.
  Use descriptive names, even in callbacks.
- Reuse before writing. Check `scripts/lib/`, `packages/`, and sibling apps, and extend what exists.
  Inline one-off wrappers instead of giving them their own function or file. Generic helpers belong
  in `scripts/lib/` or `packages/` even with one caller, so keep the existing ones.
- Comments are rare. Don't restate or narrate the code. Write one as a short label above a logical
  block in a large function, or to explain code that is hard to follow (an upstream bug, a
  workaround, an invariant), usually as a short `NOTE:`, `WARNING:`, or `TODO:`. A doc comment is
  fine on a function whose inputs are hard to track. Separate smaller blocks with blank lines, and
  keep tool annotations like `# renovate:` and `# shellcheck`.
- No type errors, lint warnings, or `any` used to silence a checker.
- Security is important, but don't over-harden dev-only or maintainer-only paths.
- **Shell:** POSIX `sh`, with `set -eu` in entrypoints. POSIX has no `local`, so prefix a function's
  variables with its name (`main`'s dispatch `cmd` is the exception). Subcommand handlers start with
  `cmd_`; `usage*` and other helpers don't, even next to older ones that do. Quote as `"${var}"`,
  print colored output with `printf` (plain `echo` is fine), and report errors with `log_error` or
  `die` from `scripts/lib/log.sh`. A script that only runs in CI may use bash, with `local` and no
  prefixes.
- **TypeScript and SST:** one `infra/` file per provider or responsibility, and a directory once it
  outgrows a file. Stage differences are `SCREAMING_SNAKE` constants built with
  `isProduction ? a : b` at the top of the file, plus `if (isProduction)` around production-only
  resources. Helpers are `function` declarations with verb names and destructured parameters. Use
  `Promise.all` instead of awaiting inside loops.
- **Go:** justify every `#nosec` or `//nolint` inline.
- **Containers and manifests:** pin Dockerfile bases, third-party images, and chart defaults as
  `image:tag@sha256:…` literals in files a Renovate manager matches, with no image lock files. Raw
  manifests in `k3s/` and `apps/*/kube` aren't matched yet, so add a `kubernetes`
  `managerFilePatterns` entry to `renovate.json` in the same change before pinning an image there.
  First-party images in `apps/*/kube` stay `${ImageRegistry}/<img>:${ImageTag}`, which
  `pnpm cluster deploy` fills per environment so local k3d runs the local build. Prefer copying
  official binaries from official images. Use the `.yaml` extension. In Helm values, use `~` for
  unset and an `# options:` comment listing the choices.

## Where code lives

- `apps/web` is the SvelteKit site on Cloudflare Pages and `apps/functions` the AWS Lambdas behind
  the API router. `apps/desktop-template` and `apps/example` set the standard for new apps. SST
  never deploys them, but `apps/example/kube` is wired into every overlay, prod included.
- `packages/` holds shared libraries, images, and charts. Import `packages/svelte` with `@lib`, not
  `$lib`.
- `k3s/` composes the cluster from `bootstrap/`, `base/`, and per-environment `overlays/`; apps plug
  in through their own `kube/` directories.

## Git and pull requests

- Stage, commit, push, or open a PR only when asked. Once asked to push to a PR, commit and push its
  follow-up fixes (review findings, CI failures) there without asking again. Stage only your own
  changes, never rewrite pushed history, and leave merging to me.
- Commits and PR titles follow
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) as
  `type(scope): short lowercase summary`, like `update(cluster): drop unused flag`. PRs are
  squash-merged, so the PR title is the commit that lands.
- Keep the description short: what changes and how to use or verify it. It describes the current
  diff, not its history, and you update it in the same push as the code. Top-level architecture
  changes get a `mermaid` diagram. UI changes get screenshots or a video, uploaded to GitHub. Never
  commit PR-only assets, plans, or research notes.
- One concern per PR, but don't split a concern into the smallest possible pieces. Unrelated
  findings, including ones from review loops, go in a separate PR or a note.
- Review and fix loops look from several angles (correctness, least code, style match, tests, docs)
  and stop when a full round finds nothing.
- When babysitting, poll checks and comments newer than the last push. Verify each bot finding
  against the source, fix the real ones, and dismiss false positives with a written reason. Resolve
  threads you addressed. If Codex skipped a push (it skips merge-only pushes), comment
  `@codex review`. Stay quiet when nothing is new, and stop when the bots are green on the latest
  commit.

## Code Review Rules

Lint and formatting belong to CI. Don't ask for comments, fallbacks, retries, or hardening for cases
that can't happen, or for compatibility code for old data or deploy order during a rollout.

- Treat a new way to change production outside the `main` deploy as P1: production commands added to
  scripts or workflows, weakened `protect` or `retain`, or stage checks that confuse production with
  other stages. The existing manual recovery paths (the `deploy-infra.yaml` dispatch and
  `pnpm cluster deploy prod`) are intended. The safe path is `isProduction` in `infra/` and the
  `prod` overlay in `k3s/`.
- Treat a new pin (a version or digest added where none was, not a bump of an existing one) that
  Renovate can't update, or a new third-party download or image with no version (`releases/latest`,
  `:latest`), as P1, except a chart's own `version:` in `Chart.yaml`, the `apk` and `apt` package
  pins hadolint requires, server OS images like `ubuntu-24.04`, and vendor install scripts and
  generators like `tailscale.com/install.sh` and `shadcn-svelte@latest`. A version bump that misses
  one of its synced copies, like `Chart.yaml` and the `apps/*/kube` manifests that use it, is P1
  too. The safe path is a native Renovate manager or a `# renovate:` comment that a `renovate.json`
  custom manager matches. Checksums Renovate can't compute are bumped by hand with their version.
- Treat a real secret value in code, manifests, values, logs, or workflow output as P0. References
  like `sst.Secret` names, `${...}` placeholders, and `${{ secrets.* }}` are fine.
- Treat swallowed failures in CI checks, scans, builds, or deploys as P1, such as `|| true`, ignored
  exit codes, Trivy `exit-code: '0'`, or `continue-on-error`. The safe path is letting the step
  fail; a known upstream bug may be tolerated with a `TODO:` linking the issue, like `sst refresh`
  in `deploy-infra.yaml`. The best-effort `rollout status ... || true` waits in
  `scripts/cluster/deploy.sh` are intended too. Lint suppressions like `# hadolint ignore=` aren't
  swallowed failures.
- Treat missing wiring as P1, because the thing silently never gets built, tested, deployed, or
  scanned, and a skipped path-filtered job still passes its required check:
  - a new `infra/` module missing from `sst.config.ts`'s import graph;
  - a new app `kube/` directory missing from `k3s/base/apps`;
  - a new `${...}` manifest placeholder with no matching SST resource or computed variable in
    `scripts/cluster/deploy.sh`, which `pnpm cluster deploy` and Argo apply as literal text;
  - a new image or chart missing from the build, cleanup, and maintenance matrices, or a new image
    missing from the security scan;
  - a new tested package missing its filter and job in `tests.yaml`, or a new CI job missing from
    its `*-pass` aggregate's `needs`;
  - a new SST or Pages build input missing from the `deploy-infra.yaml` filters or `pathIncludes` in
    `infra/website.ts`.
