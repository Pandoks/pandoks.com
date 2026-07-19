import { STAGE_NAME } from '../dns';
import { requireOvhCloudProjectService } from '../ovh';
import type { ClusterNetwork } from './network';
import {
  CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP,
  CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
  type ClusterNodeSpec
} from './types';

export type ClusterLoadBalancers = {
  api: ovh.cloudproject.LoadBalancer | undefined;
  apiAddress: $util.Output<string> | undefined;
  publicIngress: ovh.cloudproject.LoadBalancer[];
};

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
  region: string;
  flavorId: string;
  algorithm: string;
}): ClusterLoadBalancers {
  const serviceName = requireOvhCloudProjectService();
  const controlPlanes = args.nodes.filter((node) => node.role === 'control-plane');
  const ingressNodes = args.nodes.filter((node) => node.ingress);

  const api =
    controlPlanes.length === 0
      ? undefined
      : new ovh.cloudproject.LoadBalancer('OvhK3sPrivateApiLoadBalancer', {
          serviceName,
          name: `k3s-private-${STAGE_NAME}-api`,
          regionName: args.region,
          flavorId: args.flavorId,
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
                algorithm: args.algorithm,
                protocol: 'tcp',
                members: members(controlPlanes, 6443),
                healthMonitor: {
                  monitorType: 'tcp',
                  delay: 10,
                  timeout: 3,
                  maxRetries: 3
                }
              }
            }
          ]
        });

  const ingressCount =
    Math.ceil(ingressNodes.length / CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY) *
    CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP;
  const publicIngress = Array.from({ length: ingressCount }, (_, index) => {
    const group = Math.floor(index / CLUSTER_INGRESS_LOAD_BALANCERS_PER_GROUP);
    const groupNodes = ingressNodes.slice(
      group * CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY,
      (group + 1) * CLUSTER_LOAD_BALANCER_MEMBER_CAPACITY
    );
    const logicalName =
      index === 0
        ? 'OvhK3sPublicControlPlaneLoadBalancer0'
        : `OvhK3sPublicIngressLoadBalancer${index}`;

    return new ovh.cloudproject.LoadBalancer(
      logicalName,
      {
        serviceName,
        name: `k3s-public-${STAGE_NAME}-ingress-${index}`,
        regionName: args.region,
        flavorId: args.flavorId,
        network: {
          private: {
            network: {
              id: args.network.openstackNetworkId,
              subnetId: args.network.subnet.id
            },
            floatingIpCreate: {
              description: `k3s-public-${STAGE_NAME}-ingress-${index}`
            },
            gateway: { id: args.network.gateway.id }
          }
        },
        listeners: [
          {
            port: 443,
            protocol: 'tcp',
            pool: {
              algorithm: args.algorithm,
              // Must change with HAProxy Ingress use-proxy-protocol: the sender
              // and receiver must either both use PROXY v2 or both stop using it.
              protocol: 'proxyV2',
              members: members(groupNodes, 30443),
              healthMonitor: {
                monitorType: 'tcp',
                delay: 10,
                timeout: 3,
                maxRetries: 3
              }
            }
          }
        ]
      },
      index === 0
        ? undefined
        : {
            aliases: [
              {
                name: `OvhK3sPublicWorkerLoadBalancer${index - 1}`
              }
            ]
          }
    );
  });

  return {
    api,
    apiAddress: api?.vipAddress,
    publicIngress
  };
}
