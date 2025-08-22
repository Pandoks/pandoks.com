import { cloudflareIps } from './dns';

const firewall = new hcloud.Firewall('Firewall', {
  name: 'cloudflare-only',
  rules: [
    {
      direction: 'in',
      protocol: 'tcp',
      port: '80',
      sourceIps: cloudflareIps.result.ipv4_cidrs,
      description: 'Allow HTTP traffic from Cloudflare IPs'
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '443',
      sourceIps: cloudflareIps.result.ipv4_cidrs,
      description: 'Allow HTTPS traffic from Cloudflare IPs'
    },
    {
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      sourceIps: cloudflareIps.result.ipv4_cidrs,
      description: 'Allow SSH traffic from Cloudflare IPs'
    }
  ]
});
