export const desktopDev = new sst.x.DevCommand('DesktopDev', {
  dev: {
    autostart: false,
    command: 'pnpm run start',
    directory: 'apps/desktop'
  }
});

export const desktopWebDev = new sst.x.DevCommand('DesktopWebDev', {
  dev: {
    autostart: false,
    command: 'pnpm run dev',
    directory: 'apps/desktop'
  }
});
