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
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/checks.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/checks.yaml/badge.svg" alt="Checks"></a>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/tests.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/tests.yaml/badge.svg" alt="Tests"></a>
    <a href="https://github.com/Pandoks/pandoks.com/actions/workflows/security.yaml"><img src="https://github.com/Pandoks/pandoks.com/actions/workflows/security.yaml/badge.svg" alt="Security"></a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/pnpm-11-F69220?logo=pnpm&logoColor=white" alt="pnpm 11">
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
- [OpenSSL](https://www.openssl.org/)
- [Tailscale](https://tailscale.com/download), only for production cluster access

2. Setup `.env.<stage>`. Take a look at [.env.example](/.env.example) as a reference.

3. Setup the repository:

```sh
mise install
pnpm install
```

4. Configure AWS SSO session in `~/.aws/config`. `pnpm sso` points to sso session `personal`, but
   you can change it to whatever you want in `package.json`.

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

To setup the local cluster, run this from the root of the monorepo:

```sh
# Quick setup (all-in-one)
pnpm dev:init

# Or step by step:
pnpm cluster k3d deps up             # Start docker compose dependencies
pnpm cluster k3d up                  # Create k3d cluster
pnpm cluster deploy dev --bootstrap  # First-time: install helm charts + CRDs
pnpm cluster deploy dev              # Apply environment overlay
```

To tear down the cluster:

```sh
pnpm dev:destroy
```

See [scripts/cluster/README.md](./scripts/cluster/README.md) for more CLI commands and [k3s/README.md](./k3s/README.md) for cluster architecture details.

## Development

For things that are not deployed to Kubernetes, they are managed by `sst`. To run the development
server, run this from the root of the monorepo:

```sh
pnpm dev # assuming that you are still verified via SSO
```
