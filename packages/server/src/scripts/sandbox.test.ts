import { describe, expect, it } from 'vitest';
import { SANDBOX_LIMITS, runInSandbox, type SandboxHandler } from './sandbox.js';

/** Minimal handler: only what the sandbox tests use. Records the calls. */
function makeHandler(calls: string[] = []): SandboxHandler {
  return (method, args) => {
    calls.push(method);
    if (method === 'docInfo') return { id: 'doc_x', name: 'Doc' };
    if (method === 'apply') throw new Error('Operation #1 (x) failed: unknown type');
    if (method === 'slow') return new Promise((r) => setTimeout(() => r('slow'), 50));
    return args;
  };
}

const run = (code: string, timeoutMs = 5000, calls?: string[]) =>
  runInSandbox(code, makeHandler(calls), { timeoutMs });

describe('sandbox: basic execution', () => {
  it('returns the return value as JSON and uses the document API over synchronous RPC', async () => {
    const r = await run('return { id: doc.id, name: doc.name, sum: 1 + 2 };');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toEqual({ id: 'doc_x', name: 'Doc', sum: 3 });
  });

  it('allows await and several calls in sequence', async () => {
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

  it('waits for async handlers on the main thread', async () => {
    const r = await runInSandbox('return doc.tokens();', async (m) =>
      m === 'tokens' ? { a: 1 } : null,
    );
    expect(JSON.parse(r.resultJson!)).toEqual({ a: 1 });
    const slow = await runInSandbox(
      'return doc.pages();',
      () => new Promise((resolve) => setTimeout(() => resolve('later'), 80)),
    );
    expect(JSON.parse(slow.resultJson!)).toBe('later');
  });

  it('console collects lines; objects become JSON; no return produces no result', async () => {
    const r = await run(
      'console.log("a", { x: 1 }); console.warn("b"); console.error(new Map([[1, 2]])); console.info(1n);',
    );
    expect(r.ok).toBe(true);
    expect(r.resultJson).toBeUndefined();
    expect(r.logs).toEqual(['a {"x":1}', '[warn] b', '[error] {"map":[[1,2]]}', '1']);
  });

  it('non-serializable values become strings and circular references do not break', async () => {
    const r = await run('const a = {}; a.a = a; return [() => 1, Symbol("s"), 2n, a];');
    expect(r.ok).toBe(true);
    expect(typeof r.resultJson).toBe('string');
    const c = await run('const a = {}; a.a = a; console.log(a); return a;');
    expect(c.ok).toBe(true);
    expect(c.logs[0]).toBe('[object Object]');
  });

  it('script errors come back with the line; a bridge error becomes an Error of the script itself', async () => {
    const r = await run('\n\nthrow new TypeError("broke");');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('TypeError: broke (line 3)');
    const b = await run('doc.apply({ type: "x" });');
    expect(b.ok).toBe(false);
    expect(b.error).toContain('unknown type');
    const s = await run('let x = ;');
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/^Syntax error: /);
  });

  it('keeps the collected logs when the script fails', async () => {
    const r = await run('console.log("before"); throw new Error("after");');
    expect(r.logs).toEqual(['before']);
    expect(r.error).toBe('after (line 1)');
  });

  it('a script with no result (a promise that never resolves) ends with a clear message', async () => {
    const r = await run('await new Promise(() => {});');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ended without returning a result');
  });

  it('a rejected, forgotten promise does not bring down the run', async () => {
    const r = await run('Promise.reject(new Error("loose")); await null; return 5;');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe(5);
    const late = await run('Promise.resolve().then(() => { throw new Error("late"); }); return 6;');
    expect(late.ok).toBe(true);
  });

  it('limits log lines', async () => {
    const r = await run('for (let i = 0; i < 2000; i++) console.log(i); return 1;');
    expect(r.ok).toBe(true);
    expect(r.logs.length).toBeLessThanOrEqual(SANDBOX_LIMITS.maxLogLines + 1);
    expect(r.logs.at(-1)).toContain('logs truncated');
  });
});

describe('sandbox: escape and abuse', () => {
  // Each attempt must fail (ok:false) with no side effect; afterwards a normal script still runs.
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
    'import() with comment': 'return await import /* x */ ("node:fs");',
    'bridge error':
      'try { doc.apply({ type: "x" }); } catch (e) { return e.constructor.constructor("return process")().pid; }',
    'bridge error (name/prototype)':
      'try { doc.apply({ type: "x" }); } catch (e) { return Object.getPrototypeOf(e).constructor.constructor("return process")().pid; }',
    'prepareStackTrace with callsites': `
      Error.prepareStackTrace = (_e, sites) => sites.map((s) => s.getThis() ?? s.getFunction());
      const target = new Error().stack;
      return target.map((f) => f && f.constructor && f.constructor.constructor("return process")().pid);`,
    'defineProperty on prepareStackTrace': `
      Object.defineProperty(Error, "prepareStackTrace", { value: (_e, s) => s.map((x) => x.getFunction()) });
      return new Error().stack;`,
    captureStackTrace: `
      const o = {}; Error.prepareStackTrace = (_e, s) => s; Error.captureStackTrace(o);
      return o.stack[0].getFunction().constructor.constructor("return process")().pid;`,
    'API prototypes up to a host object': `
      let o = doc; const seen = [];
      while (o) { seen.push(o); o = Object.getPrototypeOf(o); }
      const f = Object.getOwnPropertyDescriptor(doc, "select").value;
      return f.constructor.constructor("return process")().pid;`,
    'Reflect/Proxy over the API': `
      const p = new Proxy(doc, {});
      return Reflect.getPrototypeOf(p.select).constructor.constructor("return process")().pid;`,
    'WebAssembly.compile':
      'return await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
    'WebAssembly.Module':
      'return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
    SharedArrayBuffer: 'return new SharedArrayBuffer(8).byteLength;',
    'huge typed array (outside the heap)':
      'const a = new Uint8Array(1e9); a.fill(1); return a.length;',
    'huge ArrayBuffer': 'return new ArrayBuffer(2 ** 30).byteLength;',
    DataView: 'return new DataView(new ArrayBuffer(8)).byteLength;',
    Atomics: 'return Atomics.wait(new Int32Array(1), 0, 0, 10);',
    'overwrite doc': 'doc = {}; return 1;',
    'overwrite console': 'console.log = () => 1; return 1;',
    'modify the frozen API': 'doc.select = () => []; return 1;',
  };

  for (const [name, code] of Object.entries(escapes)) {
    it(`blocks: ${name}`, async () => {
      const calls: string[] = [];
      const r = await run(code, 5000, calls);
      expect(r.ok, `result: ${r.resultJson} / error: ${r.error}`).toBe(false);
      expect(r.error).toBeTruthy();
      // no write left the sandbox (except in the cases that use the bridge on purpose)
      if (!name.startsWith('bridge error')) expect(calls).not.toContain('apply');
      // the daemon (test process) is still up and the sandbox is still usable
      const ok = await run('return 1 + 1;');
      expect(ok.ok).toBe(true);
      expect(JSON.parse(ok.resultJson!)).toBe(2);
    });
  }

  it('no Node global exists in the context', async () => {
    const r = await run(`
      const names = ["process", "require", "module", "Buffer", "setTimeout", "setInterval",
        "setImmediate", "queueMicrotask", "fetch", "WebAssembly", "SharedArrayBuffer", "Atomics",
        "structuredClone", "URL", "TextEncoder", "global", "performance", "eval", "WeakRef",
        "ArrayBuffer", "Uint8Array", "Float64Array", "DataView", "BigInt64Array"];
      return names.filter((n) => typeof globalThis[n] !== "undefined");`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toEqual([]);
  });

  it('while(true) is interrupted by the timeout and the daemon stays up', async () => {
    const t0 = Date.now();
    const r = await run('console.log("started"); while (true) {}', 300);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain('time limit');
    expect(r.logs).toEqual(['started']);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await run('return 7;')).ok).toBe(true);
  });

  it('an infinite loop after await is also interrupted', async () => {
    const r = await run('await null; await doc.tokens(); for (;;) {}', 300);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect((await run('return 7;')).ok).toBe(true);
  });

  it('an infinite loop of API calls is interrupted', async () => {
    const r = await run('for (;;) { doc.id; }', 400);
    expect(r.timedOut).toBe(true);
  });

  it('a catastrophic regex is interrupted by the timeout', async () => {
    const r = await run('return /^(a+)+$/.test("a".repeat(60) + "!");', 300);
    expect(r.timedOut).toBe(true);
  });

  it('the timeout also applies while the main thread waits for a slow handler', async () => {
    const r = await runInSandbox('doc.pages(); return 1;', () => new Promise(() => {}), {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
  });

  it('memory overflow becomes a readable error', async () => {
    const r = await run('const a = []; for (;;) a.push(new Array(100000).fill(1));', 20_000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.error).toContain('memory limit');
    expect((await run('return 3;')).ok).toBe(true);
  });

  it('a string that grows endlessly also overflows memory, not the daemon', async () => {
    const r = await run('let s = "x"; for (;;) s += s + Math.random();', 20_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/memory|time limit|Invalid string length/);
  });

  it('a huge return value is rejected', async () => {
    const r = await run('return "x".repeat(5_000_000);');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('too large');
    expect(r.resultJson).toBeUndefined();
  });

  it('rejects the text "import" and huge code without starting a worker', async () => {
    const a = await run('// import everything\nreturn 1;');
    expect(a.ok).toBe(false);
    expect(a.error).toContain('import');
    const b = await run('return "' + 'x'.repeat(SANDBOX_LIMITS.maxCodeChars) + '";');
    expect(b.ok).toBe(false);
    expect(b.error).toContain('too large');
  });

  it('infinite recursion becomes a script error (without bringing down the worker)', async () => {
    const r = await run('function f() { return f() + 1; } return f();');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('RangeError');
  });

  it('infinite recursion through the bridge does not leak a host error', async () => {
    const r = await run(`
      let found = null;
      function f(n) {
        try { doc.id; } catch (e) { found = e; }
        return f(n + 1);
      }
      try { f(0); } catch (e) { /* stack overflow */ }
      return found === null ? "no error" : found.constructor.constructor("return process")().pid;`);
    // with or without a caught error, it never returns the process pid
    if (r.ok) expect(r.resultJson).toBe('"no error"');
    else expect(r.error).toBeTruthy();
  });

  it("tampering with the context's own builtins does not affect the bridge", async () => {
    const r = await run(`
      JSON.parse = () => ({ ok: true, value: "forged" });
      JSON.stringify = () => "forged";
      Object.prototype.ok = true;
      Object.prototype.value = "forged";
      return doc.id;`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe('doc_x');
  });

  it('concurrent runs are independent', async () => {
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) => run(`await doc.tokens(); return ${i};`)),
    );
    expect(all.map((r) => JSON.parse(r.resultJson!))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('sandbox: script body and locked globals', () => {
  it('a "})" that closes the wrapper is a syntax error and nothing runs', async () => {
    const calls: string[] = [];
    const r = await run('}); globalThis.x = 1; doc.id; (async function(){', 5000, calls);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Syntax error');
    expect(calls).toEqual([]);
  });

  it('wrapper escape variants (comma, line comment, template) also fail', async () => {
    const variants = [
      '}), (doc.id, async function(){',
      '}); doc.id; (async function(){ //',
      '} doc.id; (async function(){',
      '}); doc.id; (async () => {',
      'return 1; }) + (function(){',
    ];
    for (const code of variants) {
      const calls: string[] = [];
      const r = await run(code, 5000, calls);
      expect(r.ok, code).toBe(false);
      expect(r.error, code).toContain('Syntax error');
      expect(calls, code).toEqual([]);
    }
  });

  it('"})" inside a comment, string, template and regex keeps working', async () => {
    const r = await run(`
      /* }) */
      // }); (async function(){
      const a = "})";
      const b = '}); (async function(){';
      const c = \`\${a}})\`;
      const d = /\\}\\)/.test("})");
      return [a, b, c, d];`);
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.resultJson!)).toEqual(['})', '}); (async function(){', '})})', true]);
  });

  it('top-level await, return and a trailing comment without a line break remain valid', async () => {
    const r = await run('const x = await doc.tokens(); return 5; // end');
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toBe(5);
  });

  it('a common syntax error still includes the line', async () => {
    const r = await run('const a = 1;\nlet = = 2;');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Syntax error');
    expect(r.error).toContain('line 2');
  });

  it('"sloppy" code does not exist: with, arguments.callee and global this fail', async () => {
    for (const code of [
      'with ({}) { return 1; }',
      'return arguments.callee.caller;',
      'return (function () { return this; })() === undefined ? "strict" : "sloppy";',
    ]) {
      const r = await run(code);
      if (code.startsWith('return (function')) {
        expect(JSON.parse(r.resultJson!)).toBe('strict');
      } else {
        expect(r.ok, code).toBe(false);
      }
    }
    // the wrapper escape cannot run non-strict code to reach arguments.callee.caller
    const calls: string[] = [];
    const r = await run(
      '}); (function(){ return arguments.callee.caller; })(); doc.id; (async function(){',
      5000,
      calls,
    );
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('globalThis.Error cannot be replaced, redefined or deleted', async () => {
    for (const code of [
      'globalThis.Error = function () {}; return 1;',
      'Error = function () {}; return 1;',
      'Object.defineProperty(globalThis, "Error", { value: function () {} }); return 1;',
      'delete globalThis.Error; return 1;',
      'globalThis.TypeError = function () {}; return 1;',
      'globalThis.Promise = function () {}; return 1;',
      'globalThis.JSON = {}; return 1;',
      'globalThis.Object = function () {}; return 1;',
      'globalThis.Proxy = function () {}; return 1;',
      'globalThis.Reflect = {}; return 1;',
      'globalThis.Array = function () {}; return 1;',
    ]) {
      const r = await run(code);
      expect(r.ok, code).toBe(false);
      expect(r.error, code).toMatch(/TypeError|read only|Cannot|not configurable/);
      expect((await run('return 1;')).ok).toBe(true);
    }
  });

  it('API errors are still instances of the original Error', async () => {
    const r = await run(`
      const E = Error;
      try { globalThis.Error = function () {}; } catch (_e) { /* locked */ }
      try { doc.apply({ type: "x" }); } catch (e) { return [e instanceof E, e instanceof Error, e.constructor === E]; }`);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.resultJson!)).toEqual([true, true, true]);
  });
});

describe('sandbox: cancellation (signal and watchdog)', () => {
  it('an aborted signal during while(true) ends quickly with ok:false', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await runInSandbox('console.log("x"); while (true) {}', makeHandler(), {
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.error).toContain('cancelled');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await run('return 7;')).ok).toBe(true);
  });

  it('an already-aborted signal does not start a worker', async () => {
    const calls: string[] = [];
    const r = await runInSandbox('doc.id; return 1;', makeHandler(calls), {
      signal: AbortSignal.abort(),
    });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(calls).toEqual([]);
  });

  it('the watchdog stops a loop with no API calls when alive() turns false', async () => {
    let alive = true;
    setTimeout(() => (alive = false), 150);
    const t0 = Date.now();
    const r = await runInSandbox('while (true) {}', makeHandler(), {
      timeoutMs: 30_000,
      alive: () => alive,
    });
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.error).toContain('assistant turn ended');
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('alive() false from the start: the worker is not even started', async () => {
    const calls: string[] = [];
    const r = await runInSandbox('doc.id; return 1;', makeHandler(calls), { alive: () => false });
    expect(r.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('an alive() that throws counts as false', async () => {
    const r = await runInSandbox('while (true) {}', makeHandler(), {
      timeoutMs: 30_000,
      alive: () => {
        throw new Error('x');
      },
    });
    expect(r.cancelled).toBe(true);
  });

  it('a normal run with an active watchdog finishes without cancelling', async () => {
    const r = await runInSandbox('await doc.tokens(); return 2;', makeHandler(), {
      alive: () => true,
      signal: new AbortController().signal,
    });
    expect(r.ok).toBe(true);
    expect(r.cancelled).toBeUndefined();
  });
});
