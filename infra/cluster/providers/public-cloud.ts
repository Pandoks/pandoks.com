import { createNodeBootstrap, deleteServerFromTailnet } from './bootstrap';
import type { ClusterNetwork } from '../network';
import type { ClusterNodeSpec, PublicCloudNodePool } from '../topology';

export function createPublicCloudNodes(args: {
  pool: PublicCloudNodePool;
  nodes: readonly ClusterNodeSpec[];
  network: ClusterNetwork;
  apiAddress: $util.Input<string>;
  protect: boolean;
}) {
  const flavorId = ovh.cloudproject
    .getFlavorsOutput({
      serviceName: args.network.projectId,
      region: args.pool.region,
      nameFilter: args.pool.flavor
    })
    .apply((result) => {
      const flavor = result.flavors.at(0);
      if (!flavor) throw new Error(`Flavor ${args.pool.flavor} isn't available`);
      return flavor.id;
    });
  const imageId = ovh.cloudproject
    .getImagesOutput({
      serviceName: args.network.projectId,
      region: args.pool.region,
      osType: 'linux'
    })
    .apply((result) => {
      const image = result.images.find(({ name }) => name === args.pool.image);
      if (!image) throw new Error(`Image ${args.pool.image} isn't available`);
      return image.id;
    });

  for (const node of args.nodes) {
    const bootstrap = createNodeBootstrap({
      node,
      apiAddress: args.apiAddress,
      networkCidr: args.network.cidr,
      networkMode: 'dhcp',
      dependsOn: [args.network.subnet]
    });
    new ovh.cloudproject.Instance(
      node.logicalName,
      {
        serviceName: args.network.projectId,
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
              id: args.network.networkId,
              subnetId: args.network.subnet.id
            }
          }
        },
        userData: bootstrap
      },
      {
        ignoreChanges: args.protect ? ['userData'] : [],
        protect: args.protect,
        hooks: { afterDelete: [deleteServerFromTailnet] }
      }
    );
  }
}
