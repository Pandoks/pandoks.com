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
  chart: oci://ghcr.io/pandoks/charts/valkey
  version: 0.1.0
  targetNamespace: &namespace <namespace>
  createNamespace: true
  failurePolicy: abort
  set:
    field: string value
```

The default values are in [values.yaml](./chart/values.yaml). The common values to set are:

```yaml
spec:
  set:
    name: <name>
    namespace: <namespace>
    persistence: ~ # No persistence by default (options: rdb,aof | rdb | aof | ~)
    cluster.masters: <number of masters>
    cluster.replicasPerMaster: <number of replicas per master>
    credentials.secret: <secret name>
    credentials.dataKeys.adminPassword: <key for admin password in secret>
    credentials.dataKeys.clientPassword: <key for client password in secret>
```

### Scaling

It is recommended to scale up the cluster by adding more masters as reading from replicas is not standard.
Replicas are generally only used for HA and are rarely used for reading. This is because the cluster
auto shards the slots across the masters so the benefits of reading from replicas are lost when there
are many masters. You tend to only need 1-2 replicas per master. Replicas also usually contain
stale data because they're not completely syned with the masters.

### Local Development

If you want to develop locally, you'll need to patch your Helm chart yaml declarations in each namespaced
directory's `dev-patch.yaml`. If you have multiple valkey clusters, you put all of the patches in the
same file:

```yaml
# kube/<namespace>/dev-patch.yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: <namespace>-valkey-<name>-cluster
  namespace: kube-system
spec:
  chart: oci://local-registry:5000/charts/valkey
  plainHTTP: true
  set:
    image: local-registry:5000/valkey:latest
    cluster.reconcilerImage: local-registry:5000/valkey-reconciler:latest
    hooks.restartPolicy: Never
    hooks.backoffLimit: 0
    hooks.ttlSecondsAfterFinished: 86400 # 24 hours
    hooks.hookDeletePolicy: before-hook-creation
```

_If you haven't already, remember to add all `dev-patch.yaml` files in the
[/k3s/dev/kustomization.yaml](/k3s/dev/kustomization.yaml) file._

#### Images & Helm Charts

You'll have to build and push the chart at least once before the local k3d cluster can access the local
images/helm chart via the local registry that are used in the `dev-patch.yaml` declarations:

```sh
pnpm run build && pnpm run push
```

If you make a change to the images or helm template run the build and push commands to make the changes
accessible to the local k3d cluster:

| Command                     | Description                                                           |
| --------------------------- | --------------------------------------------------------------------- |
| `pnpm run build:image`      | Builds the valkey docker image locally                                |
| `pnpm run build:helm`       | Packages the helm chart into a `.tgz` locally                         |
| `pnpm run build:reconciler` | Builds the valkey reconciler docker image locally                     |
| `pnpm run build`            | All of the build commands above                                       |
| `pnpm run push:image`       | Pushes the local valkey image to the local k3d registry               |
| `pnpm run push:helm`        | Pushes the local helm chart package to the local k3d registry via oci |
| `pnpm run push:reconciler`  | Pushes the local valkey reconciler image to the local k3d registry    |
| `pnpm run push`             | All of the push commands above                                        |

## Configuration

There are two configuration files that are used by the valkey cluster: `valkey.conf` and `users.acl`.
They are both templated so that `envsubst` can be used to inject secrets into the configuration files
via env variables. All clusters use the same templated configuration files via config maps.

The `valkey.conf` file is used to configure the valkey cluster. The `users.acl` file is used to
configure the users that can access the cluster.

### valkey.conf

[valkey.conf](./valkey.conf) is used to configure the valkey cluster.

For more information about the configuration options, visit [valkey.io/topics/configuration](https://valkey.io/topics/valkey.conf/).

### users.acl

[users.acl](./users.acl) is used to configure the users that can access the cluster.

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
