/** e2e test helpers: daemon HTTP, minimal MCP client (JSON-RPC) and editor opening. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Document, Node, OpenDocumentInfo } from '@mockup/core';

export const E2E_DIR = process.env.MOCKUP_E2E_DIR!;
export const DAEMON = process.env.MOCKUP_E2E_DAEMON!;

let counter = 0;

/** Unique document path in the e2e temporary folder. */
export function docPath(name: string): string {
  return path.join(E2E_DIR, `${name}-${Date.now()}-${++counter}.mockup.json`);
}

export async function api<T>(route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DAEMON}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${route}: ${res.status} ${json.error ?? ''}`);
  return json;
}

/** Creates a new document in the daemon (becomes active). */
export async function createDoc(name: string): Promise<OpenDocumentInfo> {
  return api<OpenDocumentInfo>('/api/new', { path: docPath(name), name });
}

/** Opens a file in the daemon (becomes active). */
export async function openDoc(file: string): Promise<OpenDocumentInfo> {
  const info = await api<OpenDocumentInfo>('/api/open', { path: file });
  await api('/api/active', { docId: info.docId });
  return info;
}

export async function getDoc(docId: string): Promise<Document> {
  return (await api<{ doc: Document }>(`/api/docs/${docId}`)).doc;
}

/** Looks up a node by name across the whole document. */
export function findByName(doc: Document, name: string): Node | undefined {
  let found: Node | undefined;
  const visit = (n: Node) => {
    if (!found && n.name === name) found = n;
    n.children.forEach(visit);
  };
  doc.pages.forEach((p) => p.frames.forEach(visit));
  return found;
}

/** Copies an example file to the e2e folder (so the original is not changed). */
export function copyExample(file: string): string {
  const dest = docPath(path.basename(file, '.mockup.json'));
  fs.copyFileSync(file, dest);
  return dest;
}

/** Minimal MCP client over Streamable HTTP (fetch + JSON-RPC; JSON or SSE responses). */
export class Mcp {
  private sessionId: string | null = null;
  private id = 0;

  private async rpc(method: string, params: unknown, notify = false): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const body = notify
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await fetch(`${DAEMON}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    if (notify) return null;
    const text = await res.text();
    const payload = res.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .pop()
      : text;
    const msg = JSON.parse(payload ?? '{}') as { result?: unknown; error?: { message: string } };
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg.result;
  }

  async init(): Promise<this> {
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mockup-e2e', version: '0.0.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    return this;
  }

  /** Calls a tool and returns the response text (throws if `isError`). */
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}

/** Waits for the element box to stop changing between two reads (end of rAF/measurement). */
export async function waitForStableBox(locator: Locator): Promise<void> {
  let last = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await locator.boundingBox());
      const stable = box === last && box !== 'null';
      last = box;
      return stable;
    })
    .toBe(true);
}

/** Opens the editor and waits for it to connect to the daemon and show the active document. */
export async function gotoEditor(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Center of an element in page coordinates. */
export async function centerOf(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`Element ${testId} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags with the mouse in steps (fires intermediate pointermove events). */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number } = {},
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 12 });
  await page.mouse.up();
}
