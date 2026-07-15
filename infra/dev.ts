import { readFileSync } from 'node:fs';
import { tailscaleAcl } from './tailscale';
import { deleteServerFromTailnet } from './vps/servers';
import { inboundFirewall } from './vps/vps';

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
  const tailscaleHostname = 'pandoks-dev-box';
  const registrationTailnetAuthKey = new tailscale.TailnetKey(
    'HetznerDevBoxTailnetRegistrationAuthKey',
    {
      description: 'hcloud pandoks dev box registration',
      reusable: false,
      expiry: 1800,
      preauthorized: true,
      tags: ['tag:hetzner', 'tag:dev']
    },
    { dependsOn: [tailscaleAcl] }
  );

  const cloudInitConfig = readFileSync(`${process.cwd()}/infra/dev-cloud-config.yaml`, 'utf8');
  const userData = registrationTailnetAuthKey.key.apply((key) => {
    const environment = {
      REGISTRATION_TAILNET_AUTH_KEY: key,
      TAILSCALE_HOSTNAME: tailscaleHostname
    };

    return cloudInitConfig.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) =>
      name in environment ? environment[name as keyof typeof environment] : ''
    );
  });

  new hcloud.Server(
    'HetznerDevBox',
    {
      name: tailscaleHostname,
      serverType: 'cpx11',
      image: 'ubuntu-24.04',
      location: 'hil',
      publicNets: [{ ipv4Enabled: true, ipv6Enabled: true }],
      firewallIds: [inboundFirewall.id.apply((id) => parseInt(id))],
      shutdownBeforeDeletion: true,
      labels: { tailscale: tailscaleHostname },
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
