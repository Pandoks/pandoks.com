import { GATEWAY_MODEL } from './config';
import { clusterResourceName, type ClusterPlan } from './topology';

export type ClusterFoundation = {
  projectId: $util.Output<string>;
  subsidiary: $util.Output<string>;
  vrack: ovh.vrack.Vrack;
  attachment: ovh.vrack.CloudProject;
};

export type ClusterNetwork = {
  foundation: ClusterFoundation;
  network: ovh.CloudNetworkPrivateVrack;
  subnet: ovh.CloudNetworkPrivateVrackSubnet;
  gateway: ovh.CloudGateway;
};

export function createClusterNetwork(
  foundation: ClusterFoundation,
  cluster: ClusterPlan
): ClusterNetwork {
  const { config, identity, network } = cluster;
  const privateNetwork = new ovh.CloudNetworkPrivateVrack(
    clusterResourceName('OvhK3sPrivateNetwork', config.region),
    {
      serviceName: foundation.projectId,
      name: `k3s-private-${identity.namePrefix}-network`,
      description: `k3s ${identity.namePrefix} private network`,
      region: network.publicCloudRegion,
      vlanId: network.vlanId
    },
    { dependsOn: [foundation.attachment] }
  );
  const subnet = new ovh.CloudNetworkPrivateVrackSubnet(
    clusterResourceName('OvhK3sSubnet', config.region),
    {
      serviceName: foundation.projectId,
      networkId: privateNetwork.id,
      name: `k3s-${identity.namePrefix}-subnet`,
      region: network.publicCloudRegion,
      cidr: network.networkCidr,
      gatewayIp: network.gatewayIp,
      allocationPools: [network.allocationPool],
      dhcpEnabled: true
    }
  );
  const gateway = new ovh.CloudGateway(clusterResourceName('OvhK3sGateway', config.region), {
    serviceName: foundation.projectId,
    name: `k3s-${identity.namePrefix}-gateway`,
    region: network.publicCloudRegion,
    externalGateway: { enabled: true, model: GATEWAY_MODEL },
    subnetIds: [subnet.id]
  });
  return { foundation, network: privateNetwork, subnet, gateway };
}
