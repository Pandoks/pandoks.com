import { LOAD_BALANCER_ALGORITHM, LOAD_BALANCER_FLAVOR } from './config';
import type { ClusterNetwork } from './network';
import { clusterResourceName, type ClusterPlan } from './topology';

// Private k3s API load balancer for HA control planes; public web ingress is
// Cloudflare-direct to the ingress nodes and never uses an OVH load balancer.
export function createPrivateApiLoadBalancer(args: {
  network: ClusterNetwork;
  cluster: ClusterPlan;
}) {
  const { config, identity, network, privateApi } = args.cluster;
  const api =
    privateApi.mode === 'ovh'
      ? new ovh.cloudproject.LoadBalancer(
          clusterResourceName('OvhK3sPrivateApiLoadBalancer', config.region),
          {
            serviceName: args.network.foundation.projectId,
            name: `k3s-private-${identity.namePrefix}-api`,
            regionName: network.publicCloudRegion,
            flavorId: ovh.cloudproject
              .getLoadBalancerFlavorsOutput({
                serviceName: args.network.foundation.projectId,
                regionName: network.publicCloudRegion
              })
              .apply((result) => {
                const flavor = result.flavors.find(
                  (candidate) => candidate.name === LOAD_BALANCER_FLAVOR
                );
                if (!flavor) {
                  throw new Error(
                    `Load balancer flavor ${LOAD_BALANCER_FLAVOR} isn't available in ${network.publicCloudRegion}`
                  );
                }
                return flavor.id;
              }),
            network: {
              private: {
                network: { id: args.network.network.id, subnetId: args.network.subnet.id }
              }
            },
            listeners: [
              {
                port: 6443,
                protocol: 'tcp',
                allowedCidrs: [network.networkCidr],
                pool: {
                  algorithm: LOAD_BALANCER_ALGORITHM,
                  protocol: 'tcp',
                  members: privateApi.nodes.map((node) => ({
                    name: node.hostname,
                    address: node.privateIp,
                    protocolPort: 6443
                  })),
                  healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
                }
              }
            ]
          }
        )
      : undefined;
  const apiTarget = api?.vipAddress ?? privateApi.nodes[0]?.privateIp;
  if (!apiTarget) throw new Error(`Cluster ${config.region} has no control-plane API target`);
  return { apiTarget };
}
