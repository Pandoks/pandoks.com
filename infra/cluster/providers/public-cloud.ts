import { createNodeBootstrap, deleteServerFromTailnet } from './bootstrap';
import type { ClusterNetwork } from '../network';
import type { ClusterNodeSpec, PublicCloudNodePool, RegionalClusterPlan } from '../topology';

export function createPublicCloudNodes(args: {
  cluster: RegionalClusterPlan;
  pool: PublicCloudNodePool;
  nodes: readonly ClusterNodeSpec[];
  network: ClusterNetwork;
  apiAddress: $util.Input<string>;
  protect: boolean;
}) {
  const provisioned: Array<{ node: ClusterNodeSpec; publicIp: $util.Output<string> }> = [];
  const provider = args.network.foundation.provider;
  const providerOptions = provider ? { provider } : {};
  const flavorId = ovh.cloudproject
    .getFlavorsOutput(
      {
        serviceName: args.network.foundation.projectId,
        region: args.pool.region,
        nameFilter: args.pool.machineType
      },
      providerOptions
    )
    .apply((result) => {
      const flavor = result.flavors.at(0);
      if (!flavor) throw new Error(`Machine type ${args.pool.machineType} isn't available`);
      return flavor.id;
    });
  const imageId = ovh.cloudproject
    .getImagesOutput(
      {
        serviceName: args.network.foundation.projectId,
        region: args.pool.region,
        osType: 'linux'
      },
      providerOptions
    )
    .apply((result) => {
      const image = result.images.find(({ name }) => name === args.pool.image);
      if (!image) throw new Error(`Image ${args.pool.image} isn't available`);
      return image.id;
    });

  for (const node of args.nodes) {
    const bootstrap = createNodeBootstrap({
      cluster: args.cluster,
      node,
      apiAddress: args.apiAddress,
      networkCidr: args.network.subnet.cidr,
      networkMode: 'dhcp',
      dependsOn: [args.network.subnet]
    });
    const instance = new ovh.cloudproject.Instance(
      node.logicalName,
      {
        serviceName: args.network.foundation.projectId,
        name: node.hostname,
        region: args.pool.region,
        billingPeriod: 'hourly',
        flavor: { flavorId },
        bootFrom: { imageId },
        network: {
          public: true,
          private: {
            ip: node.privateIp,
            network: {
              id: args.network.network.id,
              subnetId: args.network.subnet.id
            }
          }
        },
        userData: bootstrap
      },
      {
        ignoreChanges: args.protect ? ['userData'] : [],
        protect: args.protect,
        ...providerOptions,
        hooks: { afterDelete: [deleteServerFromTailnet] }
      }
    );
    const publicIp = instance.addresses.apply((addresses) => {
      const address = addresses.find(({ ip, version }) => version === 4 && ip !== node.privateIp);
      if (!address) throw new Error(`Public IPv4 address unavailable for ${node.hostname}`);
      return address.ip;
    });
    provisioned.push({ node, publicIp });
  }

  return provisioned;
}
