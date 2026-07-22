import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  GATEWAY_MODEL,
  LOAD_BALANCER_ALGORITHM,
  LOAD_BALANCER_FLAVOR,
  NON_PRODUCTION_CLUSTER_CONFIG,
  OVH_ACCOUNTS,
  PRODUCTION_CLUSTER_CONFIG
} from '../cluster/config.ts';

const configs = [PRODUCTION_CLUSTER_CONFIG, NON_PRODUCTION_CLUSTER_CONFIG];

void test('defines four disabled regional cluster templates for every stage', () => {
  for (const config of configs) {
    assert.deepEqual(
      config.regions.map(({ id, account, enabled, publicCloudRegion }) => ({
        id,
        account,
        enabled,
        publicCloudRegion
      })),
      [
        {
          id: 'us-west',
          account: 'us',
          enabled: false,
          publicCloudRegion: 'US-WEST-OR-1'
        },
        {
          id: 'us-east',
          account: 'us',
          enabled: false,
          publicCloudRegion: 'US-EAST-VA-1'
        },
        { id: 'eu', account: 'eu', enabled: false, publicCloudRegion: '' },
        { id: 'asia', account: 'eu', enabled: false, publicCloudRegion: '' }
      ]
    );
    for (const region of config.regions) {
      assert.equal(region.loadBalancerCount, 0);
      assert.ok([...region.cloud, ...region.dedicated].every(({ count }) => count === 0));
    }
  }
});

void test('owns stable regional network and k3s address spaces in pure configuration', () => {
  assert.deepEqual(
    PRODUCTION_CLUSTER_CONFIG.regions.map(
      ({ id, vlanId, networkCidr, gatewayIp, podCidr, serviceCidr, metalLbRange }) => ({
        id,
        vlanId,
        networkCidr,
        gatewayIp,
        podCidr,
        serviceCidr,
        metalLbRange
      })
    ),
    [
      {
        id: 'us-west',
        vlanId: 0,
        networkCidr: '10.0.0.0/16',
        gatewayIp: '10.0.0.1',
        podCidr: '10.42.0.0/16',
        serviceCidr: '10.43.0.0/16',
        metalLbRange: '10.0.5.1-10.0.5.254'
      },
      {
        id: 'us-east',
        vlanId: 101,
        networkCidr: '10.1.0.0/16',
        gatewayIp: '10.1.0.1',
        podCidr: '10.44.0.0/16',
        serviceCidr: '10.45.0.0/16',
        metalLbRange: '10.1.5.1-10.1.5.254'
      },
      {
        id: 'eu',
        vlanId: 102,
        networkCidr: '10.2.0.0/16',
        gatewayIp: '10.2.0.1',
        podCidr: '10.46.0.0/16',
        serviceCidr: '10.47.0.0/16',
        metalLbRange: '10.2.5.1-10.2.5.254'
      },
      {
        id: 'asia',
        vlanId: 103,
        networkCidr: '10.3.0.0/16',
        gatewayIp: '10.3.0.1',
        podCidr: '10.48.0.0/16',
        serviceCidr: '10.49.0.0/16',
        metalLbRange: '10.3.5.1-10.3.5.254'
      }
    ]
  );

  const source = readFileSync('infra/cluster/config.ts', 'utf8');
  assert.doesNotMatch(source, /\$app|\.\.\/utils|isProduction/);
});

void test('separates the current US account from dormant EU provider credentials', () => {
  assert.deepEqual(OVH_ACCOUNTS, {
    us: { endpoint: 'ovh-us', subsidiary: 'US' },
    eu: {
      endpoint: 'ovh-eu',
      subsidiary: '',
      applicationKeyEnvironment: 'OVH_EU_APPLICATION_KEY',
      applicationSecretEnvironment: 'OVH_EU_APPLICATION_SECRET',
      consumerKeyEnvironment: 'OVH_EU_CONSUMER_KEY'
    }
  });
  assert.equal(GATEWAY_MODEL, 'S');
  assert.equal(LOAD_BALANCER_FLAVOR, 'small');
  assert.equal(LOAD_BALANCER_ALGORITHM, 'leastConnections');
});
