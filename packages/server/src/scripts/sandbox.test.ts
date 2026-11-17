import { describe, expect, it } from 'vitest';
import { SANDBOX_LIMITS, runInSandbox, type SandboxHandler } from './sandbox.js';

/** Handler mínimo: só o que os testes de sandbox usam. Registra as chamadas. */
function makeHandler(calls: string[] = []): SandboxHandler {
  return (method, args) => {
    calls.push(method);
    if (method === 'docInfo') return { id: 'doc_x', name: 'Doc' };
    if (method === 'apply') throw new Error('Operação #1 (x) falhou: tipo desconhecido');
    if (method === 'slow') return new Promise((r) => setTimeout(() => r('lento'), 50));
    return args;
  };
}

const run = (code: string, timeoutMs = 5000, calls?: string[]) =>
  runInSandbox(code, makeHandler(calls), { timeoutMs });

describe('sandbox: execução básica', () => {
  it('devolve o return em JSON e usa a API do documento por RPC síncrono', async () => {
    const r = await run('return { id: doc.id, nome: doc.name, soma: 1 + 2 };');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toEqual({ id: 'doc_x', nome: 'Doc', soma: 3 });
  });

  it('permite await e várias chamadas em sequência', async () => {
    const calls: string[] = [];
    const r = await run(
      'let n = 0; for (let i = 0; i < 20; i++) { await null; doc.id; n++; } return n;',
      5000,
      calls,
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe(20);
    expect(calls.filter((c) => c === 'docInfo')).toHaveLength(20);
  });

  it('espera handlers assíncronos do thread principal', async () => {
    const r = await runInSandbox('return doc.tokens();', async (m) =>
      m === 'tokens' ? { a: 1 } : null,
    );
    expect(JSON.parse(r.resultJson!)).toEqual({ a: 1 });
    const slow = await runInSandbox(
      'return doc.pages();',
      () => new Promise((resolve) => setTimeout(() => resolve('depois'), 80)),
    );
    expect(JSON.parse(slow.resultJson!)).toBe('depois');
  });

  it('console coleta linhas; objetos viram JSON; ausência de return não gera resultado', async () => {
    const r = await run(
      'console.log("a", { x: 1 }); console.warn("b"); console.error(new Map([[1, 2]])); console.info(1n);',
    );
    expect(r.ok).toBe(true);
    expect(r.resultJson).toBeUndefined();
    expect(r.logs).toEqual(['a {"x":1}', '[warn] b', '[error] {"map":[[1,2]]}', '1']);
  });

  it('valores não serializáveis viram string e referências circulares não quebram', async () => {
    const r = await run('const a = {}; a.a = a; return [() => 1, Symbol("s"), 2n, a];');
    expect(r.ok).toBe(true);
    expect(typeof r.resultJson).toBe('string');
    const c = await run('const a = {}; a.a = a; console.log(a); return a;');
    expect(c.ok).toBe(true);
    expect(c.logs[0]).toBe('[object Object]');
  });

  it('erros do script voltam com a linha; erro da ponte vira Error do próprio script', async () => {
    const r = await run('\n\nthrow new TypeError("quebrou");');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('TypeError: quebrou (linha 3)');
    const b = await run('doc.apply({ type: "x" });');
    expect(b.ok).toBe(false);
    expect(b.error).toContain('tipo desconhecido');
    const s = await run('let x = ;');
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/^Erro de sintaxe: /);
  });

  it('mantém os logs coletados quando o script falha', async () => {
    const r = await run('console.log("antes"); throw new Error("depois");');
    expect(r.logs).toEqual(['antes']);
    expect(r.error).toBe('depois (linha 1)');
  });

  it('script sem resultado (promessa que nunca resolve) termina com mensagem clara', async () => {
    const r = await run('await new Promise(() => {});');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('terminou sem devolver um resultado');
  });

  it('promessa rejeitada e esquecida não derruba a execução', async () => {
    const r = await run('Promise.reject(new Error("solta")); await null; return 5;');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe(5);
    const late = await run(
      'Promise.resolve().then(() => { throw new Error("tarde"); }); return 6;',
    );
    expect(late.ok).toBe(true);
  });

  it('limita linhas de log', async () => {
    const r = await run('for (let i = 0; i < 2000; i++) console.log(i); return 1;');
    expect(r.ok).toBe(true);
    expect(r.logs.length).toBeLessThanOrEqual(SANDBOX_LIMITS.maxLogLines + 1);
    expect(r.logs.at(-1)).toContain('logs truncados');
  });
});

describe('sandbox: fuga e abuso', () => {
  // Cada tentativa deve falhar (ok:false) sem efeito colateral; depois um script normal ainda roda.
  const escapes: Record<string, string> = {
    process: 'return process.pid;',
    require: 'return require("node:fs").readdirSync(".");',
    'globalThis.process': 'return globalThis.process.pid;',
    'this.constructor.constructor': 'return this.constructor.constructor("return process")();',
    'globalThis.constructor.constructor':
      'return globalThis.constructor.constructor("return process")().pid;',
    'doc.select.constructor.constructor':
      'return doc.select.constructor.constructor("return process")().pid;',
    'Function(...)': 'return Function("return process")().pid;',
    AsyncFunction: 'return (async () => {}).constructor("return process")();',
    'eval(...)': 'return eval("1");',
    'import()': 'const fs = await import("node:fs"); return fs.readdirSync(".");',
    'import() com comentário': 'return await import /* x */ ("node:fs");',
    'erro da ponte':
      'try { doc.apply({ type: "x" }); } catch (e) { return e.constructor.constructor("return process")().pid; }',
    'erro da ponte (name/prototype)':
      'try { doc.apply({ type: "x" }); } catch (e) { return Object.getPrototypeOf(e).constructor.constructor("return process")().pid; }',
    'prepareStackTrace com callsites': `
      Error.prepareStackTrace = (_e, sites) => sites.map((s) => s.getThis() ?? s.getFunction());
      const alvo = new Error().stack;
      return alvo.map((f) => f && f.constructor && f.constructor.constructor("return process")().pid);`,
    'defineProperty em prepareStackTrace': `
      Object.defineProperty(Error, "prepareStackTrace", { value: (_e, s) => s.map((x) => x.getFunction()) });
      return new Error().stack;`,
    captureStackTrace: `
      const o = {}; Error.prepareStackTrace = (_e, s) => s; Error.captureStackTrace(o);
      return o.stack[0].getFunction().constructor.constructor("return process")().pid;`,
    'protótipos da API até um objeto do host': `
      let o = doc; const vistos = [];
      while (o) { vistos.push(o); o = Object.getPrototypeOf(o); }
      const f = Object.getOwnPropertyDescriptor(doc, "select").value;
      return f.constructor.constructor("return process")().pid;`,
    'Reflect/Proxy sobre a API': `
      const p = new Proxy(doc, {});
      return Reflect.getPrototypeOf(p.select).constructor.constructor("return process")().pid;`,
    'WebAssembly.compile':
      'return await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
    'WebAssembly.Module':
      'return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
    SharedArrayBuffer: 'return new SharedArrayBuffer(8).byteLength;',
    'array tipado gigante (fora do heap)':
      'const a = new Uint8Array(1e9); a.fill(1); return a.length;',
    'ArrayBuffer gigante': 'return new ArrayBuffer(2 ** 30).byteLength;',
    DataView: 'return new DataView(new ArrayBuffer(8)).byteLength;',
    Atomics: 'return Atomics.wait(new Int32Array(1), 0, 0, 10);',
    'sobrescrever doc': 'doc = {}; return 1;',
    'sobrescrever console': 'console.log = () => 1; return 1;',
    'alterar a API congelada': 'doc.select = () => []; return 1;',
  };

  for (const [nome, code] of Object.entries(escapes)) {
    it(`bloqueia: ${nome}`, async () => {
      const calls: string[] = [];
      const r = await run(code, 5000, calls);
      expect(r.ok, `resultado: ${r.resultJson} / erro: ${r.error}`).toBe(false);
      expect(r.error).toBeTruthy();
      // nenhuma escrita saiu da sandbox (exceto nos casos que usam a ponte de propósito)
      if (!nome.startsWith('erro da ponte')) expect(calls).not.toContain('apply');
      // o daemon (processo de testes) continua de pé e a sandbox, utilizável
      const ok = await run('return 1 + 1;');
      expect(ok.ok).toBe(true);
      expect(JSON.parse(ok.resultJson!)).toBe(2);
    });
  }

  it('não existe nenhum global do Node no contexto', async () => {
    const r = await run(`
      const nomes = ["process", "require", "module", "Buffer", "setTimeout", "setInterval",
        "setImmediate", "queueMicrotask", "fetch", "WebAssembly", "SharedArrayBuffer", "Atomics",
        "structuredClone", "URL", "TextEncoder", "global", "performance", "eval", "WeakRef",
        "ArrayBuffer", "Uint8Array", "Float64Array", "DataView", "BigInt64Array"];
      return nomes.filter((n) => typeof globalThis[n] !== "undefined");`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toEqual([]);
  });

  it('while(true) é interrompido pelo timeout e o daemon segue de pé', async () => {
    const t0 = Date.now();
    const r = await run('console.log("começou"); while (true) {}', 300);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain('tempo limite');
    expect(r.logs).toEqual(['começou']);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await run('return 7;')).ok).toBe(true);
  });

  it('laço infinito depois de await também é interrompido', async () => {
    const r = await run('await null; await doc.tokens(); for (;;) {}', 300);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect((await run('return 7;')).ok).toBe(true);
  });

  it('laço infinito de chamadas à API é interrompido', async () => {
    const r = await run('for (;;) { doc.id; }', 400);
    expect(r.timedOut).toBe(true);
  });

  it('regex catastrófico é interrompido pelo timeout', async () => {
    const r = await run('return /^(a+)+$/.test("a".repeat(60) + "!");', 300);
    expect(r.timedOut).toBe(true);
  });

  it('o timeout vale também enquanto o thread principal espera um handler lento', async () => {
    const r = await runInSandbox('doc.pages(); return 1;', () => new Promise(() => {}), {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
  });

  it('estouro de memória vira erro legível', async () => {
    const r = await run('const a = []; for (;;) a.push(new Array(100000).fill(1));', 20_000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.error).toContain('limite de memória');
    expect((await run('return 3;')).ok).toBe(true);
  });

  it('string que cresce sem parar também estoura a memória, não o daemon', async () => {
    const r = await run('let s = "x"; for (;;) s += s + Math.random();', 20_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/memória|tempo limite|Invalid string length/);
  });

  it('retorno gigante é recusado', async () => {
    const r = await run('return "x".repeat(5_000_000);');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('grande demais');
    expect(r.resultJson).toBeUndefined();
  });

  it('recusa o texto "import" e código gigante sem subir worker', async () => {
    const a = await run('// import tudo\nreturn 1;');
    expect(a.ok).toBe(false);
    expect(a.error).toContain('import');
    const b = await run('return "' + 'x'.repeat(SANDBOX_LIMITS.maxCodeChars) + '";');
    expect(b.ok).toBe(false);
    expect(b.error).toContain('grande demais');
  });

  it('recursão infinita vira erro do script (sem derrubar o worker)', async () => {
    const r = await run('function f() { return f() + 1; } return f();');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('RangeError');
  });

  it('recursão infinita passando pela ponte não vaza erro do host', async () => {
    const r = await run(`
      let achou = null;
      function f(n) {
        try { doc.id; } catch (e) { achou = e; }
        return f(n + 1);
      }
      try { f(0); } catch (e) { /* estouro de pilha */ }
      return achou === null ? "sem erro" : achou.constructor.constructor("return process")().pid;`);
    // com ou sem erro capturado, nunca devolve o pid do processo
    if (r.ok) expect(r.resultJson).toBe('"sem erro"');
    else expect(r.error).toBeTruthy();
  });

  it('adulterar builtins do próprio contexto não afeta a ponte', async () => {
    const r = await run(`
      JSON.parse = () => ({ ok: true, value: "forjado" });
      JSON.stringify = () => "forjado";
      Object.prototype.ok = true;
      Object.prototype.value = "forjado";
      return doc.id;`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe('doc_x');
  });

  it('execuções simultâneas são independentes', async () => {
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(`await doc.tokens(); return ${i};`)),
    );
    expect(all.map((r) => JSON.parse(r.resultJson!))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
