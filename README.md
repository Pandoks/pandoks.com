<div align="center">
  <a href="https://pandoks.com">
    <img src="./apps/web/static/favicon/favicon.svg" alt="Pandoks" width="96" height="96">
  </a>

  <h1>Pandoks</h1>

  <p>
    Everything Pandoks, in one monorepo.<br>
    Applications, infrastructure, clusters, automation, and development tooling.
  </p>

  <p>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/pipeline.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/pipeline.yaml/badge.svg" alt="Pipeline"></a>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/security-audit.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/security-audit.yaml/badge.svg" alt="Security Audit"></a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white" alt="pnpm 12">
    <img src="https://img.shields.io/badge/toolchain-mise-8B5CF6" alt="Managed with mise">
  </p>

  <p>
    <a href="#getting-started">Getting Started</a> ·
    <a href="#local-kubernetes-cluster">Local Kubernetes</a> ·
    <a href="#development">Development</a>
  </p>
</div>

# Getting Started

1. Install these dependencies before setting up the repository:

- [Git](https://git-scm.com/downloads) and [mise](https://mise.jdx.dev/installing-mise.html)
- [Docker](https://docs.docker.com/get-docker/)
- [Tailscale](https://tailscale.com/download), only for cloud (dev/prod) cluster access

2. Setup this machine (installs `mise` tools and `pnpm` dependencies, runs `aws configure sso` if
   the `pandoks-dev` profile isn't configured yet, signs into AWS SSO, configures the Pulumi state
   profile, and verifies state access — safe to rerun via `pnpm setup`):

```sh
./scripts/setup.sh
```

Each developer signs in with their own IAM Identity Center user
([AWS CLI SSO guide](https://docs.aws.amazon.com/cli/latest/userguide/sso-configure-profile-token.html))
into the `pandoks-dev` AWS account, while `mise.toml` (`AWS_PROFILE=pandoks-dev`) and `pnpm sso`
(`--sso-session=pandoks`) share the local profile/session names. Developers do **not** need a
Cloudflare, Hetzner, or production AWS login — AWS SSO unlocks the R2 state credentials (via SSM)
and decrypts non-production provider tokens (via KMS) automatically.

> [!NOTE]
> AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm sso` again once in a while

## Local Kubernetes Cluster

Although not all of the apps are deployed to Kubernetes, majority of the services are running in a
cluster. To make development easier, we can use a local Kubernetes cluster ([k3d](https://k3d.io/))
to run a copy of the production cluster. This makes it so that majority of the times, we can work
offline or test certain features without having to deploy to a full fledged Kubernetes cluster in
the cloud. _Because we're using k3d, which puts an entire Kubernetes cluster inside of docker
containers, not everything is one to one with the production cluster. ie. networking, registries,
etc_

To setup the local cluster, run this from the root of the monorepo (`local` defaults to the shared
`dev` stack outputs):

```sh
# Quick setup (all-in-one)
pnpm local:init

# Or step by step:
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to the local registry
pnpm cluster deploy local --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local              # Apply environment overlay
```

To tear down the cluster:

```sh
pnpm local:destroy
```

See [scripts/cluster/README.md](./scripts/cluster/README.md) for more CLI commands,
[k3s/README.md](./k3s/README.md) for cluster architecture details, and
[packages/e2e/README.md](./packages/e2e/README.md) for e2e suites.

## Development

Everything outside Kubernetes is a [Pulumi](https://www.pulumi.com/docs/) program in `infra/`, split
across two AWS member accounts and three stack tiers:

- **`production`** (`Pulumi.production.yaml`, committed) — deploys into **`pandoks-production`**
  only via GitHub Actions on `main`, encrypted with `alias/pulumi-production`.
- **`dev`** (`Pulumi.dev.yaml`, committed) — deploys into **`pandoks-dev`**, encrypted with
  `alias/pulumi-nonproduction`. Owns the single shared dev Kubernetes cluster, EC2 runner AMIs, R2
  backup bucket, Tailscale k8s operator, and `dev` GitHub environment.
- **Personal stacks** (`<name>`, local gitignored `Pulumi.<name>.yaml`) — deploy into
  **`pandoks-dev`**, encrypted with `alias/pulumi-nonproduction`. Only provision cheap, isolated
  per-stack app infra (`<name>-*`, `api.<name>.pandoks.com`) without colliding with `dev` or
  duplicating the shared cluster/runners.

State for every stack lives in the Cloudflare R2 bucket in `Pulumi.yaml`, and each
`Pulumi.<stack>.yaml` pins `aws:allowedAccountIds` so Pulumi refuses to run against the wrong AWS
account:

```sh
pulumi preview --stack <stack>
pulumi up --stack <stack>

# Set a secret on dev or a personal stack (prompts silently; use --raw < <file> for multiline keys)
pulumi config set --secret --stack <stack> <Name>
pulumi config set --secret --raw --stack <stack> <Name> < <file>

# Set a secret on production (explicit AWS_PROFILE=pandoks-production; ship Pulumi.production.yaml via PR)
AWS_PROFILE=pandoks-production pulumi config set --secret --stack production <Name>
```

To initialize a personal stack:

```sh
pulumi stack init <name> --no-select --secrets-provider 'awskms://alias/pulumi-nonproduction?region=us-west-1'
pulumi config set --path 'aws:allowedAccountIds[0]' <pandoks-dev-account-id> --stack <name>
```

A personal stack needs every secret in `infra/secrets.ts`; its file stays local and
`pulumi config refresh --stack <name>` restores it from its last deploy. Only the shared
`production` and `dev` files are committed, so their secrets change through a PR.

### Bootstrap

`pnpm bootstrap` (admin only, idempotent) sets up the cloud primitives for both AWS accounts in one
pass:

- **`pandoks-production`:** R2 state bucket, `alias/pulumi-production`, SSM R2 tokens
  (`/pulumi/r2-state-credentials` and `/pulumi/r2-state-read-credentials`), GitHub OIDC provider,
  `PandoksGithubActions` CI role, and GitHub repo variables (`AWS_ROLE_ARN`, `AWS_REGION`).
- **`pandoks-dev`:** `alias/pulumi-nonproduction`, SSM R2 token (`/pulumi/r2-state-credentials`,
  encrypted with `alias/pulumi-nonproduction`), and the local `pandoks-pulumi-state` AWS profile.

For onboarding a new laptop to an already-bootstrapped org, run `./scripts/setup.sh` (`pnpm setup`)
instead.

<details>
<summary>AWS accounts, IAM Identity Center (SSO) users, and team onboarding</summary>

#### How AWS Organizations & IAM Identity Center fit together

Think of AWS like GitHub:

| Analogy           | AWS concept                                               | Purpose in this repo                                                                                                           |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **GitHub Org**    | **Management ("root") account**                           | Billing, AWS Organizations, and IAM Identity Center (`us-west-1`). Runs **zero** app or CI workloads.                          |
| **GitHub Repos**  | **Member accounts** (`pandoks-production`, `pandoks-dev`) | Completely siloed 12-digit resource containers. Even `AdministratorAccess` in one cannot touch the other.                      |
| **GitHub Logins** | **IAM Identity Center (SSO) users**                       | One personal username + password + MFA per human (never shared). One SSO login can be assigned to one or many member accounts. |

CI/CD never uses SSO or the management account — GitHub Actions assumes `PandoksGithubActions`
directly inside `pandoks-production` via OIDC.

#### 1. Create the two AWS member accounts (once, from the management account)

1. In the management account, open **AWS Organizations → AWS accounts**.
2. Create two member accounts (each requires a unique root email address — e.g. separate email
   aliases):
   - **`pandoks-production`** — production stack only (CI + admin break-glass).
   - **`pandoks-dev`** — shared `dev` stack + every developer's personal stack.
3. Put each account's 12-digit ID in `aws:allowedAccountIds` inside `Pulumi.production.yaml` and
   `Pulumi.dev.yaml`, then run `pnpm bootstrap`.

#### 2. Onboard a developer (new IAM Identity Center SSO user)

Never create a new AWS account per developer — add a new **SSO user** instead:

1. In the management account, open **IAM Identity Center** (`us-west-1`) → **Users → Add user** (AWS
   emails them an invite to set their own password and MFA).
2. Go to **AWS accounts** and assign their user:
   - **`pandoks-dev`:** **`AdministratorAccess`** (required because `pulumi up` creates IAM roles;
     `PowerUserAccess` blocks IAM writes, and `pandoks-dev` is already siloed from production).
   - **`pandoks-production`:** **no access** for non-admin devs (optional: **`ReadOnlyAccess`** if
     they need to inspect production logs/resources). Admins get `AdministratorAccess` on both.
3. Grant them collaborator access to the GitHub repo (and invite them to Tailscale only if they need
   `kubectl`/SSH access to the cloud `dev` cluster).
4. On their machine, they run `./scripts/setup.sh`, enter the SSO start URL and region when
   prompted, name the SSO session `pandoks`, and pick `pandoks-dev` — no Cloudflare, Hetzner, or
   production AWS credentials needed.

#### 3. Cloudflare separation

Because `pandoks.com` lives in one Cloudflare account, production and non-production are separated
with **separate scoped API tokens** stored in `Pulumi.production.yaml` vs `Pulumi.dev.yaml`
(Account: Pages, R2, Filter Lists, Rulesets; Zone `pandoks.com`: Zone Read, DNS Edit, SSL/Origin
CA). Developers only need a Cloudflare account invite (**Manage Account → Members**) if they need
dashboard access; Pulumi authenticates using the decrypted `CloudflareApiKey` from the stack.

</details>
