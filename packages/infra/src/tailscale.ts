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
  deviceIds
}: {
  clientId: pulumi.Input<string>;
  clientSecret: pulumi.Input<string>;
  deviceIds: string[];
}) {
  return pulumi.all([clientId, clientSecret]).apply(async ([clientId, clientSecret]) => {
    const accessToken = await tailscaleApiToken({ clientId, clientSecret });
    return await Promise.all(
      deviceIds.map(async (deviceId) => {
        try {
          const response = await fetch(`https://api.tailscale.com/api/v2/device/${deviceId}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          return { deviceId, success: true };
        } catch (error) {
          return {
            deviceId,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
  });
}
