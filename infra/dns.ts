export const domain = $app.stage === 'production' ? 'pandoks.com' : 'dev.pandoks.com';

const cloudflareIpRequest = await fetch('https://api.cloudflare.com/client/v4/ips');
export const cloudflareIps: {
  result: { ipv4_cidrs: string[]; ipv6_cidrs: string[]; etag: string };
  success: boolean;
} = await cloudflareIpRequest.json();
