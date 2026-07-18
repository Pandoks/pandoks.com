import { isProduction, STAGE_NAME } from '../dns';
import { requireOvhCloudProjectService } from '../ovh';
import { CLUSTER_ADDRESS_PLAN } from './types';

export type ClusterNetwork = {
  cidr: string;
  vrack: ovh.vrack.Vrack;
  privateNetwork: ovh.cloudproject.NetworkPrivate;
  subnet: ovh.cloudproject.NetworkPrivateSubnet;
  openstackNetworkId: $util.Output<string>;
  gateway: ovh.cloudproject.Gateway;
};

export function createClusterNetwork(args: {
  region: string;
  cidr: string;
  gatewayModel: string;
}): ClusterNetwork {
  const serviceName = requireOvhCloudProjectService();
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
      projectId: serviceName
    },
    { dependsOn: [vrack] }
  );

  const privateNetwork = new ovh.cloudproject.NetworkPrivate(
    'OvhK3sPrivateNetwork',
    {
      serviceName,
      name: `k3s-private-${STAGE_NAME}-network`,
      regions: [args.region],
      vlanId: 0
    },
    { dependsOn: [cloudProjectAttachment] }
  );

  const subnetPrefix = args.cidr.split('.').slice(0, 3).join('.');
  const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
    serviceName,
    networkId: privateNetwork.id,
    region: args.region,
    network: args.cidr,
    start: `${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.dhcp.start}`,
    end: `${subnetPrefix}.${CLUSTER_ADDRESS_PLAN.dhcp.end}`,
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
    serviceName,
    name: `k3s-${STAGE_NAME}-gateway`,
    model: args.gatewayModel,
    region: args.region,
    networkId: openstackNetworkId,
    subnetId: subnet.id
  });

  return {
    cidr: args.cidr,
    vrack,
    privateNetwork,
    subnet,
    openstackNetworkId,
    gateway
  };
}
