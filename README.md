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

3. Configure an AWS SSO profile in `~/.aws/config` and export it as `AWS_PROFILE`, in your shell or
   a gitignored `mise.local.toml`. `pnpm sso` logs in to sso session `personal`; change it in
   `package.json` to match. Then add the profile Pulumi reads its R2 state with, whose credentials
   come from SSM through your SSO login:

```sh
aws configure set profile.pandoks-pulumi-state.region auto
aws configure set profile.pandoks-pulumi-state.credential_process \
  'aws ssm get-parameter --region us-west-1 --name /pulumi/r2-state-credentials --with-decryption --query Parameter.Value --output text'
```

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

To setup the local cluster, run this from the root of the monorepo. Replace `your-stack` with your
personal Pulumi stack (for example, `pandoks`):

```sh
# Quick setup (all-in-one)
pulumi stack select your-stack && pnpm local:init

# Or step by step:
pnpm cluster k3d deps up               # Start docker compose dependencies
pnpm cluster k3d up                    # Create k3d cluster
pnpm local:build && pnpm local:push    # Build and push images/charts to the local registry
pnpm cluster deploy local --stack your-stack --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy local --stack your-stack # Apply environment overlay
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
bucket in `Pulumi.yaml`, each `Pulumi.<stack>.yaml` names the KMS key that encrypts it, and every
secret in `infra/secrets.ts` is an SSM `SecureString` at `/pulumi/<stack>/<Name>`:

```sh
pulumi preview --stack your-stack
pulumi up --stack your-stack
# file:// keeps the value byte for byte; write it with printf '%s' to avoid a trailing newline
aws ssm put-parameter --overwrite --type SecureString --name /pulumi/your-stack/<Name> --value file://<file>
```

A new stack needs every secret in `infra/secrets.ts` and a committed `Pulumi.<stack>.yaml` from
`pulumi stack init your-stack --no-select --secrets-provider 'awskms://alias/pulumi-nonproduction?region=us-west-1'`.
Other development commands:

```sh
pnpm --filter web dev           # website
pnpm cluster k3d restart        # restart the local cluster
pnpm cluster k3d deps restart   # restart its docker compose dependencies
```
