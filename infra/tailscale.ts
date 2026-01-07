import stringify from 'json-stringify-pretty-compact';

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
          dst: ['autogroup:self'],
          users: ['autogroup:nonroot', 'root']
        }
      ],
      tagOwners: {
        'tag:hetzner': ['pandoks@github'],
        'tag:k3s': ['pandoks@github'],
        'tag:control-plane': ['pandoks@github'],
        'tag:worker': ['pandoks@github'],
        'tag:dev': ['pandoks@github'],
        'tag:prod': ['pandoks@github']
      }
    },
    { maxLength: 80, indent: 2 }
  )
});
