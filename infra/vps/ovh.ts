import { isProduction, STAGE_NAME } from '../dns';
import {
  createNodeUserData,
  createTailnetCleanupHook,
  getNodeIp,
  NODE_IP_STARTS,
  NODE_RESOURCE_NAMES,
  PRIVATE_IP_RANGE,
  type NodeCounts
} from './servers';

// NOTE: service names from the OVHcloud control panel (Bare Metal Cloud > vRack, Public Cloud project ID)
const VRACK = isProduction ? '' : '';
const CLOUD_PROJECT = isProduction ? '' : '';
const DATACENTER = isProduction ? 'hil' : 'hil'; // options: hil | vin
const CLOUD_REGION = isProduction ? 'US-WEST-OR-1' : 'US-WEST-OR-1'; // options: US-WEST-OR-1 | US-EAST-VA-1
// Control plane on Public Cloud VMs; workers and databases on Advance bare metal (codes from the US catalog)
const CONTROL_PLANE_FLAVOR = isProduction ? 'd2-4' : 'd2-4';
const CONTROL_PLANE_IMAGE = 'Ubuntu 24.04';
const WORKER_PLAN = {
  planCode: '24adv01-v3-us',
  options: [
    'ram-32g-on-die-ecc-5200-24adv01-v3-us',
    'softraid-2x960nvme-pcie-gen4-24adv01-v3-us',
    'bandwidth-3000-adv-gen3-us',
    'vrack-bandwidth-25000-adv-gen3-us'
  ]
};
const DATABASE_PLAN = {
  planCode: '26adv05-v2-us',
  options: [
    'ram-128g-ecc-5600-26adv05-v2-us',
    'softraid-2x960nvme-pcie-gen5-26adv05-v2-us',
    'bandwidth-3000-adv-gen4-us',
    'vrack-bandwidth-25000-adv-gen4-us'
  ]
};
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

export function createOvhCluster(nodeCounts: NodeCounts) {
  const missing = Object.entries({ VRACK, CLOUD_PROJECT, SERVER_PRIVATE_INTERFACE })
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
      regions: [CLOUD_REGION],
      vlanId: 0
    },
    { dependsOn: [vrackCloudProject] }
  );
  // NOTE: DHCP only hands out the control plane range; bare metal servers set their IPs statically
  const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
    serviceName: CLOUD_PROJECT,
    networkId: privateNetwork.id,
    region: CLOUD_REGION,
    network: PRIVATE_IP_RANGE,
    start: getNodeIp({ type: 'control-plane', index: 0 }),
    end: getNodeIp({
      type: 'control-plane',
      index: NODE_IP_STARTS.worker - NODE_IP_STARTS['control-plane'] - 1
    }),
    dhcp: true,
    noGateway: true
  });

  const flavorId = ovh.cloudproject
    .getFlavorsOutput({ serviceName: CLOUD_PROJECT, region: CLOUD_REGION })
    .flavors.apply((flavors) => {
      const flavor = flavors.find((flavor) => flavor.name === CONTROL_PLANE_FLAVOR);
      if (!flavor) throw new Error(`No ${CONTROL_PLANE_FLAVOR} flavor in ${CLOUD_REGION}`);
      return flavor.id;
    });
  const imageId = ovh.cloudproject
    .getImagesOutput({ serviceName: CLOUD_PROJECT, region: CLOUD_REGION, osType: 'linux' })
    .images.apply((images) => {
      const image = images.find((image) => image.name === CONTROL_PLANE_IMAGE);
      if (!image) throw new Error(`No ${CONTROL_PLANE_IMAGE} image in ${CLOUD_REGION}`);
      return image.id;
    });

  const nodes: $util.Resource[] = [];
  for (let i = 0; i < nodeCounts['control-plane']; i++) {
    const { userData, tailscaleHostname } = createNodeUserData({
      provider: 'ovh',
      type: 'control-plane',
      index: i,
      privateInterface: VM_PRIVATE_INTERFACE,
      privateNetplan: ''
    });
    nodes.push(
      new ovh.cloudproject.Instance(
        `OvhControlPlaneServer${i}`,
        {
          serviceName: CLOUD_PROJECT,
          region: CLOUD_REGION,
          name: tailscaleHostname,
          billingPeriod: 'hourly',
          flavor: { flavorId },
          bootFrom: { imageId },
          network: {
            public: true,
            private: {
              network: {
                id: privateNetwork.regionsOpenstackIds.apply((ids) => ids[CLOUD_REGION]),
                subnetId: subnet.id
              },
              ip: getNodeIp({ type: 'control-plane', index: i })
            }
          },
          userData
        },
        {
          dependsOn: nodes.slice(0, 1),
          ignoreChanges: isProduction ? ['userData'] : [],
          protect: isProduction,
          hooks: { afterDelete: [deleteInstanceFromTailnet] }
        }
      )
    );
  }

  for (const type of ['worker', 'database'] as const) {
    const plan = type === 'database' ? DATABASE_PLAN : WORKER_PLAN;
    for (let i = 0; i < nodeCounts[type]; i++) {
      const privateNetplan = Buffer.from(
        `network:\n  version: 2\n  ethernets:\n    ${SERVER_PRIVATE_INTERFACE}:\n      addresses: [${getNodeIp({ type, index: i })}/24]\n`
      ).toString('base64');
      const { userData, tailscaleHostname } = createNodeUserData({
        provider: 'ovh',
        type,
        index: i,
        privateInterface: SERVER_PRIVATE_INTERFACE,
        privateNetplan
      });
      const server = new ovh.dedicated.Server(
        `Ovh${NODE_RESOURCE_NAMES[type]}Server${i}`,
        {
          ovhSubsidiary: 'US',
          displayName: tailscaleHostname,
          os: SERVER_OS,
          customizations: { hostname: tailscaleHostname, configDriveUserData: userData },
          plans: [
            {
              planCode: plan.planCode,
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
          planOptions: plan.options.map((planCode) => ({
            planCode,
            duration: 'P1M',
            pricingMode: 'default',
            quantity: 1
          }))
        },
        {
          dependsOn: nodes.slice(0, 1),
          ignoreChanges: isProduction ? ['customizations'] : [],
          protect: isProduction,
          hooks: { afterDelete: [deleteServerFromTailnet] }
        }
      );
      new ovh.vrack.DedicatedServerInterface(
        `Ovh${NODE_RESOURCE_NAMES[type]}Server${i}Vrack`,
        {
          serviceName: VRACK,
          interfaceId: ovh
            .getServerOutput({ serviceName: server.serviceName })
            .enabledVrackVnis.apply((vnis) => vnis[0])
        },
        { protect: isProduction }
      );
      nodes.push(server);
    }
  }

  return { controlPlaneLoadBalancers: [], workerLoadBalancers: [] };
}
