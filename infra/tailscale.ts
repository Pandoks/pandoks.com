import stringify from 'json-stringify-pretty-compact';
import { secrets, setSecret } from './secrets';
import { STAGE_NAME } from './dns';

new tailscale.TailnetSettings('TailscaleSettings', {
  httpsEnabled: true
});

export const tailscaleAcl = new tailscale.Acl('TailscaleAcl', {
  resetAclOnDestroy: true,
  // NOTE: turn this on to bootstrap the ACL state into pulumi then turn it off to prevent the ACL from being overwritten
  // overwriteExistingContent: true,
  acl: stringify(
    {
      grants: [{ src: ['*'], dst: ['*'], ip: ['*'] }],
      ssh: [
        {
          action: 'check',
          src: ['autogroup:member'],
          dst: ['autogroup:self', 'tag:hetzner'],
          users: ['autogroup:nonroot', 'root']
        }
      ],
      tagOwners: {
        'tag:hetzner': ['pandoks@github'],
        'tag:k8s-operator': [],
        'tag:k8s': ['tag:k8s-operator'],
        'tag:control-plane': ['pandoks@github'],
        'tag:worker': ['pandoks@github'],
        'tag:dev': ['pandoks@github'],
        'tag:prod': ['pandoks@github']
      }
    },
    { maxLength: 80, indent: 2 }
  )
});

const kubernetesOperatorOauthClient = new tailscale.OauthClient(
  'TailscaleKubernetesOperatorOauthClient',
  {
    description: `${STAGE_NAME} k8s operator`,
    scopes: ['devices:core', 'auth_keys', 'services'],
    tags: ['tag:k8s-operator']
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
    if (oauthClientIdSecretValue != oauthClientId) {
      setSecret(oauthClientIdSecretName, oauthClientId);
    }
    if (oauthClientSecretSecretValue != oauthClientSecret) {
      setSecret(oauthClientSecretSecretName, oauthClientSecret);
    }
  }
);

export async function deleteTailscaleDevices(deviceIds: string | string[]) {
  const ids = Array.isArray(deviceIds) ? deviceIds : [deviceIds];

  return secrets.tailscale.ApiKey.value.apply(async (apiKey) => {
    return await Promise.all(
      ids.map(async (deviceId) => {
        try {
          const response = await fetch(`https://api.tailscale.com/api/v2/device/${deviceId}`, {
            method: 'DELETE',
            headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` }
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
