# OVH hybrid k3s cluster

The cluster combines OVH Public Cloud instances and dedicated servers on one
vRack network. Cluster traffic uses the vRack network. Tailscale is only for
administrator SSH and Kubernetes API access.

The OVH Public Cloud project remains required even when every compute node is a
dedicated server. The stack creates and lifecycle-manages the project with
`ovh.cloudproject.Project`; its generated `projectId` is passed directly to the
vRack attachment, private network, subnet, gateway, private API load balancer,
public ingress load balancers, floating IPs, and Public Cloud instances. It is
not an environment variable or credential. Production enables both OVH
deletion protection and Pulumi resource protection for the project. Do not
cancel or unprotect the project when migrating compute to dedicated servers.

The US project order uses the current no-cost `project` catalog plan with
monthly duration and default pricing. A default OVH payment method is still
required for the order workflow. The deployed `CloudProjectId` SST output is
the generated project ID for operator visibility; consumers inside the stack
use the Pulumi output directly.

Cluster nodes receive no provider SSH key and public SSH is not an access path.
Administration uses Tailscale SSH as `pandoks`; recovery uses the OVH console or
rescue environment. The vRack is for cluster traffic, not administrator SSH.

## Configure node pools

Topology is stage-owned in `infra/cluster/config.ts`. Update
`PRODUCTION_CLUSTER_CONFIG` for production and `NON_PRODUCTION_CLUSTER_CONFIG`
for every other stage. All four pool counts are currently zero in both
configurations.

The four counts are independent. When a dedicated count becomes non-zero, fill
in that same TypeScript object with the exact current dedicated catalog fields
for the offer being enabled. Get the plan, datacenter, region, and required
options from the live OVH order cart; catalog values are not durable defaults.
Before committing or applying a non-zero dedicated count, validate the current
authenticated catalog and run an authenticated `sst diff`. Never copy catalog
values from an old preview or this runbook.

The private network is one `/16`; the third octet partitions allocation by
owner while every node remains directly reachable inside the same subnet:

```text
10.0.0.x              OVH/Neutron infrastructure
10.0.1.x              Public Cloud control planes
10.0.2.x              Public Cloud workers
10.0.3.x              Dedicated control planes
10.0.4.x              Dedicated workers
10.0.5.x              MetalLB services
10.0.6.x-10.0.255.x   Reserved
```

Neutron automatically allocates only `10.0.0.2-10.0.0.254`. Public Cloud
ports request their role-owned fixed IPs explicitly; dedicated nodes configure
the same `/16` statically. Pool validation rejects a count above the 254
addresses in a role block or more than 25 total control planes because the
private API load balancer is intentionally unsharded. Infrastructure demand
counts two conservative network reservations (DHCP service and gateway/router
ports), one private API VIP when control planes exist, and one public ingress
VIP per 25 ingress nodes.
OVH's public ingress load balancer sends PROXY v2 to node port `30443`, and
HAProxy Ingress has `use-proxy-protocol: "true"` so both ends of that transport
remain aligned.

Do not configure topology fields in GitHub environments. The TypeScript
configuration is the only topology source. All four counts must be non-negative
integers no greater than `254`. The aggregate control-plane and infrastructure
limits above still apply.
Production node resources use `protect: isProduction`: every production node is
protected and every non-production node is unprotected. Protection has no
environment-variable override.

## Update etcd monitoring endpoints

The checked-in `kubeEtcd.endpoints` inventory in
`k3s/overlays/cluster/prom-etcd-config.yaml` is `[]` because both checked-in
stage configurations currently have zero control planes. Before deploying a
non-empty topology, replace `[]` with its exact active control-plane IPs from
the normalized address plan. Remove endpoints for control planes being deleted
before deploying the overlay; never activate placeholder or planned addresses.

This is an **operator pre-deploy step**. Verify the edited list against the
intended control-plane pool counts before running the cluster deployment. This
inventory is intentionally explicit and is not generated dynamically by SST.

## TLS migration identity

The certificate files moved from `infra/vps/` to `infra/cluster/`, but the
intentional legacy identities `HetznerOriginTlsKey` and
`HetznerOriginTlsCrt` remain the deployed SST secret names. The Cloudflare certificate resource
`OvhOriginCloudflareCaCertificate` aliases the exact deployed
`HetznerOriginCloudflareCaCertificate` identity. Those legacy names preserve
the existing stage values and certificate; do not rename, reseed, regenerate,
or replace them during the OVH migration.

## Preview

```sh
./node_modules/.bin/sst diff --stage production
```

Run the preview with authenticated OVH provider access. Do not apply if a
provider lookup fails or the selected dedicated offer differs from the live
cart.

Reject a preview that replaces `OvhK3sVrack`, `OvhK3sPrivateNetwork`,
`OvhK3sSubnet`, `OvhK3sGateway`, existing protected compute, Cloudflare DNS, or
the aliased origin certificate. A compute-only migration must retain the Public
Cloud network, load balancers, and both legacy-named origin TLS secrets.

## Scale up

Increase one pool count in `infra/cluster/config.ts` and run `sst diff`. A new
dedicated node is ordered without an OS, attached to vRack, then installed
exactly once. Apply only after the diff contains additions and expected
load-balancer member updates.

After apply, wait for every new node to become Ready and verify its InternalIP is
in `10.0.0.0/16` and in the role-owned block above:

```sh
kubectl get nodes -o wide
```

## Migrate Public Cloud to dedicated

1. Add enough dedicated control-plane nodes that the dedicated set will retain
   an odd quorum of at least three after the Public Cloud control-plane nodes
   are removed.
2. Deploy and wait for every new node to become Ready.
3. Verify `kubectl get nodes -o wide` uses `10.0.0.0/16` internal addresses in
   the role-owned blocks above.
4. Verify `k3s etcd-snapshot ls` and etcd member health.
5. Add dedicated workers and verify workloads.
6. Drain and remove one Public Cloud node at a time by following the scale-down
   procedure below.
7. Stop at the production protection boundary. Do not reduce the matching count
   until a separate reviewed IaC change safely unprotects that exact resource.

Keep the Pulumi-managed Public Cloud project after the Public Cloud compute
counts reach zero. Dedicated nodes still use its network and load balancers.

## Scale down

Scale-down can remove only the highest-index node in one pool. For a pool count
of `N`, the only valid target index is `N - 1`. Never use this procedure to
remove an arbitrary lower index; restore or replace that node first.

| Pool                      | Count variable               | Production hostname prefix                 | Logical-resource prefix          |
| ------------------------- | ---------------------------- | ------------------------------------------ | -------------------------------- |
| `cloud-control-plane`     | `cloudControlPlaneCount`     | `prod-ovh-control-plane-server-`           | `OvhControlPlaneServer`          |
| `cloud-workers`           | `cloudWorkerCount`           | `prod-ovh-worker-server-`                  | `OvhWorkerServer`                |
| `dedicated-control-plane` | `dedicatedControlPlaneCount` | `prod-ovh-dedicated-control-plane-server-` | `OvhDedicatedControlPlaneServer` |
| `dedicated-workers`       | `dedicatedWorkerCount`       | `prod-ovh-dedicated-worker-server-`        | `OvhDedicatedWorkerServer`       |

Choose one table row. Set `POOL_NAME` and `POOL_COUNT` to that pool's exact
current value in `PRODUCTION_CLUSTER_CONFIG`; do not decrement it yet:

```sh
POOL_NAME=dedicated-control-plane
POOL_COUNT=3

case "${POOL_NAME}" in
  cloud-control-plane)
    COUNT_PROPERTY=cloudControlPlaneCount
    NODE_PREFIX=prod-ovh-control-plane-server-
    LOGICAL_PREFIX=OvhControlPlaneServer
    ;;
  cloud-workers)
    COUNT_PROPERTY=cloudWorkerCount
    NODE_PREFIX=prod-ovh-worker-server-
    LOGICAL_PREFIX=OvhWorkerServer
    ;;
  dedicated-control-plane)
    COUNT_PROPERTY=dedicatedControlPlaneCount
    NODE_PREFIX=prod-ovh-dedicated-control-plane-server-
    LOGICAL_PREFIX=OvhDedicatedControlPlaneServer
    ;;
  dedicated-workers)
    COUNT_PROPERTY=dedicatedWorkerCount
    NODE_PREFIX=prod-ovh-dedicated-worker-server-
    LOGICAL_PREFIX=OvhDedicatedWorkerServer
    ;;
  *)
    printf '%s\n' "Unsupported pool"
    exit 1
    ;;
esac

case "${POOL_COUNT}" in
  ''|*[!0-9]*|0)
    printf '%s\n' "POOL_COUNT must be the current positive count"
    exit 1
    ;;
esac

CONFIGURED_POOL_COUNT="$(
  node --input-type=module -e '
    import { PRODUCTION_CLUSTER_CONFIG } from "./infra/cluster/config.ts";
    const value = PRODUCTION_CLUSTER_CONFIG[process.argv[1]];
    if (!Number.isInteger(value)) process.exit(1);
    process.stdout.write(String(value));
  ' "${COUNT_PROPERTY}"
)"
[ "${CONFIGURED_POOL_COUNT}" = "${POOL_COUNT}" ]
TARGET_INDEX=$((POOL_COUNT - 1))
NODE_NAME="${NODE_PREFIX}${TARGET_INDEX}"
LOGICAL_NAME="${LOGICAL_PREFIX}${TARGET_INDEX}"
printf 'NODE_NAME=%s\nLOGICAL_NAME=%s\n' "${NODE_NAME}" "${LOGICAL_NAME}"
kubectl get node "${NODE_NAME}" -o wide
printf 'Confirm by typing %s: ' "${LOGICAL_NAME}"
read -r CONFIRMED_LOGICAL_NAME
[ "${CONFIRMED_LOGICAL_NAME}" = "${LOGICAL_NAME}" ]
TARGET_INTERNAL_IP="$(
  kubectl get node "${NODE_NAME}" \
    -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}'
)"
case "${TARGET_INTERNAL_IP}" in
  10.0.*.*) ;;
  *)
    printf '%s\n' "Target InternalIP is outside 10.0.0.0/16"
    exit 1
    ;;
esac
```

This derives both names from the selected pool's current highest index. If the
configuration lookup, node lookup, logical-name confirmation, or InternalIP
check fails, stop.

### Remove a worker target

Workers have no embedded-etcd member. Drain only the derived node, enter that
exact host over Tailscale as the `pandoks` administrator, and stop its agent as
documented by the official
[K3s stopping guide](https://docs.k3s.io/upgrades/killall):

```sh
kubectl drain "${NODE_NAME}" --ignore-daemonsets --delete-emptydir-data
tailscale ssh "pandoks@${NODE_NAME}"
sudo systemctl stop k3s-agent || exit 1
AGENT_STATE="$(sudo systemctl is-active k3s-agent || true)"
[ "${AGENT_STATE}" = inactive ] || {
  printf 'k3s-agent state is %s; aborting\n' "${AGENT_STATE}" >&2
  exit 1
}
exit
```

Do not continue unless the stop command succeeded and the service state was
exactly `inactive`. Back on the administrator machine, delete the same derived
Kubernetes node:

```sh
kubectl delete node "${NODE_NAME}"
```

Continue with the production protection boundary below.

### Remove a control-plane target

Perform these steps from a surviving control plane unless a step explicitly
names the target. Install `etcdctl` on the survivor first by following the
official [K3s etcdctl guide](https://docs.k3s.io/advanced#using-etcdctl). K3s
does not bundle it. The guide specifies the K3s-managed CA, client certificate,
and key paths used below.

On the survivor, set the same derived `NODE_NAME` and `TARGET_INTERNAL_IP`, take
the snapshot first, and define a certificate-authenticated local client:

```sh
sudo k3s etcd-snapshot save --name "pre-remove-${NODE_NAME}-$(date -u +%Y%m%dT%H%M%SZ)"
sudo k3s etcd-snapshot ls

etcdctl_k3s() {
  sudo etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
    --cert=/var/lib/rancher/k3s/server/tls/etcd/client.crt \
    --key=/var/lib/rancher/k3s/server/tls/etcd/client.key \
    "$@"
}
```

List membership and verify every endpoint before disrupting the target. The
post-removal member count must be odd and at least three:

```sh
etcdctl_k3s member list
etcdctl_k3s --write-out=table endpoint status --cluster
etcdctl_k3s endpoint health --cluster
MEMBER_COUNT_BEFORE="$(etcdctl_k3s member list | wc -l | tr -d '[:space:]')"
EXPECTED_MEMBER_COUNT=$((MEMBER_COUNT_BEFORE - 1))
[ "${EXPECTED_MEMBER_COUNT}" -ge 3 ]
[ $((EXPECTED_MEMBER_COUNT % 2)) -eq 1 ]
```

Back on the administrator machine, drain the exact target, then enter it through
Tailscale and stop k3s:

```sh
kubectl drain "${NODE_NAME}" --ignore-daemonsets --delete-emptydir-data
tailscale ssh "pandoks@${NODE_NAME}"
sudo systemctl stop k3s
exit
```

On the surviving control plane, list members again. Enter only the hexadecimal
member ID whose row contains the exact peer URL
`https://${TARGET_INTERNAL_IP}:2380`; the two checks fail closed on another ID
or peer URL:

```sh
etcdctl_k3s member list
printf 'Member ID for peer https://%s:2380: ' "${TARGET_INTERNAL_IP}"
read -r MEMBER_ID
case "${MEMBER_ID}" in
  ''|*[!0-9a-fA-F]*)
    printf '%s\n' "Invalid etcd member ID"
    exit 1
    ;;
esac
MEMBER_ROW="$(
  etcdctl_k3s member list |
    grep -E "^${MEMBER_ID}(:|,)"
)"
printf '%s\n' "${MEMBER_ROW}" |
  grep -F "https://${TARGET_INTERNAL_IP}:2380"
etcdctl_k3s member remove "${MEMBER_ID}"
```

Back on the administrator machine, delete the exact Kubernetes node. Then
return to the surviving control plane and re-check membership, endpoint status,
health, the expected count, and odd quorum:

```sh
kubectl delete node "${NODE_NAME}"

etcdctl_k3s member list
etcdctl_k3s --write-out=table endpoint status --cluster
MEMBER_COUNT_AFTER="$(etcdctl_k3s member list | wc -l | tr -d '[:space:]')"
etcdctl_k3s endpoint health --cluster
[ "${MEMBER_COUNT_AFTER}" -eq "${EXPECTED_MEMBER_COUNT}" ]
[ "${MEMBER_COUNT_AFTER}" -ge 3 ]
[ $((MEMBER_COUNT_AFTER % 2)) -eq 1 ]
```

Do not continue unless all commands succeed. The etcd project also documents
that membership changes must be sequential and require a healthy quorum in its
[runtime reconfiguration guide](https://etcd.io/docs/v3.5/op-guide/runtime-configuration/#cluster-reconfiguration-operations).

### Production protection boundary

Production node resources use `protect: isProduction`. Every production node
remains protected, while non-production nodes are not protected. There is no
environment-variable bypass.

After completing the Kubernetes and etcd removal steps above, stop. Do not lower
the pool count or deploy the deletion: the current stage-only policy
intentionally blocks production resource deletion.

Finishing a production infrastructure deletion requires a separate reviewed IaC
change that deliberately unprotects only the exact derived logical resource.
Preview that change and reject any unrelated protection change before reducing
the selected pool count by exactly one. Do not add a persistent environment
escape hatch or disable protection for every production node.

## Bootstrap changes

Public Cloud `userData` and dedicated install customization changes are ignored
for existing production machines. They apply only to newly created nodes.
Never force a dedicated reinstall to roll out a script change; rebuild capacity
one node at a time after verifying quorum.

The completion marker at `/var/lib/pandoks/cluster-bootstrap.complete` prevents
the host bootstrap from running again. Treat `infra/cluster/bootstrap.sh`
changes as new-node behavior, not an in-place rollout mechanism.

## Recovery

If Tailscale fails, use the OVH console or rescue environment. There is no
provider key or public-SSH fallback. If a node fails before joining, inspect:

```sh
systemctl status pandoks-cluster-bootstrap.service
journalctl -u pandoks-cluster-bootstrap.service
```

Do not remove the failed node from SST until its OVH service ID and Kubernetes
membership are understood. Do not reinstall a dedicated server merely to retry
bootstrap; diagnose it from the console or rescue environment first.

The IaC-provisioned development VPS-4 is separate from this cluster. Its guest
setup and lockdown remain manual; provisioning, legacy state cleanup, and
recovery procedures are in
[`scripts/dev-vps/README.md`](../../scripts/dev-vps/README.md).
