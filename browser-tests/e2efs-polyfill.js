// e2efs-polyfill.js — injected into the panel page BEFORE its module scripts run
// (rod EvalOnNewDocument). Replaces showDirectoryPicker with a faithful in-memory
// File System Access implementation so the pipeline is fully exercisable without
// the native folder picker (which CDP cannot drive).
//
// v0.6.0 Phase 0 harness foundation (spec §8):
//   - THREE DISTINCT ROOTS keyed by the picker's `id` option
//     (convo-library / convo-archive / convo-plain; id-less calls share 'default').
//     Isolation proof (A-15): writes in one root never appear in another's snapshot.
//   - PER-ROOT PERMISSION STATES: granted | prompt | denied, driven via
//     __e2eFsSetPermission(root, state) for A-13/A-14. Default 'granted' keeps
//     existing tests deterministic. requestPermission() on 'prompt' simulates the
//     user approving; on 'denied' it refuses, like a real dismissal.
//
// Faithfulness notes (deliberate):
//   - file handles expose getFile()/createWritable()/queryPermission()/requestPermission()
//   - directory handles expose getDirectoryHandle()/getFileHandle()/removeEntry()/values()
//   - file handles have NO remove() — mirroring the real FileSystemFileHandle, so the
//     production code's orphan-cleanup path behaves exactly as it would on disk.
//   - handles carry only data own-properties (root/path/name/kind) so IndexedDB's
//     structured clone of the handle succeeds, like the real API's serializable handles.
//
// Snapshot contract (used by helpers.go):
//   __e2eFsSnapshot()            -> ALL roots merged, bare relative paths, sorted
//   __e2eFsSnapshot(rootId)      -> that root only, bare relative paths (isolation checks)
//   __e2eFsRoots()               -> JSON array of root ids
//   __e2eFsFileText(p[, root])   -> file text (all roots first-hit, or within a root)
//   __e2eFsSetPermission(root, state) / __e2eFsGetPermission(root)
(() => {
  const roots = new Map(); // picker id -> tree node

  function rootFor(id) {
    const key = (id && String(id)) || 'default';
    if (!roots.has(key)) {
      roots.set(key, { rootId: key, name: `E2E-${key}`, kind: 'directory', children: new Map() });
    }
    return roots.get(key);
  }

  function nodeAt(tree, path) {
    if (path === '') return tree;
    const parts = path.split('/');
    let node = tree;
    for (const p of parts) {
      if (!node || node.kind !== 'directory') return null;
      node = node.children.get(p);
    }
    return node || null;
  }

  function parentOf(tree, path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? { parent: tree, name: path } :
      { parent: nodeAt(tree, path.slice(0, idx)), name: path.slice(idx + 1) };
  }

  function flatten(node, prefix, out) {
    if (node.kind === 'file') { out.push(prefix); return; }
    for (const [name, child] of node.children) {
      flatten(child, prefix ? prefix + '/' + name : name, out);
    }
  }

  const permState = new Map(); // root id -> 'granted' | 'prompt' | 'denied'
  function permOf(rootId) { return permState.get(rootId) || 'granted'; }

  class FakeFileHandle {
    constructor(tree, path) {
      this.tree = tree;
      this.path = path;
      this.name = parentOf(tree, path).name;
      this.kind = 'file';
    }
    async queryPermission() { return permOf(this.tree.rootId); }
    async requestPermission() {
      const st = permOf(this.tree.rootId);
      if (st === 'denied') return 'denied';
      permState.set(this.tree.rootId, 'granted');
      return 'granted';
    }
    async getFile() {
      const node = nodeAt(this.tree, this.path);
      const text = node ? node.text : '';
      return {
        name: this.name,
        size: text.length,
        type: 'text/plain',
        lastModified: Date.now(),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      };
    }
    async createWritable() {
      let buf = '';
      const tree = this.tree;
      const path = this.path;
      return {
        write: async (t) => { buf = typeof t === 'string' ? t : String(t); },
        close: async () => {
          const node = nodeAt(tree, path);
          if (node && node.kind === 'file') node.text = buf;
        },
        abort: async () => {},
        getWriter: () => {
          throw new Error('e2e polyfill: only plain write() supported');
        },
      };
    }
  }

  class FakeDirHandle {
    constructor(tree, path) {
      this.tree = tree;
      this.path = path;
      this.name = path === '' ? tree.name : parentOf(tree, path).name;
      this.kind = 'directory';
    }
    async queryPermission() { return permOf(this.tree.rootId); }
    async requestPermission() {
      const st = permOf(this.tree.rootId);
      if (st === 'denied') return 'denied';
      permState.set(this.tree.rootId, 'granted');
      return 'granted';
    }
    async getDirectoryHandle(name, { create = false } = {}) {
      const path = this.path ? this.path + '/' + name : name;
      let node = nodeAt(this.tree, path);
      if (!node) {
        if (!create) throw new DOMException('NotFoundError', 'NotFoundError');
        node = { name, kind: 'directory', children: new Map() };
        parentOf(this.tree, path).parent.children.set(name, node);
      }
      return new FakeDirHandle(this.tree, path);
    }
    async getFileHandle(name, { create = false } = {}) {
      const path = this.path ? this.path + '/' + name : name;
      let node = nodeAt(this.tree, path);
      if (!node) {
        if (!create) throw new DOMException('NotFoundError', 'NotFoundError');
        node = { name, kind: 'file', text: '' };
        parentOf(this.tree, path).parent.children.set(name, node);
      }
      if (node.kind !== 'file') throw new DOMException('TypeMismatchError', 'TypeMismatchError');
      return new FakeFileHandle(this.tree, path);
    }
    async removeEntry(name) {
      const path = this.path ? this.path + '/' + name : name;
      const { parent } = parentOf(this.tree, path);
      if (!parent || !parent.children.has(name)) {
        throw new DOMException('NotFoundError', 'NotFoundError');
      }
      parent.children.delete(name);
    }
    async *values() {
      const node = nodeAt(this.tree, this.path);
      for (const [name, child] of node.children) {
        const path = this.path ? this.path + '/' + name : name;
        yield child.kind === 'directory' ? new FakeDirHandle(this.tree, path) : new FakeFileHandle(this.tree, path);
      }
    }
    async *entries() { yield* this.values(); }
    async *keys() {
      for (const [name] of nodeAt(this.tree, this.path).children) yield name;
    }
  }

  window.showDirectoryPicker = async (opts) => {
    const id = (opts && opts.id) || 'default';
    console.log(`[e2e-polyfill] showDirectoryPicker(id=${id}) -> in-memory root`, opts || '');
    return new FakeDirHandle(rootFor(id), '');
  };

  // ---------------------------------------------------------------------------
  // IndexedDB shim for the app's own database ('convo-hist').
  //
  // Why: the real API stores FileSystemDirectoryHandle in IDB via structured
  // clone — real handles are serializable and keep their behavior after the
  // round-trip. A JS class instance does not (clone drops the prototype), which
  // would make archiveStatus()/getArchiveHandle() crash in a way the real
  // extension never experiences. This shim keeps object IDENTITY (no clone),
  // reproducing the real round-trip behavior for the fake handles. Only the
  // surface lib/idb.js uses is implemented: open/get/put/delete.
  (() => {
    const REAL = indexedDB;
    const stores = new Map(); // storeName -> Map(key -> value)
    const openDbs = new Map();

    function makeRequest(fire) {
      const req = { readyState: 'pending', result: undefined, error: null, onsuccess: null, onerror: null };
      Promise.resolve().then(() => {
        try { fire(req); } catch (e) { req.error = e; }
        req.readyState = 'done';
        const cb = req.error ? req.onerror : req.onsuccess;
        if (cb) cb({ target: req });
      });
      return req;
    }

    function makeDb(name) {
      return {
        name,
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        close() {},
        transaction(storeName /* , mode */) {
          if (!stores.has(storeName)) stores.set(storeName, new Map());
          const m = stores.get(storeName);
          return {
            objectStore() {
              return {
                get: (key) => makeRequest((r) => { r.result = m.get(key); }),
                put: (val, key) => makeRequest((r) => { m.set(key, val); r.result = true; }),
                delete: (key) => makeRequest((r) => { m.delete(key); r.result = true; }),
              };
            },
          };
        },
      };
    }

    indexedDB.open = (name /* , version */) => {
      if (name !== 'convo-hist') return REAL.open(...arguments);
      return makeRequest((r) => {
        let db = openDbs.get(name);
        if (!db) { db = makeDb(name); openDbs.set(name, db); }
        r.result = db;
      });
    };
  })();

  // Assertion hooks (contract documented in the header).
  window.__e2eFsRoots = () => JSON.stringify([...roots.keys()].sort());

  window.__e2eFsSnapshot = (rootId) => {
    const out = [];
    if (rootId) {
      const tree = roots.get(String(rootId));
      if (tree) flatten(tree, '', out);
    } else {
      for (const tree of roots.values()) flatten(tree, '', out);
    }
    return JSON.stringify(out.sort());
  };

  window.__e2eFsFileText = (p, rootId) => {
    if (rootId) {
      const tree = roots.get(String(rootId));
      return (tree && nodeAt(tree, p) || {}).text || null;
    }
    for (const tree of roots.values()) {
      const node = nodeAt(tree, p);
      if (node && node.kind === 'file') return node.text;
    }
    return null;
  };

  window.__e2eFsSetPermission = (rootId, state) => {
    if (!['granted', 'prompt', 'denied'].includes(state)) {
      throw new Error(`e2e polyfill: bad permission state ${state}`);
    }
    permState.set(String(rootId), state);
  };
  window.__e2eFsGetPermission = (rootId) => permOf(String(rootId));
})();
