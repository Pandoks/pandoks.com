import { app, type MenuItemConstructorOptions } from 'electron';
import { createBrowserWindow } from './browser';

export const MENU: MenuItemConstructorOptions[] = [
  ...(process.platform === 'darwin'
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ] satisfies MenuItemConstructorOptions[]
        }
      ]
    : []),
  {
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CommandOrControl+N',
        click: createBrowserWindow
      },
      // Conditional Quit item for Windows/Linux
      // On macOS, 'quit' is handled by the app menu role above.
      ...(process.platform !== 'darwin'
        ? [
            { type: 'separator' },
            { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
          ] satisfies MenuItemConstructorOptions[]
        : [])
    ]
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' }, // macOS specific, but harmless on others
      { role: 'delete' },
      { role: 'selectAll' }
    ] satisfies MenuItemConstructorOptions[]
  }
];
