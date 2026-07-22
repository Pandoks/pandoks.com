import { GATEWAY_MODEL } from './config';
import { regionalResourceName, type RegionalClusterPlan } from './topology';

export type ClusterFoundation = {
  projectId: $util.Output<string>;
  subsidiary: string;
  vrack: ovh.vrack.Vrack;
  attachment: ovh.vrack.CloudProject;
  provider?: ovh.Provider;
};

export type ClusterNetwork = {
  foundation: ClusterFoundation;
  network: ovh.CloudNetworkPrivateVrack;
  subnet: ovh.CloudNetworkPrivateVrackSubnet;
  gateway: ovh.CloudGateway;
};

export function createClusterNetwork(
  foundation: ClusterFoundation,
  cluster: RegionalClusterPlan
): ClusterNetwork {
  const { config, identity } = cluster;
  const provider = foundation.provider ? { provider: foundation.provider } : {};
  const privateNetwork = new ovh.CloudNetworkPrivateVrack(
    regionalResourceName('OvhK3sPrivateNetwork', config.id),
    {
      serviceName: foundation.projectId,
      name: `k3s-private-${identity.namePrefix}-network`,
      description: `k3s ${identity.namePrefix} private network`,
      region: config.publicCloudRegion,
      vlanId: config.vlanId
    },
    { dependsOn: [foundation.attachment], ...provider }
  );
  const subnet = new ovh.CloudNetworkPrivateVrackSubnet(
    regionalResourceName('OvhK3sSubnet', config.id),
    {
      serviceName: foundation.projectId,
      networkId: privateNetwork.id,
      name: `k3s-${identity.namePrefix}-subnet`,
      region: config.publicCloudRegion,
      cidr: config.networkCidr,
      gatewayIp: config.gatewayIp,
      allocationPools: [config.allocationPool],
      dhcpEnabled: true
    },
    provider
  );
  const gateway = new ovh.CloudGateway(
    regionalResourceName('OvhK3sGateway', config.id),
    {
      serviceName: foundation.projectId,
      name: `k3s-${identity.namePrefix}-gateway`,
      region: config.publicCloudRegion,
      externalGateway: { enabled: true, model: GATEWAY_MODEL },
      subnetIds: [subnet.id]
    },
    provider
  );
  return { foundation, network: privateNetwork, subnet, gateway };
}
