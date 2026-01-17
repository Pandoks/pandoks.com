import { isProduction } from './dns';
import { readFileSync } from 'node:fs';
import { tailscaleAcl } from './tailscale';
import { inboundFirewall } from './vps/vps';

new sst.x.DevCommand('DevInit', {
  dev: {
    title: 'InitDev',
    command: 'pnpm run dev:init',
    autostart: false
  }
});

new sst.x.DevCommand('DevDestroy', {
  dev: {
    title: 'DestroyDev',
    command: 'pnpm run dev:destroy',
    autostart: false
  }
});

new sst.x.DevCommand('K3dRestart', {
  dev: {
    title: 'RestartK3d',
    command: 'pnpm run cluster k3d restart',
    autostart: false
  }
});

new sst.x.DevCommand('K3dDependencyRestart', {
  dev: {
    title: 'RestartK3dDeps',
    command: 'pnpm run cluster k3d deps restart',
    autostart: false
  }
});

if (!isProduction) {
  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    `HetznerDevBoxTailnetRegistrationAuthKey`,
    {
      description: `hcloud dev box reg`,
      reusable: false,
      expiry: 1800, // 30 minutes
      preauthorized: true,
      tags: ['tag:hetzner', `tag:dev`]
    },
    { dependsOn: [tailscaleAcl] }
  );

  const cloudInitConfig = readFileSync(`${process.cwd()}/infra/dev-cloud-config.yaml`, 'utf8');

  const userData = registrationTailnetAuthKey.key.apply((key) => {
    return cloudInitConfig.replace(/\$\{REGISTRATION_TAILNET_AUTH_KEY\}/g, key);
  });

  new hcloud.Server('HetznerDevBox', {
    name: 'dev-box',
    serverType: 'cpx11',
    image: 'ubuntu-24.04',
    location: 'hil',
    publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
    firewallIds: [inboundFirewall.id.apply((id) => parseInt(id))],
    userData
  });
}

export {};
