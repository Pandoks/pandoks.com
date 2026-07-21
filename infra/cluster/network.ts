import { STAGE_NAME, isProduction } from '../utils';
import { GATEWAY_MODEL, REGION } from './config';

export type ClusterNetwork = {
  projectId: $util.Output<string>;
  vrack: ovh.vrack.Vrack;
  network: ovh.CloudNetworkPrivateVrack;
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
    cidr: '10.0.0.0/16',
    gatewayIp: '10.0.0.1',
    // Node partitions are stable and assigned by NODE_POOL_ADDRESS_BLOCKS in topology.ts.
    allocationPools: [{ start: '10.0.0.2', end: '10.0.0.254' }],
    dhcpEnabled: true
  });

  // allows for public internet access
  const gateway = new ovh.CloudGateway('OvhK3sGateway', {
    serviceName: projectId,
    name: `k3s-${STAGE_NAME}-gateway`,
    region: REGION,
    externalGateway: { enabled: true, model: GATEWAY_MODEL },
    subnetIds: [subnet.id]
  });

  return {
    projectId: $output(projectId),
    vrack,
    network: privateNetwork,
    subnet,
    gateway
  };
}
