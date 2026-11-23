import * as pulumi from '@pulumi/pulumi';

async function tailscaleApiToken({
  clientId,
  clientSecret
}: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const response = await fetch('https://api.tailscale.com/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!response.ok) {
    throw new Error(
      `Tailscale OAuth token exchange failed: ${response.status} ${response.statusText}`
    );
  }
  const { access_token: accessToken } = (await response.json()) as { access_token: string };
  return accessToken;
}

export function deleteTailscaleDevices({
  clientId,
  clientSecret,
  devices
}: {
  clientId: pulumi.Input<string>;
  clientSecret: pulumi.Input<string>;
  devices: { nodeId: string; name: string }[];
}) {
  return pulumi.all([clientId, clientSecret]).apply(async ([clientId, clientSecret]) => {
    const accessToken = await tailscaleApiToken({ clientId, clientSecret });
    const deleted = await Promise.all(
      devices.map(async (device) => {
        try {
          const response = await fetch(`https://api.tailscale.com/api/v2/device/${device.nodeId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          return response.ok;
        } catch {
          return false;
        }
      })
    );

    const deletedDevices = devices.filter((_, i) => deleted[i]);
    const failedDevices = devices.filter((_, i) => !deleted[i]);
    if (deletedDevices.length) {
      console.log(
        `Deleted Tailscale devices:\n${deletedDevices.map((device) => device.name).join('\n')}`
      );
    }
    if (failedDevices.length) {
      console.log(
        `Failed to delete Tailscale devices:\n${failedDevices.map((device) => device.name).join('\n')}`
      );
    }
  });
}
