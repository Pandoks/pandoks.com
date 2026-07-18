import { STAGE_NAME } from '../dns';
import { OVH_CLOUD_PROJECT_SERVICE } from '../ovh';

export function createLoadBalancers(
  loadBalancerArgs: {
    type: 'control-plane' | 'worker';
    loadBalancerCount: number;
    loadBalancersPerNode: number;
    serverIps: string[];
    serversPerLoadBalancer: number;
    network: { networkId: $util.Output<string>; subnetId: $util.Output<string> };
    gateway: ovh.cloudproject.Gateway | undefined;
  },
  ovhLoadBalancerArgs: {
    flavorId: string;
    region: string;
    algorithm: string;
  }
): ovh.cloudproject.LoadBalancer[] {
  if (!loadBalancerArgs.loadBalancerCount) {
    return [];
  }
  if (!loadBalancerArgs.gateway) {
    throw new Error('Load balancers need a gateway on the private network for their floating ips');
  }

  const loadBalancerResourceName =
    loadBalancerArgs.type === 'control-plane' ? 'ControlPlane' : 'Worker';
  const publicLoadBalancers: ovh.cloudproject.LoadBalancer[] = [];
  for (let i = 0; i < loadBalancerArgs.loadBalancerCount; i++) {
    const groupIndex = Math.floor(i / loadBalancerArgs.loadBalancersPerNode);
    const memberIps = loadBalancerArgs.serverIps.slice(
      groupIndex * loadBalancerArgs.serversPerLoadBalancer,
      (groupIndex + 1) * loadBalancerArgs.serversPerLoadBalancer
    );

    const publicLoadBalancer = new ovh.cloudproject.LoadBalancer(
      `OvhK3sPublic${loadBalancerResourceName}LoadBalancer${i}`,
      {
        serviceName: OVH_CLOUD_PROJECT_SERVICE,
        name: `k3s-public-${STAGE_NAME}-${loadBalancerArgs.type}-load-balancer-${i}`,
        regionName: ovhLoadBalancerArgs.region,
        flavorId: ovhLoadBalancerArgs.flavorId,
        network: {
          private: {
            network: {
              id: loadBalancerArgs.network.networkId,
              subnetId: loadBalancerArgs.network.subnetId
            },
            floatingIpCreate: {
              description: `k3s-public-${STAGE_NAME}-${loadBalancerArgs.type}-load-balancer-${i}`
            },
            gateway: { id: loadBalancerArgs.gateway.id }
          }
        },
        // Only enable https on the load balancer because we're using Cloudflare Strict
        listeners: [
          {
            port: 443,
            protocol: 'tcp',
            pool: {
              algorithm: ovhLoadBalancerArgs.algorithm,
              // NOTE: needed to validate all requests are coming from Cloudflare (tcp will only show the load balancer's private network ip)
              protocol: 'proxyV2',
              members: memberIps.map((memberIp, serverIndex) => ({
                name: `${loadBalancerArgs.type}-server-${groupIndex * loadBalancerArgs.serversPerLoadBalancer + serverIndex}`,
                address: memberIp,
                protocolPort: 30443
              })),
              healthMonitor: {
                monitorType: 'tcp',
                delay: 10,
                timeout: 3,
                maxRetries: 3
              }
            }
          }
        ]
      }
    );
    publicLoadBalancers.push(publicLoadBalancer);
  }

  return publicLoadBalancers;
}
