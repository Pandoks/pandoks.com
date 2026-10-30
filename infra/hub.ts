import { isProduction } from './dns';
import { tailscaleAcl } from './tailscale';

if (isProduction) {
  const hubTailscaleDevice = tailscale.getDeviceOutput({ hostname: 'thinkpad-t470' });
  new tailscale.DeviceTags(
    'HubTailscaleTags',
    {
      deviceId: hubTailscaleDevice.nodeId,
      tags: ['tag:hub', 'tag:ssh']
    },
    { dependsOn: [tailscaleAcl] }
  );

  // NOTE: the hub serves each of these with `tailscale serve --service=<name> --https=443`
  new tailscale.Service(
    'CliproxyapiTailscaleService',
    {
      name: 'svc:cliproxyapi',
      comment: 'CLIProxyAPI on the homelab hub',
      ports: ['tcp:443'],
      tags: ['tag:hub']
    },
    { dependsOn: [tailscaleAcl] }
  );
  new tailscale.Service(
    'CliproxyapiCiTailscaleService',
    {
      name: 'svc:cliproxyapi-ci',
      comment: 'CLIProxyAPI with Console API keys only',
      ports: ['tcp:443'],
      tags: ['tag:hub']
    },
    { dependsOn: [tailscaleAcl] }
  );
  new tailscale.Service(
    'BeszelTailscaleService',
    {
      name: 'svc:beszel',
      comment: 'Beszel monitoring hub',
      ports: ['tcp:443'],
      tags: ['tag:hub']
    },
    { dependsOn: [tailscaleAcl] }
  );
}
