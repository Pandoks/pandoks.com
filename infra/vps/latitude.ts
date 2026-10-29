import { isProduction, STAGE_NAME } from '../dns';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getClusterNodes,
  PRIVATE_IP_RANGE,
  type NodePool
} from './servers';

// NOTE: a bare metal plan like m4-metal-small or m4-metal-medium; US West has no VMs
export type LatitudeServer = string;

const SITE = isProduction ? 'LAX' : 'LAX'; // options: LAX | LAX2 | SJC2 | ASH | NYC | DAL | SGP | TYO3 | TYO4
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

export function createLatitudeCluster(pools: NodePool<LatitudeServer>[]) {
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
  for (const node of getClusterNodes({ provider: 'latitude', pools })) {
    const nodeResourceName = `Latitude${node.resourceName}`;
    const privateNetplan = virtualNetwork.vid.apply((vid) =>
      Buffer.from(
        `network:\n  version: 2\n  vlans:\n    ${PRIVATE_INTERFACE}:\n      id: ${vid}\n      link: ${PRIVATE_PARENT_INTERFACE}\n      addresses: [${node.ip}/${PRIVATE_IP_RANGE.split('/')[1]}]\n`
      ).toString('base64')
    );
    const userData = createNodeUserData({
      provider: 'latitude',
      node,
      privateInterface: PRIVATE_INTERFACE,
      privateNetplan
    });
    // NOTE: servers read user data only at install, so new content replaces the server
    const latitudeUserData = new latitudesh.UserData(
      `${nodeResourceName}UserData`,
      {
        project: project.id,
        description: node.hostname,
        content: userData.apply((content) => Buffer.from(content).toString('base64'))
      },
      { replaceOnChanges: ['content'] }
    );
    const server = new latitudesh.Server(
      nodeResourceName,
      {
        project: project.id,
        site: SITE,
        plan: node.pool.server,
        operatingSystem: OPERATING_SYSTEM,
        hostname: node.hostname,
        billing: BILLING,
        userData: latitudeUserData.id
      },
      {
        dependsOn: servers.slice(0, 1),
        ignoreChanges: isProduction ? ['userData'] : [],
        replaceOnChanges: ['userData'],
        deleteBeforeReplace: true,
        protect: isProduction,
        hooks: { afterDelete: [deleteServerFromTailnet] }
      }
    );
    new latitudesh.VlanAssignment(
      `${nodeResourceName}Vlan`,
      { serverId: server.id, virtualNetworkId: virtualNetwork.id },
      { protect: isProduction }
    );
    servers.push(server);
  }
}
