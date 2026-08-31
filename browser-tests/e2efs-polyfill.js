// e2efs-polyfill.js — injected into the panel page BEFORE its module scripts run
// (rod EvalOnNewDocument). Replaces showDirectoryPicker with a faithful in-memory
// File System Access implementation so the capture pipeline is fully exercisable
// without the native folder picker (which CDP cannot drive).
//
// Faithfulness notes (deliberate):
//   - file handles expose getFile()/createWritable()/queryPermission()/requestPermission()
//   - directory handles expose getDirectoryHandle()/getFileHandle()/removeEntry()/values()
//   - file handles have NO remove() — mirroring the real FileSystemFileHandle, so the
//     production code's orphan-cleanup path behaves exactly as it would on disk.
//   - handles carry only data own-properties (path/name/kind) so IndexedDB's
//     structured clone of the handle succeeds, like the real API's serializable handles.
(() => {
  const tree = { name: 'E2E-Archive', kind: 'directory', children: new Map() };
  self.__e2eFsTree = tree;

  function nodeAt(path) {
    if (path === '') return tree;
    const parts = path.split('/');
    let node = tree;
    for (const p of parts) {
      if (!node || node.kind !== 'directory') return null;
      node = node.children.get(p);
    }
    return node || null;
  }

  function parentOf(path) {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? { parent: tree, name: path } :
      { parent: nodeAt(path.slice(0, idx)), name: path.slice(idx + 1) };
  }

  function flatten(node, prefix, out) {
    if (node.kind === 'file') { out.push(prefix); return; }
    for (const [name, child] of node.children) {
      flatten(child, prefix ? prefix + '/' + name : name, out);
    }
  }

  class FakeFileHandle {
    constructor(path) {
      this.path = path;
      this.name = parentOf(path).name;
      this.kind = 'file';
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async getFile() {
      const node = nodeAt(this.path);
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
      const path = this.path;
      return {
        write: async (t) => { buf = typeof t === 'string' ? t : String(t); },
        close: async () => {
          const node = nodeAt(path);
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
    constructor(path) {
      this.path = path;
      this.name = path === '' ? 'E2E-Archive' : parentOf(path).name;
      this.kind = 'directory';
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async getDirectoryHandle(name, { create = false } = {}) {
      const path = this.path ? this.path + '/' + name : name;
      let node = nodeAt(path);
      if (!node) {
        if (!create) throw new DOMException('NotFoundError', 'NotFoundError');
        node = { name, kind: 'directory', children: new Map() };
        parentOf(path).parent.children.set(name, node);
      }
      return new FakeDirHandle(path);
    }
    async getFileHandle(name, { create = false } = {}) {
      const path = this.path ? this.path + '/' + name : name;
      let node = nodeAt(path);
      if (!node) {
        if (!create) throw new DOMException('NotFoundError', 'NotFoundError');
        node = { name, kind: 'file', text: '' };
        parentOf(path).parent.children.set(name, node);
      }
      if (node.kind !== 'file') throw new DOMException('TypeMismatchError', 'TypeMismatchError');
      return new FakeFileHandle(path);
    }
    async removeEntry(name) {
      const path = this.path ? this.path + '/' + name : name;
      const { parent } = parentOf(path);
      if (!parent || !parent.children.has(name)) {
        throw new DOMException('NotFoundError', 'NotFoundError');
      }
      parent.children.delete(name);
    }
    async *values() {
      const node = nodeAt(this.path);
      for (const [name, child] of node.children) {
        const path = this.path ? this.path + '/' + name : name;
        yield child.kind === 'directory' ? new FakeDirHandle(path) : new FakeFileHandle(path);
      }
    }
    async *entries() { yield* this.values(); }
    async *keys() {
      for (const [name] of nodeAt(this.path).children) yield name;
    }
  }

  window.showDirectoryPicker = async (opts) => {
    console.log('[e2e-polyfill] showDirectoryPicker() -> in-memory E2E-Archive', opts || '');
    return new FakeDirHandle('');
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

  // Assertion hook: JSON list of every file path currently in the fake archive.
  window.__e2eFsSnapshot = () => {
    const out = [];
    flatten(tree, '', out);
    return JSON.stringify(out.sort());
  };
  window.__e2eFsFileText = (p) => (nodeAt(p) || {}).text || null;
})();
