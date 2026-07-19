import { isProduction } from '../../utils';
import { createNodeBootstrap, deleteServerFromTailnet } from '../bootstrap';
import type { ClusterNetwork } from '../network';
import type { ClusterNodeSpec, PublicCloudNodePool } from '../types';

export type ClusterNode = {
  spec: ClusterNodeSpec;
  privateIp: $util.Output<string>;
  resource: $util.CustomResource;
  readiness: $util.Resource;
};

export function createPublicCloudNode(args: {
  spec: ClusterNodeSpec & { pool: PublicCloudNodePool };
  network: ClusterNetwork;
  apiAddress: $util.Input<string>;
  flavorId: $util.Input<string>;
  imageId: $util.Input<string>;
  protect: boolean;
}): ClusterNode {
  const bootstrap = createNodeBootstrap({
    node: args.spec,
    apiAddress: args.apiAddress,
    networkCidr: args.network.cidr,
    networkMode: 'dhcp',
    dependsOn: [args.network.privateNetwork, args.network.subnet]
  });

  const instance = new ovh.cloudproject.Instance(
    args.spec.logicalName,
    {
      serviceName: args.network.serviceName,
      name: args.spec.hostname,
      region: args.spec.pool.region,
      billingPeriod: 'hourly',
      flavor: { flavorId: args.flavorId },
      bootFrom: { imageId: args.imageId },
      network: {
        public: true,
        private: {
          ip: args.spec.privateIp,
          network: {
            id: args.network.openstackNetworkId,
            subnetId: args.network.subnet.id
          }
        }
      },
      userData: bootstrap.cloudInit
    },
    {
      ignoreChanges: isProduction ? ['userData'] : [],
      protect: args.protect,
      hooks: { afterDelete: [deleteServerFromTailnet] }
    }
  );

  return {
    spec: args.spec,
    privateIp: $output(args.spec.privateIp),
    resource: instance,
    readiness: instance
  };
}
