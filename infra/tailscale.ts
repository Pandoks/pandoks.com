import stringify from 'json-stringify-pretty-compact';
import { secrets, setSecret } from './secrets';
import { STAGE_NAME } from './dns';

new tailscale.TailnetSettings('TailscaleSettings', {
  httpsEnabled: true
});

export const tailscaleAcl = new tailscale.Acl('TailscaleAcl', {
  resetAclOnDestroy: true,
  // NOTE: overwriteExistingContent is set to true so it works in all stages. we do this because the
  // tailnet isn't used for any important networking. it is solely to access the devices.
  // WARNING: a change to this will overwrite the ACL on all stages.
  overwriteExistingContent: true,
  acl: stringify(
    {
      grants: [
        { src: ['*'], dst: ['*'], ip: ['*'] },
        {
          src: ['tag:ci'],
          dst: ['tag:k8s-operator'],
          app: {
            'tailscale.com/cap/kubernetes': [
              {
                impersonate: { groups: ['argocd-deployer'] }
              }
            ]
          }
        }
      ],
      ssh: [
        {
          action: 'check',
          src: ['autogroup:member'],
          dst: ['autogroup:self', 'tag:ovh'],
          users: ['autogroup:nonroot', 'root']
        }
      ],
      tagOwners: {
        'tag:ovh': ['pandoks@github'],
        'tag:k8s-operator': ['tag:k8s-operator'],
        'tag:k8s': ['tag:k8s-operator'],
        'tag:control-plane': ['pandoks@github'],
        'tag:worker': ['pandoks@github'],
        'tag:public-cloud': ['pandoks@github'],
        'tag:dedicated': ['pandoks@github'],
        'tag:cloud-control-plane': ['pandoks@github'],
        'tag:cloud-workers': ['pandoks@github'],
        'tag:dedicated-control-plane': ['pandoks@github'],
        'tag:dedicated-workers': ['pandoks@github'],
        'tag:dev': ['pandoks@github', 'tag:k8s-operator'],
        'tag:prod': ['pandoks@github', 'tag:k8s-operator'],
        'tag:ci': ['pandoks@github']
      }
    },
    { maxLength: 80, indent: 2 }
  )
});

const kubernetesOperatorOauthClient = new tailscale.OauthClient(
  `${STAGE_NAME}TailscaleKubernetesOperatorOauthClient`.replace(/^./, (char) => char.toUpperCase()),
  {
    description: `${STAGE_NAME} k8s operator`,
    scopes: ['devices:core', 'auth_keys', 'services'],
    tags: ['tag:k8s-operator', `tag:${STAGE_NAME}`]
  },
  { dependsOn: [tailscaleAcl] }
);
$resolve([
  secrets.k8s.tailscale.OauthClientId.name,
  secrets.k8s.tailscale.OauthClientId.value,
  kubernetesOperatorOauthClient.id,
  secrets.k8s.tailscale.OauthClientSecret.name,
  secrets.k8s.tailscale.OauthClientSecret.value,
  kubernetesOperatorOauthClient.key
]).apply(
  ([
    oauthClientIdSecretName,
    oauthClientIdSecretValue,
    oauthClientId,
    oauthClientSecretSecretName,
    oauthClientSecretSecretValue,
    oauthClientSecret
  ]) => {
    if (oauthClientIdSecretValue !== oauthClientId) {
      setSecret(oauthClientIdSecretName, oauthClientId);
    }
    if (oauthClientSecretSecretValue !== oauthClientSecret) {
      setSecret(oauthClientSecretSecretName, oauthClientSecret);
    }
  }
);

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

export function deleteTailscaleDevices(...deviceIds: string[]) {
  return $resolve([
    secrets.tailscale.OauthClientId.value,
    secrets.tailscale.OauthClientSecret.value
  ]).apply(async ([clientId, clientSecret]) => {
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
