import type * as pulumi from '@pulumi/pulumi';
import * as tailscale from '@pulumi/tailscale';
import stringify from 'json-stringify-pretty-compact';
import { isProduction, isSharedStage, STAGE_NAME } from '@pandoks.com/infra/stack';

export const hubTailscaleServices = [
  { name: 'cliproxyapi', comment: 'CLIProxyAPI on the homelab hub', ports: ['tcp:443'] },
  {
    name: 'cliproxyapi-api',
    comment: 'CLIProxyAPI with Console API keys only',
    ports: ['tcp:443']
  },
  { name: 'beszel', comment: 'Beszel monitoring hub', ports: ['tcp:443'] },
  { name: 'artex', comment: 'ARTEX on the homelab hub', ports: ['tcp:443'] },
  {
    name: 'protonmail-bridge',
    comment: 'Proton Mail Bridge IMAP and SMTP on the homelab hub',
    ports: ['tcp:1143', 'tcp:1025']
  }
];

// NOTE: the ACL and settings span the whole tailnet, so production owns them for every stack.
export let tailscaleAcl: tailscale.Acl | undefined;
if (isProduction) {
  new tailscale.TailnetSettings('TailscaleSettings', {
    httpsEnabled: true
  });

  tailscaleAcl = new tailscale.Acl('TailscaleAcl', {
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
          services: Object.fromEntries(
            hubTailscaleServices.map(({ name }) => [`svc:${name}`, ['tag:hub']])
          )
        },
        grants: [
          { src: ['*'], dst: ['*'], ip: ['*'] },
          ...hubTailscaleServices.map(({ name, ports }) => ({
            src: ['*'],
            dst: [`svc:${name}`],
            ip: ports
          })),
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
            dst: ['autogroup:self'],
            users: ['autogroup:nonroot', 'root']
          },
          {
            action: 'check',
            src: ['pandoks@github'],
            dst: ['tag:hetzner', 'tag:ovh'],
            users: ['autogroup:nonroot', 'root']
          },
          {
            action: 'check',
            src: ['autogroup:member'],
            dst: ['tag:ssh'],
            users: ['autogroup:nonroot']
          },
          // NOTE: tailscale doesn't allow check mode from tagged devices
          {
            action: 'accept',
            src: ['tag:ssh'],
            dst: ['tag:ssh'],
            users: ['autogroup:nonroot']
          }
        ],
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
          'tag:hub': ['pandoks@github'],
          'tag:ssh': ['pandoks@github']
        }
      },
      { maxLength: 80, indent: 2 }
    )
  });
}

export const kubernetesOperatorOauthClient = isSharedStage
  ? new tailscale.OauthClient(
      `${STAGE_NAME}TailscaleKubernetesOperatorOauthClient`.replace(/^./, (char) =>
        char.toUpperCase()
      ),
      {
        description: `${STAGE_NAME} k8s operator`,
        scopes: ['devices:core', 'auth_keys', 'services'],
        tags: ['tag:k8s-operator', `tag:${STAGE_NAME}`]
      },
      { dependsOn: tailscaleAcl }
    )
  : undefined;

export const outputs: Record<string, pulumi.Output<string>> = kubernetesOperatorOauthClient
  ? {
      KubernetesTailscaleOauthClientId: kubernetesOperatorOauthClient.id,
      KubernetesTailscaleOauthClientSecret: kubernetesOperatorOauthClient.key
    }
  : {};
