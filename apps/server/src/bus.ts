import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@opendots/shared';
import { accountKey, currentAccount, type AccountContext } from './auth/context.ts';

/** Bus d'événements interne, relayé au frontend par SSE. */
const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function publish(event: ServerEvent) {
  emitter.emit(`event:${accountKey()}`, event);
  emitter.emit('event:*', event, currentAccount());
}

/** Every account's events, with the account they belong to (server-side consumers such as notifications, #64). */
export function subscribeAll(fn: (event: ServerEvent, account: AccountContext | undefined) => void): () => void {
  emitter.on('event:*', fn);
  return () => emitter.off('event:*', fn);
}

export function subscribe(fn: (event: ServerEvent) => void): () => void {
  const channel = `event:${accountKey()}`;
  emitter.on(channel, fn);
  return () => emitter.off(channel, fn);
}
