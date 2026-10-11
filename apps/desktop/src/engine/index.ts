// Entry point of the engine utilityProcess (architecture §4). Main talks to it over
// process.parentPort; the media renderer gets a direct MessagePort, sent by main at startup and
// again after either side restarts.
import type { MainToEngine } from '../shared/engine-protocol';
import { getPlatform } from '../platform';
import { Engine } from './engine';
import { PortMediaChannel } from './media-channel';

const parent = process.parentPort;
const media = new PortMediaChannel();
const platform = getPlatform();

const engine = new Engine({
  post: (msg) => parent.postMessage(msg),
  media,
  createHoldKeyHook: (key, dictationKey) => platform.createHoldKeyHook(key, dictationKey),
});

function log(level: 'info' | 'warn' | 'error', message: string): void {
  parent.postMessage({ type: 'log', level, message });
}

process.on('uncaughtException', (e) => log('error', `engine uncaught exception: ${e.stack ?? String(e)}`));
process.on('unhandledRejection', (e) =>
  log('error', `engine unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
);

parent.on('message', (e) => {
  const msg = e.data as MainToEngine | { type: 'media.port' };
  if (msg.type === 'media.port') {
    const port = e.ports[0];
    if (port) media.attach(port);
    return;
  }
  if (msg.type === 'media.crashed') media.crashed();
  engine.handle(msg);
  if (msg.type === 'shutdown') setTimeout(() => process.exit(0), 50);
});

parent.postMessage({ type: 'ready' });
