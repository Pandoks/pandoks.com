import { STAGE_NAME } from '../dns';

export function createLoadBalancers(
  loadBalancerArgs: {
    loadBalancerCount: number;
    network: hcloud.Network;
  },
  hcloudLoadBalancerArgs: {
    type: string;
    location: string;
    algorithm: string;
  }
): { loadbalancer: hcloud.LoadBalancer; network: hcloud.LoadBalancerNetwork }[] {
  if (!loadBalancerArgs.loadBalancerCount) {
    return [];
  }

  const nodeResourceName = loadBalancerArgs.type === 'control-plane' ? 'ControlPlane' : 'Worker';
  let publicLoadBalancers: {
    loadbalancer: hcloud.LoadBalancer;
    network: hcloud.LoadBalancerNetwork;
  }[] = [];
  for (let i = 0; i < loadBalancerArgs.loadBalancerCount; i++) {
    const publicLoadBalancer = new hcloud.LoadBalancer(`HetznerK3sPublicLoadBalancer${i}`, {
      name: `k3s-public-${STAGE_NAME}-load-balancer-${i}`,
      loadBalancerType: hcloudLoadBalancerArgs.type,
      location: hcloudLoadBalancerArgs.location,
      algorithm: { type: hcloudLoadBalancerArgs.algorithm }
    });
    const publicLoadBalancerNetwork = new hcloud.LoadBalancerNetwork(
      `HetznerK3sPublicLoadBalancer${i}Network`,
      {
        loadBalancerId: publicLoadBalancer.id.apply((id) => parseInt(id)),
        networkId: loadBalancerArgs.network.id.apply((id) => parseInt(id))
      }
    );
    // Only enable https on the load balancer because we're using Cloudflare Strict
    new hcloud.LoadBalancerService(`HetznerK3sLoadBalancer${i}Port443`, {
      loadBalancerId: publicLoadBalancer.id,
      protocol: 'tcp',
      listenPort: 443,
      destinationPort: 30443,
      // NOTE: needed to validate all requests are coming from Cloudflare (false will only show load balancer's private network ip)
      proxyprotocol: true,
      healthCheck: {
        protocol: 'tcp',
        port: 30443,
        interval: 10,
        timeout: 3,
        retries: 3
      }
    });
    publicLoadBalancers.push({
      loadbalancer: publicLoadBalancer,
      network: publicLoadBalancerNetwork
    });
  }

  return publicLoadBalancers;
}
