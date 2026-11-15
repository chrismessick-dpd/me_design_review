/* History, version tags, and Version comparison: one engine for every Signoff tool (Chris, 2026-11-14:
   "one engine for the history system", with EE as the reference and the rest vendored from it).

   This file is the Signoff engine's; edit it only in ee_design_review. Signoff ME and FW copy it with
   tools/sync_engine.py, Signoff PL and Loom with tools/sync_vendor.py.

   History. A sheet listing one document's changes, newest first, built from the versions of its file in
   git (GitHubStore.fileHistory) and never stored. Runs by one person fold into blocks (model.historyBlocks).
   The tool says what a change is (its rows), how to show one, and what Revert or Restore does; this file
   draws the timeline, the pane, the filters, Load older, and the version tags.

   Version tags. A synced version can be tagged with a note on what it was. Tags are records on the document
   itself, so they sync and merge like any other: doc.tags = { <id>: { id, commit, note, at, updatedAt,
   updatedBy, deleted } }. commit is the git commit holding the version (it's fetched by it, and History
   shows the tag on that version's changes); at is the version's own time.

   Version comparison. A tagged version's Compare opens a bar over the page (under the demo's) with two
   tabs, Current and the tag, that switch the page between the live document and that version, keeping the
   view. The tagged side is read-only: the tool draws the copy this file holds (view(key)) and refuses every
   edit while it shows (locked(key), isCopy(doc), refuse()). Restore this version puts it back as a new edit.

   window.SignoffHistory = { open, tags: { list, at, set, phrases, carry }, compare: { … }, fmt: { … } } */
(function (H) {
  'use strict';
  var S = window.Signoff || {};
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function listText(a) { return a.length < 3 ? a.join(' and ') : a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1]; }
  function rel(iso) {
    var s = (Date.now() - Date.parse(iso)) / 1000;
    if (!(s >= -60)) return '';
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function clock(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function dayOf(iso) {
    var d = new Date(iso), t = new Date();
    if (isNaN(d)) return '';
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function initials(name) {
    var w = String(name || '?').replace(/^@/, '').trim().split(/[\s._-]+/).filter(Boolean);
    return ((w[0] || '?').charAt(0) + (w.length > 1 ? w[w.length - 1].charAt(0) : (w[0] || '').charAt(1))).toUpperCase();
  }
  var TAG_ICON = '<svg class="hist-tagico" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5V3.2c0-.4.3-.7.7-.7h5.3l5 5-6 6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="5.6" cy="5.6" r="1.1" fill="currentColor"/></svg>';
  var SHA = /^[0-9a-f]{7,40}$/;

  // ── Version tags ──
  // The live tags of a document, newest version first. Anything that isn't a tag record is ignored.
  function tagList(doc) {
    var m = doc && doc.tags && typeof doc.tags === 'object' && !Array.isArray(doc.tags) ? doc.tags : {};
    return Object.keys(m).map(function (k) { return m[k]; })
      .filter(function (t) { return t && typeof t === 'object' && !t.deleted && typeof t.commit === 'string' && SHA.test(t.commit); })
      .map(function (t) { return { id: String(t.id || ''), commit: t.commit, note: String(t.note || '').slice(0, 200), at: String(t.at || ''), updatedAt: String(t.updatedAt || ''), updatedBy: String(t.updatedBy || '') }; })
      .sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }
  function tagAt(doc, commit) { return commit ? tagList(doc).filter(function (t) { return t.commit === commit; })[0] || null : null; }
  // The document's tags with one version's tag set (note given) or removed (note null, a tombstone), as a
  // new map; v: { commit, at }.
  function setTag(doc, v, note, user) {
    var m = JSON.parse(JSON.stringify(doc && doc.tags && typeof doc.tags === 'object' && !Array.isArray(doc.tags) ? doc.tags : {}));
    var was = tagAt(doc, v.commit), id = was ? was.id : (S.model ? S.model.uid('t') : 't' + Date.now().toString(36));
    if (note == null) { if (!was) return m; m[id] = Object.assign({}, m[id], { deleted: true }); }
    else m[id] = { id: id, commit: v.commit, note: String(note).slice(0, 200), at: String(v.at || '') };
    m[id].updatedAt = new Date().toISOString(); m[id].updatedBy = user || '';
    return m;
  }
  // What a change did to the tags, for a tool whose History compares whole documents (Loom):
  // [{ verb: 'tagged a version', what: '“EVT build”' }].
  function tagPhrases(a, b) {
    if (!a || !b) return [];
    var A = {}, B = {}, out = [];
    tagList(a).forEach(function (t) { A[t.id] = t; });
    tagList(b).forEach(function (t) { B[t.id] = t; });
    Object.keys(B).forEach(function (k) {
      var o = A[k], t = B[k];
      if (!o) out.push({ verb: 'tagged a version', what: '“' + t.note + '”' });
      else if (o.note !== t.note) out.push({ verb: 'renamed a tag', what: '“' + o.note + '” to “' + t.note + '”' });
    });
    Object.keys(A).forEach(function (k) { if (!B[k]) out.push({ verb: 'removed the tag', what: '“' + A[k].note + '”' }); });
    return out;
  }
  // A version put back keeps the tags the document has now: tags name versions, not edits.
  function carry(doc, cur) {
    if (!doc) return doc;
    if (cur && cur.tags && typeof cur.tags === 'object') doc.tags = JSON.parse(JSON.stringify(cur.tags)); else delete doc.tags;
    return doc;
  }

  // ── Version comparison ──
  // One per page. The tool sets it up once:
  //   setup({ render(), toast(text, isError), fresh(key, obj) -> document to draw, restore(key, older, tag)
  //           -> true if done, word(key) -> 'board', note(key) -> extra words for the tagged side })
  // A key names one document ('pmw…', or 'system|s…' in Loom).
  var C = null, host = {}, refusedAt = 0;
  function setup(h) { host = h || {}; }
  function active() { return !!C; }
  function view(key) { return C && C.side === 'tag' && C.key === key ? C.doc : null; }
  function locked(key) { return !!view(key); }
  function isCopy(doc) { return !!C && !!doc && doc === C.doc; }
  function refuse() {
    if (Date.now() - refusedAt > 1500 && host.toast) host.toast('This is the tagged version, so it’s read-only. Switch to Current to edit, or Restore this version.');
    refusedAt = Date.now();
  }
  // Anything drawn or dragged into the copy is dropped: it goes back to the version as stored.
  function reset() { if (C) C.doc = host.fresh ? host.fresh(C.key, JSON.parse(C.pristine)) : JSON.parse(C.pristine); }
  function redraw() { drawBar(); if (host.render) host.render(); }
  function start(key, title, tag, doc) {
    C = { key: key, title: title || '', tag: tag, pristine: JSON.stringify(doc), doc: null, side: 'tag' };
    try { reset(); } catch (e) { C = null; drawBar(); throw e; }
    redraw();
  }
  function side(to) { if (!C || C.side === to) return; C.side = to; reset(); redraw(); }
  function exit(quiet) { if (!C) return; C = null; drawBar(); if (!quiet && host.render) host.render(); }
  // Called as the page draws: leaving the document being compared ends the comparison.
  function check(key) { if (C && C.key !== key) exit(true); }
  function restore() {
    if (!C) return;
    var word = host.word ? host.word(C.key) : 'document', older = JSON.parse(C.pristine), note = C.tag.note, key = C.key, tag = C.tag;
    if (!confirm('Put the ' + word + ' back as it was at “' + note + '”?\n\n' + (host.restoreNote ? host.restoreNote(key) + '\n\n' : '') +
      'It’s saved as a new edit by you and syncs like any other. Nothing in GitHub’s history is rewritten, and its tags stay.')) return;
    C.side = 'current';   // a restore writes the live document
    var done = host.restore ? host.restore(key, older, tag) : false;
    if (done === false) { if (host.toast) host.toast('Couldn’t restore it: open the ' + word + ' and try again.', true); C.side = 'tag'; reset(); redraw(); return; }
    exit();
  }
  function bar() {
    var b = document.getElementById('compare-bar');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'compare-bar'; b.className = 'compare-bar'; b.hidden = true;
    b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Version comparison');
    var demo = document.getElementById('demo-banner');
    if (demo && demo.parentNode) demo.parentNode.insertBefore(b, demo.nextSibling); else document.body.insertBefore(b, document.body.firstChild);
    b.addEventListener('click', function (e) {
      var x = e.target.closest && e.target.closest('[data-cmp]'); if (!x) return;
      var a = x.getAttribute('data-cmp');
      if (a === 'current' || a === 'tag') side(a);
      else if (a === 'restore') restore();
      else if (a === 'exit') exit();
    });
    return b;
  }
  function drawBar() {
    var b = bar(), tagSide = !!C && C.side === 'tag';
    document.body.classList.toggle('has-compare', !!C);
    document.body.classList.toggle('on-tagged', tagSide);
    b.hidden = !C;
    if (!C) { b.innerHTML = ''; return; }
    var extra = tagSide && host.note ? host.note(C.key) : '';
    var note = tagSide ? 'Viewing the tagged version · read-only' + (extra ? '. ' + extra : '') : 'Viewing the current version';
    var when = C.tag.at ? new Date(C.tag.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    b.className = 'compare-bar' + (tagSide ? ' on-tag' : '');
    b.innerHTML = '<span class="cmp-title">' + TAG_ICON.replace('hist-tagico', 'cmp-ico') + 'Version comparison</span>' +
      '<span class="cmp-what">' + esc(C.title) + '</span>' +
      '<span class="cmp-tabs" role="tablist" aria-label="Show">' +
        '<button role="tab" data-cmp="current" aria-selected="' + !tagSide + '">Current</button>' +
        '<button role="tab" data-cmp="tag" aria-selected="' + tagSide + '" title="' + esc(C.tag.note + (when ? ' · ' + when : '')) + '"><span class="cmp-tag">' + esc(C.tag.note || 'Tagged version') + '</span>' + (when ? '<span class="cmp-date">' + esc(when) + '</span>' : '') + '</button>' +
      '</span><span class="cmp-note" title="' + esc(note) + '">' + esc(note) + '</span>' +
      '<span class="cmp-acts">' + (tagSide ? '<button class="cmp-btn" data-cmp="restore">Restore this version…</button>' : '') +
      '<button class="cmp-btn cmp-x" data-cmp="exit" title="End the comparison" aria-label="End the comparison">Done</button></span>';
  }

  // ── The History sheet ──
  // host: {
  //   title, word ('board'), demo, demoNote,
  //   mount() -> the sheet element (a .sheet in its wrap), unmount(),
  //   store: a GitHubStore or null, repo: 'owner/repo' (for commit links), path: the file, cache: {} per repo,
  //   noStore: what to say when there's no store,
  //   parse(text) -> the version's document, or null when the file isn't one,
  //   live() -> the document as it is now (never a compared copy),
  //   rows(versions, complete) -> rows from [{ doc, commit }] (newest first),
  //   unsynced(live, newest) -> this browser's rows not synced yet (newest: the newest version's doc, or null),
  //   demoRows(live) -> rows for the demo, which has no git,
  //   intro(rows) -> the sheet's line under its title, empty -> what an empty list says,
  //   filters: [[key, label]], filter(row, key) -> shown,
  //   person(by) -> how a name shows, counts(rows) -> a block's count line,
  //   row(r) -> { kind, label, sub } for a row in an open block (sub is HTML),
  //   change(r, k) -> { title, meta, body, acts } for the pane (body and acts are HTML; buttons
  //                   data-h="<act>" data-r="<k>" call act),
  //   act(name, row, api) -> a tool button, api: { rows(), draw(), rebuild(), addRow(row), close() },
  //   tags: true when versions can be tagged here,
  //   writeTags(map) -> true when written (an edit to the live document),
  //   compareKey, compareTitle: the comparison's key and title for this document }
  // Each row: { at, by, commit: { sha, at, login } | null (not synced) | undefined (demo), … }.
  function open(host) {
    var st = { rows: [], versions: [], page: 0, more: !host.demo, loading: false, error: '', filter: 'all', gap: 2 * 3600e3, open: {}, sel: null };
    var box = host.mount();
    box.classList.add('hist-sheet');
    var M = S.model, person = host.person || function (by) { return by || 'Someone'; };
    var TAGS = !!host.tags && !host.demo;
    function tagOf(r) { return TAGS && r.commit && r.commit.sha ? tagAt(host.live(), r.commit.sha) : null; }
    function shown() {
      return st.rows.filter(function (r) { return st.filter === 'all' ? true : st.filter === 'tagged' ? !!tagOf(r) : host.filter(r, st.filter); });
    }
    function chip(t) { return '<span class="hist-tag hist-vtag" title="' + esc(t.note) + '">' + TAG_ICON + esc(t.note) + '</span>'; }
    function where(r) {
      return r.commit ? 'synced in <a href="https://github.com/' + esc(host.repo) + '/commit/' + esc(r.commit.sha) + '" target="_blank" rel="noopener"><code>' + esc(r.commit.sha.slice(0, 7)) + '</code></a>' +
        (r.commit.login ? ' by @' + esc(r.commit.login) : '') : r.commit === null ? 'not synced yet' : '';
    }
    // The version a change is in: its tag, or Tag this version… once it's on GitHub.
    function versionBox(r, k) {
      if (!TAGS || !r.commit || !r.commit.sha) return '';
      var t = tagOf(r), sha = esc(r.commit.sha.slice(0, 7));
      if (!t) return '<div class="hist-vbox hist-vnone"><span class="muted">Version <code>' + sha + '</code></span><span class="hist-vacts"><button class="btn btn-sm" data-h="tag" data-r="' + k + '">' + TAG_ICON + 'Tag this version…</button></span></div>';
      return '<div class="hist-vbox">' + chip(t) + '<span class="muted">' + esc('Version ' + r.commit.sha.slice(0, 7) + ', tagged' + (t.updatedBy ? ' by ' + t.updatedBy : '') + (t.updatedAt ? ', ' + rel(t.updatedAt) : '')) + '</span>' +
        '<span class="hist-vacts"><button class="btn btn-sm btn-primary" data-h="compare" data-r="' + k + '">Compare</button><button class="btn btn-sm" data-h="tag" data-r="' + k + '">Edit note…</button><button class="btn btn-sm" data-h="untag" data-r="' + k + '">Remove tag</button></span></div>';
    }
    function paneHtml() {
      var s = st.sel;
      if (!s) return '<p class="note">Pick a block or a change to see what it did' + (TAGS ? ', and to tag its version' : '') + '.</p>';
      var rows = s.row != null ? [st.rows[s.row]] : ((M.historyBlocks(shown(), st.gap).filter(function (b) { return b.by + '|' + b.end === s.block; })[0]) || { rows: [] }).rows;
      var seen = {};
      return rows.map(function (r) {
        var k = st.rows.indexOf(r), c = host.change(r, k) || {}, sha = r.commit && r.commit.sha, vb = sha && !seen[sha] ? versionBox(r, k) : '';
        if (sha) seen[sha] = 1;
        var meta = [person(r.by) + ' · ' + clock(r.at) + ', ' + rel(r.at)].concat(c.meta ? [c.meta] : []).map(esc).join(' · ');
        return vb + '<div class="hist-chg"><h3>' + esc(c.title || '') + '</h3><p class="hist-meta">' + meta + (where(r) ? ' · ' + where(r) : '') + '</p>' +
          (c.body || '') + (c.acts ? '<div class="hist-acts">' + c.acts + '</div>' : '') + '</div>';
      }).join('');
    }
    function draw() {
      var blocks = M.historyBlocks(shown(), st.gap), last = '', html = '';
      blocks.forEach(function (b) {
        var d = dayOf(b.end);
        if (d !== last) { html += '<li class="hist-day">' + esc(d) + '</li>'; last = d; }
        var key = b.by + '|' + b.end, isOpen = !!st.open[key], unsynced = b.rows.every(function (r) { return r.commit === null; });
        var span = clock(b.start) !== clock(b.end) ? clock(b.start) + '–' + clock(b.end) : clock(b.end);
        var tags = [], seenTag = {};
        b.rows.forEach(function (r) { var t = tagOf(r); if (t && !seenTag[t.id]) { seenTag[t.id] = 1; tags.push(t); } });
        html += '<li class="hist-blk' + (isOpen ? ' open' : '') + (st.sel && st.sel.block === key ? ' sel' : '') + '">' +
          '<span class="hist-node" aria-hidden="true">' + esc(initials(b.by)) + '</span>' +
          '<button class="hist-head" data-h="block" data-k="' + esc(key) + '" aria-expanded="' + isOpen + '"><span class="hist-who">' + esc(person(b.by)) + '</span>' +
          (unsynced ? '<span class="hist-tag">Not synced yet</span>' : '') + (host.blockTags ? host.blockTags(b.rows) : '') + tags.map(chip).join('') +
          '<span class="hist-when">' + esc(span + ' · ' + rel(b.end)) + '</span><span class="hist-counts">' + esc(host.counts(b.rows)) + '</span></button>' +
          (isOpen ? '<ul class="hist-rows">' + b.rows.map(function (r) {
            var k = st.rows.indexOf(r), x = host.row(r) || {}, t = tagOf(r);
            return '<li><button class="hist-row' + (st.sel && st.sel.row === k ? ' sel' : '') + '" data-h="row" data-r="' + k + '">' + (x.kind ? '<span class="hist-kind">' + esc(x.kind) + '</span>' : '') +
              '<span class="hist-what">' + esc(x.label) + (x.sub ? ' ' + x.sub : '') + (t ? ' ' + chip(t) : '') + '</span><time>' + esc(clock(r.at)) + '</time></button></li>';
          }).join('') + '</ul>' : '') + '</li>';
      });
      var nTags = TAGS ? tagList(host.live()).length : 0;
      var filters = (host.filters || [['all', 'Everything']]).concat(TAGS ? [['tagged', 'Tagged' + (nTags ? ' (' + nTags + ')' : '')]] : []);
      var foot = st.loading ? '<p class="note">Reading the ' + esc(host.word) + '’s history from GitHub…</p>'
        : st.error ? '<p class="note">' + esc(st.error) + '</p>'
        : st.more ? '<button class="btn" data-h="older">Load older</button>'
        : st.rows.length ? '<p class="note">' + esc(host.demo ? host.demoNote : 'That’s the whole history.') + '</p>' : '';
      var empty = st.loading ? '' : st.filter === 'tagged' ? '<li class="note">No tagged versions' + (st.more ? ' among those read so far' : '') + '. Pick a synced change, then Tag this version… to name it.</li>'
        : '<li class="note">' + esc(host.empty ? host.empty(st.filter) : 'No changes yet.') + '</li>';
      box.innerHTML = '<div class="sheet-head"><h2>History · ' + esc(host.title) + '</h2><p>' + esc(host.intro(st.rows)) + '</p></div>' +
        '<div class="hist-bar"><div class="seg" role="group" aria-label="Show">' + filters.map(function (f) {
          return '<button data-h="filter" data-f="' + esc(f[0]) + '" aria-pressed="' + (st.filter === f[0]) + '">' + esc(f[1]) + '</button>';
        }).join('') + '</div><label class="hist-gap">Fold runs within <select data-h="gap">' + [[30, '30 min'], [120, '2 h'], [1440, '1 day'], [0, 'Never']].map(function (o) {
          return '<option value="' + o[0] * 6e4 + '"' + (st.gap === o[0] * 6e4 ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></label></div>' +
        '<div class="hist-grid"><div class="hist-col"><ol class="hist-tl">' + (html || empty) + '</ol>' + foot + '</div>' +
        '<div class="hist-col hist-pane">' + paneHtml() + '</div></div>' +
        '<div class="sheet-foot"><button class="btn" data-h="close">Close</button></div>';
    }
    function sortRows(a) { return a.sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : 0; }); }
    // The rows: this browser's edits not synced yet, then the versions read so far.
    function rebuild() {
      var newest = st.versions[0];
      var mine = host.unsynced(host.live(), newest ? newest.doc : null) || [];
      mine.forEach(function (r) { r.commit = null; });
      st.rows = sortRows(mine.concat(host.rows(st.versions, !st.more)));
    }
    function load() {
      if (host.demo) { st.rows = sortRows(host.demoRows(host.live())); st.rows.forEach(function (r) { r.commit = undefined; }); st.more = false; draw(); return; }
      if (!host.store) { st.more = false; st.error = host.noStore || 'Sign in to GitHub to see the history.'; draw(); return; }
      st.loading = true; st.error = ''; draw();
      host.store.fileHistory(host.path, { page: st.page + 1, perPage: 15, cache: host.cache }).then(function (got) {
        st.page++;
        got.versions.forEach(function (v) {
          var doc = null; try { doc = v.text ? host.parse(v.text) : null; } catch (e) { doc = null; }
          if (doc) st.versions.push({ doc: doc, commit: v.commit });
        });
        st.more = got.more;
        rebuild();
        st.loading = false; draw();
      }, function (err) { st.loading = false; st.error = 'Couldn’t read the history from GitHub: ' + (err.message || 'unknown error'); draw(); });
    }
    function tag(r, remove) {
      var t = tagOf(r), note = null;
      if (!remove) {
        note = prompt(t ? 'Change this version’s note:' : 'Tag this version with a note on what it was (for example “Sent for the EVT build”):', t ? t.note : '');
        if (note == null || !note.trim()) return;
        note = note.trim();
      } else if (!confirm('Remove the tag “' + t.note + '”? The version itself stays in the history.')) return;
      var v = { commit: r.commit.sha, at: r.commit.at || r.at };
      if (!host.writeTags(setTag(host.live(), v, note, host.user ? host.user() : ''))) return;
      rebuild();
      var k = -1; st.rows.forEach(function (x, i) { if (k < 0 && x.commit && x.commit.sha === v.commit) k = i; });
      st.sel = k >= 0 ? { row: k } : null;
      draw();
    }
    function compare(r, btn) {
      var t = tagOf(r); if (!t) return;
      if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
      host.store.fileAt(host.path, t.commit).then(function (text) {
        var doc = null; try { doc = host.parse(text); } catch (e) { doc = null; }
        if (!doc) throw new Error('that version can’t be drawn by this page (its format is older)');
        start(host.compareKey, host.compareTitle || host.title, t, doc);
        close();
      }).catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Compare'; }
        if (host.toast) host.toast('Couldn’t open that version: ' + (e.message || e), true);
      });
    }
    var api = {
      rows: function () { return st.rows; }, draw: draw, rebuild: rebuild, close: close,
      addRow: function (row) { st.rows.unshift(row); st.sel = { row: 0 }; draw(); }
    };
    function close() { document.removeEventListener('keydown', onKey); if (host.unmount) host.unmount(); }
    function onKey(e) { if (e.key === 'Escape' && document.body.contains(box)) { e.preventDefault(); close(); } }
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-h]'); if (!b) return;
      var h = b.getAttribute('data-h'), r = st.rows[+b.getAttribute('data-r')];
      if (h === 'close') close();
      else if (h === 'filter') { st.filter = b.getAttribute('data-f'); st.sel = null; draw(); }
      else if (h === 'block') { var k = b.getAttribute('data-k'); st.open[k] = !st.open[k]; st.sel = { block: k }; draw(); }
      else if (h === 'row') { st.sel = { row: +b.getAttribute('data-r') }; draw(); }
      else if (h === 'older') load();
      else if (h === 'tag') tag(r);
      else if (h === 'untag') tag(r, true);
      else if (h === 'compare') compare(r, b);
      else if (host.act) host.act(h, r, api);
    });
    box.addEventListener('change', function (e) { if (e.target.getAttribute('data-h') === 'gap') { st.gap = +e.target.value; st.open = {}; st.sel = null; draw(); } });
    document.addEventListener('keydown', onKey);
    load();
    return api;
  }

  H.open = open;
  H.tags = { list: tagList, at: tagAt, set: setTag, phrases: tagPhrases, carry: carry };
  H.compare = { setup: setup, active: active, view: view, locked: locked, isCopy: isCopy, refuse: refuse, reset: reset, start: start, side: side, exit: exit, check: check, restore: restore, drawBar: drawBar, state: function () { return C; } };
  H.fmt = { esc: esc, rel: rel, clock: clock, day: dayOf, initials: initials, listText: listText, TAG_ICON: TAG_ICON };
})(window.SignoffHistory = window.SignoffHistory || {});
