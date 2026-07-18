# OVH hybrid k3s cluster

The cluster combines OVH Public Cloud instances and dedicated servers on one
vRack network. Cluster traffic uses the vRack network. Tailscale is only for
administrator SSH and Kubernetes API access.

The OVH Public Cloud project remains required even when every compute node is a
dedicated server. It owns the project attachment, private network, subnet,
gateway, private API load balancer, public ingress load balancers, and floating
IPs. Do not remove `OVH_CLOUD_PROJECT_SERVICE` or cancel the Public Cloud
project when migrating compute to dedicated servers.

Cluster nodes receive no provider SSH key and public SSH is not an access path.
Administration uses Tailscale SSH as `pandoks`; recovery uses the OVH console or
rescue environment. The vRack is for cluster traffic, not administrator SSH.

## Configure node pools

Set stage-specific values in `.env.production`:

```dotenv
OVH_CLOUD_CONTROL_PLANE_COUNT=1
OVH_CLOUD_WORKER_COUNT=0
OVH_DEDICATED_CONTROL_PLANE_COUNT=0
OVH_DEDICATED_WORKER_COUNT=0
OVH_DEDICATED_SERVER_PLAN=
OVH_DEDICATED_DATACENTER=
OVH_DEDICATED_ORDER_REGION=
OVH_DEDICATED_PLAN_OPTIONS=[]
```

The four counts are independent. Dedicated catalog values may remain empty only
while both dedicated counts are zero. Get the exact plan, datacenter, region,
and required options from the live OVH order cart for the offer being enabled.
Catalog values are not durable defaults. Before committing or applying a
non-zero dedicated count, validate the current authenticated catalog, set the
validated values and intended count locally, and run an authenticated
`sst diff`. Never copy catalog values from an old preview or this runbook.

## Preview

```sh
./node_modules/.bin/sst diff --stage production
```

Run the preview with authenticated OVH provider access. Do not apply if a
provider lookup fails or the selected dedicated offer differs from the live
cart.

Reject a preview that replaces `OvhK3sVrack`, `OvhK3sPrivateNetwork`,
`OvhK3sSubnet`, `OvhK3sGateway`, existing protected compute, Cloudflare DNS, or
the origin certificate. A compute-only migration must retain the Public Cloud
network and load balancers.

## Scale up

Increase one pool count and run `sst diff`. A new dedicated node is ordered
without an OS, attached to vRack, then installed exactly once. Apply only after
the diff contains additions and expected load-balancer member updates.

After apply, wait for every new node to become Ready and verify its InternalIP is
in `10.0.1.0/24`:

```sh
kubectl get nodes -o wide
```

## Migrate Public Cloud to dedicated

1. Add enough dedicated control-plane nodes that the dedicated set will retain
   an odd quorum of at least three after the Public Cloud control-plane nodes
   are removed.
2. Deploy and wait for every new node to become Ready.
3. Verify `kubectl get nodes -o wide` uses `10.0.1.0/24` internal addresses.
4. Verify `k3s etcd-snapshot ls` and etcd member health.
5. Add dedicated workers and verify workloads.
6. Drain and remove one Public Cloud node at a time.
7. Reduce only the count for each node already removed.

Keep `OVH_CLOUD_PROJECT_SERVICE` and the Public Cloud project after the Public
Cloud compute counts reach zero. Dedicated nodes still use its network and load
balancers.

## Scale down

For each intended node:

```sh
kubectl get nodes -o custom-columns=NAME:.metadata.name --no-headers
printf "Exact node to remove: "
read -r NODE_NAME
kubectl drain "${NODE_NAME}" --ignore-daemonsets --delete-emptydir-data
kubectl delete node "${NODE_NAME}"
```

For a control-plane node, take and verify a current etcd snapshot, remove the
etcd member, and verify the remaining members still have quorum before reducing
its pool count. Never remove enough control-plane members to leave fewer than
three or an even final member count.

Production resources are protected. Remove protection only for the exact node
that has already been drained and removed. Run another authenticated `sst diff`
and reduce only that node's pool count; reject unrelated replacements or
deletions.

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

The manually managed development VPS is separate from this cluster. Its setup,
lockdown, state cleanup, and recovery procedure is in
[`scripts/dev-vps/README.md`](../../scripts/dev-vps/README.md).
