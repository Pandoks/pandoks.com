import { app } from 'electron';
import { createWindow } from './window';

export const MENU = [
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
            { role: 'hideothers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      ]
    : []),
  {
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CommandOrControl+N',
        click: createWindow
      },
      // Conditional Quit item for Windows/Linux
      // On macOS, 'quit' is handled by the app menu role above.
      ...(process.platform !== 'darwin'
        ? [
            { type: 'separator' },
            { label: 'Quit', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
          ]
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
    ]
  }
];
