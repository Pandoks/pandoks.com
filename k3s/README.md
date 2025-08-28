# K3s

This is the k8s clsuter that hosts most of the applications in this monorepo. The applications that
are not hosted in this cluster are hosted either in AWS or Cloudflare usually for serverless
applications. For databases, it is better to used a managed database as it reduces the operational
overhead.

As it stands, the cluster is hosted on Hetzner VPS's.

## Local Development

For local development, we use [k3d](https://k3d.io/) to create a local k3s cluster.

To setup the cluster, run the following commands from the root of the project:

```sh
pnpm run cluster:create
pnpm run cluster:setup
```

If you want to add the cluster to a docker network, like running it with the local docker compose
dependencies:

```sh
pnpm run cluster:create --network <network-name>
```

You can also set everything up including adding the cluster to the dependency docker compose network
with:

```sh
pnpm run setup
```

## Production/SSH Vps

Once you are happy with your local k3s cluster, you can deploy it to a vps either for production or
for most development/testing.
