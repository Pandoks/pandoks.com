import { STAGE_NAME, isProduction } from '../utils';
import type { GatewayModel } from './config';
import { CLUSTER_ADDRESS_PLAN, formatClusterIp } from './types';

export type ClusterNetwork = {
  cidr: string;
  serviceName: $util.Input<string>;
  vrack: ovh.vrack.Vrack;
  privateNetwork: ovh.cloudproject.NetworkPrivate;
  subnet: ovh.cloudproject.NetworkPrivateSubnet;
  openstackNetworkId: $util.Output<string>;
  gateway: ovh.cloudproject.Gateway;
};

export function createClusterNetwork(args: {
  serviceName: $util.Input<string>;
  region: string;
  cidr: string;
  gatewayModel: GatewayModel;
}): ClusterNetwork {
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

  const cloudProjectAttachment = new ovh.vrack.CloudProject(
    'OvhK3sVrackCloudProject',
    {
      serviceName: vrack.serviceName,
      projectId: args.serviceName
    },
    { dependsOn: [vrack] }
  );

  const privateNetwork = new ovh.cloudproject.NetworkPrivate(
    'OvhK3sPrivateNetwork',
    {
      serviceName: args.serviceName,
      name: `k3s-private-${STAGE_NAME}-network`,
      regions: [args.region],
      vlanId: 0
    },
    { dependsOn: [cloudProjectAttachment] }
  );

  const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
    serviceName: args.serviceName,
    networkId: privateNetwork.id,
    region: args.region,
    network: args.cidr,
    start: formatClusterIp(
      args.cidr,
      CLUSTER_ADDRESS_PLAN.infrastructure.thirdOctet,
      CLUSTER_ADDRESS_PLAN.infrastructure.start
    ),
    end: formatClusterIp(
      args.cidr,
      CLUSTER_ADDRESS_PLAN.infrastructure.thirdOctet,
      CLUSTER_ADDRESS_PLAN.infrastructure.end
    ),
    dhcp: true
  });

  const openstackNetworkId = privateNetwork.regionsAttributes.apply((attributes) => {
    const region = attributes.find((value) => value.region === args.region);
    if (!region) {
      throw new Error(`Private network is missing region ${args.region}`);
    }
    return region.openstackid;
  });

  const gateway = new ovh.cloudproject.Gateway('OvhK3sGateway', {
    serviceName: args.serviceName,
    name: `k3s-${STAGE_NAME}-gateway`,
    model: args.gatewayModel,
    region: args.region,
    networkId: openstackNetworkId,
    subnetId: subnet.id
  });

  return {
    cidr: args.cidr,
    serviceName: args.serviceName,
    vrack,
    privateNetwork,
    subnet,
    openstackNetworkId,
    gateway
  };
}
