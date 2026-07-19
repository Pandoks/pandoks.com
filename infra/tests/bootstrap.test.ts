import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import {
  renderBootstrapEnvironment,
  renderCloudInitTransport,
  renderDedicatedTransport
} from '../cluster/bootstrap-render.ts';

const environment = {
  STAGE_NAME: 'prod',
  NODE_NAME: 'prod-ovh-control-plane-server-0',
  NODE_IP: '10.0.1.10',
  NETWORK_CIDR: '10.0.1.0/24',
  NETWORK_MODE: 'dhcp',
  VRACK_MAC: '',
  ROLE: 'control-plane',
  BOOTSTRAP_CANDIDATE: 'true',
  SERVER_API: 'https://10.0.1.2:6443',
  K3S_TOKEN: "token-with-'quote",
  REGISTRATION_TAILNET_AUTH_KEY: 'tskey-auth-test',
  KUBERNETES_TAILSCALE_OAUTH_CLIENT_ID: 'client-id',
  KUBERNETES_TAILSCALE_OAUTH_CLIENT_SECRET: 'client-secret',
  KUBERNETES_TAILSCALE_HOSTNAME: 'prod-cluster',
  S3_HOST: 'example.r2.cloudflarestorage.com',
  BACKUP_BUCKET: 'backup',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret'
} as const;

void test('shell-quotes every bootstrap environment value', () => {
  const rendered = renderBootstrapEnvironment(environment);
  assert.match(rendered, /^STAGE_NAME='prod'$/m);
  assert.match(rendered, /^K3S_TOKEN='token-with-'"'"'quote'$/m);
});

void test('cloud-init embeds the environment, script, and systemd unit as base64', () => {
  const cloudInit = renderCloudInitTransport('#!/bin/sh\nprintf "bootstrap\\n"\n', environment);
  assert.match(cloudInit, /^#cloud-config/m);
  assert.doesNotMatch(cloudInit, /tskey-auth-test/);
  assert.match(cloudInit, /encoding: b64/);
  assert.match(cloudInit, /pandoks-cluster-bootstrap\.service/);
  writeFileSync('/tmp/ovh-cluster-cloud-config.yaml', cloudInit);
});

void test('dedicated transport installs the same script and unit', () => {
  const postInstall = Buffer.from(
    renderDedicatedTransport('#!/bin/sh\nprintf "bootstrap\\n"\n', environment),
    'base64'
  ).toString();
  assert.match(postInstall, /^#!\/bin\/sh/m);
  assert.match(postInstall, /pandoks-cluster-bootstrap\.service/);
  assert.doesNotMatch(postInstall, /tskey-auth-test/);
});
