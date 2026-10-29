// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { createHetznerCluster, type HetznerServer } from './hetzner';
import { createLatitudeCluster, type LatitudeServer } from './latitude';
import { createOvhCluster, type OvhServer } from './ovh';
import type { NodePool } from './servers';

type Cluster =
  | { provider: 'hetzner'; pools: NodePool<HetznerServer>[] }
  | { provider: 'ovh'; pools: NodePool<OvhServer>[] }
  | { provider: 'latitude'; pools: NodePool<LatitudeServer>[] };

// NOTE: each pool orders `count` identical servers; locations and network settings live at the top
// of each provider's file. The database charts schedule onto nodes labeled and tainted role=db
// NOTE: switch providers through a zero-node deploy, which removes the old `<stage>-cluster` proxy
// NOTE: if you want to downsize a pool, remember to manually drain and remove its highest-index nodes with `kubectl drain` & `kubectl delete node`
const CLUSTER: Cluster = isProduction
  ? {
      provider: 'hetzner',
      pools: [
        { name: 'control-plane', role: 'control-plane', count: 0, server: 'ccx13' },
        { name: 'worker', role: 'worker', count: 0, server: 'ccx13' },
        {
          name: 'database',
          role: 'worker',
          count: 0,
          server: 'ccx13',
          labels: { role: 'db' },
          taints: ['role=db:NoSchedule']
        }
      ]
    }
  : {
      provider: 'hetzner',
      pools: [
        { name: 'control-plane', role: 'control-plane', count: 0, server: 'cx23' },
        { name: 'worker', role: 'worker', count: 0, server: 'cx23' },
        {
          name: 'database',
          role: 'worker',
          count: 0,
          server: 'cx23',
          labels: { role: 'db' },
          taints: ['role=db:NoSchedule']
        }
      ]
    };

function createCluster(cluster: Cluster) {
  if (cluster.provider === 'ovh') return createOvhCluster(cluster.pools);
  if (cluster.provider === 'latitude') return createLatitudeCluster(cluster.pools);
  return createHetznerCluster(cluster.pools);
}
export const { controlPlaneLoadBalancers, workerLoadBalancers } = createCluster(CLUSTER);

if (CLUSTER.pools.every((pool) => pool.count === 0)) {
  const { devices = [] } = await tailscale.getDevices({ namePrefix: `${STAGE_NAME}` });

  const kubernetesDevices = devices.filter(
    (device) => device.tags.includes('tag:k8s') && device.tags.includes(`tag:${STAGE_NAME}`)
  );
  if (kubernetesDevices.length > 0) {
    const deletedDevices = deleteTailscaleDevices(
      ...kubernetesDevices.map((device) => device.nodeId)
    );
    deletedDevices.apply((deletedDevices) => {
      const deletedDeviceIds = deletedDevices
        .filter((device) => device.success)
        .map((device) => device.deviceId);
      const failedToDeleteDeviceIds = deletedDevices
        .filter((device) => !device.success)
        .map((device) => device.deviceId);
      if (deletedDeviceIds.length) {
        console.log(
          `Deleted Tailscale devices:\n${kubernetesDevices
            .filter((device) => deletedDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
      if (failedToDeleteDeviceIds.length) {
        console.log(
          `Failed to delete Tailscale devices:\n${kubernetesDevices
            .filter((device) => failedToDeleteDeviceIds.includes(device.nodeId))
            .map((device) => device.name)
            .join('\n')}`
        );
      }
    });
  }
}

const publicLoadBalancerOutputs = Object.fromEntries(
  // NOTE: we have to hard code the name because indecies can't be pulumi inputs/outputs
  [
    ...controlPlaneLoadBalancers.map((lb, i): [string, $util.Output<string>] => [
      `ControlPlaneLoadBalancer${i}`,
      lb.loadbalancer.ipv4
    ]),
    ...workerLoadBalancers.map((lb, i): [string, $util.Output<string>] => [
      `WorkerLoadBalancer${i}`,
      lb.loadbalancer.ipv4
    ])
  ]
);

export const outputs = { ...publicLoadBalancerOutputs };
