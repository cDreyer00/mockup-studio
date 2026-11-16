/** Helpers dos testes e2e: HTTP do daemon, cliente MCP mínimo (JSON-RPC) e abertura do editor. */
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Document, Node, OpenDocumentInfo } from '@mockup/core';

export const E2E_DIR = process.env.MOCKUP_E2E_DIR!;
export const DAEMON = process.env.MOCKUP_E2E_DAEMON!;

let counter = 0;

/** Caminho único de documento na pasta temporária do e2e. */
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

/** Cria um documento novo no daemon (fica ativo). */
export async function createDoc(name: string): Promise<OpenDocumentInfo> {
  return api<OpenDocumentInfo>('/api/new', { path: docPath(name), name });
}

/** Abre um arquivo no daemon (fica ativo). */
export async function openDoc(file: string): Promise<OpenDocumentInfo> {
  const info = await api<OpenDocumentInfo>('/api/open', { path: file });
  await api('/api/active', { docId: info.docId });
  return info;
}

export async function getDoc(docId: string): Promise<Document> {
  return (await api<{ doc: Document }>(`/api/docs/${docId}`)).doc;
}

/** Procura um nó pelo nome em todo o documento. */
export function findByName(doc: Document, name: string): Node | undefined {
  let found: Node | undefined;
  const visit = (n: Node) => {
    if (!found && n.name === name) found = n;
    n.children.forEach(visit);
  };
  doc.pages.forEach((p) => p.frames.forEach(visit));
  return found;
}

/** Copia um arquivo de exemplo para a pasta do e2e (para não alterar o original). */
export function copyExample(file: string): string {
  const dest = docPath(path.basename(file, '.mockup.json'));
  fs.copyFileSync(file, dest);
  return dest;
}

/** Cliente MCP mínimo sobre Streamable HTTP (fetch + JSON-RPC; respostas JSON ou SSE). */
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

  /** Chama uma ferramenta e devolve o texto da resposta (lança se `isError`). */
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

/** Abre o editor e espera conectar ao daemon e exibir o documento ativo. */
/** Espera a caixa do elemento parar de mudar entre duas leituras (fim de rAF/medição). */
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

export async function gotoEditor(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
}

/** Centro de um elemento em coordenadas da página. */
export async function centerOf(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`Elemento ${testId} sem caixa`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Arrasta com o mouse em passos (dispara pointermove intermediários). */
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
