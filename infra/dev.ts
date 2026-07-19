import { isProduction } from './utils';

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
        }
      ]
    },
    { protect: true }
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
