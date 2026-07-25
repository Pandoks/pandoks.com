import { isProduction } from './dns';
import { secrets } from './secrets';

if (isProduction) {
  // NOTE: config in sst.config.ts's providers block lands under '@ovhcloud/pulumi-ovh:*' while
  // the provider reads 'ovh:*', so OVH credentials only bind through an explicit provider
  const ovhProvider = new ovh.Provider('Ovh', {
    endpoint: 'ovh-us',
    applicationKey: 'edf9a4672d28e3c7',
    applicationSecret: secrets.ovh.ApplicationSecret.value,
    consumerKey: secrets.ovh.ConsumerKey.value
  });

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
    { protect: true, provider: ovhProvider }
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
