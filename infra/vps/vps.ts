// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import { createHetznerCluster } from './hetzner';
import { createLatitudeCluster } from './latitude';
import { createOvhCluster } from './ovh';
import { NODE_IP_STARTS, type NodeCounts, type Provider } from './servers';

// NOTE: plans, locations, and network settings live at the top of each provider's file
const PROVIDER: Provider = isProduction ? 'hetzner' : 'hetzner'; // options: hetzner | ovh | latitude
// NOTE: if you want to downsize the cluster, remember to manually drain remove the nodes with `kubectl drain` & `kubectl delete node`
const CONTROL_PLANE_NODE_COUNT = isProduction ? 0 : 0;
const WORKER_NODE_COUNT = isProduction ? 0 : 0;
// NOTE: database nodes join with the role=db label and role=db:NoSchedule taint for the database charts
const DATABASE_NODE_COUNT = isProduction ? 0 : 0;

const nodeCounts: NodeCounts = {
  'control-plane': CONTROL_PLANE_NODE_COUNT,
  worker: WORKER_NODE_COUNT,
  database: DATABASE_NODE_COUNT
};
const nodeCapacities: NodeCounts = {
  'control-plane': NODE_IP_STARTS.worker - NODE_IP_STARTS['control-plane'],
  worker: NODE_IP_STARTS.database - NODE_IP_STARTS.worker,
  database: 255 - NODE_IP_STARTS.database
};
for (const [type, count] of Object.entries(nodeCounts) as [keyof NodeCounts, number][]) {
  if (count > nodeCapacities[type]) {
    throw new Error(`You can only have ${nodeCapacities[type]} ${type} nodes. Currently: ${count}`);
  }
}

const createCluster = {
  hetzner: createHetznerCluster,
  ovh: createOvhCluster,
  latitude: createLatitudeCluster
}[PROVIDER];
export const { controlPlaneLoadBalancers, workerLoadBalancers } = createCluster(nodeCounts);

if (CONTROL_PLANE_NODE_COUNT + WORKER_NODE_COUNT + DATABASE_NODE_COUNT === 0) {
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
