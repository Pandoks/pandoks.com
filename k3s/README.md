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

Once you are happy with your local k3d cluster, you can deploy it to a vps either for production or
for most development/testing. _Remember to wait for all the nodes to be ready before deploying_.

```sh
pnpm run k3s:remote <username>@<ssh-hostname>
pnpm run ssh:tunnel <username>@<ssh-hostname>
# NOTE: usually ip-pool-range is 10.0.1.100-10.0.1.200
# look at the output of K3sSubnet in the outputs of the Hetzner deployment
pnpm run k3s:setup --ip-pool <ip-pool-range>
```

## k9s

### Local Development

`k3d` will automatically setup the kubeconfig and context for you. If the context changes, you can
run these commands to switch to the correct context:

```sh
kubectl config get-contexts
kubectl config use-context <context-name>
```

**NOTE:** `k3d` is setup to use port 6444 for the local k3s cluster so that it doesn't conflict with
the remote k3s through ssh tunneling.

### Production/SSH Vps

To access you k3s cluster on your vps or production environment, you need to use the ssh tunnel and
also have a copy of the kubeconfig on your local machine. You can use the following commands to
setup the kubeconfig and ssh tunnel:

```sh
pnpm run k3s:remote <username>@<ssh-hostname>
pnpm run ssh:tunnel <username>@<ssh-hostname>
```

Once you have the kubeconfig and the ssh tunnel setup, you can connect to the cluster with:

```sh
k9s --kubeconfig ./k3s.yaml
```

You can also normally use `kubectl` to access the cluster:

```sh
kubectl --kubeconfig ./k3s.yaml get pods
```
