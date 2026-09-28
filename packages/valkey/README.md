# Valkey

This implements [Valkey](https://valkey.io/) clusters as a Helm chart.

## Usage

We use the [HelmChart](https://docs.k3s.io/add-ons/helm) kind to install our Valkey cluster:

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: <namespace>-valkey-<name>-cluster
  namespace: kube-system # the helm chart controller that k3s uses needs to be in the kube-system namespace
spec:
  chart: oci://${ImageRegistry}/charts/valkey
  version: 0.1.0
  targetNamespace: &namespace <namespace>
  createNamespace: true
  failurePolicy: abort
  plainHTTP: ${IsLocal}
  set:
    field: string value
```

`${ImageRegistry}`, `${ImageTag}`, and `${IsLocal}` are substituted by `pnpm cluster deploy`, so the
same manifest pulls from `local-registry:5000` locally and `ghcr.io/pandoks` in the cloud. See
[apps/example/kube/valkey.yaml](/apps/example/kube/valkey.yaml) for a full example.

The default values are in [values.yaml](./chart/values.yaml). The common values to set are:

```yaml
spec:
  set:
    name: <name>
    namespace: <namespace>
    image: ${ImageRegistry}/valkey:${ImageTag}
    cluster.reconcilerImage: ${ImageRegistry}/valkey-reconciler:${ImageTag}
    persistence: ~ # No persistence by default (options: rdb,aof | rdb | aof | ~)
    cluster.masters: <number of masters>
    cluster.replicasPerMaster: <number of replicas per master>
    credentials.secret: <secret name>
    credentials.dataKeys.adminPassword: <key for admin password in secret>
    credentials.dataKeys.clientPassword: <key for client password in secret>
```

The chart expects the `valkey-reconciler` ClusterRole from
[k3s/base/core/valkey.yaml](/k3s/base/core/valkey.yaml) and the Prometheus Operator CRDs (for its
`ServiceMonitor`) to already be in the cluster.

### Scaling

It is recommended to scale up the cluster by adding more masters as reading from replicas is not standard.
Replicas are generally only used for HA and are rarely used for reading. This is because the cluster
auto shards the slots across the masters so the benefits of reading from replicas are lost when there
are many masters. You tend to only need 1-2 replicas per master. Replicas also usually contain
stale data because they're not completely synced with the masters.

Changing `cluster.masters` or `cluster.replicasPerMaster` is handled by the
[reconciler](#reconciler) hooks, which move slots off removed masters and rebalance slots onto new
ones.

### Local Development

The registry and tag are templated, so local patches only need to make the hook jobs fail fast and
stick around for debugging. Put them in the app's `dev-patch.yaml`. If you have multiple valkey
clusters, you put all of the patches in the same file:

```yaml
# apps/<app>/kube/dev-patch.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: <namespace>-valkey-<name>-cluster
  namespace: kube-system
spec:
  set:
    hooks.restartPolicy: Never
    hooks.backoffLimit: 0
    hooks.ttlSecondsAfterFinished: 86400 # 24 hours
    hooks.hookDeletePolicy: before-hook-creation
```

_If you haven't already, remember to add all `dev-patch.yaml` files to the `patches` in the
[/k3s/overlays/local/kustomization.yaml](/k3s/overlays/local/kustomization.yaml) file._

#### Images & Helm Charts

You'll have to build and push the images and chart at least once before the local k3d cluster can
pull them from the local registry (`localhost:12345` on your machine, `local-registry:5000` inside
the cluster):

```sh
pnpm build && pnpm dev:push
```

`pnpm docker:build && pnpm dev:push` from the repo root does this for every package.

If you make a change to the images or helm template run the build and push commands to make the changes
accessible to the local k3d cluster:

| Command                    | Description                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| `pnpm build:image`         | Builds the valkey docker image locally                                |
| `pnpm build:helm`          | Packages the helm chart into a `.tgz` locally                         |
| `pnpm build:reconciler`    | Builds the valkey reconciler docker image locally                     |
| `pnpm build`               | All of the build commands above                                       |
| `pnpm dev:push:image`      | Pushes the local valkey image to the local k3d registry               |
| `pnpm dev:push:helm`       | Pushes the local helm chart package to the local k3d registry via oci |
| `pnpm dev:push:reconciler` | Pushes the local valkey reconciler image to the local k3d registry    |
| `pnpm dev:push`            | All of the push commands above                                        |
| `pnpm test`                | Runs the reconciler Go tests                                          |

## Reconciler

[reconciler](./reconciler) is a Go CLI that the chart runs as Helm hook jobs to manage the cluster
topology:

| Hook           | Command      | Description                                                        |
| -------------- | ------------ | ------------------------------------------------------------------ |
| `post-install` | `init`       | Creates the cluster from the initial masters and replicas          |
| `pre-upgrade`  | `scale-down` | Moves slots off masters being removed, then removes excess nodes   |
| `post-upgrade` | `scale-up`   | Adds new masters and replicas, then rebalances slots across shards |

## Configuration

There are two configuration files that are used by the valkey cluster: `valkey.conf` and `users.acl`.
They live in [chart/files](./chart/files) and are both templated so that `envsubst` can be used to
inject secrets into the configuration files via env variables. All clusters use the same templated configuration files via config maps.

The `valkey.conf` file is used to configure the valkey cluster. The `users.acl` file is used to
configure the users that can access the cluster.

### valkey.conf

[valkey.conf](./chart/files/valkey.conf) is used to configure the valkey cluster.

For more information about the configuration options, visit [valkey.io/topics/configuration](https://valkey.io/topics/valkey.conf/).

### users.acl

[users.acl](./chart/files/users.acl) is used to configure the users that can access the cluster.

For better security practices, we use multiple users to access the cluster. We have an **admin** user
and a **client** user:

| User   | Description                          | Permissions                                      |
| ------ | ------------------------------------ | ------------------------------------------------ |
| admin  | Has full access to the cluster       | All permissions                                  |
| client | Has read/write access to the cluster | Read, Write, String, Hash, List, Set, Sorted Set |

_The **client** user doesn't have dangerous permissions like `FLUSHALL`, `CONFIG`, etc._

For more information about the permissions, visit [valkey.io/topics/acl](https://valkey.io/topics/acl/).

#### Permissions Cheat Sheet

| Permission Symbol | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `on`              | Enables the user                                                        |
| `~<pattern>`      | Key access pattern (`~*` means all keys)                                |
| `&<pattern>`      | Pub/Sub channel pattern (`&*` means all channels)                       |
| `+@<category>`    | Allow command category (`+@all`, `+@read`, `+@write`, etc.)             |
| `-@<category>`    | Deny command category (`-@dangerous` blocks `FLUSHALL`, `CONFIG`, etc.) |
| `+<command>`      | Allow specific command                                                  |
| `-<command>`      | Deny specific command                                                   |
