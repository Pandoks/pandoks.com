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
    <img src="https://img.shields.io/badge/Pulumi-IaC-8A3391?logo=pulumi&logoColor=white" alt="Pulumi">
    <img src="https://img.shields.io/badge/K3s-Kubernetes-FFC61C?logo=k3s&logoColor=black" alt="K3s">
    <img src="https://img.shields.io/badge/mise-toolchain-8B5CF6" alt="Managed with mise">
  </p>

  <p>
    <a href="#getting-started">Getting Started</a> ·
    <a href="#local-kubernetes">Local Kubernetes</a> ·
    <a href="#infrastructure">Infrastructure</a> ·
    <a href="#bootstrap">Bootstrap</a>
  </p>
</div>

---

| Directory    | Contents                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `apps/`      | Deployable apps (`web`, `functions`, `example`)                                                                |
| `packages/`  | Shared libraries, Helm charts & images (`svelte`, `postgres`, `clickhouse`, `valkey`, `argocd`, `e2e`)         |
| `templates/` | Starter apps (`desktop`, `mobile`, never deployed)                                                             |
| `infra/`     | [Pulumi](https://www.pulumi.com/docs/) cloud infrastructure (AWS, Cloudflare, Hetzner, OVH, Tailscale, GitHub) |
| `k3s/`       | Kustomize overlays & ArgoCD config ([k3s/README.md](./k3s/README.md))                                          |
| `scripts/`   | Setup, bootstrap, lint/format & cluster CLI ([scripts/cluster/README.md](./scripts/cluster/README.md))         |

## Getting Started

**Prerequisites:** [Git](https://git-scm.com/downloads),
[mise](https://mise.jdx.dev/installing-mise.html), [Docker](https://docs.docker.com/get-docker/),
and _(cloud clusters only)_ [Tailscale](https://tailscale.com/download).

```sh
./scripts/setup.sh
```

Installs `mise` tools and `pnpm` dependencies, configures/signs into `pandoks-dev` AWS SSO, sets up
the Pulumi R2 state profile, and verifies access (idempotent — rerun anytime). Developers only need
an IAM Identity Center login for `pandoks-dev` — no Cloudflare, Hetzner, or production AWS
credentials.

> [!NOTE]
> AWS SSO sessions expire every 12 hours — run `pnpm sso` to refresh.

## Local Kubernetes

Run a local K3s mirror in Docker with [k3d](https://k3d.io/) (`local` reads shared outputs from the
`dev` stack):

```sh
pnpm local:init      # Start deps, create k3d cluster, build/push images, bootstrap & deploy
pnpm local:destroy   # Tear down cluster and local dependencies
```

<details>
<summary>Step-by-step local cluster commands</summary>

```sh
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to local registry
pnpm cluster deploy local --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local              # Apply local overlay
```

</details>

More docs: [scripts/cluster/README.md](./scripts/cluster/README.md) ·
[k3s/README.md](./k3s/README.md) · [packages/e2e/README.md](./packages/e2e/README.md)

## Infrastructure

`infra/` is a Pulumi program (generic helpers in `packages/infra/`) backed by Cloudflare R2 state
(`Pulumi.yaml`), split across two AWS accounts and three stack tiers (each `Pulumi.<stack>.yaml`
pins `aws:allowedAccountIds`):

| Stack        | File                             | AWS Account          | KMS Key                      | Scope & Deploy                                                    |
| ------------ | -------------------------------- | -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `production` | `Pulumi.production.yaml` _(git)_ | `pandoks-production` | `alias/pulumi-production`    | Full prod infra; deployed **only** by GitHub Actions on `main`    |
| `dev`        | `Pulumi.dev.yaml` _(git)_        | `pandoks-dev`        | `alias/pulumi-nonproduction` | Shared dev cluster, EC2 runner AMIs, R2 backups, `dev` GitHub env |
| `<name>`     | `Pulumi.<name>.yaml` _(local)_   | `pandoks-dev`        | `alias/pulumi-nonproduction` | Isolated per-dev app infra (`<name>-*`, `api.<name>.pandoks.com`) |

```sh
# Preview & deploy (defaults to AWS_PROFILE=pandoks-dev via mise.toml)
pulumi preview --stack <stack>
pulumi up --stack <stack>

# Initialize a personal stack (copies aws:allowedAccountIds & non-prod secrets from dev)
pulumi stack init <name> --no-select \
  --secrets-provider 'awskms://alias/pulumi-nonproduction?region=us-west-1' \
  --copy-config-from dev

# Set secrets (--raw < <file> for multiline keys)
pulumi config set --secret --stack <stack> <Name>
AWS_PROFILE=pandoks-production pulumi config set --secret --stack production <Name>
```

> [!TIP]
> Personal stack files stay gitignored — `pulumi config refresh --stack <name>` restores them from
> state. `production` and `dev` secrets ship via PR.

## Bootstrap

**Admin-only** one-time setup for both AWS accounts (idempotent — rerun anytime; developers use
`./scripts/setup.sh` instead):

```sh
pnpm bootstrap
```

- **`pandoks-production`:** R2 state bucket, `alias/pulumi-production`, SSM R2 tokens
  (`/pulumi/r2-state-credentials`, `/pulumi/r2-state-read-credentials`), GitHub OIDC +
  `PandoksGithubActions` role, and GitHub repo vars (`AWS_ROLE_ARN`, `AWS_REGION`).
- **`pandoks-dev`:** `alias/pulumi-nonproduction`, SSM R2 token (`/pulumi/r2-state-credentials`),
  and local `pandoks-pulumi-state` AWS profile.

<details>
<summary>AWS Organizations, IAM Identity Center (SSO) & Cloudflare token setup</summary>

- **Management account:** billing, AWS Organizations, and IAM Identity Center (`us-west-1`) — runs
  no workloads.
- **Member accounts (`pandoks-production`, `pandoks-dev`):** hard-siloed 12-digit resource
  containers; permissions never cross accounts.
- **SSO users:** personal logins (with MFA) assigned to member accounts. Adding a new developer
  always means adding an **SSO user**, never a new AWS account. CI uses OIDC, not SSO.

#### 1. Initial AWS Setup (once)

1. Create an AWS **management account**, open **AWS Organizations → AWS accounts**, and create two
   member accounts (`pandoks-production` and `pandoks-dev`, unique root email alias each).
2. Enable **IAM Identity Center** in `us-west-1` and create the `AdministratorAccess` permission set
   (plus `ReadOnlyAccess` if needed).
3. Put each member account's 12-digit ID in `aws:allowedAccountIds` in `Pulumi.production.yaml` and
   `Pulumi.dev.yaml`, then run `pnpm bootstrap`.

#### 2. Add a Developer (SSO user)

1. In **IAM Identity Center** (`us-west-1`) → **Users → Add user**.
2. Assign their user `AdministratorAccess` on **`pandoks-dev`** (no access on `pandoks-production`,
   or `ReadOnlyAccess` for logs; admins get `AdministratorAccess` on both).
3. Add them to the GitHub repo (and Tailscale if they need cloud `dev` cluster access).
4. On their laptop, they run `./scripts/setup.sh` and pick `pandoks-dev`.

#### 3. Cloudflare Token Scoping

`pandoks.com` lives in one Cloudflare account, isolated via two scoped Account API tokens
(`CloudflareApiKey` in `Pulumi.production.yaml` vs `Pulumi.dev.yaml`):

- **Both tokens:** Zone policy locked strictly to `pandoks.com` (`Zone: Read`, `DNS: Edit`,
  `SSL and Certificates: Edit`, `Workers Routes: Edit`) + Account Developer Platform
  (`Workers: Admin`, R2, D1, KV, Queues, AI, Images, Stream). Neither gets `Account & Billing`,
  `Registrar`, `Account API Tokens`, `Zero Trust`, `Zone Write`, or other domains.
- **Prod only:** `Pages: Edit`, `Account Rulesets` / `Account Rule Lists` /
  `Mass URL Redirects: Edit`, `Secrets Store: Edit`, and `pandoks.com` edge security/cache controls.

</details>
