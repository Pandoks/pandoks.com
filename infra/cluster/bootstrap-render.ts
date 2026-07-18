import { readFileSync } from 'node:fs';

const cloudConfig = readFileSync(`${process.cwd()}/infra/cluster/cloud-config.yaml`, 'utf8');

export type BootstrapEnvironment = Readonly<
  Record<
    | 'STAGE_NAME'
    | 'NODE_NAME'
    | 'NODE_IP'
    | 'NETWORK_CIDR'
    | 'NETWORK_MODE'
    | 'VRACK_MAC'
    | 'ROLE'
    | 'BOOTSTRAP_CANDIDATE'
    | 'SERVER_API'
    | 'K3S_TOKEN'
    | 'REGISTRATION_TAILNET_AUTH_KEY'
    | 'KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID'
    | 'KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET'
    | 'KUBERNETES_TAILSCALE_HOSTNAME'
    | 'S3_HOST'
    | 'BACKUP_BUCKET'
    | 'S3_ACCESS_KEY'
    | 'S3_SECRET_KEY',
    string
  >
>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderBootstrapEnvironment(environment: BootstrapEnvironment): string {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join('\n')
    .concat('\n');
}

const systemdUnit = `[Unit]
Description=Pandoks cluster bootstrap
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/pandoks/cluster.env
ExecStart=/usr/local/sbin/pandoks-cluster-bootstrap
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;

function encode(value: string): string {
  return Buffer.from(value).toString('base64');
}

export function renderCloudInitTransport(
  script: string,
  environment: BootstrapEnvironment
): string {
  const replacements = {
    BOOTSTRAP_ENV_BASE64: encode(renderBootstrapEnvironment(environment)),
    BOOTSTRAP_SCRIPT_BASE64: encode(script),
    BOOTSTRAP_SERVICE_BASE64: encode(systemdUnit)
  };
  return cloudConfig.replace(
    /\$\{([A-Z0-9_]+)\}/g,
    (_, name: keyof typeof replacements) => replacements[name]
  );
}

export function renderDedicatedTransport(
  script: string,
  environment: BootstrapEnvironment
): string {
  const wrapper = `#!/bin/sh
set -eu
install -d -m 0700 /etc/pandoks
printf '%s' '${encode(renderBootstrapEnvironment(environment))}' | base64 -d > /etc/pandoks/cluster.env
chmod 0600 /etc/pandoks/cluster.env
printf '%s' '${encode(script)}' | base64 -d > /usr/local/sbin/pandoks-cluster-bootstrap
chmod 0755 /usr/local/sbin/pandoks-cluster-bootstrap
printf '%s' '${encode(systemdUnit)}' | base64 -d > /etc/systemd/system/pandoks-cluster-bootstrap.service
chmod 0644 /etc/systemd/system/pandoks-cluster-bootstrap.service
systemctl daemon-reload
systemctl enable --now pandoks-cluster-bootstrap.service
`;
  return encode(wrapper);
}
