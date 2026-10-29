// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { createLatitudeCluster, type LatitudeServer } from './latitude';
import { ADVANCE_1_SERVER, ADVANCE_5_SERVER, createOvhCluster, type OvhServer } from './ovh';
import type { NodePool } from './servers';

type Cluster =
  | { provider: 'ovh'; pools: NodePool<OvhServer>[] }
  | { provider: 'latitude'; pools: NodePool<LatitudeServer>[] };

// NOTE: each pool orders `count` identical servers; locations and network settings live at the top
// of each provider's file. The database charts schedule onto nodes labeled and tainted role=db
// NOTE: switch providers through a zero-node deploy, which removes the old `<stage>-cluster` proxy
// NOTE: if you want to downsize a pool, remember to manually drain and remove its highest-index nodes with `kubectl drain` & `kubectl delete node`
const CLUSTER: Cluster = isProduction
  ? {
      provider: 'ovh',
      pools: [
        { name: 'control-plane', role: 'control-plane', count: 0, server: { flavor: 'd2-4' } },
        { name: 'worker', role: 'worker', count: 0, server: ADVANCE_1_SERVER },
        {
          name: 'database',
          role: 'worker',
          count: 0,
          server: ADVANCE_5_SERVER,
          labels: { role: 'db' },
          taints: ['role=db:NoSchedule']
        }
      ]
    }
  : {
      provider: 'ovh',
      pools: [
        { name: 'control-plane', role: 'control-plane', count: 0, server: { flavor: 'd2-8' } },
        { name: 'worker', role: 'worker', count: 0, server: { flavor: 'd2-8' } },
        {
          name: 'database',
          role: 'worker',
          count: 0,
          server: ADVANCE_1_SERVER,
          labels: { role: 'db' },
          taints: ['role=db:NoSchedule']
        }
      ]
    };

function createCluster(cluster: Cluster) {
  if (cluster.provider === 'ovh') return createOvhCluster(cluster.pools);
  return createLatitudeCluster(cluster.pools);
}

// NOTE: a stage without nodes creates nothing at its provider, so it deploys before that provider's
// account settings are filled in
if (CLUSTER.pools.some((pool) => pool.count > 0)) {
  createCluster(CLUSTER);
} else {
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
