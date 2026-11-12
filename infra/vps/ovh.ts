import { isProduction, STAGE_NAME } from '../dns';
import { createTailnetCleanupHook, type Machine } from './servers';

type OvhMachine = Extract<Machine, { provider: 'ovh' }>;
type OvhLocationNetwork = {
  privateNetwork: ovh.cloudproject.NetworkPrivate;
  subnet: ovh.cloudproject.NetworkPrivateSubnet;
};
type Gpu = { gpu?: 'nvidia' };
export type OvhVmServer = { provider: 'ovh'; kind: 'vm'; flavor: string } & Gpu;
export type OvhMetalServer = {
  provider: 'ovh';
  kind: 'metal';
  planCode: string;
  options: string[];
} & Gpu;
export type OvhServer = OvhVmServer | OvhMetalServer;
// NOTE: the provider uses OVHcloud's US API, so each US region and the datacenter of its bare metal
const DATACENTERS = { 'US-EAST-VA-1': 'vin', 'US-WEST-OR-1': 'hil' } as const;
/** A Public Cloud region. Its gateway is bare metal, since VM ports drop traffic they forward */
export type OvhLocation = {
  provider: 'ovh';
  region: keyof typeof DATACENTERS;
  cidr: string;
  gateway?: OvhMetalServer;
};

// NOTE: GPU flavor families in OVHcloud's US catalog (/order/catalog/public/cloud?ovhSubsidiary=US)
const GPU_FLAVOR = /^(t2|t2-le|l4|l40s)-\d+$/;

/** A Public Cloud VM flavor like d2-4 */
export function vm(flavor: string, { gpu }: Gpu = {}): OvhVmServer {
  if (gpu && !GPU_FLAVOR.test(flavor)) throw new Error(`OVHcloud flavor ${flavor} has no GPU`);
  return { provider: 'ovh', kind: 'vm', flavor, gpu };
}

/** A bare metal plan code and its options; GPU plans carry a gpu-* option */
export function metal(
  { planCode, options }: { planCode: string; options: string[] },
  { gpu }: Gpu = {}
): OvhMetalServer {
  if (gpu && !options.some((option) => option.startsWith('gpu-'))) {
    throw new Error(`OVHcloud plan ${planCode} has no GPU option`);
  }
  return { provider: 'ovh', kind: 'metal', planCode, options, gpu };
}

// NOTE: from the US catalog: /1.0/order/catalog/public/baremetalServers?ovhSubsidiary=US
export const ADVANCE_1 = {
  planCode: '24adv01-v3-us',
  options: [
    'ram-32g-on-die-ecc-5200-24adv01-v3-us',
    'softraid-2x960nvme-pcie-gen4-24adv01-v3-us',
    'bandwidth-3000-adv-gen3-us',
    'vrack-bandwidth-25000-adv-gen3-us'
  ]
};
export const ADVANCE_5 = {
  planCode: '26adv05-v2-us',
  options: [
    'ram-128g-ecc-5600-26adv05-v2-us',
    'softraid-2x960nvme-pcie-gen5-26adv05-v2-us',
    'bandwidth-3000-adv-gen4-us',
    'vrack-bandwidth-25000-adv-gen4-us'
  ]
};

// NOTE: service names from the OVHcloud control panel (Bare Metal Cloud > vRack, Public Cloud project ID)
const VRACK = isProduction ? '' : '';
const CLOUD_PROJECT = isProduction ? '' : '';
const VM_IMAGE = 'Ubuntu 24.04';
// NOTE: a Public Cloud SSH key's name; OVHcloud won't create a VM without one, though nodes are
// reached over Tailscale SSH
const VM_SSH_KEY = isProduction ? '' : '';
const SERVER_OS = 'ubuntu2404-server_64';
// NOTE: interface names differ by server range; read them with `ip link` on the first server
const VM_PRIVATE_INTERFACE = 'ens4';
const SERVER_PRIVATE_INTERFACE = '';

const deleteServerFromTailnet = createTailnetCleanupHook({
  name: 'OvhDeleteServerFromTailnet',
  provider: 'ovh',
  getTailscaleHostname: (oldOutputs) => oldOutputs.displayName as string | undefined
});
const deleteInstanceFromTailnet = createTailnetCleanupHook({
  name: 'OvhDeleteInstanceFromTailnet',
  provider: 'ovh',
  getTailscaleHostname: (oldOutputs) => oldOutputs.name as string | undefined
});

/**
 * Puts the Public Cloud project on the vRack, on one untagged private network across the machines'
 * regions, and gives each location its subnet. Returns the subnets by `locationKey`.
 */
export function createOvhNetwork(machines: OvhMachine[]): Record<string, OvhLocationNetwork> {
  if (machines.length === 0) return {};
  const ordersVms = machines.some(({ server }) => server.kind === 'vm');
  const ordersBareMetal = machines.some(({ server }) => server.kind === 'metal');
  const missing = Object.entries({
    VRACK,
    CLOUD_PROJECT,
    ...(ordersVms && { VM_SSH_KEY }),
    ...(ordersBareMetal && { SERVER_PRIVATE_INTERFACE })
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Set ${missing.join(', ')} in infra/vps/ovh.ts before using OVHcloud`);
  }

  // NOTE: VLAN 0 is untagged, so the VMs share a network with the bare metal servers in the vRack
  const vrackCloudProject = new ovh.vrack.CloudProject('OvhVrackCloudProject', {
    serviceName: VRACK,
    projectId: CLOUD_PROJECT
  });
  const privateNetwork = new ovh.cloudproject.NetworkPrivate(
    'OvhK3sPrivateNetwork',
    {
      serviceName: CLOUD_PROJECT,
      name: `k3s-private-${STAGE_NAME}-network`,
      regions: [...new Set(machines.map(({ location }) => location.region))],
      vlanId: 0
    },
    { dependsOn: [vrackCloudProject] }
  );
  const locations = new Map(machines.map(({ locationKey, location }) => [locationKey, location]));
  return Object.fromEntries(
    [...locations].map(([locationKey, { region, cidr }]) => {
      const cidrPrefix = cidr.split('.').slice(0, 2).join('.');
      // NOTE: Neutron's DHCP and its own ports take .0.x; VMs get fixed IPs and bare metal static ones
      const subnet = new ovh.cloudproject.NetworkPrivateSubnet(`${locationKey}Subnet`, {
        serviceName: CLOUD_PROJECT,
        networkId: privateNetwork.id,
        region,
        network: cidr,
        start: `${cidrPrefix}.0.2`,
        end: `${cidrPrefix}.0.254`,
        dhcp: true,
        noGateway: true
      });
      return [locationKey, { privateNetwork, subnet }];
    })
  );
}

/**
 * Orders the machine: a Public Cloud VM, or a bare metal server joined to the vRack. Only k3s nodes
 * are protected in production; gateways hold no data, so a link change rebuilds them everywhere.
 */
export function createOvhServer({
  machine,
  network: { privateNetwork, subnet },
  dependsOn
}: {
  machine: OvhMachine;
  network: OvhLocationNetwork;
  dependsOn: $util.Resource[];
}) {
  const { server, location } = machine;
  const protect = isProduction && machine.role !== 'gateway';
  if (server.kind === 'vm') {
    const userData = machine.createUserData({
      name: VM_PRIVATE_INTERFACE,
      createNetplanDevices: (routes) => ({
        ethernets: { [VM_PRIVATE_INTERFACE]: { dhcp4: true, routes } }
      })
    });
    const imageId = ovh.cloudproject
      .getImagesOutput({ serviceName: CLOUD_PROJECT, region: location.region, osType: 'linux' })
      .images.apply((images) => {
        const image = images.find((image) => image.name === VM_IMAGE);
        if (!image) throw new Error(`No ${VM_IMAGE} image in ${location.region}`);
        return image.id;
      });
    const flavorId = ovh.cloudproject
      .getFlavorsOutput({ serviceName: CLOUD_PROJECT, region: location.region })
      .flavors.apply((flavors) => {
        const flavor = flavors.find((flavor) => flavor.name === server.flavor);
        if (!flavor) throw new Error(`No ${server.flavor} flavor in ${location.region}`);
        return flavor.id;
      });
    const instance = new ovh.cloudproject.Instance(
      `Ovh${machine.resourceName}`,
      {
        serviceName: CLOUD_PROJECT,
        region: location.region,
        name: machine.hostname,
        billingPeriod: 'hourly',
        flavor: { flavorId },
        bootFrom: { imageId },
        sshKey: { name: VM_SSH_KEY },
        network: {
          public: true,
          private: {
            network: {
              id: privateNetwork.regionsOpenstackIds.apply((ids) => ids[location.region]),
              subnetId: subnet.id
            },
            ip: machine.ip
          }
        },
        userData
      },
      {
        dependsOn,
        // NOTE: OVHcloud updates its base images, and a new image ID would replace every VM
        ignoreChanges: protect ? ['userData', 'bootFrom'] : ['bootFrom'],
        // NOTE: the replacement asks for the same fixed IP, which the old VM's port still holds
        deleteBeforeReplace: true,
        protect,
        hooks: { afterDelete: [deleteInstanceFromTailnet] }
      }
    );
    return {
      resource: instance,
      publicIp: instance.addresses.apply(
        (addresses) => addresses.find(({ ip, version }) => version === 4 && ip !== machine.ip)!.ip
      )
    };
  }

  const userData = machine.createUserData({
    name: SERVER_PRIVATE_INTERFACE,
    createNetplanDevices: (routes) => ({
      ethernets: { [SERVER_PRIVATE_INTERFACE]: { addresses: [`${machine.ip}/16`], routes } }
    })
  });
  const dedicatedServer = new ovh.dedicated.Server(
    `Ovh${machine.resourceName}`,
    {
      ovhSubsidiary: 'US',
      displayName: machine.hostname,
      os: SERVER_OS,
      customizations: { hostname: machine.hostname, configDriveUserData: userData },
      plans: [
        {
          planCode: server.planCode,
          duration: 'P1M',
          pricingMode: 'default',
          quantity: 1,
          configurations: [
            { label: 'dedicated_datacenter', value: DATACENTERS[location.region] },
            { label: 'dedicated_os', value: 'none_64.en' },
            { label: 'region', value: 'united_states' }
          ]
        }
      ],
      planOptions: server.options.map((planCode) => ({
        planCode,
        duration: 'P1M',
        pricingMode: 'default',
        quantity: 1
      }))
    },
    {
      dependsOn,
      ignoreChanges: protect ? ['os', 'customizations'] : [],
      protect,
      hooks: { afterDelete: [deleteServerFromTailnet] }
    }
  );
  new ovh.vrack.DedicatedServerInterface(
    `Ovh${machine.resourceName}Vrack`,
    {
      serviceName: VRACK,
      interfaceId: ovh
        .getServerOutput({ serviceName: dedicatedServer.serviceName })
        .enabledVrackVnis.apply((vnis) => vnis[0])
    },
    { protect }
  );
  return { resource: dedicatedServer, publicIp: dedicatedServer.ip };
}
