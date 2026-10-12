import { join } from 'node:path';
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { InteractionState, SavedAction } from '@clicky/core';

export interface TrayActions {
  openDashboard(page?: string): void;
  holdKeyLabel(): string;
  paused(): boolean;
  setPaused(paused: boolean): void;
  actions(): SavedAction[];
  runAction(id: string): void;
  needsSetup(): boolean;
  /** Draw the built-in example sketch on the screen with the mouse. */
  showDrawing(): void;
}

const STATE_TEXT: Partial<Record<InteractionState, string>> = {
  listening: 'Listening…',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: 'Answering…',
};

export class AppTray {
  private readonly tray: Tray;
  private state: InteractionState = 'idle';

  constructor(private readonly a: TrayActions) {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources/tray.png'));
    this.tray = new Tray(icon);
    this.tray.on('click', () => a.openDashboard());
    // Rebuild on open so it reflects the current key, pause state and actions.
    this.tray.on('right-click', () => this.refresh());
    this.refresh();
  }

  setState(state: InteractionState): void {
    this.state = state;
    this.refreshTooltip();
  }

  refresh(): void {
    this.refreshTooltip();
    const actions = this.a.actions().slice(0, 15);
    const actionItems: MenuItemConstructorOptions[] = actions.length
      ? actions.map((x) => ({ label: x.name.replace(/&/g, '&&'), click: () => this.a.runAction(x.id) }))
      : [{ label: 'No saved actions yet', enabled: false }];
    const paused = this.a.paused();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Clicky',
          click: () => this.a.openDashboard(),
          ...(this.a.needsSetup() ? { label: 'Finish setting up Clicky…' } : {}),
        },
        { type: 'separator' },
        { label: 'Run action', submenu: actionItems },
        { label: 'History', click: () => this.a.openDashboard('history') },
        { label: 'Show me a drawing', click: () => this.a.showDrawing() },
        { type: 'separator' },
        {
          label: paused ? 'Resume Clicky' : 'Pause Clicky',
          click: () => {
            this.a.setPaused(!paused);
            this.refresh();
          },
        },
        { label: 'Settings', click: () => this.a.openDashboard('general') },
        { type: 'separator' },
        { label: 'Quit Clicky', role: 'quit' },
      ]),
    );
  }

  private refreshTooltip(): void {
    const busy = STATE_TEXT[this.state];
    const text = this.a.needsSetup()
      ? 'Clicky: click to finish setup'
      : this.a.paused()
        ? 'Clicky (paused)'
        : busy
          ? `Clicky: ${busy}`
          : `Clicky: hold ${this.a.holdKeyLabel()} and ask`;
    this.tray.setToolTip(text);
  }

  destroy(): void {
    this.tray.destroy();
  }
}
