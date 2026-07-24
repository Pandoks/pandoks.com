import { createHash } from 'node:crypto';
import { cloudflareIpv4Cidrs } from '../dns';
import { LOAD_BALANCER_ALGORITHM, LOAD_BALANCER_FLAVOR } from './config';
import type { ClusterNetwork } from './network';
import {
  clusterResourceName,
  type ClusterNodeSpec,
  type ClusterPlan,
  type IpLoadBalancingPlan
} from './topology';

function members(nodes: readonly ClusterNodeSpec[], port: number) {
  return nodes.map((node) => ({
    name: node.hostname,
    address: node.privateIp,
    protocolPort: port
  }));
}

export function createClusterLoadBalancers(args: {
  network: ClusterNetwork;
  cluster: ClusterPlan;
}) {
  const { config, identity, network, privateApi, publicIngress } = args.cluster;
  const flavors =
    privateApi.mode === 'ovh' || publicIngress.loadBalancerCount > 0
      ? ovh.cloudproject.getLoadBalancerFlavorsOutput({
          serviceName: args.network.foundation.projectId,
          regionName: network.publicCloudRegion
        })
      : undefined;
  const flavorId = (name: string) =>
    flavors!.apply((result) => {
      const flavor = result.flavors.find((candidate) => candidate.name === name);
      if (!flavor) {
        throw new Error(
          `Load balancer flavor ${name} isn't available in ${network.publicCloudRegion}`
        );
      }
      return flavor.id;
    });

  const api =
    privateApi.mode === 'ovh'
      ? new ovh.cloudproject.LoadBalancer(
          clusterResourceName('OvhK3sPrivateApiLoadBalancer', config.region),
          {
            serviceName: args.network.foundation.projectId,
            name: `k3s-private-${identity.namePrefix}-api`,
            regionName: network.publicCloudRegion,
            flavorId: flavorId(LOAD_BALANCER_FLAVOR),
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
                  members: members(privateApi.nodes, 6443),
                  healthMonitor: { monitorType: 'tcp', delay: 10, timeout: 3, maxRetries: 3 }
                }
              }
            ]
          }
        )
      : undefined;
  const apiTarget = api?.vipAddress ?? privateApi.nodes[0]?.privateIp;
  if (!apiTarget) throw new Error(`Cluster ${config.region} has no control-plane API target`);

  const ingress = Array.from({ length: publicIngress.loadBalancerCount }, (_, index) => {
    const suffix = index === 0 ? '' : String(index);
    const resourceName = clusterResourceName(
      `OvhK3sPublicIngressLoadBalancer${suffix}`,
      config.region
    );
    const name = `k3s-public-${identity.namePrefix}-ingress${index === 0 ? '' : `-${index}`}`;
    return new ovh.cloudproject.LoadBalancer(resourceName, {
      serviceName: args.network.foundation.projectId,
      name,
      regionName: network.publicCloudRegion,
      flavorId: flavorId(publicIngress.flavor!),
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
    });
  });
  return { apiTarget, publicIngress: ingress };
}

const IP_LOAD_BALANCING_ALGORITHMS = {
  leastConnections: 'leastconn',
  roundRobin: 'roundrobin',
  sourceIP: 'source'
} as const;

const wait = (milliseconds: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const OVH_API_ROOTS: Record<string, string> = {
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0'
};

// The raw signed API calls reuse the credentials sst.config.ts hands the OVH provider.
function ovhProviderConfig() {
  const provider = $app.providers?.['ovhcloud/pulumi-ovh'] as
    | string
    | undefined
    | {
        endpoint?: string;
        applicationKey?: string;
        applicationSecret?: string;
        consumerKey?: string;
      };
  if (!provider || typeof provider === 'string') {
    throw new Error('Missing ovhcloud/pulumi-ovh provider configuration');
  }
  return provider;
}

async function refreshIpLoadBalancing(serviceName: string) {
  const { endpoint, applicationKey, applicationSecret, consumerKey } = ovhProviderConfig();
  const apiRoot = OVH_API_ROOTS[endpoint ?? ''];
  if (!apiRoot) throw new Error(`Unsupported OVH endpoint: ${endpoint}`);
  if (!applicationKey || !applicationSecret || !consumerKey) {
    throw new Error(`Missing OVH credentials needed to refresh ${serviceName}`);
  }

  const timeResponse = await fetch(`${apiRoot}/auth/time`);
  if (!timeResponse.ok) throw new Error(`Unable to read OVH API time: ${timeResponse.status}`);
  const timeOffset = Number(await timeResponse.text()) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timeOffset)) throw new Error('OVH API returned an invalid timestamp');
  const request = async <Result>(method: 'GET' | 'POST', path: string): Promise<Result> => {
    const url = `${apiRoot}${path}`;
    const timestamp = String(Math.floor(Date.now() / 1000) + timeOffset);
    const signature = createHash('sha1')
      .update(`${applicationSecret}+${consumerKey}+${method}+${url}++${timestamp}`)
      .digest('hex');
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Ovh-Application': applicationKey,
        'X-Ovh-Consumer': consumerKey,
        'X-Ovh-Signature': `$1$${signature}`,
        'X-Ovh-Timestamp': timestamp
      }
    });
    if (!response.ok) {
      throw new Error(`OVH ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Result;
  };

  const path = `/ipLoadbalancing/${encodeURIComponent(serviceName)}`;
  let deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const tasks = (
      await Promise.all(
        ['todo', 'doing'].map((status) =>
          request<number[]>('GET', `${path}/task?action=refreshIplb&status=${status}`)
        )
      )
    ).flat();
    if (tasks.length === 0) break;
    await wait(3000);
  }
  if (Date.now() >= deadline) throw new Error(`Timed out waiting to refresh ${serviceName}`);

  const pending = await request<unknown[]>('GET', `${path}/pendingChanges`);
  if (pending.length === 0) return;
  const task = await request<{ id: number }>('POST', `${path}/refresh`);
  deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const { status } = await request<{ status: string }>('GET', `${path}/task/${task.id}`);
    if (status === 'done') return;
    if (status === 'error' || status === 'cancelled') {
      throw new Error(`OVH IP Load Balancing refresh ${task.id} ended with ${status}`);
    }
    await wait(3000);
  }
  throw new Error(`Timed out refreshing ${serviceName}`);
}

const ipLoadBalancingRefreshQueues = new Map<string, Promise<void>>();

function queueIpLoadBalancingRefresh(serviceName: string) {
  const previous = ipLoadBalancingRefreshQueues.get(serviceName) ?? Promise.resolve();
  const refresh = previous.catch(() => undefined).then(() => refreshIpLoadBalancing(serviceName));
  ipLoadBalancingRefreshQueues.set(serviceName, refresh);
  return refresh.finally(() => {
    if (ipLoadBalancingRefreshQueues.get(serviceName) === refresh) {
      ipLoadBalancingRefreshQueues.delete(serviceName);
    }
  });
}

const refreshIpLoadBalancingAfterDelete = new $util.ResourceHook(
  'RefreshIpLoadBalancingAfterDelete',
  async ({ oldInputs }) => {
    const serviceName = (oldInputs as Record<string, unknown> | undefined)?.serviceName;
    if (typeof serviceName !== 'string') throw new Error('Deleted OVH resource has no serviceName');
    await queueIpLoadBalancingRefresh(serviceName);
  }
);

export function createIpLoadBalancingIngress(args: {
  plan: IpLoadBalancingPlan;
  networks: ReadonlyMap<string, ClusterNetwork>;
}) {
  const firstCluster = args.plan.clusters[0];
  if (!firstCluster) throw new Error('IP Load Balancing requires at least one cluster');
  const firstNetwork = args.networks.get(firstCluster.cluster.config.region);
  if (!firstNetwork) {
    throw new Error(`Missing cluster network for ${firstCluster.cluster.config.region}`);
  }

  const stagedResourceOptions = {
    hooks: { afterDelete: [refreshIpLoadBalancingAfterDelete] }
  };
  const loadBalancer = ovh.iploadbalancing.getIpLoadBalancingOutput({
    serviceName: args.plan.config.serviceName,
    state: 'ok'
  });
  const serviceName = loadBalancer.vrackEligibility.apply((eligible) => {
    if (!eligible) {
      throw new Error(
        `IP Load Balancing service ${args.plan.config.serviceName} is not vRack eligible`
      );
    }
    return args.plan.config.serviceName;
  });
  const attachment = new ovh.vrack.IpLoadbalancing(
    'OvhK3sIpLoadBalancingVrack',
    {
      serviceName: firstNetwork.foundation.vrack.serviceName,
      LoadbalancingId: serviceName
    },
    { dependsOn: [firstNetwork.foundation.vrack] }
  );
  const farmSettings = {
    port: 443,
    balance: IP_LOAD_BALANCING_ALGORITHMS[LOAD_BALANCER_ALGORITHM],
    probe: { type: 'tcp', port: 443, interval: 30 }
  } as const;
  const backendSettings = {
    port: 443,
    probe: true,
    ssl: false,
    status: 'active',
    weight: 1
  } as const;
  const frontendSettings = {
    port: '443',
    ssl: false,
    allowedSources: cloudflareIpv4Cidrs
  } as const;
  const refreshConfiguration = JSON.stringify({
    serviceName: args.plan.config.serviceName,
    clusters: args.plan.clusters.map(({ cluster, zone, natIp }) => ({
      name: cluster.config.region,
      displayName: `k3s-${cluster.identity.namePrefix}`,
      subnet: cluster.network.networkCidr,
      vlan: cluster.network.vlanId,
      natIp,
      zone,
      farm: farmSettings,
      frontend: frontendSettings,
      backends: cluster.publicIngress.nodes.map((node) => ({
        displayName: node.hostname,
        address: node.privateIp,
        ...backendSettings
      }))
    }))
  });
  const resourceIds: $util.Output<string>[] = [];

  for (const { cluster, zone: clusterZone, natIp } of args.plan.clusters) {
    const network = args.networks.get(cluster.config.region);
    if (!network) throw new Error(`Missing cluster network for ${cluster.config.region}`);
    const zone = loadBalancer.zones.apply((zones) => {
      if (!zones.includes(clusterZone)) {
        throw new Error(
          `IP Load Balancing service ${args.plan.config.serviceName} does not include zone ${clusterZone}`
        );
      }
      return clusterZone;
    });
    const vrackNetwork = new ovh.iploadbalancing.VrackNetwork(
      clusterResourceName('OvhK3sIpLoadBalancingVrackNetwork', cluster.config.region),
      {
        serviceName,
        displayName: `k3s-${cluster.identity.namePrefix}`,
        subnet: cluster.network.networkCidr,
        natIp,
        vlan: cluster.network.vlanId
      },
      {
        dependsOn: [attachment, network.network],
        ...stagedResourceOptions
      }
    );
    resourceIds.push(vrackNetwork.id);
    const farm = new ovh.iploadbalancing.TcpFarm(
      clusterResourceName('OvhK3sIpLoadBalancingFarm', cluster.config.region),
      {
        serviceName,
        displayName: `k3s-${cluster.identity.namePrefix}`,
        zone,
        ...farmSettings,
        vrackNetworkId: vrackNetwork.vrackNetworkId
      },
      stagedResourceOptions
    );
    resourceIds.push(farm.id);
    for (const node of cluster.publicIngress.nodes) {
      const backend = new ovh.iploadbalancing.TcpFarmServer(
        `${node.logicalName}IpLoadBalancingBackend`,
        {
          serviceName,
          farmId: farm.id.apply(Number),
          displayName: node.hostname,
          address: node.privateIp,
          ...backendSettings
        },
        stagedResourceOptions
      );
      resourceIds.push(backend.id);
    }
    const frontend = new ovh.iploadbalancing.TcpFrontend(
      clusterResourceName('OvhK3sIpLoadBalancingFrontend', cluster.config.region),
      {
        serviceName,
        displayName: `k3s-${cluster.identity.namePrefix}`,
        zone,
        ...frontendSettings,
        defaultFarmId: farm.id.apply(Number)
      },
      stagedResourceOptions
    );
    resourceIds.push(frontend.id);
  }

  const refresh = new ovh.iploadbalancing.Refresh('OvhK3sIpLoadBalancingRefresh', {
    serviceName,
    keepers: [refreshConfiguration, ...resourceIds]
  });
  return refresh.id.apply(() => loadBalancer.ipv4);
}
