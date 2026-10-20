import { isProduction, STAGE_NAME } from '../dns';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getNodeIp,
  NODE_RESOURCE_NAMES,
  type NodeCounts
} from './servers';

const SITE = isProduction ? 'LAX' : 'LAX'; // options: LAX | LAX2 | SJC2 | ASH | NYC | DAL | SGP | TYO3 | TYO4
// NOTE: no VMs in US West, so the control plane shares the worker plan
const CONTROL_PLANE_PLAN = isProduction ? 'm4-metal-small' : 'm4-metal-small';
const WORKER_PLAN = isProduction ? 'm4-metal-small' : 'm4-metal-small';
const DATABASE_PLAN = isProduction ? 'm4-metal-medium' : 'm4-metal-medium';
const BILLING = isProduction ? 'monthly' : 'hourly'; // options: hourly | monthly | yearly
const OPERATING_SYSTEM = 'ubuntu_24_04_x64_lts';
// NOTE: the private NIC carries the VLAN; read its name with `ip link` on the first server
const PRIVATE_PARENT_INTERFACE: string = '';
const PRIVATE_INTERFACE = 'private0';

const deleteServerFromTailnet = createTailnetCleanupHook({
  name: 'LatitudeDeleteServerFromTailnet',
  provider: 'latitude',
  getTailscaleHostname: (oldOutputs) => oldOutputs.hostname as string | undefined
});

export function createLatitudeCluster(nodeCounts: NodeCounts) {
  if (!PRIVATE_PARENT_INTERFACE) {
    throw new Error('Set PRIVATE_PARENT_INTERFACE in infra/vps/latitude.ts before using Latitude');
  }

  const project = new latitudesh.Project('LatitudeProject', {
    name: `k3s-${STAGE_NAME}`,
    environment: isProduction ? 'Production' : 'Development',
    provisioningType: 'on_demand'
  });
  const virtualNetwork = new latitudesh.VirtualNetwork('LatitudeK3sPrivateNetwork', {
    project: project.id,
    site: SITE,
    description: `k3s-private-${STAGE_NAME}-network`
  });

  const servers: latitudesh.Server[] = [];
  for (const type of ['control-plane', 'worker', 'database'] as const) {
    const plan =
      type === 'control-plane'
        ? CONTROL_PLANE_PLAN
        : type === 'database'
          ? DATABASE_PLAN
          : WORKER_PLAN;
    for (let i = 0; i < nodeCounts[type]; i++) {
      const nodeResourceName = `Latitude${NODE_RESOURCE_NAMES[type]}Server${i}`;
      const privateNetplan = virtualNetwork.vid.apply((vid) =>
        Buffer.from(
          `network:\n  version: 2\n  vlans:\n    ${PRIVATE_INTERFACE}:\n      id: ${vid}\n      link: ${PRIVATE_PARENT_INTERFACE}\n      addresses: [${getNodeIp({ type, index: i })}/24]\n`
        ).toString('base64')
      );
      const { userData, tailscaleHostname } = createNodeUserData({
        provider: 'latitude',
        type,
        index: i,
        privateInterface: PRIVATE_INTERFACE,
        privateNetplan
      });
      const latitudeUserData = new latitudesh.UserData(`${nodeResourceName}UserData`, {
        project: project.id,
        description: tailscaleHostname,
        content: userData.apply((content) => Buffer.from(content).toString('base64'))
      });
      const server = new latitudesh.Server(
        nodeResourceName,
        {
          project: project.id,
          site: SITE,
          plan,
          operatingSystem: OPERATING_SYSTEM,
          hostname: tailscaleHostname,
          billing: BILLING,
          userData: latitudeUserData.id
        },
        {
          dependsOn: servers.slice(0, 1),
          ignoreChanges: isProduction ? ['userData'] : [],
          protect: isProduction,
          hooks: { afterDelete: [deleteServerFromTailnet] }
        }
      );
      new latitudesh.VlanAssignment(`${nodeResourceName}Vlan`, {
        serverId: server.id,
        virtualNetworkId: virtualNetwork.id
      });
      servers.push(server);
    }
  }

  return { controlPlaneLoadBalancers: [], workerLoadBalancers: [] };
}
