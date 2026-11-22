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

2. Setup the repository:

```sh
mise install
pnpm install
```

3. Configure an AWS SSO session and profile named `pandoks` for this AWS account with
   `aws configure sso`
   ([AWS CLI SSO guide](https://docs.aws.amazon.com/cli/latest/userguide/sso-configure-profile-token.html))
   — each developer signs in with their own IAM Identity Center user, while `mise.toml`
   (`AWS_PROFILE`) and `pnpm sso` (`package.json`) share the `pandoks` profile/session name (rename
   both if forking this repo). Then run `pnpm bootstrap` ([Bootstrap](#bootstrap)).

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

To setup the local cluster, run this from the root of the monorepo. Replace `<stack>` with your
personal Pulumi stack (for example, `pandoks`):

```sh
# Quick setup (all-in-one)
pulumi stack select <stack> && pnpm local:init

# Or step by step:
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to the local registry
pnpm cluster deploy local --stack <stack> --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local --stack <stack> # Apply environment overlay
```

To tear down the cluster:

```sh
pnpm local:destroy
```

See [scripts/cluster/README.md](./scripts/cluster/README.md) for more CLI commands,
[k3s/README.md](./k3s/README.md) for cluster architecture details, and
[packages/e2e/README.md](./packages/e2e/README.md) for e2e suites.

## Development

Everything outside Kubernetes is a [Pulumi](https://www.pulumi.com/docs/) program in `infra/`, with
one stack per stage (`production`, `dev`, and personal stacks like `pandoks`). State lives in the R2
bucket in `Pulumi.yaml`, and each `Pulumi.<stack>.yaml` names the KMS key that encrypts its state
and holds its secrets, encrypted with that key:

```sh
pulumi preview --stack <stack>
pulumi up --stack <stack>
# --raw keeps trailing newlines
pulumi config set --secret --raw --stack <stack> <Name> < <file>
```

A new stack needs every secret in `infra/secrets.ts` and a `Pulumi.<stack>.yaml` from
`pulumi stack init <stack> --no-select --secrets-provider 'awskms://alias/pulumi-nonproduction?region=us-west-1'`;
`production` exclusively uses `alias/pulumi-production`, the only key Argo CD can decrypt. Only the
shared `production` and `dev` files are committed, so their secrets change through a PR. A personal
stack's file stays local; `pulumi config refresh --stack <stack>` restores it from its last deploy.

### Bootstrap

`pnpm bootstrap` sets up the state bucket, KMS keys, R2 state tokens, this machine's profile and
CI's AWS role. It's safe to rerun, and on a new machine it only logs in and adds the profile.
