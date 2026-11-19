import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, HelloEvent, ServerMessage } from '@mockup/core';
import type { EditorConnection } from './editors.js';
import { attachServiceEvents, routeServiceMessage, type DaemonServices } from './services.js';
import { STORE_EVENT_NAMES, type DocumentStore } from './store.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Accepts an absent Origin (non-browser clients) and http(s) on a local host (any port).
 * `Origin: null` is rejected: `sandbox` iframes and `data:` pages from any site send that value.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export interface WsHandle {
  broadcast(msg: ServerMessage): void;
  close(): Promise<void>;
}

function buildHello(store: DocumentStore): HelloEvent {
  const active = store.getActive();
  return {
    type: 'hello',
    documents: store.list(),
    activeDocId: active?.id ?? null,
    doc: active ? active.history.doc : null,
    selection: active ? store.getSelection(active.id) : [],
    revision: active ? active.history.revision : 0,
    history: active ? store.historyState(active) : { canUndo: false, canRedo: false },
  };
}

async function handleMessage(
  store: DocumentStore,
  msg: ClientMessage,
  services: DaemonServices,
  conn: EditorConnection,
): Promise<unknown> {
  const routed = routeServiceMessage(services, msg);
  if (routed) return routed;
  switch (msg.type) {
    case 'op:apply': {
      if (typeof msg.docId !== 'string' || !msg.docId)
        throw new Error('op:apply requires "docId" (string).');
      if (!Array.isArray(msg.ops))
        throw new Error('op:apply requires "ops" as an array of operations.');
      const r = store.applyOps(msg.docId, msg.ops, { source: 'editor' });
      return { revision: r.revision, results: r.results.map((x) => x ?? null) };
    }
    case 'selection:set':
      store.setSelection(msg.docId, msg.nodeIds, 'editor');
      return {};
    case 'doc:open': {
      const { doc: _doc, ...info } = await store.open(msg.path);
      return info;
    }
    case 'doc:new': {
      if (typeof msg.path !== 'string' || !msg.path)
        throw new Error('doc:new requires "path" (string).');
      if (typeof msg.name !== 'string' || !msg.name)
        throw new Error('doc:new requires "name" (string).');
      const { doc: _doc, ...info } = await store.create(msg.path, msg.name);
      return info;
    }
    case 'doc:close': {
      if (typeof msg.docId !== 'string' || !msg.docId)
        throw new Error('doc:close requires "docId" (string).');
      await store.close(msg.docId);
      return {};
    }
    case 'doc:save':
      return { path: await store.save(msg.docId) };
    case 'doc:saveAs': {
      if (typeof msg.path !== 'string' || !msg.path)
        throw new Error('doc:saveAs requires "path" (string).');
      return await store.saveAs(msg.docId, msg.path);
    }
    case 'undo': {
      const r = store.undo(msg.docId, 'editor');
      return { applied: r !== null, revision: r?.revision ?? null };
    }
    case 'redo': {
      const r = store.redo(msg.docId, 'editor');
      return { applied: r !== null, revision: r?.revision ?? null };
    }
    case 'active:set':
      store.setActive(msg.docId);
      return {};
    case 'editor:register': {
      if (typeof msg.focused !== 'boolean')
        throw new Error('editor:register requires "focused" (boolean).');
      services.editors?.register(conn, msg.focused);
      return {};
    }
    case 'editor:result': {
      if (typeof msg.commandId !== 'string' || !msg.commandId)
        throw new Error('editor:result requires "commandId" (string).');
      if (typeof msg.ok !== 'boolean') throw new Error('editor:result requires "ok" (boolean).');
      services.editors?.resolve(conn, msg);
      return {};
    }
    default:
      throw new Error(`Unknown message type: ${(msg as { type?: string }).type ?? '?'}`);
  }
}

export function attachWebSocket(
  httpServer: HttpServer,
  store: DocumentStore,
  path = '/ws',
  services: DaemonServices = {},
): WsHandle {
  const wss = new WebSocketServer({
    server: httpServer,
    path,
    verifyClient: (info, cb) => {
      if (isAllowedOrigin(info.origin)) cb(true);
      else cb(false, 403, 'Origin not allowed');
    },
  });

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };

  const listeners: Array<() => void> = [];
  for (const name of STORE_EVENT_NAMES) {
    const fn = (ev: ServerMessage): void => broadcast(ev);
    store.on(name, fn as never);
    listeners.push(() => store.off(name, fn as never));
  }
  listeners.push(attachServiceEvents(services, broadcast));

  wss.on('connection', (ws) => {
    const conn: EditorConnection = { send: (msg) => send(ws, msg) };
    ws.on('close', () => services.editors?.unregister(conn));
    send(ws, buildHello(store));
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string')
          throw new Error('format');
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON or malformed message.' });
        return;
      }
      const reqId = (msg as { reqId?: string }).reqId;
      Promise.resolve()
        .then(() => handleMessage(store, msg, services, conn))
        .then(
          (result) => {
            if (reqId !== undefined) send(ws, { type: 'ack', reqId, result });
          },
          (e: unknown) => {
            send(ws, { type: 'error', reqId, message: e instanceof Error ? e.message : String(e) });
          },
        );
    });
    ws.on('error', () => undefined);
  });

  return {
    broadcast,
    close: () =>
      new Promise<void>((resolve) => {
        listeners.forEach((off) => off());
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
