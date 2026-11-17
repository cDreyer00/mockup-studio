/* global process, fetch, console, setTimeout, Buffer */
/**
 * Fake CLI that mimics `claude -p --input-format stream-json --output-format stream-json` for the
 * assistant tests. Reads the user message from stdin and runs the `@@...` commands it finds in
 * the text, really talking to the daemon MCP (URL and token from `--mcp-config`).
 *
 * Commands (one per line):
 *   @@rename <nodeId> <name>          rename_nodes
 *   @@style <nodeId> <prop> <value>   update_styles
 *   @@undo                            calls `undo` (must be rejected inside a turn)
 *   @@sleep <ms>                      waits
 *   @@text <message>                 emits a text
 *   @@echo                            returns the prompt, the system prompt, the MCP URL, the resume and the args
 *   @@fail <message>                 ends with an error (is_error) and exit code 1
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('--version')) {
  console.log('0.0.0-fake (fake CLI)');
  process.exit(0);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- minimal MCP client (Streamable HTTP) ---------- */

async function rpc(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !text) throw new Error(`MCP HTTP ${res.status}`);
  let msg;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const j = JSON.parse(line.slice(5).trim());
      if (j.id === body.id) msg = j;
    }
  } else if (text) {
    msg = JSON.parse(text);
  }
  return { res, msg };
}

async function openMcp(url) {
  const init = await rpc(
    url,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fake-agent-cli', version: '0.0.0' },
      },
    },
    {},
  );
  if (init.msg?.error) throw new Error(init.msg.error.message);
  const sid = init.res.headers.get('mcp-session-id');
  if (!sid) throw new Error(`MCP refused the session (HTTP ${init.res.status})`);
  const headers = { 'mcp-session-id': sid };
  await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  let n = 1;
  return async (name, args) => {
    const { msg } = await rpc(
      url,
      { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } },
      headers,
    );
    if (msg?.error) return { isError: true, text: msg.error.message };
    const text = (msg?.result?.content ?? []).map((c) => c.text ?? '').join('\n');
    return { isError: msg?.result?.isError === true, text };
  };
}

/* ---------- turn ---------- */

const raw = (await readStdin()).split('\n')[0] ?? '';
let userText = '';
let images = 0;
try {
  const m = JSON.parse(raw);
  for (const b of m.message?.content ?? []) {
    if (b.type === 'text') userText += b.text + '\n';
    if (b.type === 'image') images++;
  }
} catch {
  userText = raw;
}

const resume =
  arg('--resume') ?? argv.find((a) => a.startsWith('--resume='))?.slice('--resume='.length);
const sessionId = resume ?? `fake-${Math.random().toString(16).slice(2, 10)}`;
const cfgFile = arg('--mcp-config');
const sysFile = arg('--append-system-prompt-file');
let mcpUrl;
if (cfgFile) {
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  mcpUrl = Object.values(cfg.mcpServers ?? {})[0]?.url;
}
const system = sysFile ? fs.readFileSync(sysFile, 'utf8') : '';
const docId = /docId: (\S+?)\)/.exec(userText)?.[1];

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  tools: mcpUrl ? ['mcp__mockup-studio__rename_nodes'] : [],
  mcp_servers: mcpUrl ? [{ name: 'mockup-studio', status: 'connected' }] : [],
});

let counter = 0;
const textMsg = (text) =>
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

let call;
async function tool(name, input) {
  if (!mcpUrl) throw new Error('no MCP configured in this turn');
  call ??= await openMcp(mcpUrl);
  const id = `toolu_${++counter}`;
  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: `mcp__mockup-studio__${name}`, input }],
    },
  });
  const r = await call(name, input);
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: r.text, is_error: r.isError }],
    },
  });
  return r;
}

const finalTexts = [];
const lines = userText.split(/\r?\n/).filter((l) => l.startsWith('@@'));
try {
  for (const line of lines) {
    const [cmd, ...rest] = line.slice(2).trim().split(/\s+/);
    if (cmd === 'rename') {
      const [nodeId, ...name] = rest;
      await tool('rename_nodes', { docId, nodeIds: [nodeId], names: [name.join(' ')] });
    } else if (cmd === 'style') {
      const [nodeId, prop, ...value] = rest;
      await tool('update_styles', {
        docId,
        nodeIds: [nodeId],
        styles: { [prop]: value.join(' ') },
      });
    } else if (cmd === 'undo') {
      const r = await tool('undo', { docId });
      finalTexts.push(`undo: ${r.isError ? 'rejected' : 'accepted'}`);
    } else if (cmd === 'sleep') {
      await new Promise((r) => setTimeout(r, Number(rest[0]) || 0));
    } else if (cmd === 'text') {
      const t = rest.join(' ');
      textMsg(t);
      finalTexts.push(t);
    } else if (cmd === 'echo') {
      const t = [
        `ECHO-PROMPT:\n${userText}`,
        `ECHO-SYSTEM:\n${system}`,
        `ECHO-MCP: ${mcpUrl ?? '(no mcp)'}`,
        `ECHO-RESUME: ${resume ?? '(none)'}`,
        `ECHO-ARGS: ${JSON.stringify(argv)}`,
        `ECHO-IMAGES: ${images}`,
      ].join('\n');
      textMsg(t);
      finalTexts.push(t);
    } else if (cmd === 'fail') {
      const message = rest.join(' ') || 'failed';
      console.error(`fake stderr: ${message}`);
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: message,
        session_id: sessionId,
      });
      process.exit(1);
    }
  }
} catch (e) {
  emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: e instanceof Error ? e.message : String(e),
    session_id: sessionId,
  });
  process.exit(1);
}

const finalText = finalTexts.length ? finalTexts.join('\n') : 'Done.';
if (!finalTexts.length) textMsg(finalText);
emit({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: finalText,
  session_id: sessionId,
  total_cost_usd: 0,
});
