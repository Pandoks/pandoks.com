import * as ovh from '@ovhcloud/pulumi-ovh';
import * as tailscale from '@pulumi/tailscale';
import { isProduction } from './dns.ts';
import { hubTailscaleServices, tailscaleAcl } from './tailscale.ts';
import { secrets } from './secrets.ts';

if (isProduction) {
  const ovhProvider = new ovh.Provider('Ovh', {
    endpoint: 'ovh-us',
    applicationKey: 'edf9a4672d28e3c7',
    applicationSecret: secrets.ovh.ApplicationSecret,
    consumerKey: secrets.ovh.ConsumerKey
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
      provider: ovhProvider,
      protect: true,
      retainOnDelete: true,
      import: 'vps-54c42746.vps.ovh.us',
      ignoreChanges: ['plans', 'ovhSubsidiary', 'planOptions']
    }
  );

  const devTailscaleDevice = tailscale.getDeviceOutput({ hostname: 'pandoks-dev-box' });
  new tailscale.DeviceTags(
    'OvhDevVpsTailscaleTags',
    {
      deviceId: devTailscaleDevice.nodeId,
      tags: ['tag:funnel', 'tag:ovh', 'tag:ssh']
    },
    { dependsOn: tailscaleAcl }
  );

  const hubTailscaleDevice = tailscale.getDeviceOutput({ hostname: 'thinkpad-t470' });
  new tailscale.DeviceTags(
    'HubTailscaleTags',
    {
      deviceId: hubTailscaleDevice.nodeId,
      tags: ['tag:hub', 'tag:ssh']
    },
    { dependsOn: tailscaleAcl }
  );

  for (const { name, comment } of hubTailscaleServices) {
    new tailscale.Service(
      `${name.replace(/(?:^|-)(.)/g, (_, char: string) => char.toUpperCase())}TailscaleService`,
      { name: `svc:${name}`, comment, ports: ['tcp:443'], tags: ['tag:hub'] },
      { dependsOn: tailscaleAcl }
    );
  }
}
