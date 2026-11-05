import { isProduction, STAGE_NAME } from '../dns';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getClusterNodes,
  PRIVATE_IP_RANGE,
  type NodePool
} from './servers';

// NOTE: a Public Cloud VM flavor like d2-4, or a bare metal plan code and its options from the US
// catalog (https://api.us.ovhcloud.com/1.0/order/catalog/public/baremetalServers?ovhSubsidiary=US)
export type OvhServer = { flavor: string } | { planCode: string; options: string[] };
export const ADVANCE_1_SERVER: OvhServer = {
  planCode: '24adv01-v3-us',
  options: [
    'ram-32g-on-die-ecc-5200-24adv01-v3-us',
    'softraid-2x960nvme-pcie-gen4-24adv01-v3-us',
    'bandwidth-3000-adv-gen3-us',
    'vrack-bandwidth-25000-adv-gen3-us'
  ]
};
export const ADVANCE_5_SERVER: OvhServer = {
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
const DATACENTER = isProduction ? 'hil' : 'hil'; // options: hil | vin
const CLOUD_REGION = isProduction ? 'US-WEST-OR-1' : 'US-WEST-OR-1'; // options: US-WEST-OR-1 | US-EAST-VA-1
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

export function createOvhCluster(pools: NodePool<OvhServer>[]) {
  const ordersVms = pools.some((pool) => pool.count > 0 && 'flavor' in pool.server);
  const ordersBareMetal = pools.some((pool) => pool.count > 0 && 'planCode' in pool.server);
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
  const nodes = getClusterNodes({ provider: 'ovh', pools });

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
      regions: [CLOUD_REGION],
      vlanId: 0
    },
    { dependsOn: [vrackCloudProject] }
  );
  // NOTE: Neutron's DHCP and its own ports take 10.0.0.x; VMs get their nodes' fixed IPs, and bare
  // metal servers set theirs statically
  const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
    serviceName: CLOUD_PROJECT,
    networkId: privateNetwork.id,
    region: CLOUD_REGION,
    network: PRIVATE_IP_RANGE,
    start: '10.0.0.2',
    end: '10.0.0.254',
    dhcp: true,
    noGateway: true
  });

  const flavors = ovh.cloudproject.getFlavorsOutput({
    serviceName: CLOUD_PROJECT,
    region: CLOUD_REGION
  }).flavors;
  const imageId = ovh.cloudproject
    .getImagesOutput({ serviceName: CLOUD_PROJECT, region: CLOUD_REGION, osType: 'linux' })
    .images.apply((images) => {
      const image = images.find((image) => image.name === VM_IMAGE);
      if (!image) throw new Error(`No ${VM_IMAGE} image in ${CLOUD_REGION}`);
      return image.id;
    });

  const nodeResources: $util.Resource[] = [];
  for (const node of nodes) {
    const { server } = node.pool;
    if ('flavor' in server) {
      const userData = createNodeUserData({
        provider: 'ovh',
        node,
        privateInterface: VM_PRIVATE_INTERFACE,
        privateNetplan: ''
      });
      nodeResources.push(
        new ovh.cloudproject.Instance(
          `Ovh${node.resourceName}`,
          {
            serviceName: CLOUD_PROJECT,
            region: CLOUD_REGION,
            name: node.hostname,
            billingPeriod: 'hourly',
            flavor: {
              flavorId: flavors.apply((flavors) => {
                const flavor = flavors.find((flavor) => flavor.name === server.flavor);
                if (!flavor) throw new Error(`No ${server.flavor} flavor in ${CLOUD_REGION}`);
                return flavor.id;
              })
            },
            bootFrom: { imageId },
            sshKey: { name: VM_SSH_KEY },
            network: {
              public: true,
              private: {
                network: {
                  id: privateNetwork.regionsOpenstackIds.apply((ids) => ids[CLOUD_REGION]),
                  subnetId: subnet.id
                },
                ip: node.ip
              }
            },
            userData
          },
          {
            dependsOn: nodeResources.slice(0, 1),
            ignoreChanges: isProduction ? ['userData'] : [],
            protect: isProduction,
            hooks: { afterDelete: [deleteInstanceFromTailnet] }
          }
        )
      );
      continue;
    }

    const privateNetplan = Buffer.from(
      `network:\n  version: 2\n  ethernets:\n    ${SERVER_PRIVATE_INTERFACE}:\n      addresses: [${node.ip}/${PRIVATE_IP_RANGE.split('/')[1]}]\n`
    ).toString('base64');
    const userData = createNodeUserData({
      provider: 'ovh',
      node,
      privateInterface: SERVER_PRIVATE_INTERFACE,
      privateNetplan
    });
    const dedicatedServer = new ovh.dedicated.Server(
      `Ovh${node.resourceName}`,
      {
        ovhSubsidiary: 'US',
        displayName: node.hostname,
        os: SERVER_OS,
        customizations: { hostname: node.hostname, configDriveUserData: userData },
        plans: [
          {
            planCode: server.planCode,
            duration: 'P1M',
            pricingMode: 'default',
            quantity: 1,
            configurations: [
              { label: 'dedicated_datacenter', value: DATACENTER },
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
        dependsOn: nodeResources.slice(0, 1),
        ignoreChanges: isProduction ? ['os', 'customizations'] : [],
        protect: isProduction,
        hooks: { afterDelete: [deleteServerFromTailnet] }
      }
    );
    new ovh.vrack.DedicatedServerInterface(
      `Ovh${node.resourceName}Vrack`,
      {
        serviceName: VRACK,
        interfaceId: ovh
          .getServerOutput({ serviceName: dedicatedServer.serviceName })
          .enabledVrackVnis.apply((vnis) => vnis[0])
      },
      { protect: isProduction }
    );
    nodeResources.push(dedicatedServer);
  }
}
