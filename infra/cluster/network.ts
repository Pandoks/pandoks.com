import { STAGE_NAME, isProduction } from '../utils';
import { GATEWAY_MODEL, REGION } from './config';
import { CLUSTER_NETWORK } from './topology';

export type ClusterNetwork = {
  cidr: string;
  projectId: $util.Input<string>;
  vrack: ovh.vrack.Vrack;
  networkId: $util.Output<string>;
  subnet: ovh.CloudNetworkPrivateVrackSubnet;
  gateway: ovh.CloudGateway;
};

export function createClusterNetwork(projectId: $util.Input<string>): ClusterNetwork {
  const vrack = new ovh.vrack.Vrack(
    'OvhK3sVrack',
    {
      ovhSubsidiary: 'US',
      name: `k3s-${STAGE_NAME}`,
      description: `k3s ${STAGE_NAME} private network`,
      plan: {
        duration: 'P1M',
        planCode: 'vrack',
        pricingMode: 'default'
      }
    },
    { protect: isProduction }
  );
  const attachment = new ovh.vrack.CloudProject('OvhK3sVrackCloudProject', {
    serviceName: vrack.serviceName,
    projectId
  });
  const privateNetwork = new ovh.CloudNetworkPrivateVrack(
    'OvhK3sPrivateNetwork',
    {
      serviceName: projectId,
      name: `k3s-private-${STAGE_NAME}-network`,
      description: `k3s ${STAGE_NAME} private network`,
      region: REGION,
      vlanId: 0
    },
    { dependsOn: [attachment] }
  );
  const subnet = new ovh.CloudNetworkPrivateVrackSubnet('OvhK3sSubnet', {
    serviceName: projectId,
    networkId: privateNetwork.id,
    name: `k3s-${STAGE_NAME}-subnet`,
    region: REGION,
    cidr: CLUSTER_NETWORK.cidr,
    allocationPools: [{ start: CLUSTER_NETWORK.dhcpStart, end: CLUSTER_NETWORK.dhcpEnd }],
    dhcpEnabled: true
  });
  const gateway = new ovh.CloudGateway('OvhK3sGateway', {
    serviceName: projectId,
    name: `k3s-${STAGE_NAME}-gateway`,
    region: REGION,
    externalGateway: { enabled: true, model: GATEWAY_MODEL },
    subnetIds: [subnet.id]
  });

  return {
    cidr: CLUSTER_NETWORK.cidr,
    projectId,
    vrack,
    networkId: privateNetwork.id,
    subnet,
    gateway
  };
}
