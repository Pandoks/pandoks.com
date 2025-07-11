export const browserDev = new sst.x.DevCommand('BrowserDev', {
  dev: {
    autostart: false,
    command: 'pnpm run start',
    directory: 'apps/browser'
  }
});
