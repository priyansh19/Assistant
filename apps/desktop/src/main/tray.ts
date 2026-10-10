import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export function createTray(): Tray {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources/tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('Clicky: hold Right Ctrl and ask');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Clicky', enabled: false },
      { label: 'Hold Right Ctrl to talk', enabled: false },
      { type: 'separator' },
      { label: 'Quit', role: 'quit' },
    ]),
  );
  return tray;
}
