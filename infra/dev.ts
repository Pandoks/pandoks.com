import { readFileSync } from 'node:fs';
import { getFlavorId, getImageId, OVH_CLOUD_PROJECT_SERVICE } from './ovh';
import { tailscaleAcl } from './tailscale';
import { renderCloudInit } from './utils';
import { deleteServerFromTailnet } from './vps/servers';

new sst.x.DevCommand('DevInit', {
  dev: {
    title: 'InitDev',
    command: 'pnpm dev:init',
    autostart: false
  }
});

new sst.x.DevCommand('DevDestroy', {
  dev: {
    title: 'DestroyDev',
    command: 'pnpm dev:destroy',
    autostart: false
  }
});

new sst.x.DevCommand('K3dRestart', {
  dev: {
    title: 'RestartK3d',
    command: 'pnpm cluster k3d restart',
    autostart: false
  }
});

new sst.x.DevCommand('K3dDependencyRestart', {
  dev: {
    title: 'RestartK3dDeps',
    command: 'pnpm cluster k3d deps restart',
    autostart: false
  }
});

if ($app.stage === 'pandoks') {
  const tailscaleHostname = `${$app.stage}-dev-box`;
  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    'OvhDevBoxTailnetRegistrationAuthKey',
    {
      description: `ovh ${$app.stage} dev box registration`,
      reusable: false,
      expiry: 1800,
      preauthorized: true,
      tags: ['tag:ovh', 'tag:dev']
    },
    { dependsOn: [tailscaleAcl] }
  );

  const cloudInitConfig = readFileSync(`${process.cwd()}/infra/dev-cloud-config.yaml`, 'utf8');
  const userData = registrationTailnetAuthKey.key.apply((key) => {
    const environment = {
      REGISTRATION_TAILNET_AUTH_KEY: key,
      TAILSCALE_HOSTNAME: tailscaleHostname
    };

    return renderCloudInit(cloudInitConfig, environment);
  });

  const devBoxRegion = 'US-WEST-OR-1';
  new ovh.cloudproject.Instance(
    'OvhDevBox',
    {
      serviceName: OVH_CLOUD_PROJECT_SERVICE,
      name: tailscaleHostname,
      region: devBoxRegion,
      billingPeriod: 'hourly',
      flavor: { flavorId: await getFlavorId(devBoxRegion, 'd2-4') },
      bootFrom: { imageId: await getImageId(devBoxRegion, 'Ubuntu 24.04') },
      network: { public: true },
      userData
    },
    {
      hooks: {
        afterDelete: [deleteServerFromTailnet]
      }
    }
  );
}

export {};
