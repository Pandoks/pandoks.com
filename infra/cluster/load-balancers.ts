import { STAGE_NAME } from '../utils';
import { cloudflareIpv4Cidrs } from '../dns';
import { LOAD_BALANCER_ALGORITHM, LOAD_BALANCER_FLAVOR, REGION } from './config';
import type { ClusterNetwork } from './network';
import type { ClusterNodeSpec, PrivateApiPlan, PublicIngressPlan } from './topology';

function members(nodes: readonly ClusterNodeSpec[], port: number) {
  return nodes.map((node) => ({
    name: node.hostname,
    address: node.privateIp,
    protocolPort: port
  }));
}

export function createClusterLoadBalancers(args: {
  network: ClusterNetwork;
  privateApi: PrivateApiPlan;
  publicIngress: PublicIngressPlan;
}) {
  const loadBalancerFlavorId =
    args.privateApi.mode === 'ovh' || args.publicIngress.loadBalancerCount > 0
      ? ovh.cloudproject
          .getLoadBalancerFlavorsOutput({
            serviceName: args.network.projectId,
            regionName: REGION
          })
          .apply((result) => {
            const flavor = result.flavors.find(({ name }) => name === LOAD_BALANCER_FLAVOR);
            if (!flavor) {
              throw new Error(
                `Load balancer flavor ${LOAD_BALANCER_FLAVOR} isn't available in ${REGION}`
              );
            }
            return flavor.id;
          })
      : undefined;

  const api =
    args.privateApi.mode === 'ovh'
      ? new ovh.cloudproject.LoadBalancer('OvhK3sPrivateApiLoadBalancer', {
          serviceName: args.network.projectId,
          name: `k3s-private-${STAGE_NAME}-api`,
          regionName: REGION,
          flavorId: loadBalancerFlavorId!,
          network: {
            private: {
              network: {
                id: args.network.network.id,
                subnetId: args.network.subnet.id
              }
            }
          },
          listeners: [
            {
              port: 6443,
              protocol: 'tcp',
              // The API VIP has no floating IP and only accepts private vRack clients.
              allowedCidrs: ['10.0.0.0/16'],
              pool: {
                algorithm: LOAD_BALANCER_ALGORITHM,
                protocol: 'tcp',
                members: members(args.privateApi.nodes, 6443),
                healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
              }
            }
          ]
        })
      : undefined;

  const apiTarget = api?.vipAddress ?? args.privateApi.nodes[0]?.privateIp;
  if (!apiTarget) {
    throw new Error('Cluster load balancers require at least one control-plane node');
  }

  const ingressNodes = args.publicIngress.nodes;
  const publicIngress = Array.from({ length: args.publicIngress.loadBalancerCount }, (_, index) => {
    const suffix = index === 0 ? '' : String(index);
    const resourceName = `OvhK3sPublicIngressLoadBalancer${suffix}`;
    const name = `k3s-public-${STAGE_NAME}-ingress${index === 0 ? '' : `-${index}`}`;
    return new ovh.cloudproject.LoadBalancer(resourceName, {
      serviceName: args.network.projectId,
      name,
      regionName: REGION,
      flavorId: loadBalancerFlavorId!,
      network: {
        private: {
          network: {
            id: args.network.network.id,
            subnetId: args.network.subnet.id
          },
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
            members: members(ingressNodes, 443),
            healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
          }
        }
      ]
    });
  });

  return { apiTarget, publicIngress };
}
