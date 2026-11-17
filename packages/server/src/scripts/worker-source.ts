/**
 * Sources (as text) of the worker and of the bootstrap script of the scripts sandbox.
 *
 * The daemon is bundled into a single file by electron-vite, so the worker CANNOT be a .js
 * next to the bundle: the code travels as a string (`new Worker(WORKER_SOURCE, { eval: true })`).
 * That is why both texts are plain JavaScript in `String.raw` (no backticks and no `${`).
 *
 * Layers (see docs/SCRIPTS.md):
 * 1. `WORKER_SOURCE` runs on the worker thread (the worker's "host" realm), creates a `node:vm` context
 *    with nothing but the JavaScript builtins and hands the bootstrap ONE bridge function.
 * 2. `BOOTSTRAP_SOURCE` runs INSIDE the vm context: keeps the bridge in a closure, builds `doc` and
 *    `console` using only the context's own objects and runs the user code.
 * No object, function or error from the worker's realm may reach the user code (otherwise
 * `x.constructor.constructor('return process')()` escapes): the bridge only exchanges JSON strings and every
 * error caught on the other side is discarded and rethrown as an `Error` of the context itself.
 */

/** Worker code (strict: callsites of strict frames do not expose `getThis`/`getFunction`). */
export const WORKER_SOURCE = String.raw`'use strict';
const wt = require('node:worker_threads');
const vm = require('node:vm');

const data = wt.workerData;
const port = data.port;
const i32 = new Int32Array(data.sab);

// A rejected promise forgotten by the script is its own problem: it does not take down the worker.
process.on('unhandledRejection', function () {});

const FAILURE = '{"ok":false,"error":"Failure on the document bridge."}';

/**
* Worker -> main thread bridge. Never throws and only returns a string. Document calls are
* synchronous: posts the request, sleeps in Atomics.wait and reads the reply with receiveMessageOnPort.
 */
function bridge(method, argsJson) {
  try {
    if (typeof method !== 'string' || typeof argsJson !== 'string') return FAILURE;
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
      /* the main thread replies or terminates this worker */
    }
    Atomics.store(i32, 0, 0);
    const m = wt.receiveMessageOnPort(port);
    return m && typeof m.message === 'string' ? m.message : FAILURE;
  } catch (_e) {
    return FAILURE;
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
  // 1) Validation: the code must be, ON ITS OWN, a valid async function body in strict mode.
  //    The AsyncFunction constructor (from this realm, only to parse: nothing is executed) parses the body
  //    separately from the header, so a "}); ...; (async function(){" that would close the wrapper
  //    below becomes a SyntaxError here. Strings, comments and templates containing "})" remain valid.
  let invalid = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    new AsyncFunction('"use strict";\n' + data.code);
  } catch (e) {
    invalid = e && typeof e.message === 'string' ? e.message : 'syntax error';
  }
  // 2) Compilation in the context: the wrapper is only used with code already validated as a function body.
  //    The header stays on the same line as the code so that the line number in the error is the user's.
  //    Without importModuleDynamically: import() does not work (and the text "import" is rejected beforehand).
  //    The "use strict" at the top of the script also covers anything outside the function (extra defense).
  try {
    const compiled = new vm.Script(
      '"use strict"; (async function () { "use strict"; ' + data.code + '\n})',
      { filename: 'script.js' },
    );
    if (invalid === null) userFn = compiled.runInContext(context);
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : 'syntax error';
    const m = e && typeof e.stack === 'string' ? /script\.js:(\d+)/.exec(e.stack) : null;
    if (invalid === null) invalid = msg;
    invalid = invalid + (m ? ' (line ' + m[1] + ')' : '');
  }
  if (invalid !== null) {
    finish(
      'Syntax error: ' +
        invalid +
        (userFn === null && !/\(line \d+\)$/.test(invalid)
          ? ' (the script must be a valid async function body on its own: check for unbalanced braces and parentheses)'
          : ''),
    );
    userFn = null;
  }
  if (userFn) execute(userFn);
} catch (e) {
  finish('Failed to prepare the sandbox: ' + (e && e.message ? e.message : String(e)));
}
`;

/**
 * Bootstrap evaluated in the vm context: a function expression `(bridge, limitsJson) => execute`.
 * Runs in strict mode and only uses the context's own builtins.
 */
export const BOOTSTRAP_SOURCE = String.raw`(function (bridge, limitsJson) {
'use strict';

/* ---- copies of the builtins used (the user script may change the globals later) ---- */
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

/* ---- context defenses ---- */
// No prepareStackTrace with CallSites (getThis/getFunction) and no way to install one later.
defineProperty(ErrorCtor, 'prepareStackTrace', {
  value: undefined,
  writable: false,
  enumerable: false,
  configurable: false,
});
// Capabilities a document script does not use and that would give memory or waiting outside the heap.
var globalRef = globalThis;
// Buffers and typed arrays allocate OUTSIDE the heap (the worker's memory limit does not see them): removed.
var toRemove = [
  'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'eval', 'FinalizationRegistry', 'WeakRef',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
];
for (var r = 0; r < toRemove.length; r++) {
  try {
    deleteProperty(globalRef, toRemove[r]);
  } catch (_e) {
    /* carry on */
  }
}

function fail(message) {
  throw new ErrorCtor(message);
}

/* ---- bridge call: strings only; anything caught on the other side is discarded ---- */
function post(method, json) {
  var out;
  try {
    out = bridge(method, json);
  } catch (_e) {
    fail('Failure on the document bridge.');
  }
  if (typeof out !== 'string') fail('Invalid response from the bridge.');
  return out;
}

function call(method, args) {
  var s;
  try {
    s = JSONstringify(args === undefined ? null : args);
  } catch (_e) {
    fail('Argument not serializable as JSON (circular reference?).');
  }
  if (typeof s !== 'string') s = 'null';
  if (s.length > limits.maxArgsChars) fail('Argument too large for the document API.');
  var parsed;
  try {
    parsed = JSONparse(post(method, s));
  } catch (_e) {
    fail('Invalid response from the bridge.');
  }
  if (!parsed || parsed.ok !== true) {
    fail(parsed && typeof parsed.error === 'string' ? parsed.error : 'Unknown error.');
  }
  return parsed.value;
}

/* ---- util ---- */
function idOf(x, what) {
  if (typeof x === 'string' && x) return x;
  if (x && typeof x === 'object' && typeof x.id === 'string' && x.id) return x.id;
  return fail((what || 'Node') + ': provide an id (string) or a node.');
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
    /* falls back to String() */
  }
  try {
    return StringCtor(v);
  } catch (_e2) {
    return '[value not serializable]';
  }
}

/* ---- console ---- */
function fmtLog(v) {
  if (typeof v === 'string') return v;
  if (v === null || typeof v !== 'object') {
    try {
      return StringCtor(v);
    } catch (_e) {
      return '[value not serializable]';
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
    post('__log', '… (logs truncated: limit of ' + limits.maxLogLines + ' lines or ' + limits.maxLogChars + ' characters)');
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

/* ---- nodes ---- */
var handles = new MapCtor();
var NodeProto = {};

function snap(h) {
  var id = h.id;
  var s = call('node', { id: id });
  if (!s) fail('Node "' + id + '" no longer exists (was it removed?).');
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

/** Style/attributes map as a Proxy: reading returns the value, assigning writes (op), delete removes. */
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
  if (!obj || typeof obj !== 'object') fail('setStyle expects an object { property: value }.');
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

/** Search by selector (host), predicate function or object (in the context); always in document order. */
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
    fail('Invalid query: use a selector (string), a function (node) => boolean or an object { type, tag, name, text, within }.');
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
    set: function () { fail('Use node.style.property = value or node.setStyle({ ... }).'); },
    enumerable: true,
  },
  attrs: {
    get: function () { return makeBag(this.id, 'attrs'); },
    set: function () { fail('Use node.attrs.name = value or doc.apply({ type: "setAttrs", ... }).'); },
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
      if (!id) fail('Could not duplicate the node.');
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
      return handlesOf(call('frames', { pageId: pageId === undefined || pageId === null ? null : idOf(pageId, 'Page') }));
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
      if (opOrOps === undefined || opOrOps === null) fail('doc.apply expects an op or an array of ops.');
      return writeOps(isArray(opOrOps) ? opOrOps : [opOrOps]);
    },
  },
  create: {
    value: function (parent, spec) {
      var id = call('create', { parentId: parent === null || parent === undefined ? null : idOf(parent, 'Parent'), spec: spec });
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

// After installing doc and console, all remaining globals (Object, Function, Array, Error and subclasses, Promise, JSON, Proxy,
// Reflect, Map, String, Number, Math...) become read-only and non-configurable: the script cannot
// replace Error (or any other constructor) that the API and its errors use. The bootstrap only uses the
// references captured above and never rereads globalThis.X.
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
      /* carry on */
    }
  }
})();

/* ---- execution ---- */
function describe(e) {
  var msg;
  try {
    if (e && typeof e === 'object' && typeof e.message === 'string') {
      msg = (typeof e.name === 'string' && e.name !== 'Error' ? e.name + ': ' : '') + e.message;
      var st = typeof e.stack === 'string' ? e.stack : '';
      var m = /script\.js:(\d+):(\d+)/.exec(st);
      if (m) msg += ' (line ' + m[1] + ')';
    } else if (typeof e === 'string') {
      msg = e;
    } else {
      msg = stringifySafe(e);
    }
  } catch (_x) {
    msg = 'Unknown error.';
  }
  return msg.length > 4000 ? msg.slice(0, 4000) + '…' : msg;
}

function outcome(value) {
  if (value === undefined) return { ok: true };
  var s = stringifySafe(value);
  if (s.length > limits.maxResultChars) {
    return {
      ok: false,
      error: 'The script result is too large (' + s.length + ' characters; limit ' + limits.maxResultChars + '). Return less data. The changes to the document have already been applied.',
    };
  }
  return { ok: true, result: s };
}

return async function execute(userFn) {
  var out;
  try {
    await null; // the user code starts in a microtask: no worker frames on the stack
    var value = await userFn();
    out = outcome(value);
  } catch (e) {
    out = { ok: false, error: describe(e) };
  }
  var json;
  try {
    json = JSONstringify(out);
  } catch (_e) {
    json = '{"ok":false,"error":"Invalid result."}';
  }
  post('__done', json);
};
})`;
