import { join } from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export interface TrayActions {
  openSettings(): void;
  holdKeyLabel(): string;
}

export function createTray(actions: TrayActions): Tray {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources/tray.png'));
  const tray = new Tray(icon);
  const refresh = (): void => {
    const key = actions.holdKeyLabel();
    tray.setToolTip(`Clicky: hold ${key} and ask`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Clicky', enabled: false },
        { label: `Hold ${key} to talk`, enabled: false },
        { type: 'separator' },
        { label: 'Settings…', click: () => actions.openSettings() },
        { type: 'separator' },
        { label: 'Quit Clicky', role: 'quit' },
      ]),
    );
  };
  refresh();
  tray.on('click', () => actions.openSettings());
  // Rebuild the menu each time it opens so it reflects the current hold key.
  tray.on('right-click', refresh);
  return tray;
}
