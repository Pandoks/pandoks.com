# Pandoks.com

## Overview

### Workflow

Pandoks.com uses [SST](https://sst.dev/) to manage all of its infrastructure. We try to use as
little providers as possible. Currently we use AWS, Cloudflare, and OVH for actual compute
infrastructure, but this may change if we start needing more and more GPUs. For management
infrastructure, we use Tailscale and GitHub. Ideally we can stay as close to the metal and rely on
as little managed 3rd party services as possible.

For compute, we rely on OVH machines. For things that need higher availability and reliability, we
rely on AWS and Cloudflare. Because we're working near the metal, we use K3s and ArgoCD to make
things easier to manage.

Using SST, we are able to manage different environments and stages. The `production` stage obviously
has it's own infrastructure and is protected from accidental deletions. Although you can manage
production environments manually via SST, we should be using GitHub Actions to deploy to production
via ArgoCD. Only resort to manual deployments if we need to fix something manually. In general,
avoid touching production as much as possible unless it's absolutely necessary.

There is also a `development` stage that is used for staging environments for PRs and testing before
merging to `main` and thus deploying to production. This is mainly to manage the dev K3s cluster so
that we don't have to spin up a new cluster for every PR. Other changes though that don't need to be
deployed to a cluster would be deployed to the PR's specific stage ie. infrastructure changes that
changes the IAC, or general changes that don't affect the infrastructure.

During development, developers will first manage their own local `k3d` cluster so that they can
iterate quickly on their changes. Each developer has their own SST stage too to test changes that
need infrastructure changes or general features from SST. Once they are satisfied with their changes
and all of the guardrails have been passed, they will then be able to create a PR to the `main`
branch. Depending on the change, CI/CD may have deployed some of the changes to a PR specific SST
stage to be able to run tests on them. If you add the `preview` label to the PR, it will deploy the
PR to it's own SST stage (if it hasn't already during CI/D) and also deploy certain changes to the
`development` stage's K3s cluster. If the change is cluster control plane related, it will apply it
the the entire `development` SST stsage's K3s cluster. It will not deploy anything even if you apply
the `preview` label to the PR if CI/CD hasn't passed though, so you should test heavily locally on
`k3d` and also make sure that all CI/CD checks pass.

### `apps`

This includes all deployable applications and also templates that are meant to be used to bootstrap
new applications. Templates and examples are not meant to be deployed to production, but they are
there to be used as a starting point and also to set the standards for all applications.

### `infra`

This includes all IAC that is managed by SST in @sst.config.ts. When writing infrastrcuture, we try
to separate the code out as much as possible such that it is split by responsibilities:
`secrets.ts`. If the repsonsibility is small enough, we can merge everything into one file and just
have it as the provider's file: `github.ts`. When the responsibilities are large enough and need
many different files that aren't shared by other responsbilities, we use a dedicated directory for
that responsibility: `vps/`.

### `k3s`

This is the entrypoint to K3s configurations and yamls. Applications in `apps/` define their own
`kube/` directory that acts as their own entrypoints. This directory just takes care of the core
control plane, imports and orchestrates how all the different applications' `kube/` fit into the
cluster and also how everything splits between different environments, namespaces, and sst stages.

### `packages`

This includes reusable building blocks (libraries, helm charts, container images, etc.) that apps
and infrastructure can use.

### `scripts`

This holds developer and ops scripts. Ideally everything in here can be in posix shell scripts, but
sometimes they're ran in environments where the default is `bash` and also sometimes it's just not
possible to use only shell ie. `sst-resources.ts`.

## Development

## Pull Requests



## Testing

## Implementation Style

- Versions are pinned to a specific version and fully managed by Renovate unless frequent version
  bumps break things too much to be worth it.
  - Whenever there is a situation where you have to sync versions in multiple places, pin the
    version in each location and use Renovate to keep them in sync.
- Make sure that all lints, formatting, and tests pass when you make changes.
  - If your change is a special and you think that the guardrails are too strict, ask for help on
    what you should do? Either abide by the guardrails or ask for the guardrails to be relaxed.
- There should be no LSP errors, warnings, or hints besides unused variables that are included for
  the purpose of understanding or to future changes easier to setup and understand.
  - Make sure that when you check against the LSP, the LSP is setup properly.
  - Make sure that everything that you see is consistent with what a developer using Neovim on the
    same machine would see. They may have their neovim setup differently so you should setup your
    LSP to be consistent with what they have.
  - Don't sacrifice conciseness and readability for the sake of LSP. If you see yourself using too
    many definitions, `any`/`unknown` types or their equivalents in other languages, you should
    let the developer know that there may be some LSP flags that are begning or not worth handling.
- Consistent styling should be taken into account. Look at the existing committed code and staged
  changes and follow the same style.
- When implementing something, make sure to look around the codebase to see if it is already
  implememented or if there are small changes that can be made to existing code to create the
  functionality that you need ie. small extensions to existing code.
  - If there is nothing, see if there are certain patterns that you can use to implement the feature
    that you need.
  - Implementations should be designed as generic as possible and ideally they can be written in
    `packages/` and used by multiple applications when possible.
- Avoid comments as much as possible unless it's for LSP annotations or it passes these conditions:
  -
