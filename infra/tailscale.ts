import stringify from 'json-stringify-pretty-compact';
import { execSync } from 'node:child_process';
import { secrets } from './secrets';

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
    description: `${$app.stage === 'production' ? 'prod' : 'dev'} k8s operator`,
    scopes: ['devices:core', 'auth_keys', 'services'],
    tags: ['tag:k8s-operator']
  },
  { dependsOn: [tailscaleAcl] }
);
$resolve([secrets.k8s.tailscale.OauthClientId.name, kubernetesOperatorOauthClient.id]).apply(
  ([secretName, oauthClientId]) => {
    execSync(`sst secret set ${secretName} --stage ${$app.stage} ${oauthClientId}`, {
      stdio: 'inherit'
    });
  }
);
$resolve([secrets.k8s.tailscale.OauthClientSecret.name, kubernetesOperatorOauthClient.key]).apply(
  ([secretName, oauthClientSecret]) => {
    execSync(`sst secret set ${secretName} --stage ${$app.stage} ${oauthClientSecret}`, {
      stdio: 'inherit'
    });
  }
);
