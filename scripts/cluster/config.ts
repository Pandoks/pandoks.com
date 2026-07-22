import {
  NON_PRODUCTION_CLUSTER_CONFIG,
  PRODUCTION_CLUSTER_CONFIG,
  type ClusterConfig
} from '../../infra/cluster/config.ts';
import { buildRegionalClusterPlan } from '../../infra/cluster/topology.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function stage(value: string): { config: ClusterConfig; name: 'prod' | 'dev' } {
  if (value === 'production' || value === 'prod') {
    return { config: PRODUCTION_CLUSTER_CONFIG, name: 'prod' };
  }
  if (value === 'non-production' || value === 'dev') {
    return { config: NON_PRODUCTION_CLUSTER_CONFIG, name: 'dev' };
  }
  return fail(`Unknown cluster stage: ${value}`);
}

const [command = '', stageName = '', regionId = ''] = process.argv.slice(2);
const selected = stage(stageName);
const plan = (region: ClusterConfig['regions'][number]) =>
  buildRegionalClusterPlan(region, selected.name, 'unused.invalid');

if (command === 'enabled') {
  console.log(
    JSON.stringify(
      selected.config.regions
        .filter(({ enabled }) => enabled)
        .map((region) => ({
          id: region.id,
          operatorHostname: plan(region).identity.operatorHostname
        }))
    )
  );
} else if (command === 'region') {
  const region = selected.config.regions.find(({ id }) => id === regionId);
  if (!region) fail(`Unknown cluster region: ${regionId}`);
  const regionalPlan = plan(region);
  console.log(
    JSON.stringify({
      ClusterMetalLbRange: region.metalLbRange,
      ClusterRegion: region.id,
      ClusterOperatorHostname: regionalPlan.identity.operatorHostname
    })
  );
} else {
  fail(`Unknown command: ${command}`);
}
