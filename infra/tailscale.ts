import stringify from 'json-stringify-pretty-compact';
import { secrets, setSecret } from './secrets';
import { STAGE_NAME } from './dns';

new tailscale.TailnetSettings('TailscaleSettings', {
  httpsEnabled: true
});

// Exclude tag:grokbot from the catch-all grant and tag:ssh SSH rule: Tailscale has no deny
// rules, and * / autogroup:tagged would include it. Add new tags here unless restricted like grokbot.
const trustedTags = [
  'tag:funnel',
  'tag:hetzner',
  'tag:ovh',
  'tag:k8s-operator',
  'tag:k8s',
  'tag:control-plane',
  'tag:worker',
  'tag:dev',
  'tag:prod',
  'tag:ci',
  'tag:cliproxyapi',
  'tag:ssh'
];

export const tailscaleAcl = new tailscale.Acl('TailscaleAcl', {
  resetAclOnDestroy: true,
  // NOTE: overwriteExistingContent is set to true so it works in all stages. we do this because the
  // tailnet isn't used for any important networking. it is solely to access the devices.
  // WARNING: a change to this will overwrite the ACL on all stages.
  overwriteExistingContent: true,
  acl: stringify(
    {
      nodeAttrs: [
        {
          target: ['tag:funnel'],
          attr: ['funnel']
        }
      ],
      autoApprovers: {
        services: {
          'svc:cliproxyapi': ['tag:cliproxyapi']
        }
      },
      hosts: {
        // untagged shared box (T3 Code MCP via Tailscale Serve on :443 -> 127.0.0.1:3773)
        'grok-box': '100.120.114.92/32',
        // Jason's MacBook Pro (Tailscale name Pandoks-MacBook-Pro / personal-m1-max, tag:ssh)
        'jason-mbp': '100.67.19.11/32'
      },
      grants: [
        // `*` replaced so tag:grokbot is excluded; autogroup:member + autogroup:shared + trustedTags
        // preserves prior access for everything else.
        { src: ['autogroup:member', 'autogroup:shared', ...trustedTags], dst: ['*'], ip: ['*'] },
        // Grok Bot connector: only the T3 Code MCP on the shared box. Tailscale Serve terminates
        // HTTPS on :443 and proxies to 127.0.0.1:3773; 3773 itself is loopback-only so it is not granted.
        { src: ['tag:grokbot'], dst: ['grok-box'], ip: ['tcp:443'] },
        // Jason's Mac also serves T3 Code (/mcp) on :443 via Tailscale Serve. Uncomment to allow.
        // { src: ['tag:grokbot'], dst: ['jason-mbp'], ip: ['tcp:443'] },
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
          dst: ['autogroup:self', 'tag:hetzner', 'tag:ovh'],
          users: ['autogroup:nonroot', 'root']
        },
        {
          action: 'accept',
          // tag:grokbot must not get SSH.
          src: ['autogroup:member', ...trustedTags],
          dst: ['tag:ssh'],
          users: ['autogroup:nonroot', 'root']
        }
      ],
      // guardrail: tag:grokbot may only reach grok-box:443 (100.116.252.21 = pandoks-dev-box, 100.90.249.97 = sieve-macbook-air)
      tests: [
        {
          src: 'tag:grokbot',
          proto: 'tcp',
          accept: ['grok-box:443'],
          deny: [
            'grok-box:3773',
            'grok-box:22',
            'jason-mbp:443',
            '100.116.252.21:22',
            '100.116.252.21:443',
            '100.90.249.97:443'
          ]
        }
      ],
      sshTests: [{ src: 'tag:grokbot', dst: ['tag:ssh'], deny: ['root'] }],
      tagOwners: {
        'tag:funnel': ['pandoks@github'],
        'tag:hetzner': ['pandoks@github'],
        'tag:ovh': ['pandoks@github'],
        'tag:k8s-operator': ['tag:k8s-operator'],
        'tag:k8s': ['tag:k8s-operator'],
        'tag:control-plane': ['pandoks@github'],
        'tag:worker': ['pandoks@github'],
        'tag:dev': ['pandoks@github', 'tag:k8s-operator'],
        'tag:prod': ['pandoks@github', 'tag:k8s-operator'],
        'tag:ci': ['pandoks@github'],
        'tag:cliproxyapi': ['pandoks@github'],
        'tag:ssh': ['pandoks@github'],
        'tag:grokbot': ['pandoks@github']
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
