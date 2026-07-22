import { createHash } from 'node:crypto';
import { cloudflareIpv4Cidrs } from '../dns';
import {
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  OVH_ACCOUNTS,
  type ClusterRegionId,
  type LoadBalancerFlavor,
  type OvhAccountId
} from './config';
import type { ClusterNetwork } from './network';
import {
  regionalResourceName,
  type ClusterNodeSpec,
  type IpLoadBalancingPlan,
  type RegionalClusterPlan
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
  cluster: RegionalClusterPlan;
}) {
  const { config, identity, privateApi, publicIngress } = args.cluster;
  const provider = args.network.foundation.provider;
  const invokeOptions = provider ? { provider } : {};
  const resourceOptions = provider ? { provider } : {};
  const flavors =
    privateApi.mode === 'ovh' || publicIngress.loadBalancerCount > 0
      ? ovh.cloudproject.getLoadBalancerFlavorsOutput(
          {
            serviceName: args.network.foundation.projectId,
            regionName: config.publicCloudRegion
          },
          invokeOptions
        )
      : undefined;
  const flavorId = (name: LoadBalancerFlavor) =>
    flavors!.apply((result) => {
      const flavor = result.flavors.find((candidate) => candidate.name === name);
      if (!flavor) {
        throw new Error(
          `Load balancer flavor ${name} isn't available in ${config.publicCloudRegion}`
        );
      }
      return flavor.id;
    });

  const api =
    privateApi.mode === 'ovh'
      ? new ovh.cloudproject.LoadBalancer(
          regionalResourceName('OvhK3sPrivateApiLoadBalancer', config.id),
          {
            serviceName: args.network.foundation.projectId,
            name: `k3s-private-${identity.namePrefix}-api`,
            regionName: config.publicCloudRegion,
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
      },
      resourceOptions
    );
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

async function refreshIpLoadBalancing(accountId: OvhAccountId, serviceName: string) {
  const account = OVH_ACCOUNTS[accountId];
  const applicationKey =
    'applicationKey' in account
      ? account.applicationKey
      : process.env[account.applicationKeyEnvironment];
  const applicationSecret = process.env[account.applicationSecretEnvironment];
  const consumerKey = process.env[account.consumerKeyEnvironment];
  if (!applicationKey || !applicationSecret || !consumerKey) {
    throw new Error(`Missing OVH ${accountId} credentials needed to refresh ${serviceName}`);
  }

  const timeResponse = await fetch(`${account.apiRoot}/auth/time`);
  if (!timeResponse.ok) throw new Error(`Unable to read OVH API time: ${timeResponse.status}`);
  const timeOffset = Number(await timeResponse.text()) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timeOffset)) throw new Error('OVH API returned an invalid timestamp');
  const request = async <Result>(method: 'GET' | 'POST', path: string): Promise<Result> => {
    const url = `${account.apiRoot}${path}`;
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

function queueIpLoadBalancingRefresh(accountId: OvhAccountId, serviceName: string) {
  const key = `${accountId}:${serviceName}`;
  const previous = ipLoadBalancingRefreshQueues.get(key) ?? Promise.resolve();
  const refresh = previous
    .catch(() => undefined)
    .then(() => refreshIpLoadBalancing(accountId, serviceName));
  ipLoadBalancingRefreshQueues.set(key, refresh);
  return refresh.finally(() => {
    if (ipLoadBalancingRefreshQueues.get(key) === refresh) {
      ipLoadBalancingRefreshQueues.delete(key);
    }
  });
}

const refreshUsIpLoadBalancingAfterDelete = new $util.ResourceHook(
  'RefreshUsIpLoadBalancingAfterDelete',
  async ({ oldInputs }) => {
    const serviceName = (oldInputs as Record<string, unknown> | undefined)?.serviceName;
    if (typeof serviceName !== 'string') throw new Error('Deleted OVH resource has no serviceName');
    await queueIpLoadBalancingRefresh('us', serviceName);
  }
);

const refreshEuIpLoadBalancingAfterDelete = new $util.ResourceHook(
  'RefreshEuIpLoadBalancingAfterDelete',
  async ({ oldInputs }) => {
    const serviceName = (oldInputs as Record<string, unknown> | undefined)?.serviceName;
    if (typeof serviceName !== 'string') throw new Error('Deleted OVH resource has no serviceName');
    await queueIpLoadBalancingRefresh('eu', serviceName);
  }
);

export function createIpLoadBalancingIngress(args: {
  plan: IpLoadBalancingPlan;
  networks: ReadonlyMap<ClusterRegionId, ClusterNetwork>;
}) {
  const firstRegion = args.plan.regions[0];
  if (!firstRegion) throw new Error('IP Load Balancing requires at least one cluster region');
  const firstNetwork = args.networks.get(firstRegion.cluster.config.id);
  if (!firstNetwork) {
    throw new Error(`Missing cluster network for region ${firstRegion.cluster.config.id}`);
  }

  const provider = firstNetwork.foundation.provider;
  const invokeOptions = provider ? { provider } : {};
  const resourceOptions = provider ? { provider } : {};
  const accountPrefix = args.plan.config.account === 'us' ? 'Ovh' : 'OvhEu';
  const refreshAfterDelete =
    args.plan.config.account === 'us'
      ? refreshUsIpLoadBalancingAfterDelete
      : refreshEuIpLoadBalancingAfterDelete;
  const stagedResourceOptions = {
    ...resourceOptions,
    hooks: { afterDelete: [refreshAfterDelete] }
  };
  const loadBalancer = ovh.iploadbalancing.getIpLoadBalancingOutput(
    { serviceName: args.plan.config.serviceName, state: 'ok' },
    invokeOptions
  );
  const serviceName = loadBalancer.vrackEligibility.apply((eligible) => {
    if (!eligible) {
      throw new Error(
        `IP Load Balancing service ${args.plan.config.serviceName} is not vRack eligible`
      );
    }
    return args.plan.config.serviceName;
  });
  const attachment = new ovh.vrack.IpLoadbalancing(
    `${accountPrefix}K3sIpLoadBalancingVrack`,
    {
      serviceName: firstNetwork.foundation.vrack.serviceName,
      LoadbalancingId: serviceName
    },
    { dependsOn: [firstNetwork.foundation.vrack], ...resourceOptions }
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
    regions: args.plan.regions.map(({ cluster, zone, natIp }) => ({
      id: cluster.config.id,
      displayName: `k3s-${cluster.identity.namePrefix}`,
      subnet: cluster.config.networkCidr,
      vlan: cluster.config.vlanId,
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

  for (const region of args.plan.regions) {
    const { cluster } = region;
    const network = args.networks.get(cluster.config.id);
    if (!network) throw new Error(`Missing cluster network for region ${cluster.config.id}`);
    const zone = loadBalancer.zones.apply((zones) => {
      if (!zones.includes(region.zone)) {
        throw new Error(
          `IP Load Balancing service ${args.plan.config.serviceName} does not include zone ${region.zone}`
        );
      }
      return region.zone;
    });
    const vrackNetwork = new ovh.iploadbalancing.VrackNetwork(
      regionalResourceName('OvhK3sIpLoadBalancingVrackNetwork', cluster.config.id),
      {
        serviceName,
        displayName: `k3s-${cluster.identity.namePrefix}`,
        subnet: cluster.config.networkCidr,
        natIp: region.natIp,
        vlan: cluster.config.vlanId
      },
      {
        dependsOn: [attachment, network.network],
        ...stagedResourceOptions
      }
    );
    resourceIds.push(vrackNetwork.id);
    const farm = new ovh.iploadbalancing.TcpFarm(
      regionalResourceName('OvhK3sIpLoadBalancingFarm', cluster.config.id),
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
      regionalResourceName('OvhK3sIpLoadBalancingFrontend', cluster.config.id),
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

  const refresh = new ovh.iploadbalancing.Refresh(
    `${accountPrefix}K3sIpLoadBalancingRefresh`,
    {
      serviceName,
      keepers: [refreshConfiguration, ...resourceIds]
    },
    resourceOptions
  );
  return refresh.id.apply(() => loadBalancer.ipv4);
}
