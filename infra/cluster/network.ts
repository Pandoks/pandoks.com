import { STAGE_NAME, isProduction } from '../utils';
import { GATEWAY_MODEL, REGION } from './config';
import { CLUSTER_NETWORK } from './topology';

export type ClusterNetwork = {
  cidr: string;
  serviceName: $util.Input<string>;
  vrack: ovh.vrack.Vrack;
  subnet: ovh.cloudproject.NetworkPrivateSubnet;
  openstackNetworkId: $util.Output<string>;
  gateway: ovh.cloudproject.Gateway;
};

export function createClusterNetwork(serviceName: $util.Input<string>): ClusterNetwork {
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
  const attachment = new ovh.vrack.CloudProject(
    'OvhK3sVrackCloudProject',
    { serviceName: vrack.serviceName, projectId: serviceName },
    { dependsOn: [vrack] }
  );
  const privateNetwork = new ovh.cloudproject.NetworkPrivate(
    'OvhK3sPrivateNetwork',
    {
      serviceName,
      name: `k3s-private-${STAGE_NAME}-network`,
      regions: [REGION],
      vlanId: 0
    },
    { dependsOn: [attachment] }
  );
  const subnet = new ovh.cloudproject.NetworkPrivateSubnet('OvhK3sSubnet', {
    serviceName,
    networkId: privateNetwork.id,
    region: REGION,
    network: CLUSTER_NETWORK.cidr,
    start: CLUSTER_NETWORK.dhcpStart,
    end: CLUSTER_NETWORK.dhcpEnd,
    dhcp: true
  });
  const openstackNetworkId = privateNetwork.regionsAttributes.apply((attributes) => {
    const region = attributes.find((value) => value.region === REGION);
    if (!region) throw new Error(`Private network is missing region ${REGION}`);
    return region.openstackid;
  });
  const gateway = new ovh.cloudproject.Gateway('OvhK3sGateway', {
    serviceName,
    name: `k3s-${STAGE_NAME}-gateway`,
    model: GATEWAY_MODEL,
    region: REGION,
    networkId: openstackNetworkId,
    subnetId: subnet.id
  });

  return {
    cidr: CLUSTER_NETWORK.cidr,
    serviceName,
    vrack,
    subnet,
    openstackNetworkId,
    gateway
  };
}
