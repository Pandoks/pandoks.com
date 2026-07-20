import { STAGE_NAME, isProduction } from '../utils';
import { GATEWAY_MODEL, REGION } from './config';

export type ClusterNetwork = {
  cidr: $util.Output<string>;
  projectId: $util.Input<string>;
  vrack: ovh.vrack.Vrack;
  networkId: $util.Output<string>;
  subnet: ovh.CloudNetworkPrivateVrackSubnet;
  gateway: ovh.CloudGateway;
};

/**
 * Subnet CIDRs
 *
 * 10.0.0.x            OVH/Neutron infrastructure
 * 10.0.1.x            Public Cloud control planes
 * 10.0.2.x            Public Cloud workers
 * 10.0.3.x            Dedicated control planes
 * 10.0.4.x            Dedicated workers
 * 10.0.5.x            MetalLB services
 * 10.0.6-255.x        Reserved
 */
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
    // Keep 10.0.N.x role blocks /24-compatible for future splits without readdressing.
    allocationPools: [{ start: '10.0.0.2', end: '10.0.0.254' }],
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
    cidr: subnet.cidr,
    projectId,
    vrack,
    networkId: privateNetwork.id,
    subnet,
    gateway
  };
}
