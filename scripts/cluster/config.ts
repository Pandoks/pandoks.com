import {
  NON_PRODUCTION_CLUSTER_CONFIG,
  PRODUCTION_CLUSTER_CONFIG,
  type ClusterSpec
} from '../../infra/cluster/config.ts';
import { buildClusterPlan } from '../../infra/cluster/topology.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function stage(value: string): { clusters: ClusterSpec[]; name: 'prod' | 'dev' } {
  if (value === 'production' || value === 'prod') {
    return { clusters: PRODUCTION_CLUSTER_CONFIG, name: 'prod' };
  }
  if (value === 'non-production' || value === 'dev') {
    return { clusters: NON_PRODUCTION_CLUSTER_CONFIG, name: 'dev' };
  }
  return fail(`Unknown cluster stage: ${value}`);
}

const [command = '', stageName = '', clusterRegion = ''] = process.argv.slice(2);
const selected = stage(stageName);
const plan = (cluster: ClusterSpec) => buildClusterPlan(cluster, selected.name, 'unused.invalid');

if (command === 'enabled') {
  console.log(
    JSON.stringify(
      selected.clusters.map((cluster) => ({
        id: cluster.region,
        operatorHostname: plan(cluster).identity.operatorHostname
      }))
    )
  );
} else if (command === 'region') {
  const cluster = selected.clusters.find(({ region }) => region === clusterRegion);
  if (!cluster) fail(`Unknown cluster: ${clusterRegion}`);
  const clusterPlan = plan(cluster);
  console.log(
    JSON.stringify({
      ClusterMetalLbRange: clusterPlan.network.metalLbRange,
      ClusterRegion: cluster.region,
      ClusterOperatorHostname: clusterPlan.identity.operatorHostname
    })
  );
} else {
  fail(`Unknown command: ${command}`);
}
