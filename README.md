# Pandoks 🐼

All things that are related to Pandoks runs on this monorepo. Over time, some of these will branch
off into their own repos, but for now, they are all here.

# Getting Started

Look at [.env.example](/.env.example) and create `.env.<stage>` files. During _development_, you'll
want to use the `.env.<dev-stage>` file where `<dev-stage>` is your local machine's username.
[`sst`](https://sst.dev/) will automatically use the `.env.<dev-stage>` file if you don't specify a
`--stage` flag. During _production_, you'll want to use the `.env.production` file. You'll also have
to specify a `--stage production` flag.

Once you have created your `.env` files, run this from the root of the monorepo to set it up for
development:

```sh
pnpm install
pnpm run sso
pnpm sst install
```

> [!NOTE] AWS SSO only verifies you for 12 hours, so you'll have to run `pnpm run sso` again once in
> a while

<details>
  <summary>Dependencies</summary>
  <ul>
    <li><a href="https://nodejs.org/en/">Node.js</a> >= v22</li>
    <li><a href="https://pnpm.io/">pnpm</a> >= v10</li>
    <li><a href="https://docs.docker.com/get-docker/">Docker</a> >= v20</li>
    <li><a href="https://k3d.io/">k3d</a> >= v5.8</li>
    <li><a href="https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html">awscli</a> >= v2.13</li>
  </ul>
</details>

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
pnpm run setup
pnpm run cluster:secrets # assuming that you are still verified via SSO
pnpm run cluster:build
pnpm run cluster:push
pnpm run cluster:deploy
```
# Apps

# Packages

# Infra
