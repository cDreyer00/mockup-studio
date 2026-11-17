/**
 * Fontes (em texto) do worker e do script de bootstrap da sandbox de scripts.
 *
 * O daemon é empacotado num único arquivo pelo electron-vite, então o worker NÃO pode ser um .js
 * ao lado do bundle: o código viaja como string (`new Worker(WORKER_SOURCE, { eval: true })`).
 * Por isso os dois textos são JavaScript puro em `String.raw` (sem crases e sem `${`).
 *
 * Camadas (ver docs/SCRIPTS.md):
 * 1. `WORKER_SOURCE` roda no thread do worker (realm "host" do worker), cria um contexto `node:vm`
 *    sem nada além dos builtins do JavaScript e entrega ao bootstrap UMA função-ponte.
 * 2. `BOOTSTRAP_SOURCE` roda DENTRO do contexto vm: guarda a ponte numa closure, monta `doc` e
 *    `console` só com objetos do próprio contexto e executa o código do usuário.
 * Nenhum objeto, função ou erro do realm do worker pode chegar ao código do usuário (senão
 * `x.constructor.constructor('return process')()` escapa): a ponte só troca strings JSON e todo
 * erro capturado do lado de lá é descartado e relançado como `Error` do próprio contexto.
 */

/** Código do worker (strict: callsites de frames strict não expõem `getThis`/`getFunction`). */
export const WORKER_SOURCE = String.raw`'use strict';
const wt = require('node:worker_threads');
const vm = require('node:vm');

const data = wt.workerData;
const port = data.port;
const i32 = new Int32Array(data.sab);

// Promessa rejeitada e esquecida pelo script é problema dele: não derruba o worker.
process.on('unhandledRejection', function () {});

const FALHA = '{"ok":false,"error":"Falha na ponte com o documento."}';

/**
 * Ponte worker -> thread principal. Nunca lança e só devolve string. Chamadas de documento são
 * síncronas: posta o pedido, dorme em Atomics.wait e lê a resposta com receiveMessageOnPort.
 */
function bridge(method, argsJson) {
  try {
    if (typeof method !== 'string' || typeof argsJson !== 'string') return FALHA;
    if (method === '__log') {
      port.postMessage({ t: 'log', line: argsJson });
      return 'null';
    }
    if (method === '__done') {
      port.postMessage({ t: 'done', payload: argsJson });
      return 'null';
    }
    port.postMessage({ t: 'rpc', method: method, args: argsJson });
    while (Atomics.wait(i32, 0, 0, 1000) === 'timed-out') {
      /* a thread principal responde ou termina este worker */
    }
    Atomics.store(i32, 0, 0);
    const m = wt.receiveMessageOnPort(port);
    return m && typeof m.message === 'string' ? m.message : FALHA;
  } catch (_e) {
    return FALHA;
  }
}

function finish(error) {
  port.postMessage({ t: 'done', payload: JSON.stringify({ ok: false, error: error }) });
}

try {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    codeGeneration: { strings: false, wasm: false },
  });
  const factory = new vm.Script(data.bootstrap, { filename: 'mockup-bootstrap.js' }).runInContext(
    context,
  );
  const execute = factory(bridge, data.limits);
  let userFn = null;
  // 1) Validação: o código precisa ser, SOZINHO, um corpo de função async válido em modo estrito.
  //    O construtor de AsyncFunction (deste realm, só para parsear: nada é executado) analisa o corpo
  //    separadamente do cabeçalho, então um "}); ...; (async function(){" que fecharia o invólucro
  //    abaixo vira SyntaxError aqui. Strings, comentários e templates com "})" continuam válidos.
  let invalid = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction('"use strict";\n' + data.code);
  } catch (e) {
    invalid = e && typeof e.message === 'string' ? e.message : 'erro de sintaxe';
  }
  // 2) Compilação no contexto: o invólucro só é usado com código já validado como corpo de função.
  //    O cabeçalho fica na mesma linha do código para que o número da linha no erro seja o do usuário.
  //    Sem importModuleDynamically: import() não funciona (e o texto "import" é recusado antes).
  //    O "use strict" no topo do script cobre também o que estiver fora da função (defesa extra).
  try {
    const compiled = new vm.Script(
      '"use strict"; (async function () { "use strict"; ' + data.code + '\n})',
      { filename: 'script.js' },
    );
    if (invalid === null) userFn = compiled.runInContext(context);
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : 'erro de sintaxe';
    const m = e && typeof e.stack === 'string' ? /script\.js:(\d+)/.exec(e.stack) : null;
    if (invalid === null) invalid = msg;
    invalid = invalid + (m ? ' (linha ' + m[1] + ')' : '');
  }
  if (invalid !== null) {
    finish(
      'Erro de sintaxe: ' +
        invalid +
        (userFn === null && !/\(linha \d+\)$/.test(invalid)
          ? ' (o script deve ser um corpo de função async válido por si só: confira chaves e parênteses desbalanceados)'
          : ''),
    );
    userFn = null;
  }
  if (userFn) execute(userFn);
} catch (e) {
  finish('Falha ao preparar a sandbox: ' + (e && e.message ? e.message : String(e)));
}
`;

/**
 * Bootstrap avaliado no contexto vm: uma expressão de função `(bridge, limitsJson) => execute`.
 * Roda em strict mode e só usa builtins do próprio contexto.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (bridge, limitsJson) {
'use strict';

/* ---- cópias dos builtins usados (o script do usuário pode alterar os globais depois) ---- */
var JSONparse = JSON.parse;
var JSONstringify = JSON.stringify;
var isArray = Array.isArray;
var keysOf = Object.keys;
var freeze = Object.freeze;
var defineProperty = Object.defineProperty;
var defineProperties = Object.defineProperties;
var createObject = Object.create;
var hasOwn = Object.prototype.hasOwnProperty;
var toStringTag = Object.prototype.toString;
var ErrorCtor = Error;
var MapCtor = Map;
var ProxyCtor = Proxy;
var StringCtor = String;
var NumberCtor = Number;
var arrayFrom = Array.from;
var deleteProperty = Reflect.deleteProperty;
var ownKeys = Reflect.ownKeys;
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var limits = JSONparse(limitsJson);

/* ---- defesas do contexto ---- */
// Sem prepareStackTrace com CallSites (getThis/getFunction) e sem como instalar um depois.
defineProperty(ErrorCtor, 'prepareStackTrace', {
  value: undefined,
  writable: false,
  enumerable: false,
  configurable: false,
});
// Capacidades que um script de documento não usa e que dariam memória ou espera fora do heap.
var globalRef = globalThis;
// Buffers e arrays tipados alocam FORA do heap (o limite de memória do worker não os vê): removidos.
var toRemove = [
  'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'FinalizationRegistry', 'WeakRef',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];
for (var r = 0; r < toRemove.length; r++) {
  try {
    deleteProperty(globalRef, toRemove[r]);
  } catch (_e) {
    /* segue */
  }
}

function fail(message) {
  throw new ErrorCtor(message);
}

/* ---- chamada à ponte: só strings; qualquer coisa capturada do lado de lá é descartada ---- */
function post(method, json) {
  var out;
  try {
    out = bridge(method, json);
  } catch (_e) {
    fail('Falha na ponte com o documento.');
  }
  if (typeof out !== 'string') fail('Resposta inválida da ponte.');
  return out;
}

function call(method, args) {
  var s;
  try {
    s = JSONstringify(args === undefined ? null : args);
  } catch (_e) {
    fail('Argumento não serializável em JSON (referência circular?).');
  }
  if (typeof s !== 'string') s = 'null';
  if (s.length > limits.maxArgsChars) fail('Argumento grande demais para a API do documento.');
  var parsed;
  try {
    parsed = JSONparse(post(method, s));
  } catch (_e) {
    fail('Resposta inválida da ponte.');
  }
  if (!parsed || parsed.ok !== true) {
    fail(parsed && typeof parsed.error === 'string' ? parsed.error : 'Erro desconhecido.');
  }
  return parsed.value;
}

/* ---- util ---- */
function idOf(x, what) {
  if (typeof x === 'string' && x) return x;
  if (x && typeof x === 'object' && typeof x.id === 'string' && x.id) return x.id;
  return fail((what || 'Nó') + ': informe um id (string) ou um nó.');
}

function kebab(p) {
  if (p.charAt(0) === '-' ) return p;
  return p.replace(/[A-Z]/g, function (m) {
    return '-' + m.toLowerCase();
  });
}

function stringifySafe(v) {
  try {
    var s = JSONstringify(v, function (_k, x) {
      var t = typeof x;
      if (t === 'bigint' || t === 'function' || t === 'symbol') return StringCtor(x);
      if (x && t === 'object') {
        var tag = toStringTag.call(x);
        if (tag === '[object Map]') return { map: arrayFrom(x) };
        if (tag === '[object Set]') return { set: arrayFrom(x) };
        if (tag === '[object RegExp]' || tag === '[object Error]') return StringCtor(x);
      }
      return x;
    });
    if (typeof s === 'string') return s;
  } catch (_e) {
    /* cai no String() */
  }
  try {
    return StringCtor(v);
  } catch (_e2) {
    return '[valor não serializável]';
  }
}

/* ---- console ---- */
function fmtLog(v) {
  if (typeof v === 'string') return v;
  if (v === null || typeof v !== 'object') {
    try {
      return StringCtor(v);
    } catch (_e) {
      return '[valor não serializável]';
    }
  }
  return stringifySafe(v);
}
var logLines = 0;
var logChars = 0;
var logFull = false;
function emitLog(level, args) {
  if (logFull) return;
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    parts.push(fmtLog(args[i]));
  }
  var line = parts.join(' ');
  if (line.length > limits.maxLogLine) line = line.slice(0, limits.maxLogLine) + '…';
  if (level) line = '[' + level + '] ' + line;
  if (logLines >= limits.maxLogLines || logChars + line.length > limits.maxLogChars) {
    logFull = true;
    post('__log', '… (logs truncados: limite de ' + limits.maxLogLines + ' linhas ou ' + limits.maxLogChars + ' caracteres)');
    return;
  }
  logLines++;
  logChars += line.length;
  post('__log', line);
}
var consoleApi = freeze({
  log: function () { emitLog('', arguments); },
  info: function () { emitLog('', arguments); },
  debug: function () { emitLog('', arguments); },
  warn: function () { emitLog('warn', arguments); },
  error: function () { emitLog('error', arguments); },
});

/* ---- nós ---- */
var handles = new MapCtor();
var NodeProto = {};

function snap(h) {
  var id = h.id;
  var s = call('node', { id: id });
  if (!s) fail('O nó "' + id + '" não existe mais (foi removido?).');
  return s;
}

function writeOps(ops) {
  return call('apply', { ops: ops });
}

function makeHandle(id) {
  var h = handles.get(id);
  if (h) return h;
  h = createObject(NodeProto);
  defineProperty(h, 'id', { value: id, enumerable: true });
  freeze(h);
  handles.set(id, h);
  return h;
}

function isRegExp(x) {
  return toStringTag.call(x) === '[object RegExp]';
}

/** Mapa de estilo/atributos como Proxy: ler devolve o valor, atribuir grava (op), delete remove. */
function makeBag(nodeId, kind) {
  var isStyle = kind === 'style';
  var norm = function (p) {
    return isStyle ? kebab(p) : p;
  };
  var read = function () {
    return snap({ id: nodeId })[kind] || {};
  };
  var write = function (key, value) {
    var remove = value === null || value === undefined || (isStyle && value === '');
    if (isStyle) {
      var op = { type: 'updateStyles', nodeIds: [nodeId] };
      if (remove) {
        op.unset = [key];
      } else {
        op.styles = {};
        op.styles[key] = StringCtor(value);
      }
      writeOps([op]);
    } else {
      var change = { nodeId: nodeId };
      if (remove) change.unset = [key];
      else {
        change.set = {};
        change.set[key] = StringCtor(value);
      }
      writeOps([{ type: 'setAttrs', changes: [change] }]);
    }
    return true;
  };
  return new ProxyCtor({}, {
    get: function (_t, p) {
      if (typeof p !== 'string') return undefined;
      var o = read();
      var k = norm(p);
      return hasOwn.call(o, k) ? o[k] : undefined;
    },
    set: function (_t, p, v) {
      if (typeof p !== 'string') return false;
      return write(norm(p), v);
    },
    has: function (_t, p) {
      return typeof p === 'string' && hasOwn.call(read(), norm(p));
    },
    deleteProperty: function (_t, p) {
      if (typeof p !== 'string') return false;
      return write(norm(p), null);
    },
    ownKeys: function () {
      return keysOf(read());
    },
    getOwnPropertyDescriptor: function (_t, p) {
      if (typeof p !== 'string') return undefined;
      var o = read();
      var k = norm(p);
      if (!hasOwn.call(o, k)) return undefined;
      return { value: o[k], writable: true, enumerable: true, configurable: true };
    },
    defineProperty: function (_t, p, d) {
      if (typeof p !== 'string' || !d || !('value' in d)) return false;
      return write(norm(p), d.value);
    },
    preventExtensions: function () {
      return false;
    },
  });
}

function setStyleMany(id, obj) {
  if (!obj || typeof obj !== 'object') fail('setStyle espera um objeto { propriedade: valor }.');
  var styles = {};
  var unset = [];
  var ks = keysOf(obj);
  for (var i = 0; i < ks.length; i++) {
    var v = obj[ks[i]];
    var k = kebab(ks[i]);
    if (v === null || v === undefined || v === '') unset.push(k);
    else styles[k] = StringCtor(v);
  }
  var op = { type: 'updateStyles', nodeIds: [id] };
  if (keysOf(styles).length) op.styles = styles;
  if (unset.length) op.unset = unset;
  if (!op.styles && !op.unset) return;
  writeOps([op]);
}

function strMatch(spec, value) {
  if (value === undefined || value === null) return false;
  if (isRegExp(spec)) {
    spec.lastIndex = 0;
    return spec.test(value);
  }
  return value === StringCtor(spec);
}

function objectPredicate(q) {
  return function (n) {
    if (q.type !== undefined && n.type !== q.type) return false;
    if (q.tag !== undefined && n.tag !== StringCtor(q.tag).toLowerCase()) return false;
    if (q.name !== undefined && !strMatch(q.name, n.name)) return false;
    if (q.text !== undefined && !strMatch(q.text, n.text)) return false;
    return true;
  };
}

/** Busca por seletor (host), função predicado ou objeto (no contexto); sempre em ordem de documento. */
function selectIn(query, within) {
  var ids = [];
  if (typeof query === 'string') {
    ids = call('select', { selector: query, within: within || null });
  } else if (typeof query === 'function' || (query && typeof query === 'object')) {
    var pred = typeof query === 'function' ? query : objectPredicate(query);
    var scope = within || null;
    if (typeof query === 'object' && query.within !== undefined && query.within !== null) {
      scope = idOf(query.within, 'within');
    }
    var nodes = call('nodes', { within: scope });
    for (var i = 0; i < nodes.length; i++) {
      if (pred(nodes[i])) ids.push(nodes[i].id);
    }
  } else {
    fail('Consulta inválida: use um seletor (string), uma função (node) => boolean ou um objeto { type, tag, name, text, within }.');
  }
  var out = [];
  for (var j = 0; j < ids.length; j++) out.push(makeHandle(ids[j]));
  return out;
}

defineProperties(NodeProto, {
  type: { get: function () { return snap(this).type; }, enumerable: true },
  tag: { get: function () { return snap(this).tag; }, enumerable: true },
  name: {
    get: function () { return snap(this).name; },
    set: function (v) {
      writeOps([{ type: 'renameNodes', changes: [{ nodeId: this.id, name: StringCtor(v) }] }]);
    },
    enumerable: true,
  },
  text: {
    get: function () { return snap(this).text; },
    set: function (v) {
      writeOps([{ type: 'setText', changes: [{ nodeId: this.id, text: v === null || v === undefined ? null : StringCtor(v) }] }]);
    },
    enumerable: true,
  },
  style: {
    get: function () { return makeBag(this.id, 'style'); },
    set: function () { fail('Use node.style.propriedade = valor ou node.setStyle({ ... }).'); },
    enumerable: true,
  },
  attrs: {
    get: function () { return makeBag(this.id, 'attrs'); },
    set: function () { fail('Use node.attrs.nome = valor ou doc.apply({ type: "setAttrs", ... }).'); },
    enumerable: true,
  },
  classes: { get: function () { return snap(this).classes || ''; }, enumerable: true },
  position: {
    get: function () { return snap(this).position; },
    set: function (v) {
      var pos = null;
      if (v) pos = { x: NumberCtor(v.x), y: NumberCtor(v.y) };
      writeOps([{ type: 'setPosition', changes: [{ nodeId: this.id, position: pos }] }]);
    },
    enumerable: true,
  },
  parent: {
    get: function () {
      var p = snap(this).parentId;
      return p ? makeHandle(p) : null;
    },
    enumerable: true,
  },
  children: {
    get: function () {
      var ids = snap(this).childIds;
      var out = [];
      for (var i = 0; i < ids.length; i++) out.push(makeHandle(ids[i]));
      return out;
    },
    enumerable: true,
  },
  frame: { get: function () { return makeHandle(snap(this).frameId); }, enumerable: true },
  setStyle: { value: function (obj) { setStyleMany(this.id, obj); return this; } },
  remove: { value: function () { writeOps([{ type: 'deleteNodes', nodeIds: [this.id] }]); } },
  duplicate: {
    value: function () {
      var res = writeOps([{ type: 'duplicateNodes', nodeIds: [this.id] }]);
      var map = res && res[0] && res[0].idMap;
      var id = map && map[this.id];
      if (!id) fail('Não foi possível duplicar o nó.');
      return makeHandle(id);
    },
  },
  select: { value: function (query) { return selectIn(query, this.id); } },
  toJSON: { value: function () { return snap(this); } },
});
freeze(NodeProto);

/* ---- doc ---- */
function handlesOf(ids) {
  var out = [];
  for (var i = 0; i < ids.length; i++) out.push(makeHandle(ids[i]));
  return out;
}

var docApi = {};
defineProperties(docApi, {
  id: { get: function () { return call('docInfo').id; }, enumerable: true },
  name: { get: function () { return call('docInfo').name; }, enumerable: true },
  pages: { value: function () { return call('pages'); } },
  frames: {
    value: function (pageId) {
      return handlesOf(call('frames', { pageId: pageId === undefined || pageId === null ? null : idOf(pageId, 'Página') }));
    },
  },
  get: {
    value: function (id) {
      var nid = idOf(id);
      return call('node', { id: nid }) ? makeHandle(nid) : null;
    },
  },
  select: { value: function (query) { return selectIn(query, null); } },
  selectOne: {
    value: function (query) {
      var all = selectIn(query, null);
      return all.length ? all[0] : null;
    },
  },
  selection: { value: function () { return handlesOf(call('selection')); } },
  apply: {
    value: function (opOrOps) {
      if (opOrOps === undefined || opOrOps === null) fail('doc.apply espera uma op ou um array de ops.');
      return writeOps(isArray(opOrOps) ? opOrOps : [opOrOps]);
    },
  },
  create: {
    value: function (parent, spec) {
      var id = call('create', { parentId: parent === null || parent === undefined ? null : idOf(parent, 'Pai'), spec: spec });
      return makeHandle(id);
    },
  },
  screenshot: {
    value: function (target, options) {
      var o = options && typeof options === 'object' ? options : {};
      return call('screenshot', {
        nodeId: target === undefined || target === null ? null : idOf(target),
        scale: o.scale === undefined ? null : o.scale,
        format: o.format === undefined ? null : o.format,
      });
    },
  },
  tokens: { value: function () { return call('tokens'); } },
  setTokens: { value: function (obj) { return call('setTokens', { tokens: obj }); } },
});
freeze(docApi);

function lock(name, value) {
  defineProperty(globalRef, name, { value: value, writable: false, enumerable: true, configurable: false });
}
lock('doc', docApi);
lock('console', consoleApi);

// Depois de instalar doc e console, todos os globais restantes (Object, Function, Array, Error e subclasses, Promise, JSON, Proxy,
// Reflect, Map, String, Number, Math...) ficam somente-leitura e não configuráveis: o script não pode
// trocar o Error (nem nenhum outro construtor) que a API e os erros dela usam. O bootstrap só usa as
// referências capturadas acima, nunca relê globalThis.X.
(function lockBuiltins() {
  var names = ownKeys(globalRef);
  for (var i = 0; i < names.length; i++) {
    var d = getOwnPropertyDescriptor(globalRef, names[i]);
    if (!d || !d.configurable || !('value' in d)) continue;
    try {
      defineProperty(globalRef, names[i], {
        value: d.value,
        writable: false,
        enumerable: d.enumerable,
        configurable: false,
      });
    } catch (_e) {
      /* segue */
    }
  }
})();

/* ---- execução ---- */
function describe(e) {
  var msg;
  try {
    if (e && typeof e === 'object' && typeof e.message === 'string') {
      msg = (typeof e.name === 'string' && e.name !== 'Error' ? e.name + ': ' : '') + e.message;
      var st = typeof e.stack === 'string' ? e.stack : '';
      var m = /script\.js:(\d+):(\d+)/.exec(st);
      if (m) msg += ' (linha ' + m[1] + ')';
    } else if (typeof e === 'string') {
      msg = e;
    } else {
      msg = stringifySafe(e);
    }
  } catch (_x) {
    msg = 'Erro desconhecido.';
  }
  return msg.length > 4000 ? msg.slice(0, 4000) + '…' : msg;
}

function outcome(value) {
  if (value === undefined) return { ok: true };
  var s = stringifySafe(value);
  if (s.length > limits.maxResultChars) {
    return {
      ok: false,
      error: 'O resultado do script é grande demais (' + s.length + ' caracteres; limite ' + limits.maxResultChars + '). Devolva menos dados. As alterações no documento já foram aplicadas.',
    };
  }
  return { ok: true, result: s };
}

return async function execute(userFn) {
  var out;
  try {
    await null; // o código do usuário começa numa microtask: sem frames do worker na pilha
    var value = await userFn();
    out = outcome(value);
  } catch (e) {
    out = { ok: false, error: describe(e) };
  }
  var json;
  try {
    json = JSONstringify(out);
  } catch (_e) {
    json = '{"ok":false,"error":"Resultado inválido."}';
  }
  post('__done', json);
};
})`;
