export const desktopDev = new sst.x.DevCommand('DesktopDev', {
  dev: {
    autostart: false,
    command: 'pnpm run start',
    directory: 'apps/desktop'
  }
});
