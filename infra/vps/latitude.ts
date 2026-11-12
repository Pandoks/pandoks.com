import { isProduction, STAGE_NAME } from '../dns';
import { createTailnetCleanupHook, type Machine } from './servers';

type LatitudeMachine = Extract<Machine, { provider: 'latitude' }>;
// NOTE: @sst-provider/latitudesh 1.2.0 orders only bare metal; add vm() once it supports VMs
export type LatitudeServer = { provider: 'latitude'; kind: 'metal'; plan: string; gpu?: 'nvidia' };
export type LatitudeLocation = {
  provider: 'latitude';
  site: 'LAX' | 'LAX2' | 'SJC2' | 'ASH' | 'NYC' | 'DAL' | 'SGP' | 'TYO3' | 'TYO4';
  cidr: string;
  gateway?: LatitudeServer;
};

// NOTE: GPU plans are the g families, like g3-h100-small and g4-rtx6kpro-large
const GPU_PLAN = /^g\d+-/;

/** A bare metal plan like m4-metal-small */
export function metal(plan: string, { gpu }: { gpu?: 'nvidia' } = {}): LatitudeServer {
  if (gpu && !GPU_PLAN.test(plan)) throw new Error(`Latitude plan ${plan} has no GPU`);
  return { provider: 'latitude', kind: 'metal', plan, gpu };
}

const BILLING = isProduction ? 'monthly' : 'hourly'; // options: hourly | monthly | yearly
const OPERATING_SYSTEM = 'ubuntu_24_04_x64_lts';
// NOTE: the private NIC (https://www.latitude.sh/docs/networking/private-networks); bonded is bond0
const PRIVATE_PARENT_INTERFACE = 'eno2';
const PRIVATE_INTERFACE = 'private0';

const deleteServerFromTailnet = createTailnetCleanupHook({
  name: 'LatitudeDeleteServerFromTailnet',
  provider: 'latitude',
  getTailscaleHostname: (oldOutputs) => oldOutputs.hostname as string | undefined
});

/** Creates the stage's project and a VLAN for each location, returned by `locationKey` */
export function createLatitudeNetwork(
  machines: LatitudeMachine[]
): Record<string, latitudesh.VirtualNetwork> {
  if (machines.length === 0) return {};
  const project = new latitudesh.Project('LatitudeProject', {
    name: `k3s-${STAGE_NAME}`,
    environment: isProduction ? 'Production' : 'Development',
    provisioningType: 'on_demand'
  });
  const sites = new Map(machines.map(({ locationKey, location }) => [locationKey, location.site]));
  return Object.fromEntries(
    [...sites].map(([locationKey, site]) => [
      locationKey,
      new latitudesh.VirtualNetwork(`${locationKey}PrivateNetwork`, {
        project: project.id,
        site,
        description: `k3s-private-${STAGE_NAME}-${locationKey}`
      })
    ])
  );
}

/**
 * Orders the machine as a bare metal server on its location's VLAN. Only k3s nodes are protected in
 * production; gateways hold no data, so a link change rebuilds them everywhere.
 */
export function createLatitudeServer({
  machine,
  virtualNetwork,
  dependsOn
}: {
  machine: LatitudeMachine;
  virtualNetwork: latitudesh.VirtualNetwork;
  dependsOn: $util.Resource[];
}) {
  const protect = isProduction && machine.role !== 'gateway';
  const userData = machine.createUserData({
    name: PRIVATE_INTERFACE,
    createNetplanDevices: (routes) =>
      virtualNetwork.vid.apply((vid) => ({
        // NOTE: netplan links a VLAN only to an interface it defines
        ethernets: { [PRIVATE_PARENT_INTERFACE]: {} },
        vlans: {
          [PRIVATE_INTERFACE]: {
            id: vid,
            link: PRIVATE_PARENT_INTERFACE,
            addresses: [`${machine.ip}/16`],
            routes
          }
        }
      }))
  });
  // NOTE: servers read user data only at install, so new content replaces the server
  const latitudeUserData = new latitudesh.UserData(
    `Latitude${machine.resourceName}UserData`,
    {
      project: virtualNetwork.project,
      description: machine.hostname,
      content: userData.apply((content) => Buffer.from(content).toString('base64'))
    },
    { replaceOnChanges: ['content'] }
  );
  const server = new latitudesh.Server(
    `Latitude${machine.resourceName}`,
    {
      project: virtualNetwork.project,
      site: machine.location.site,
      plan: machine.server.plan,
      operatingSystem: OPERATING_SYSTEM,
      hostname: machine.hostname,
      billing: BILLING,
      userData: latitudeUserData.id
    },
    {
      dependsOn,
      ignoreChanges: protect ? ['userData'] : [],
      replaceOnChanges: ['userData'],
      deleteBeforeReplace: true,
      protect,
      hooks: { afterDelete: [deleteServerFromTailnet] }
    }
  );
  new latitudesh.VlanAssignment(
    `Latitude${machine.resourceName}Vlan`,
    { serverId: server.id, virtualNetworkId: virtualNetwork.id },
    { protect }
  );
  return { resource: server, publicIp: server.primaryIpv4 };
}
