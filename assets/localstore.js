/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py, and Fabcheck and Pincheck vendor it
   for their Send to Signoff. */
/* SignoffLocal: this browser's working copy of a tool's reviews, in IndexedDB (Chris, 2026-11-19).

   localStorage holds about 5 MB for the whole site, and every tool on it shares that; a full one kept a
   sync's reviews from being saved while its small record of what it synced was saved, so the browser
   claimed versions it didn't hold, and a later sync wrote an old copy over a newer file. IndexedDB has far
   more room, and a review, the change markers, and the sync record are written in ONE transaction, so they
   can't fall out of step.

   One database per storage namespace ('signoff-local-' + ns, e.g. signoff-local-signoff.v1.), one object
   store 'kv':
     'p:' + slug   a review (the app's projects map is slug -> document)
     'dirty'       project id (or 'roster') -> time of the last unsynced edit
     'homes'       project id -> 'owner/repo'
     'cache2'      'owner/repo' -> { path: { sha, fp } } as of the last sync
     'bases'       project id -> Scribe base (model.specBase)

   Legacy: before this, those lived in localStorage under ns + 'projects', 'dirty', 'homes', 'cache2', and
   'bases'. legacy() reads whatever is there (the first load after the update, a tab still running older
   code, or an older Fabcheck or Pincheck Send), the app merges it in and saves, and clearLegacy() removes
   it once the save is read back. Nothing is removed before it's safely here.

   Other tabs hear of every save over a BroadcastChannel (onChange), as localStorage's storage event did.
   Without IndexedDB (blocked, or a private window that refuses it) the store falls back to localStorage,
   as before, and says so (backend 'ls'). */
(function (root) {
  'use strict';
  var KEYS = ['dirty', 'homes', 'cache2', 'bases'];
  var LEGACY = ['projects'].concat(KEYS);

  function dbName(ns) { return 'signoff-local-' + ns; }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function done(tx) { return new Promise(function (res, rej) { tx.oncomplete = function () { res(true); }; tx.onabort = tx.onerror = function () { rej(tx.error || new Error('IndexedDB write failed')); }; }); }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  function Store(ns) {
    this.ns = ns;
    this.backend = '';
    this.db = null;
    this.last = {};          // slug -> JSON of the copy last read or written here (to write only what changed)
    this.chain = Promise.resolve(true);
    this.listeners = [];
    this.tab = Math.random().toString(36).slice(2);
    var self = this;
    try {
      this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(dbName(ns)) : null;
      if (this.channel) this.channel.onmessage = function (e) { var m = e.data || {}; if (m.tab !== self.tab) self.listeners.forEach(function (fn) { try { fn(m); } catch (err) { /* a listener's own error */ } }); };
    } catch (e) { this.channel = null; }
  }

  Store.prototype.open = function () {
    var self = this;
    if (this.opening) return this.opening;
    this.opening = new Promise(function (res) {
      var r;
      try { r = indexedDB.open(dbName(self.ns), 1); } catch (e) { self.backend = 'ls'; res(null); return; }
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = function () {
        self.db = r.result; self.backend = 'idb';
        // Another tab upgrading or Sign out deleting the database: let it go, and reopen next time.
        self.db.onversionchange = function () { try { self.db.close(); } catch (e) { /* closed */ } self.db = null; self.opening = null; };
        res(self.db);
      };
      r.onerror = r.onblocked = function () { self.backend = 'ls'; res(null); };
    });
    return this.opening;
  };

  // Everything kept here: { projects, dirty, homes, cache2, bases, backend }.
  Store.prototype.load = function () {
    var self = this;
    return this.open().then(function (db) {
      if (!db) return self.loadLs();
      var tx = db.transaction('kv', 'readonly'), s = tx.objectStore('kv');
      return Promise.all([req(s.getAllKeys()), req(s.getAll())]).then(function (got) {
        var out = { projects: {}, dirty: {}, homes: {}, cache2: {}, bases: {}, backend: 'idb' };
        got[0].forEach(function (k, i) {
          var v = got[1][i];
          if (typeof k === 'string' && k.indexOf('p:') === 0) { out.projects[k.slice(2)] = v; self.last[k.slice(2)] = JSON.stringify(v); }
          else if (KEYS.indexOf(k) >= 0 && v && typeof v === 'object') out[k] = v;
        });
        return out;
      });
    });
  };
  Store.prototype.loadLs = function () {
    var ns = this.ns, out = { backend: 'ls' };
    out.projects = lsGet(ns + 'projects') || {};
    KEYS.forEach(function (k) { out[k] = lsGet(ns + k) || {}; });
    return Promise.resolve(out);
  };

  // Reviews (slug -> document) read again, after another tab said it saved them.
  Store.prototype.read = function (slugs) {
    var self = this;
    return this.open().then(function (db) {
      if (!db) return self.loadLs().then(function (d) { var o = {}; slugs.forEach(function (s) { if (d.projects[s]) o[s] = d.projects[s]; }); return o; });
      var s = db.transaction('kv', 'readonly').objectStore('kv');
      return Promise.all(slugs.map(function (slug) { return req(s.get('p:' + slug)); })).then(function (docs) {
        var o = {}; slugs.forEach(function (slug, i) { if (docs[i]) { o[slug] = docs[i]; self.last[slug] = JSON.stringify(docs[i]); } }); return o;
      });
    });
  };
  // One of dirty, homes, cache2, or bases as stored now.
  Store.prototype.get = function (key) {
    var self = this;
    return this.open().then(function (db) {
      if (!db) return lsGet(self.ns + key) || {};
      return req(db.transaction('kv', 'readonly').objectStore('kv').get(key)).then(function (v) { return v || {}; });
    });
  };

  // Save in one transaction: state.projects (the whole map; only reviews that changed since this store last
  // read or wrote them are written, and ones gone from the map are deleted), and any of dirty, homes, cache2,
  // and bases given. Saves run one after another in the order made. Resolves true, or false when it failed
  // (nothing of that save is kept then: a transaction is all or nothing).
  Store.prototype.save = function (state) {
    var self = this;
    var snap = {};
    if (state.projects) {
      snap.put = {}; snap.del = [];
      Object.keys(state.projects).forEach(function (slug) {
        var j = JSON.stringify(state.projects[slug]);
        if (self.last[slug] !== j) snap.put[slug] = j;
      });
      Object.keys(self.last).forEach(function (slug) { if (!state.projects[slug]) snap.del.push(slug); });
    }
    KEYS.forEach(function (k) { if (state[k]) snap[k] = JSON.stringify(state[k]); });
    var p = this.chain.then(function () { return self.write(snap); });
    this.chain = p.then(function () { return true; }, function () { return true; });
    return p;
  };
  Store.prototype.write = function (snap) {
    var self = this;
    var put = snap.put || {}, del = snap.del || [], keys = KEYS.filter(function (k) { return snap[k] != null; });
    if (!Object.keys(put).length && !del.length && !keys.length) return Promise.resolve(true);
    return this.open().then(function (db) {
      if (!db) return self.writeLs(snap);
      var tx = db.transaction('kv', 'readwrite'), s = tx.objectStore('kv');
      Object.keys(put).forEach(function (slug) { s.put(JSON.parse(put[slug]), 'p:' + slug); });
      del.forEach(function (slug) { s.delete('p:' + slug); });
      keys.forEach(function (k) { s.put(JSON.parse(snap[k]), k); });
      return done(tx).then(function () {
        Object.keys(put).forEach(function (slug) { self.last[slug] = put[slug]; });
        del.forEach(function (slug) { delete self.last[slug]; });
        self.post({ slugs: Object.keys(put), removed: del, keys: keys });
        self.persist();
        return true;
      }, function () { return false; });
    });
  };
  // Without IndexedDB: localStorage as before, the reviews first and the sync record only after them.
  Store.prototype.writeLs = function (snap) {
    var self = this, ns = this.ns;
    try {
      if (snap.put || snap.del) {
        var all = lsGet(ns + 'projects') || {};
        Object.keys(snap.put || {}).forEach(function (slug) { all[slug] = JSON.parse(snap.put[slug]); });
        (snap.del || []).forEach(function (slug) { delete all[slug]; });
        localStorage.setItem(ns + 'projects', JSON.stringify(all));
        Object.keys(snap.put || {}).forEach(function (slug) { self.last[slug] = snap.put[slug]; });
        (snap.del || []).forEach(function (slug) { delete self.last[slug]; });
      }
      KEYS.forEach(function (k) { if (snap[k] != null) localStorage.setItem(ns + k, snap[k]); });
      return Promise.resolve(true);
    } catch (e) { return Promise.resolve(false); }
  };

  // What older code left in localStorage, or null: { projects, dirty, homes, cache2, bases } (each may be
  // null). Only for the IndexedDB backend; with localStorage it's the store itself.
  Store.prototype.legacy = function () {
    if (this.backend !== 'idb') return null;
    var ns = this.ns, out = {}, any = false;
    LEGACY.forEach(function (k) { var v = lsGet(ns + k); out[k] = v; if (v != null) any = true; });
    return any ? out : null;
  };
  // Remove those keys once what they held is saved here: each review is read back and compared first, and
  // a key whose contents changed since legacy() read them (another writer) is left for the next pass.
  Store.prototype.clearLegacy = function (seen, mergedProjects) {
    var self = this, ns = this.ns;
    if (this.backend !== 'idb' || !seen) return Promise.resolve(false);
    var slugs = Object.keys(mergedProjects || {});
    return this.open().then(function (db) {
      var s = db.transaction('kv', 'readonly').objectStore('kv');
      return Promise.all(slugs.map(function (slug) { return req(s.get('p:' + slug)); }));
    }).then(function (docs) {
      var ok = slugs.every(function (slug, i) { return JSON.stringify(docs[i]) === JSON.stringify(mergedProjects[slug]); });
      if (!ok) return false;
      LEGACY.forEach(function (k) {
        if (seen[k] == null) return;
        try { if (JSON.stringify(lsGet(ns + k)) === JSON.stringify(seen[k])) localStorage.removeItem(ns + k); } catch (e) { /* storage blocked */ }
      });
      return true;
    }, function () { return false; });
  };

  Store.prototype.onChange = function (fn) { this.listeners.push(fn); };
  Store.prototype.post = function (m) { if (this.channel) try { this.channel.postMessage(Object.assign({ tab: this.tab }, m)); } catch (e) { /* closed */ } };
  // Ask once for storage the browser won't clear under pressure: unsynced edits live only here.
  Store.prototype.persist = function () {
    if (this.asked) return; this.asked = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) { /* not offered */ }
  };

  var stores = {};
  root.SignoffLocal = {
    // One store per namespace in a page.
    store: function (ns) { return stores[ns] || (stores[ns] = new Store(ns)); },
    dbName: dbName,
    // Every database this module makes, for Sign out (each tool's own and demo namespaces).
    dbNames: function (namespaces) { return namespaces.map(dbName); }
  };
})(window);
