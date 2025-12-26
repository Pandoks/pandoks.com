new sst.x.DevCommand('DevInit', {
  dev: {
    title: 'InitDev',
    command: 'pnpm run dev:init',
    autostart: true
  }
});

new sst.x.DevCommand('DevDestroy', {
  dev: {
    title: 'DestroyDev',
    command: 'pnpm run dev:destroy',
    autostart: false
  }
});

new sst.x.DevCommand('K3dRestart', {
  dev: {
    title: 'RestartK3d',
    command: 'pnpm run cluster k3d restart',
    autostart: false
  }
});

new sst.x.DevCommand('K3dDependencyRestart', {
  dev: {
    title: 'RestartK3dDeps',
    command: 'pnpm run cluster k3d deps restart',
    autostart: false
  }
});

export {};
