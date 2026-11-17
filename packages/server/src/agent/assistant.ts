/**
 * Serviço do assistente de IA: um chat por documento que conversa com o canvas por uma CLI de agente
 * (Claude Code ou Codex), usando o MCP do próprio daemon.
 *
 * Cada turno é um subprocesso novo, ligado ao daemon por uma URL `/mcp?turn=<token>`. O token vale só
 * enquanto o turno roda e dá às escritas do agente um grupo de undo único (`assistant:<turnId>`).
 * Contrato público em `services.ts`; backends em `backend.ts` e `cli.ts`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findNode,
  getDocumentSummary,
  getTreeSummary,
  type AssistantBackendInfo,
  type AssistantConfig,
  type AssistantEvent,
  type AssistantMessage,
  type AssistantToolCall,
  type ClientMessage,
  type Document,
} from '@mockup/core';
import type { RenderProvider } from '../render.js';
import type { AssistantServiceApi, RunTurnOptions, TurnBinding } from '../services.js';
import type { DocumentStore } from '../store.js';
import type { AgentBackend, AgentImage, AgentRunEvent, AgentRunInput } from './backend.js';
import { detectBackends, isAbortError, MCP_SERVER_NAME } from './cli.js';

export interface AssistantServiceOptions {
  /** Pasta de dados do daemon (onde fica `assistant.json`); sem ela a config fica só em memória. */
  dataDir?: string;
  getPort: () => number;
  host?: string;
  render?: RenderProvider;
  /** Backends no lugar dos detectados (testes). */
  backends?: AgentBackend[];
}

/** Mensagens do histórico guardadas por documento. */
export const MAX_HISTORY_MESSAGES = 200;
/** Limite do resumo da árvore enviado como contexto. */
export const MAX_CONTEXT_CHARS = 6000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const HISTORY_FILE_VERSION = 1;

const log = (...args: unknown[]): void => console.error('[mockup-assistant]', ...args);

/** Arquivo lateral do histórico: `<pasta>/<base>.assistant.json` ao lado de `<base>.mockup.json`. */
export function assistantSidecarPath(docPath: string): string {
  const dir = path.dirname(docPath);
  const base = path
    .basename(docPath)
    .replace(/\.mockup\.json$/i, '')
    .replace(/\.json$/i, '');
  return path.join(dir, `${base}.assistant.json`);
}

interface SidecarFile {
  version: number;
  messages: AssistantMessage[];
  /** sessionId do backend por id de backend (continuação da conversa com `--resume`). */
  sessions: Record<string, string>;
}

interface DocChat {
  messages: AssistantMessage[];
  sessions: Record<string, string>;
  /** Arquivo lateral já carregado (ou tentado). */
  loadedFrom: string | null;
}

interface Turn {
  id: string;
  docId: string;
  token: string;
  group: string;
  /** O serviço é dono do grupo (fecha no fim); falso se o chamador passou `opts.group`. */
  ownGroup: boolean;
  controller: AbortController;
  backend?: AgentBackend;
  user: AssistantMessage;
  text: string;
  tools: AssistantToolCall[];
  sessionId?: string;
  /** Mensagem final do assistente (resolve sempre; erros viram `status: 'error'`). */
  result: Promise<AssistantMessage>;
  /** Registro do token ativo (só depois do backend resolvido). */
  active: boolean;
}

const NO_BACKEND =
  'Nenhum agente de IA disponível. Instale e faça login no Claude Code (`claude`) ou no Codex (`codex`) e tente de novo.';

const SYSTEM_TEXT_ONLY =
  'Responda apenas com o texto pedido, em português do Brasil, sem usar ferramentas e sem explicações extras.';

function systemPrompt(docId: string, selection: string[], extra?: string): string {
  const lines = [
    'Você é o assistente de design embutido no Mockup Studio, um editor visual de mockups em HTML/CSS. O usuário conversa com você num painel do editor e você edita o documento dele pelas ferramentas MCP do servidor "mockup-studio".',
    '',
    'Regras:',
    '- Use SOMENTE as ferramentas MCP do mockup-studio. Não use shell, arquivos nem web.',
    `- O documento do turno é ${docId}: passe sempre docId="${docId}" nas ferramentas.`,
    selection.length
      ? `- Trabalhe sobre a seleção do usuário (${selection.join(', ')}); só mexa fora dela se o pedido exigir.`
      : '- Não há seleção: o pedido vale para o documento; confira os frames antes de editar.',
    '- Em dúvida sobre ferramentas, estilos ou layout, leia get_guide (ex.: get_guide("getting-started")).',
    '- Depois de editar, confira o resultado com get_screenshot (quando houver render) e corrija com as ferramentas de edição.',
    '- Não chame undo nem redo: todas as suas alterações neste turno formam um único passo de desfazer, que o usuário aciona no editor.',
    '- Quando terminar, chame finish_working.',
    '- Responda em português do Brasil, curto: diga em 1 a 3 frases o que fez (sem repetir o código).',
  ];
  if (extra?.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 20) + '\n...(truncado)' : text;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: tempo esgotado`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class AssistantService implements AssistantServiceApi {
  private readonly list: AgentBackend[];
  private config: AssistantConfig = { backend: 'auto' };
  private readonly chats = new Map<string, DocChat>();
  private readonly turnsByDoc = new Map<string, Turn>();
  private readonly byToken = new Map<string, Turn>();
  private readonly listeners = new Set<(docId: string, event: AssistantEvent) => void>();
  private readonly texts = new Set<AbortController>();
  private closed = false;

  constructor(
    readonly store: DocumentStore,
    readonly opts: AssistantServiceOptions,
  ) {
    this.list = opts.backends ?? detectBackends();
    this.loadConfig();
  }

  /* ---------- configuração ---------- */

  private get configFile(): string | undefined {
    return this.opts.dataDir ? path.join(this.opts.dataDir, 'assistant.json') : undefined;
  }

  private loadConfig(): void {
    const file = this.configFile;
    if (!file) return;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        if (typeof r['backend'] === 'string' && r['backend']) this.config.backend = r['backend'];
        if (typeof r['model'] === 'string' && r['model']) this.config.model = r['model'];
      }
    } catch {
      /* sem arquivo ou inválido: padrão */
    }
  }

  private saveConfig(): void {
    const file = this.configFile;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
    } catch (e) {
      log('não foi possível gravar a configuração:', e instanceof Error ? e.message : e);
    }
  }

  getConfig(): AssistantConfig {
    return { ...this.config };
  }

  private async setConfig(patch: Partial<AssistantConfig>): Promise<void> {
    const next: AssistantConfig = { ...this.config };
    if (patch.backend !== undefined) {
      if (typeof patch.backend !== 'string' || !patch.backend)
        throw new Error('backend deve ser "auto" ou o id de um backend.');
      if (patch.backend !== 'auto' && !this.list.some((b) => b.id === patch.backend)) {
        throw new Error(
          `Backend desconhecido: ${patch.backend}. Use "auto" ou ${this.list.map((b) => b.id).join(', ')}.`,
        );
      }
      next.backend = patch.backend;
    }
    if (patch.model !== undefined) {
      const m = typeof patch.model === 'string' ? patch.model.trim() : '';
      if (m && !/^[\w.:/[\]-]+$/.test(m)) throw new Error(`Nome de modelo inválido: ${m}`);
      if (m) next.model = m;
      else delete next.model;
    }
    this.config = next;
    this.saveConfig();
  }

  /* ---------- backends ---------- */

  backends(): Promise<AssistantBackendInfo[]> {
    return Promise.all(this.list.map((b) => b.info()));
  }

  private async resolveBackend(requested?: string): Promise<AgentBackend> {
    const want = requested ?? this.config.backend;
    if (want === 'auto') {
      const infos: AssistantBackendInfo[] = [];
      for (const b of this.list) {
        const info = await b.info();
        if (info.available) return b;
        infos.push(info);
      }
      const why = infos.map((i) => `${i.name}: ${i.detail ?? 'indisponível'}`).join('\n');
      throw new Error(why ? `${NO_BACKEND}\n${why}` : NO_BACKEND);
    }
    const b = this.list.find((x) => x.id === want);
    if (!b) {
      throw new Error(
        `Backend desconhecido: ${want}. Disponíveis: ${this.list.map((x) => x.id).join(', ') || '(nenhum)'}.`,
      );
    }
    const info = await b.info();
    if (!info.available) {
      throw new Error(
        `${info.name} indisponível${info.detail ? `: ${info.detail}` : '.'}\n${NO_BACKEND}`,
      );
    }
    return b;
  }

  /* ---------- eventos ---------- */

  onEvent(fn: (docId: string, event: AssistantEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(docId: string, event: AssistantEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(docId, event);
      } catch (e) {
        log('erro num ouvinte de evento:', e instanceof Error ? e.message : e);
      }
    }
  }

  /* ---------- histórico ---------- */

  private sidecar(docId: string): string | null {
    try {
      const p = this.store.getInfo(docId).path;
      return p ? assistantSidecarPath(p) : null;
    } catch {
      return null;
    }
  }

  private chatOf(docId: string): DocChat {
    let c = this.chats.get(docId);
    if (!c) {
      c = { messages: [], sessions: {}, loadedFrom: null };
      this.chats.set(docId, c);
    }
    const file = this.sidecar(docId);
    if (file && c.loadedFrom !== file) {
      c.loadedFrom = file;
      if (c.messages.length === 0) {
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SidecarFile>;
          if (Array.isArray(raw.messages)) c.messages = raw.messages.slice(-MAX_HISTORY_MESSAGES);
          if (raw.sessions && typeof raw.sessions === 'object') c.sessions = { ...raw.sessions };
        } catch {
          /* sem arquivo lateral ou ilegível: histórico vazio */
        }
      }
    }
    return c;
  }

  private async persist(docId: string): Promise<void> {
    const file = this.sidecar(docId);
    const c = this.chats.get(docId);
    if (!file || !c) return;
    try {
      if (c.messages.length === 0 && Object.keys(c.sessions).length === 0) {
        await fs.promises.rm(file, { force: true });
        return;
      }
      const data: SidecarFile = {
        version: HISTORY_FILE_VERSION,
        messages: c.messages.slice(-MAX_HISTORY_MESSAGES),
        sessions: c.sessions,
      };
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (e) {
      log('não foi possível gravar o histórico do assistente:', e instanceof Error ? e.message : e);
    }
  }

  async history(docId: string): Promise<AssistantMessage[]> {
    this.store.getInfo(docId);
    const c = this.chatOf(docId);
    const out = [...c.messages];
    const t = this.turnsByDoc.get(docId);
    if (t) {
      // Turno em andamento: mensagem do usuário e o que o assistente já produziu.
      out.push(t.user, {
        id: `${t.id}-running`,
        role: 'assistant',
        text: t.text,
        at: t.user.at,
        turnId: t.id,
        status: 'running',
        tools: t.tools.map((x) => ({ ...x })),
        ...(t.backend ? { backend: t.backend.id } : {}),
      });
    }
    return out;
  }

  private async clear(docId: string): Promise<void> {
    this.store.getInfo(docId);
    if (this.turnsByDoc.has(docId)) {
      throw new Error(
        'Há um turno em andamento neste documento. Cancele-o antes de limpar a conversa.',
      );
    }
    const c = this.chatOf(docId);
    c.messages = [];
    c.sessions = {};
    await this.persist(docId);
    this.emit(docId, { kind: 'cleared' });
  }

  /* ---------- turnos ---------- */

  resolveTurn(token: string): TurnBinding | null {
    const t = this.byToken.get(token);
    return t ? { turnId: t.id, docId: t.docId, group: t.group } : null;
  }

  cancel(docId: string): boolean {
    const t = this.turnsByDoc.get(docId);
    if (!t) return false;
    t.controller.abort();
    return true;
  }

  async send(
    docId: string,
    prompt: string,
    opts: RunTurnOptions = {},
  ): Promise<{ turnId: string }> {
    const t = await this.start(docId, prompt, opts);
    return { turnId: t.id };
  }

  async runTurn(
    docId: string,
    prompt: string,
    opts: RunTurnOptions = {},
  ): Promise<AssistantMessage> {
    const t = await this.start(docId, prompt, opts);
    return t.result;
  }

  private async start(docId: string, prompt: string, opts: RunTurnOptions): Promise<Turn> {
    if (this.closed) throw new Error('O assistente foi encerrado.');
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new Error('Escreva um pedido para o assistente.');
    this.store.getInfo(docId); // 404 se o documento não existe
    if (this.turnsByDoc.has(docId)) {
      throw new Error(
        'Já existe um turno do assistente em andamento neste documento. Aguarde o fim ou cancele.',
      );
    }
    const id = `turn_${randomUUID().slice(0, 8)}`;
    const selection = (opts.selection ?? this.store.getSelection(docId)).filter(
      (s) => typeof s === 'string',
    );
    const user: AssistantMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'user',
      text: prompt,
      at: new Date().toISOString(),
      turnId: id,
      ...(selection.length ? { selection } : {}),
    };
    let finish!: (m: AssistantMessage) => void;
    const result = new Promise<AssistantMessage>((r) => (finish = r));
    const turn: Turn = {
      id,
      docId,
      token: randomBytes(16).toString('hex'),
      group: opts.group ?? `assistant:${id}`,
      ownGroup: opts.group === undefined,
      controller: new AbortController(),
      user,
      text: '',
      tools: [],
      result,
      active: false,
    };
    // Reserva o documento já (antes de qualquer await) para recusar um segundo `send` concorrente.
    this.turnsByDoc.set(docId, turn);
    try {
      turn.backend = await this.resolveBackend(opts.backend);
    } catch (e) {
      this.turnsByDoc.delete(docId);
      // Libera quem já esperava o turno (ex.: `close()` durante a resolução do backend).
      finish({ ...user, id: `${id}-erro`, role: 'assistant', text: '', status: 'error' });
      throw e;
    }
    this.byToken.set(turn.token, turn);
    turn.active = true;
    void this.execute(turn, prompt, selection, opts).then(finish);
    return turn;
  }

  private mcpUrl(token: string): string {
    const h = this.opts.host ?? '127.0.0.1';
    const host = h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h === '::1' ? '[::1]' : h;
    return `http://${host}:${this.opts.getPort()}/mcp?turn=${token}`;
  }

  /** Pasta de trabalho estável por documento (a CLI guarda a sessão por pasta; `--resume` precisa dela). */
  private cwdFor(key: string): string {
    return path.join(os.tmpdir(), 'mockup-studio-assistant', key.replace(/[^\w.-]/g, '_'));
  }

  /** Roda o turno inteiro; nunca rejeita. */
  private async execute(
    turn: Turn,
    prompt: string,
    selection: string[],
    opts: RunTurnOptions,
  ): Promise<AssistantMessage> {
    const { docId } = turn;
    const backend = turn.backend!;
    this.emit(docId, { kind: 'turn-start', turnId: turn.id, user: turn.user, backend: backend.id });
    let status: 'done' | 'cancelled' | 'error' = 'done';
    let error: string | undefined;
    let finalText = '';
    try {
      const signal = turn.controller.signal;
      if (signal.aborted)
        throw Object.assign(new Error('Turno cancelado.'), { name: 'AbortError' });
      const ctx = await this.buildContext(docId, selection, signal);
      if (signal.aborted)
        throw Object.assign(new Error('Turno cancelado.'), { name: 'AbortError' });
      const chat = this.chatOf(docId);
      const model = opts.backend ? undefined : this.config.model;
      const base: AgentRunInput = {
        prompt: '',
        system: systemPrompt(docId, ctx.selection, opts.instructions),
        images: ctx.images,
        mcp: { name: MCP_SERVER_NAME, url: this.mcpUrl(turn.token) },
        model,
        cwd: this.cwdFor(docId),
      };
      const handler = (ev: AgentRunEvent): void => this.onBackendEvent(turn, ev);
      const resumeId = chat.sessions[backend.id];
      const withPrompt = (resume: string | undefined): AgentRunInput => ({
        ...base,
        // Sem sessão para continuar, o histórico recente vai resumido no prompt.
        prompt: this.composePrompt(ctx.header, prompt, resume ? [] : chat.messages),
        resumeSession: resume,
      });
      let res;
      try {
        res = await backend.run(withPrompt(resumeId), handler, signal);
      } catch (e) {
        // Resume falhou antes de qualquer ferramenta: tenta de novo sem continuar a sessão.
        if (resumeId && !signal.aborted && !isAbortError(e) && turn.tools.length === 0) {
          log(
            `resume da sessão falhou (${e instanceof Error ? e.message : e}); tentando sem resume`,
          );
          delete chat.sessions[backend.id];
          res = await backend.run(withPrompt(undefined), handler, signal);
        } else {
          throw e;
        }
      }
      if (res.sessionId) turn.sessionId = res.sessionId;
      finalText = res.text?.trim() || turn.text.trim() || 'Pronto.';
    } catch (e) {
      if (turn.controller.signal.aborted || isAbortError(e)) {
        status = 'cancelled';
      } else {
        status = 'error';
        error = e instanceof Error ? e.message : String(e);
      }
      finalText = turn.text.trim();
    } finally {
      this.byToken.delete(turn.token);
      turn.active = false;
    }

    const opsCount = this.safe(() => this.store.groupOpsCount(docId, turn.group)) ?? 0;
    if (turn.ownGroup) {
      this.safe(() => this.store.closeGroup(docId, turn.group));
      this.safe(() => this.store.finishWorking(docId, []));
    }
    const message: AssistantMessage = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'assistant',
      text: finalText,
      at: new Date().toISOString(),
      turnId: turn.id,
      tools: turn.tools,
      status,
      ...(error ? { error } : {}),
      backend: backend.id,
      opsCount,
    };
    if (!opts.ephemeral) {
      const chat = this.chatOf(docId);
      chat.messages.push(turn.user, message);
      if (chat.messages.length > MAX_HISTORY_MESSAGES) {
        chat.messages = chat.messages.slice(-MAX_HISTORY_MESSAGES);
      }
      if (turn.sessionId) chat.sessions[backend.id] = turn.sessionId;
      await this.persist(docId);
    }
    this.turnsByDoc.delete(docId);
    this.emit(docId, { kind: 'turn-end', turnId: turn.id, message });
    return message;
  }

  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined; // ex.: o documento foi fechado durante o turno
    }
  }

  private onBackendEvent(turn: Turn, ev: AgentRunEvent): void {
    switch (ev.kind) {
      case 'text':
        turn.text += ev.text;
        this.emit(turn.docId, { kind: 'text', turnId: turn.id, text: ev.text });
        break;
      case 'tool': {
        const tool: AssistantToolCall = {
          id: ev.id,
          name: ev.name,
          ...(ev.input !== undefined ? { input: ev.input } : {}),
        };
        turn.tools.push(tool);
        this.emit(turn.docId, { kind: 'tool', turnId: turn.id, tool: { ...tool } });
        break;
      }
      case 'tool-result': {
        const t = turn.tools.find((x) => x.id === ev.id);
        if (t) {
          t.ok = ev.ok;
          if (ev.summary) t.summary = ev.summary;
        }
        this.emit(turn.docId, {
          kind: 'tool-result',
          turnId: turn.id,
          toolId: ev.id,
          ok: ev.ok,
          ...(ev.summary ? { summary: ev.summary } : {}),
        });
        break;
      }
      case 'session':
        turn.sessionId = ev.sessionId;
        break;
    }
  }

  /* ---------- contexto ---------- */

  private async buildContext(
    docId: string,
    selection: string[],
    signal: AbortSignal,
  ): Promise<{ header: string; selection: string[]; images: AgentImage[] }> {
    const doc: Document = this.store.get(docId);
    const valid = selection.filter((id) => findNode(doc, id));
    const lines = [`Documento: ${doc.name} (docId: ${docId})`];
    let body: string;
    if (valid.length) {
      lines.push(`Seleção: ${valid.join(', ')}`);
      const parts = valid.map((id) => getTreeSummary(findNode(doc, id)!.node, 3, { doc }));
      body = clip(parts.join('\n'), MAX_CONTEXT_CHARS);
    } else {
      lines.push('Seleção: (nenhuma)');
      body = clip(`Frames do documento:\n${getDocumentSummary(doc, 1)}`, MAX_CONTEXT_CHARS);
    }
    lines.push(body);

    const images: AgentImage[] = [];
    const render = this.opts.render;
    if (render && !signal.aborted) {
      const target = valid[0] ?? doc.pages.flatMap((p) => p.frames)[0]?.id;
      if (target) {
        try {
          const shot = await withTimeout(
            render.capture({
              doc,
              docId,
              nodeId: target,
              assetsDir: this.safe(() => this.store.assetsDir(docId)) ?? null,
              scale: 1,
              format: 'png',
              maxWidth: 1024,
            }),
            SCREENSHOT_TIMEOUT_MS,
            'screenshot',
          );
          images.push({ mime: shot.mime, data: shot.data.toString('base64') });
          lines.push(`(Screenshot anexo: ${target})`);
        } catch (e) {
          log('screenshot de contexto indisponível:', e instanceof Error ? e.message : e);
        }
      }
    }
    return { header: lines.join('\n'), selection: valid, images };
  }

  private composePrompt(header: string, prompt: string, previous: AssistantMessage[]): string {
    const parts = [header];
    const recent = previous.slice(-6);
    if (recent.length) {
      parts.push(
        'Conversa anterior (resumo):\n' +
          recent
            .map((m) => `- ${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${clip(m.text, 300)}`)
            .join('\n'),
      );
    }
    parts.push(`Pedido do usuário:\n${prompt}`);
    return parts.join('\n\n');
  }

  /* ---------- texto puro ---------- */

  async generateText(
    prompt: string,
    opts: { backend?: string; system?: string } = {},
  ): Promise<string> {
    if (this.closed) throw new Error('O assistente foi encerrado.');
    const backend = await this.resolveBackend(opts.backend);
    const controller = new AbortController();
    this.texts.add(controller);
    let streamed = '';
    try {
      const res = await backend.run(
        {
          prompt,
          system: opts.system ?? SYSTEM_TEXT_ONLY,
          model: opts.backend ? undefined : this.config.model,
          cwd: this.cwdFor('_texto'),
        },
        (ev) => {
          if (ev.kind === 'text') streamed += ev.text;
        },
        controller.signal,
      );
      const text = (res.text || streamed).trim();
      if (!text) throw new Error('O agente não devolveu texto.');
      return text;
    } finally {
      this.texts.delete(controller);
    }
  }

  /* ---------- mensagens WS ---------- */

  async handle(msg: ClientMessage): Promise<unknown> {
    switch (msg.type) {
      case 'assistant:send': {
        if (typeof msg.docId !== 'string' || !msg.docId)
          throw new Error('assistant:send exige "docId" (string).');
        if (typeof msg.prompt !== 'string' || !msg.prompt.trim())
          throw new Error('assistant:send exige "prompt" (texto não vazio).');
        if (msg.selection !== undefined && !Array.isArray(msg.selection))
          throw new Error('"selection" deve ser uma lista de ids.');
        return this.send(msg.docId, msg.prompt, {
          selection: msg.selection,
          backend: typeof msg.backend === 'string' && msg.backend ? msg.backend : undefined,
        });
      }
      case 'assistant:cancel':
        return { cancelled: this.cancel(msg.docId) };
      case 'assistant:history': {
        const [messages, backends] = await Promise.all([this.history(msg.docId), this.backends()]);
        return {
          messages,
          running: this.turnsByDoc.get(msg.docId)?.id ?? null,
          backends,
          config: this.getConfig(),
        };
      }
      case 'assistant:clear':
        await this.clear(msg.docId);
        return {};
      case 'assistant:config': {
        if (msg.config) await this.setConfig(msg.config);
        return { config: this.getConfig(), backends: await this.backends() };
      }
      default:
        throw new Error(`Mensagem do assistente desconhecida: ${(msg as { type: string }).type}`);
    }
  }

  /* ---------- encerramento ---------- */

  async close(): Promise<void> {
    this.closed = true;
    for (const c of this.texts) c.abort();
    const turns = [...this.turnsByDoc.values()];
    for (const t of turns) t.controller.abort();
    await Promise.allSettled(turns.map((t) => t.result));
  }
}
