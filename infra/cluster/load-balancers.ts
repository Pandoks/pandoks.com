import { STAGE_NAME } from '../utils';
import { LOAD_BALANCER_ALGORITHM, LOAD_BALANCER_FLAVOR, REGION } from './config';
import type { ClusterNetwork } from './network';
import type { ClusterNodeSpec } from './topology';

function members(nodes: readonly ClusterNodeSpec[], port: number) {
  return nodes.map((node) => ({
    name: node.hostname,
    address: node.privateIp,
    protocolPort: port
  }));
}

export function createClusterLoadBalancers(args: {
  nodes: readonly ClusterNodeSpec[];
  network: ClusterNetwork;
}) {
  const flavorId = ovh.cloudproject
    .getLoadBalancerFlavorsOutput({
      serviceName: args.network.serviceName,
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
    });
  const controlPlanes = args.nodes.filter((node) => node.pool.role === 'control-plane');
  const api = new ovh.cloudproject.LoadBalancer('OvhK3sPrivateApiLoadBalancer', {
    serviceName: args.network.serviceName,
    name: `k3s-private-${STAGE_NAME}-api`,
    regionName: REGION,
    flavorId,
    network: {
      private: {
        network: {
          id: args.network.openstackNetworkId,
          subnetId: args.network.subnet.id
        }
      }
    },
    listeners: [
      {
        port: 6443,
        protocol: 'tcp',
        pool: {
          algorithm: LOAD_BALANCER_ALGORITHM,
          protocol: 'tcp',
          members: members(controlPlanes, 6443),
          healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
        }
      }
    ]
  });

  const ingressNodes = args.nodes.filter((node) => node.pool.ingress);
  const publicIngress = new ovh.cloudproject.LoadBalancer('OvhK3sPublicIngressLoadBalancer', {
    serviceName: args.network.serviceName,
    name: `k3s-public-${STAGE_NAME}-ingress`,
    regionName: REGION,
    flavorId,
    network: {
      private: {
        network: {
          id: args.network.openstackNetworkId,
          subnetId: args.network.subnet.id
        },
        floatingIpCreate: {
          description: `k3s-public-${STAGE_NAME}-ingress`
        },
        gateway: { id: args.network.gateway.id }
      }
    },
    listeners: [
      {
        port: 443,
        protocol: 'tcp',
        pool: {
          algorithm: LOAD_BALANCER_ALGORITHM,
          // Must match HAProxy Ingress use-proxy-protocol.
          protocol: 'proxyV2',
          members: members(ingressNodes, 30443),
          healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
        }
      }
    ]
  });

  return { apiAddress: api.vipAddress, publicIngress };
}
