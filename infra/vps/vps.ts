// WARNING: resources that hold data like servers, volumes, etc. should be protected by the
// `protect` option in production. This is to prevent accidental deletion of resources.
import { isProduction, STAGE_NAME } from '../dns';
import { deleteTailscaleDevices } from '../tailscale';
import * as latitude from './latitude';
import * as ovh from './ovh';
import { getMachines, type Cluster } from './servers';

// NOTE: one cluster per region, since embedded etcd keeps a cluster's control plane in one location
const CLUSTERS: Cluster[] = [
  {
    name: 'us-west',
    locations: { 'ovh-hil': { provider: 'ovh', region: 'US-WEST-OR-1', cidr: '10.0.0.0/16' } },
    links: [],
    pools: [
      {
        name: 'control-plane',
        location: 'ovh-hil',
        role: 'control-plane',
        count: 0,
        server: isProduction ? ovh.vm('d2-4') : ovh.vm('d2-8')
      },
      {
        name: 'worker',
        location: 'ovh-hil',
        role: 'worker',
        count: 0,
        server: isProduction ? ovh.metal(ovh.ADVANCE_1) : ovh.vm('d2-8')
      },
      {
        name: 'database',
        location: 'ovh-hil',
        role: 'worker',
        count: 0,
        server: isProduction ? ovh.metal(ovh.ADVANCE_5) : ovh.metal(ovh.ADVANCE_1),
        labels: { role: 'db' },
        taints: ['role=db:NoSchedule']
      }
    ]
  }
];

const gatewayPublicIps: Record<string, $util.Output<string>> = {};
const machines = getMachines({ clusters: CLUSTERS, gatewayPublicIps });

if (machines.length > 0) {
  const ovhNetworks = ovh.createOvhNetwork(
    machines.filter((machine) => machine.provider === 'ovh')
  );
  const latitudeNetworks = latitude.createLatitudeNetwork(
    machines.filter((machine) => machine.provider === 'latitude')
  );
  const bootstrapServers: Record<string, $util.Resource> = {};
  for (const machine of machines) {
    const dependsOn =
      machine.role !== 'gateway' && machine.clusterName in bootstrapServers
        ? [bootstrapServers[machine.clusterName]]
        : [];
    const { resource, publicIp } =
      machine.provider === 'ovh'
        ? ovh.createOvhServer({ machine, network: ovhNetworks[machine.locationKey], dependsOn })
        : latitude.createLatitudeServer({
            machine,
            virtualNetwork: latitudeNetworks[machine.locationKey],
            dependsOn
          });
    if (machine.role === 'gateway') {
      gatewayPublicIps[machine.locationKey] = publicIp;
    } else {
      bootstrapServers[machine.clusterName] ??= resource;
    }
  }
}

// NOTE: only the first cluster gets `pnpm cluster deploy`'s devices, like <stage>-grafana
if (!machines.some(({ clusterName }) => clusterName === CLUSTERS[0].name)) {
  const { devices = [] } = await tailscale.getDevices({ namePrefix: `${STAGE_NAME}` });
  const keptProxyHostnames = machines.map(
    ({ clusterName }) => `${STAGE_NAME}-${clusterName}-cluster`
  );

  const kubernetesDevices = devices.filter(
    (device) =>
      device.tags.includes('tag:k8s') &&
      device.tags.includes(`tag:${STAGE_NAME}`) &&
      !keptProxyHostnames.includes(device.hostname)
  );
  if (kubernetesDevices.length > 0) {
    const deviceNames = new Map(kubernetesDevices.map((device) => [device.nodeId, device.name]));
    deleteTailscaleDevices(...deviceNames.keys()).apply((deletedDevices) => {
      const failedDevices = deletedDevices.filter((device) => !device.success);
      if (failedDevices.length) {
        throw new Error(
          `Failed to delete Tailscale devices:\n${failedDevices
            .map(({ deviceId, error }) => `${deviceNames.get(deviceId)}: ${error}`)
            .join('\n')}`
        );
      }
      console.log(`Deleted Tailscale devices:\n${[...deviceNames.values()].join('\n')}`);
    });
  }
}
