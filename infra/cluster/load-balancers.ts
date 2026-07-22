import { cloudflareIpv4Cidrs } from '../dns';
import { LOAD_BALANCER_ALGORITHM, LOAD_BALANCER_FLAVOR } from './config';
import type { ClusterNetwork } from './network';
import { regionalResourceName, type ClusterNodeSpec, type RegionalClusterPlan } from './topology';

function members(nodes: readonly ClusterNodeSpec[], port: number) {
  return nodes.map((node) => ({
    name: node.hostname,
    address: node.privateIp,
    protocolPort: port
  }));
}

export function createClusterLoadBalancers(args: {
  network: ClusterNetwork;
  cluster: RegionalClusterPlan;
}) {
  const { config, identity, privateApi, publicIngress } = args.cluster;
  const provider = args.network.foundation.provider;
  const invokeOptions = provider ? { provider } : {};
  const resourceOptions = provider ? { provider } : {};
  const flavorId =
    privateApi.mode === 'ovh' || publicIngress.loadBalancerCount > 0
      ? ovh.cloudproject
          .getLoadBalancerFlavorsOutput(
            {
              serviceName: args.network.foundation.projectId,
              regionName: config.publicCloudRegion
            },
            invokeOptions
          )
          .apply((result) => {
            const flavor = result.flavors.find(({ name }) => name === LOAD_BALANCER_FLAVOR);
            if (!flavor) {
              throw new Error(
                `Load balancer flavor ${LOAD_BALANCER_FLAVOR} isn't available in ${config.publicCloudRegion}`
              );
            }
            return flavor.id;
          })
      : undefined;

  const api =
    privateApi.mode === 'ovh'
      ? new ovh.cloudproject.LoadBalancer(
          regionalResourceName('OvhK3sPrivateApiLoadBalancer', config.id),
          {
            serviceName: args.network.foundation.projectId,
            name: `k3s-private-${identity.namePrefix}-api`,
            regionName: config.publicCloudRegion,
            flavorId: flavorId!,
            network: {
              private: {
                network: { id: args.network.network.id, subnetId: args.network.subnet.id }
              }
            },
            listeners: [
              {
                port: 6443,
                protocol: 'tcp',
                allowedCidrs: [config.networkCidr],
                pool: {
                  algorithm: LOAD_BALANCER_ALGORITHM,
                  protocol: 'tcp',
                  members: members(privateApi.nodes, 6443),
                  healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
                }
              }
            ]
          },
          resourceOptions
        )
      : undefined;
  const apiTarget = api?.vipAddress ?? privateApi.nodes[0]?.privateIp;
  if (!apiTarget) throw new Error(`Cluster region ${config.id} has no control-plane API target`);

  const ingress = Array.from({ length: publicIngress.loadBalancerCount }, (_, index) => {
    const suffix = index === 0 ? '' : String(index);
    const resourceName = regionalResourceName(
      `OvhK3sPublicIngressLoadBalancer${suffix}`,
      config.id
    );
    const name = `k3s-public-${identity.namePrefix}-ingress${index === 0 ? '' : `-${index}`}`;
    return new ovh.cloudproject.LoadBalancer(
      resourceName,
      {
        serviceName: args.network.foundation.projectId,
        name,
        regionName: config.publicCloudRegion,
        flavorId: flavorId!,
        network: {
          private: {
            network: { id: args.network.network.id, subnetId: args.network.subnet.id },
            floatingIpCreate: { description: name },
            gateway: { id: args.network.gateway.id }
          }
        },
        listeners: [
          {
            port: 443,
            protocol: 'tcp',
            allowedCidrs: cloudflareIpv4Cidrs,
            pool: {
              algorithm: LOAD_BALANCER_ALGORITHM,
              protocol: 'tcp',
              members: members(publicIngress.nodes, 443),
              healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
            }
          }
        ]
      },
      resourceOptions
    );
  });
  return { apiTarget, publicIngress: ingress };
}
