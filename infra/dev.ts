import { isProduction } from './dns';
import { readFileSync } from 'node:fs';
import { tailscaleAcl } from './tailscale';
import { inboundFirewall } from './vps/vps';

new sst.x.DevCommand('DevInit', {
  dev: {
    title: 'InitDev',
    command: 'pnpm dev:init',
    autostart: false
  }
});

new sst.x.DevCommand('DevDestroy', {
  dev: {
    title: 'DestroyDev',
    command: 'pnpm dev:destroy',
    autostart: false
  }
});

new sst.x.DevCommand('K3dRestart', {
  dev: {
    title: 'RestartK3d',
    command: 'pnpm cluster k3d restart',
    autostart: false
  }
});

new sst.x.DevCommand('K3dDependencyRestart', {
  dev: {
    title: 'RestartK3dDeps',
    command: 'pnpm cluster k3d deps restart',
    autostart: false
  }
});

export {};
