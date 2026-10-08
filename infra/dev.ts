import { isProduction } from './dns';
import { tailscaleAcl } from './tailscale';

if (isProduction) {
  new ovh.vps.Vps(
    'OvhDevVps',
    {
      displayName: 'pandoks-dev-box',
      doNotSendPassword: false,
      ovhSubsidiary: 'US',
      plans: [
        {
          duration: 'P1M',
          planCode: 'vps-2027-model4',
          pricingMode: 'upfront12',
          quantity: 1,
          configurations: [
            { label: 'vps_datacenter', value: 'US-WEST-OR' },
            { label: 'vps_os', value: 'Ubuntu 26.04' }
          ]
        }
      ],
      planOptions: [
        {
          duration: 'P1M',
          planCode: 'option-linux',
          pricingMode: 'upfront12',
          quantity: 1
        },
        {
          duration: 'P1M',
          planCode: 'option-auto-backup-2027-1-model4',
          pricingMode: 'upfront12',
          quantity: 1
        },
        {
          duration: 'P1M',
          planCode: 'option-storage-local-2027-model4',
          pricingMode: 'upfront12',
          quantity: 1
        },
        {
          duration: 'P1M',
          planCode: 'option-additional-disk-2027-200g',
          pricingMode: 'default',
          quantity: 1
        }
      ]
    },
    {
      protect: true,
      import: 'vps-54c42746.vps.ovh.us',
      ignoreChanges: ['plans', 'ovhSubsidiary', 'planOptions']
    }
  );

  const devTailscaleDevice = tailscale.getDeviceOutput({ hostname: 'pandoks-dev-box' });
  new tailscale.DeviceTags(
    'OvhDevVpsTailscaleTags',
    {
      deviceId: devTailscaleDevice.nodeId,
      tags: ['tag:funnel', 'tag:ovh', 'tag:cliproxyapi', 'tag:ssh']
    },
    { dependsOn: [tailscaleAcl] }
  );

  // NOTE: pandoks-dev-box hosts this with `tailscale serve --service=svc:cliproxyapi --https=443`
  new tailscale.Service(
    'CliproxyapiTailscaleService',
    {
      name: 'svc:cliproxyapi',
      comment: 'CLIProxyAPI on pandoks-dev-box',
      ports: ['tcp:443'],
      tags: ['tag:cliproxyapi']
    },
    { dependsOn: [tailscaleAcl] }
  );
}

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

export {};
