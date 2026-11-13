/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff app: state, storage, rendering, and interaction. */
(function (S) {
  'use strict';
  var M = S.model;
  var C = S.config, W = C.words || {};
  // One review is a board (EE) or a part (ME); a "project" is the client project it belongs to.
  var UNIT = W.unit || 'review', UNITS = W.units || UNIT + 's';
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ── Storage ──────────────────────────────────────────────
  // Each tool keeps its data under its own namespace (assets/config.js). The token and the
  // light/dark theme are shared by the whole suite, so they live under fixed keys.
  var DEMO = /[?&]demo\b/.test(location.search) || location.hash === '#demo';
  // ?page=people&embed=1 inside a frame: only People & access, for the suite's People sheet
  // (signoff/assets/people.js) opened from another tool. No sidebar, toolbar, or demo.
  var EMBED = !DEMO && /[?&]embed=1\b/.test(location.search) && window.parent !== window;
  if (EMBED) document.documentElement.classList.add('embed');
  var PEOPLE = window.SignoffPeople && !EMBED ? window.SignoffPeople : null;
  var NS = DEMO ? C.storage.demoNs : C.storage.ns;
  var TOKEN_KEY = 'signoff.token';
  var THEME_KEY = 'signoff.v1.settings';   // .theme; Fabcheck and the hub read it too

  function load(key, fallback) {
    try { var v = localStorage.getItem(NS + key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) { toast('Couldn’t save in this browser: ' + e.message); }
  }
  // Tokens never contain spaces; copying one from a web page or document can pick up line
  // breaks or invisible characters, which GitHub then rejects as "Bad credentials".
  function cleanToken(t) { return String(t || '').replace(/[\s​-‍⁠﻿]/g, ''); }
  function getToken() {
    try { return cleanToken(sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''); } catch (e) { return ''; }
  }
  function setToken(token, remember) {
    token = cleanToken(token);
    try {
      sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY);
      if (token) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
    } catch (e) { /* storage blocked */ }
  }

  function sharedTheme() {
    try { return (JSON.parse(localStorage.getItem(THEME_KEY) || '{}') || {}).theme || ''; } catch (e) { return ''; }
  }
  function saveSharedTheme(theme) {
    try { var o = JSON.parse(localStorage.getItem(THEME_KEY) || '{}') || {}; o.theme = theme; localStorage.setItem(THEME_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked */ }
  }

  // owner: the GitHub account or organization that holds every repository.
  // toolRepo: the tool and checklists. dataRepo: internal reviews and People (FTEs only).
  // prefix: name prefix for the private repos of projects shared with contractors.
  // suiteRepos: the rest of the suite FTEs are invited to; always taken from the config.
  var DEFAULT_SETTINGS = { user: '', owner: C.repos.owner, toolRepo: C.repos.toolRepo, dataRepo: C.repos.dataRepo, dataPath: '', prefix: C.repos.prefix, branch: 'main', templatePath: 'templates', theme: 'auto' };
  // sharedPrefixes: every tool's shared repo prefix; FTEs are invited to all of those repos too.
  var settings = Object.assign({}, DEFAULT_SETTINGS, load('settings', {}), { suiteRepos: (C.repos.suite || []).slice(), sharedPrefixes: (C.repos.sharedPrefixes || []).slice(),
    plRepo: (C.pl && C.pl.dataRepo) || '', plTool: (C.pl && C.pl.tool) || '' });
  settings.theme = sharedTheme() || settings.theme || 'auto';
  if (!settings.user && !DEMO) {
    // First visit to this tool: reuse the name given in another Signoff tool (EE's settings).
    try { settings.user = (JSON.parse(localStorage.getItem(THEME_KEY) || '{}') || {}).user || ''; } catch (e) { /* ignore */ }
  }
  if (settings.repo) {
    // Before the data repo existed, reviews lived in the tool repo's data/ folder.
    settings.toolRepo = settings.repo; settings.dataRepo = DEFAULT_SETTINGS.dataRepo; settings.dataPath = '';
    delete settings.repo; save('settings', settings);
  }
  var projects = load('projects', {});      // slug -> project document (working copy)
  var dirty = load('dirty', {});            // project id (or 'roster') -> time of last unsynced edit
  var homes = load('homes', {});            // project id -> 'owner/repo' it lives in
  var cache = load('cache2', {});           // 'owner/repo' -> { path: { sha } } as of the last sync
  var dataAccess = load('dataAccess', '');  // 'ok' (FTE) | 'none' (contractor) | '' (not synced yet)
  var roster = Object.assign(M.emptyRoster(), load('roster', {}));   // users.json from the data repo
  if (settings.prefix === 'review-' && settings.prefix !== C.repos.prefix && !Object.keys(roster.shared || {}).length) {
    // Shared repos used to be review-<project> for EE. Each tool now has its own prefix, so a
    // contractor's sync never picks up the other discipline's repos.
    settings.prefix = C.repos.prefix; save('settings', settings);
  }
  Object.keys(dirty).forEach(function (k) { if (projects[k]) { dirty[projects[k].id] = dirty[k]; delete dirty[k]; } });
  (function () {   // a change marker for a project that isn't here has nothing to sync
    var ids = {}; Object.keys(projects).forEach(function (k) { ids[projects[k].id] = 1; });
    var gone = Object.keys(dirty).filter(function (k) { return k !== 'roster' && !ids[k]; });
    gone.forEach(function (k) { delete dirty[k]; });
    if (gone.length) save('dirty', dirty);
  })();
  var pulledTemplates = load('templates', []);
  var lastSync = load('lastSync', null);    // { at, version, errors }
  var invitations = load('invitations', []);   // repository invitations waiting for this user
  var plRead = load('pl', null);               // Signoff PL's projects, slimmed (workspace.js readPl): From Signoff PL
  // Unsynced FTE work in this browser while a contractor's token is in use: kept out of sight
  // and pushed when an FTE syncs here again. { projects: { id: doc }, roster: roster | null }
  var held = load('held', { projects: {}, roster: null });
  var ui = Object.assign({ slug: '', view: 'overview', filter: 'all', query: '', showArchived: false }, load('ui', {}));

  var TEMPLATES, INDEX;
  function refreshTemplates() {
    TEMPLATES = M.resolveTemplates(window.SIGNOFF_TEMPLATES || [], pulledTemplates);
    INDEX = M.indexTemplates(TEMPLATES);
  }
  refreshTemplates();

  // Demo projects have fixed ids so other tools (Signoff PL's demo) can link to them. A demo
  // built by an older version is rebuilt.
  if (DEMO && S.demo && (!Object.keys(projects).length || load('demoVersion', 0) !== S.demo.VERSION)) {
    projects = {};
    S.demo.projects(TEMPLATES).forEach(function (p) { projects[p.slug] = p; });
    save('demoVersion', S.demo.VERSION);
    save('projects', projects);
  }
  // The demo asks for the visitor's name on first opening (see Start). Older demos filled in
  // this placeholder instead; it counts as no name.
  var DEMO_USER = 'Demo Reviewer';
  if (DEMO && settings.user === DEMO_USER) { settings.user = ''; save('settings', settings); }
  if (DEMO && !settings.user) {
    // First visit to this tool's demo: reuse the name given in another tool's demo (EE, ME, FW),
    // so a visitor moving through the suite is asked once.
    try {
      Object.keys(localStorage).some(function (k) {
        if (!/\.demo\.settings$/.test(k)) return false;
        var u = (JSON.parse(localStorage.getItem(k) || '{}') || {}).user;
        if (typeof u === 'string' && u.trim() && u !== DEMO_USER) { settings.user = u.trim().slice(0, 100); save('settings', settings); return true; }
        return false;
      });
    } catch (e) { /* storage blocked */ }
  }
  // A tab still running an older demo can write its copies of the sample projects back (other
  // ids, same names). Drop them, here and whenever another tab writes, so a sample project
  // never shows twice. Projects a visitor created in the demo are kept.
  function dropStaleDemo(map) {
    if (!DEMO || !S.demo) return map;
    var ids = {}, names = {};
    ((C.demo || {}).projects || []).forEach(function (d) { ids[S.demo.id(d.seed)] = 1; names[d.fields.name] = 1; });
    var out = {};
    Object.keys(map || {}).forEach(function (k) {
      var d = map[k];
      if (d && d.meta && names[d.meta.name] && !ids[d.id]) return;
      out[k] = d;
    });
    return out;
  }
  // ...and put back any sample project such a tab replaced, so none goes missing either.
  if (DEMO && S.demo) {
    var cleaned = dropStaleDemo(projects), have = {}, fixed = Object.keys(cleaned).length !== Object.keys(projects).length;
    Object.keys(cleaned).forEach(function (k) { have[cleaned[k].id] = 1; });
    S.demo.projects(TEMPLATES).forEach(function (p) {
      if (have[p.id]) return;
      var key = p.slug, n = 2;
      while (cleaned[key]) key = p.slug + '-' + n++;
      cleaned[key] = p; fixed = true;
    });
    if (fixed) { projects = cleaned; save('projects', projects); }
  }

  function persist() { save('projects', projects); save('dirty', dirty); save('roster', roster); save('homes', homes); }

  // ── People and access ────────────────────────────────────
  // GitHub decides what each person can open. An FTE's token reaches the data repo; a
  // contractor's reaches only the review-* repos of their projects, so their copy of
  // Signoff never sees anything else. Without a token nothing real is shown (copies stay in
  // the browser until a token comes back or Sign out clears them). With one, nothing is
  // shown until a sync tells who it belongs to: after a token change the browser may hold
  // another person's copy.
  function signedOut() { return !DEMO && !getToken(); }
  function checking() { return !DEMO && !!getToken() && !dataAccess; }
  function myRole() {
    if (DEMO) return 'fte';
    if (signedOut()) return 'signedout';
    if (dataAccess === 'ok') return 'fte';
    return checking() ? 'checking' : 'contractor';
  }
  function isFte() { return myRole() === 'fte'; }
  function isOwner() { return !!settings.login && settings.login === String(settings.owner).toLowerCase(); }
  // The token is shared by every Signoff tool, so it can change outside this one's Settings.
  // A different token may be a different person: who it is, and their role, are found again at
  // the next sync. Other tools read `tokenTag` and `dataAccess` to tell whether this browser's
  // token is an FTE's (Signoff PL, Fabcheck, and the hub show People & access then).
  function noticeToken() {
    var tag = getToken() ? M.tokenTag(getToken()) : '';
    if ((settings.tokenTag || '') === tag) return false;
    settings.tokenTag = tag; settings.login = ''; save('settings', settings);
    dataAccess = ''; save('dataAccess', dataAccess); accessMap = {}; suiteShared = []; suiteListed = false; save('suiteShared', suiteShared);
    invitations = []; save('invitations', invitations);
    plRead = null; save('pl', null);
    return true;
  }
  function visible() { return !checking() && !signedOut(); }
  function visibleProjects() { return visible() ? Object.keys(projects).map(function (k) { return projects[k]; }) : []; }
  function workspace() { return new S.Workspace(settings, getToken(), undefined, function (doc) { return M.projectSummary(doc, TEMPLATES); }); }
  function homeOf(p) { return M.sharedRepo(roster, p.id) || homes[p.id] || settings.owner + '/' + settings.dataRepo; }
  function touchRoster() { dirty.roster = M.now(); persist(); renderSyncState(); renderToolbar(); }
  function setPerson(login, fields) {
    login = String(login || '').trim().replace(/^@/, '').toLowerCase();
    if (!login) return;
    var prev = roster.users[login] || { login: login, name: '', role: 'contractor', projects: [] };
    roster.users[login] = M.stamp(Object.assign({}, prev, fields, { login: login }), me());
    touchRoster();
  }
  function assignedContractors(projectId) {
    return M.liveUsers(roster).filter(function (u) { return M.isOutside(u) && (u.projects || []).indexOf(projectId) >= 0; });
  }
  function saveUi() { save('ui', { slug: ui.slug, view: ui.view, filter: ui.filter, showArchived: ui.showArchived, sideCollapsed: !!ui.sideCollapsed, reqFilter: ui.reqFilter || 'all', closedGroups: ui.closedGroups || {}, home: !!ui.home }); }
  // Close the open review and show the home screen; it stays there on reload (ui.home).
  function goHome() {
    ui.slug = ''; ui.view = 'overview'; ui.page = ''; ui.query = ''; ui.filter = 'all'; ui.home = true; selected = null;
    closeInspector(); saveUi(); render(); $('#main').scrollTop = 0;
  }
  // The sidebar slides over the page on narrow windows; on wide ones it collapses away and
  // stays that way until opened again.
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 860px)') : { matches: false };
  function toggleSidebar() {
    if (narrow.matches) { $('#app').classList.toggle('nav-open'); return; }
    ui.sideCollapsed = !ui.sideCollapsed;
    $('#app').classList.toggle('side-collapsed', ui.sideCollapsed);
    saveUi();
  }
  // On a narrow window a tap outside the open menu (on its scrim, styles.css) closes it and goes
  // no further, as in Loom and the hub.
  document.addEventListener('click', function (e) {
    var app = $('#app');
    if (!app.classList.contains('nav-open') || e.target !== app) return; // the scrim is #app's ::after
    app.classList.remove('nav-open'); e.preventDefault(); e.stopPropagation();
  }, true);

  // ── Small helpers ────────────────────────────────────────
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function plural(n, word, many) { return n + ' ' + (n === 1 ? word : (many || word + 's')); }
  function relTime(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function hue(name) { var h = 0; for (var i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360; return h; }
  function me() { return settings.user || (DEMO ? DEMO_USER : 'Anonymous'); }

  var ICON = {
    check: '<svg class="i-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>',
    bang: '<svg class="i-bang" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 2.5v4.2M6 9.3v.1"/></svg>',
    dash: '<svg class="i-dash" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h6"/></svg>',
    chev: '<svg class="sec-chev" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.2L7 8.8l3.5-3.6"/></svg>',
    bubble: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.2 3.2a1.5 1.5 0 011.5-1.5h6.6a1.5 1.5 0 011.5 1.5v4.6a1.5 1.5 0 01-1.5 1.5H6l-2.8 2.4V9.3h0a1.5 1.5 0 01-1-1.5z" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5" stroke-linecap="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    more: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="5" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/></svg>',
    doc: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5"/></svg>',
    sync: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 8a6 6 0 00-10.6-2.6L4 7M4 12a6 6 0 0010.6 2.6L16 13"/><path d="M4 3.5V7h3.5M16 16.5V13h-3.5"/></svg>',
    undo: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5L3.5 8 7 11.5"/><path d="M3.5 8H12a4.5 4.5 0 010 9H8"/></svg>',
    moon: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M16.2 12.4A6.6 6.6 0 017.6 3.8a6.6 6.6 0 108.6 8.6z"/></svg>',
    sun: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v1.8M10 16.2V18M2 10h1.8M16.2 10H18M4.3 4.3l1.3 1.3M14.4 14.4l1.3 1.3M15.7 4.3l-1.3 1.3M5.6 14.4l-1.3 1.3"/></svg>',
    pencil: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3L7 16H4v-3z"/><path d="M11.5 5.5l3 3"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3h6v1.5M8.5 11l2 2 4-4.5M8.5 17h7"/></svg>'
  };

  function ring(pct, size, stroke, label, sub) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r;
    // The number fits inside the ring with room to spare, sized for the widest it can show ("100"
    // or "100%") so every ring of one size matches: at most 22px, smaller in small rings (a digit
    // is about 0.6em wide; the widest text takes ~80% of the hole).
    var text = label == null ? '' : String(label);
    var fs = Math.min(22, Math.floor((size - 2 * stroke) * 0.8 / (0.6 * (/%/.test(text) ? 4 : 3))));
    var fsStyle = fs < 22 ? ' style="font-size:' + fs + 'px"' : '';
    return '<div class="ring" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg width="' + size + '" height="' + size + '"><circle class="ring-track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
      '<circle class="ring-val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '"/></svg>' +
      (label != null ? '<div class="ring-label"><div><b' + fsStyle + '>' + label + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div></div>' : '') + '</div>';
  }
  function bar(c) {
    if (!c.total) return '<div class="bar"></div>';
    return '<div class="bar"><i class="b-pass" style="width:' + (100 * c.pass / c.total) + '%"></i><i class="b-issue" style="width:' + (100 * c.issue / c.total) + '%"></i><i class="b-na" style="width:' + (100 * c.na / c.total) + '%"></i></div>';
  }

  // ── Current project helpers ──────────────────────────────
  function current() { var p = projects[ui.slug]; return p && visible(p) ? p : null; }
  function templateById(id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0]; }
  function projectTemplates(p) { return TEMPLATES.filter(function (t) { return p.meta.checklists.indexOf(t.id) >= 0; }); }

  function touch(p) {
    if (specHists[p.id]) specHistNote(p);
    dirty[p.id] = M.now();
    persist();
    renderSidebar();
    renderSyncState();
  }

  function itemDef(p, id) {
    if (INDEX.items[id]) return { def: INDEX.items[id].item, section: INDEX.items[id].section, template: INDEX.items[id].template };
    var c = p.custom[id];
    if (c) return { def: c, section: (INDEX.sections[c.section] || {}).section, template: templateById(c.checklist), custom: true };
    var st = p.items[id] || {};
    return { def: { id: id, text: st.text || '(retired item ' + id + ')', severity: 'minor' }, retired: true };
  }

  // ── Mutations ────────────────────────────────────────────
  function setItem(id, fields) {
    var p = current(); if (!p) return;
    var prev = p.items[id] || {};
    var next = Object.assign({}, prev, fields);
    // Keep the wording with the state, so a retired item still reads sensibly.
    var d = itemDef(p, id);
    if (!d.retired) { next.text = d.def.text; if (d.template) next.checklist = d.template.id; }
    p.items[id] = M.stamp(next, me());
    touch(p);
    renderPage(); renderInspector();
  }
  function setStatus(id, status) {
    var p = current(); if (!p) return;
    var prev = p.items[id] || {};
    var fields = { status: status };
    if (status === 'issue' && !prev.resolution) fields.resolution = '';
    setItem(id, fields);
  }
  function toggleSectionNA(secId) {
    var p = current(); if (!p) return;
    var prev = p.sections[secId] || {};
    p.sections[secId] = M.stamp(Object.assign({}, prev, { na: !prev.na }), me());
    touch(p); renderPage();
  }
  function addComment(itemId, text) {
    var p = current(); if (!p || !text.trim()) return;
    var id = M.uid(C.ids.comment || 'c');
    p.comments[id] = M.stamp({ id: id, item: itemId || null, author: me(), at: M.now(), text: text.trim() }, me());
    touch(p); renderPage(); renderInspector();
    // Comments are a conversation, so they go out straight away rather than at the next sync.
    syncSoon();
  }
  function deleteComment(id) {
    var p = current(); if (!p || !p.comments[id]) return;
    p.comments[id] = M.stamp(Object.assign({}, p.comments[id], { deleted: true, text: '' }), me());
    touch(p); renderPage(); renderInspector();
    syncSoon();
  }
  function addCustom(checklist, section, text) {
    var p = current(); if (!p || !text.trim()) return;
    var id = M.uid(C.ids.custom || 'x');
    p.custom[id] = M.stamp({ id: id, checklist: checklist, section: section, text: text.trim(), hint: '', severity: 'major', createdAt: M.now() }, me());
    touch(p); renderPage(); syncSoon();
    return id;
  }
  function updateMeta(fields) {
    var p = current(); if (!p) return;
    var meta = Object.assign({}, p.meta, fields);
    Object.keys(fields).forEach(function (k) { if (fields[k] === undefined) delete meta[k]; });   // undefined removes a field (meta.kind)
    p.meta = M.stamp(meta, me());
    touch(p); render();
  }

  // ── From Signoff PL ──────────────────────────────────────
  // Parts a Signoff PL project marks as a Placeholder for this tool wait here, FTEs only, until a
  // review is started from one (Chris, 2026-11-08: new things wait in a tray in the tool they belong
  // to, to be added on purpose). Start opens New design review filled in from the Part; the review
  // names it (meta.plPart, summary.plPart), and PL links the Part to it at PL's next sync.
  function plWaitingList() {
    if (DEMO || !isFte() || !plRead || !C.pl) return [];
    return M.plWaiting(plRead.projects, Object.keys(projects).map(function (k) { return projects[k]; }));
  }
  function fromPlHtml(q) {
    var list = plWaitingList().filter(function (w) { return !q || [w.name, w.number, w.projectName].join(' ').toLowerCase().indexOf(q) >= 0; });
    if (!list.length) return '';
    return '<div class="side-group from-pl"><div class="side-group-head from-pl-head" title="Parts Signoff PL is waiting on: start one to begin its review"><span class="side-group-name">From Signoff PL</span><span class="side-group-count">' + list.length + '</span></div>' +
      list.map(function (w) {
        return '<button class="proj pl-wait" data-act="pl-start" data-pl="' + esc(w.project + '/' + w.node) + '" title="' + esc('Start the review of ' + (w.name || 'this Part') + ': it opens New design review filled in from the Part, and Signoff PL links the Part to it at its next sync') + '">' +
          '<span class="pl-wait-ring" aria-hidden="true"></span><span class="proj-body"><span class="proj-name">' + esc(w.name || 'Unnamed Part') + '</span>' +
          '<span class="proj-sub">' + esc([w.number, w.projectName].filter(Boolean).join(' · ')) + '</span></span><span class="pl-wait-start">Start</span></button>';
      }).join('') + '</div>';
  }
  function startFromPl(key) {
    var w = plWaitingList().filter(function (x) { return x.project + '/' + x.node === key; })[0];
    if (!w) { toast('That Part isn’t waiting in Signoff PL any more. Sync to refresh the list.'); return; }
    projectSheet(null, { name: w.name, board: w.number, project: w.clientProject, plPart: { project: w.project, node: w.node }, from: w });
  }

  // ── Sidebar ──────────────────────────────────────────────
  function renderSidebar() {
    var q = ($('#project-search').value || '').toLowerCase();
    var list = visibleProjects()
      .filter(function (p) { return !q || [p.meta.name, p.meta.project, p.meta.client, p.meta.board].join(' ').toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (b.meta.updatedAt || '').localeCompare(a.meta.updatedAt || ''); });
    var active = list.filter(function (p) { return !p.meta.archived; });
    var archived = list.filter(function (p) { return p.meta.archived; });
    // Rows are keyed by the project's key in `projects`, not doc.slug: two projects with one
    // name share a slug, and the second is stored under a suffixed key (slug-2).
    var keyOf = new Map();
    Object.keys(projects).forEach(function (k) { keyOf.set(projects[k], k); });
    function row(p) {
      var key = keyOf.get(p);
      var st = M.projectStats(p, TEMPLATES);
      var tip = [p.meta.name, [p.meta.client, p.meta.board, p.meta.revision && 'Rev ' + p.meta.revision].filter(Boolean).join(' · '), p.meta.stage].filter(Boolean).join('\n');
      return '<button class="proj' + (key === ui.slug ? ' active' : '') + '" data-act="open-project" data-slug="' + esc(key) + '" title="' + esc(tip) + '">' +
        ring(st.pct, 26, 3.5) +
        '<span class="proj-body"><span class="proj-name">' + esc(p.meta.name) + '</span>' +
        '<span class="proj-sub">' + esc([p.meta.board, p.meta.revision && 'Rev ' + p.meta.revision].filter(Boolean).join(' · ') || p.meta.stage) + '</span></span>' +
        (dirty[p.id] ? '<span class="proj-dirty" title="Not synced yet"></span>' : '') + '</button>';
    }
    // Grouped by client project once any review has one; a group can be folded, and folding the
    // one holding the open review closes it (home). Opening a review unfolds its group, and a
    // search shows every match.
    var groups = M.projectGroups(active), closed = ui.closedGroups || {};
    var grouped = groups.length > 1 || !!(groups[0] && groups[0].name);
    var html = grouped ? groups.map(function (g) {
      var key = g.name.toLowerCase();
      var holds = g.docs.some(function (p) { return keyOf.get(p) === ui.slug; });
      var open = !closed[key] || !!q || holds;
      return '<div class="side-group"><button class="side-group-head" data-act="toggle-group" data-group="' + esc(key) + '"' + (holds ? ' data-holds-open' : '') + ' aria-expanded="' + open + '">' +
        '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="side-group-name">' + esc(g.name || 'No project') + '</span><span class="side-group-count">' + g.docs.length + '</span></button>' +
        (open ? g.docs.map(row).join('') : '') + '</div>';
    }).join('') : active.map(row).join('');
    html = html || '<div class="side-empty">' + (q ? 'No matching ' + UNITS + '.' : signedOut() ? 'Sign in to see your reviews.' : checking() ? 'Checking access…' : myRole() === 'fte' ? 'No ' + UNITS + ' yet.' : 'No ' + UNITS + ' shared with you yet.') + '</div>';
    if (archived.length) {
      html += '<div class="side-archived"><div class="side-head"><span class="side-label">Archived</span><button class="btn-plain btn" style="padding:2px 6px;font-size:12px" data-act="toggle-archived">' + (ui.showArchived ? 'Hide' : 'Show ' + archived.length) + '</button></div>' +
        (ui.showArchived ? archived.map(row).join('') : '') + '</div>';
    }
    html = fromPlHtml(q) + html;
    // The suite's shared card (signoff/assets/invites.js) lists private repos too; this one is the fallback.
    if (invitations.length && !DEMO && !window.SignoffInvites) {
      html = '<div class="invite-card"><b>' + plural(invitations.length, 'invitation') + ' from ' + esc(settings.owner) + '</b><span>' +
        invitations.map(function (i) { return esc(String(i.repo).split('/')[1]); }).join(', ') + '</span><button class="btn btn-primary" data-act="accept-invites">Accept</button></div>' + html;
    }
    $('#project-list').innerHTML = html;
    var newBtn = $('[data-act="new-project"]');
    newBtn.hidden = !isFte();
    // Fold or unfold every project group; the button sits in the Boards header beside New.
    var foldBtn = $('[data-act="fold-groups"]');
    if (!foldBtn && newBtn.parentNode) {
      foldBtn = document.createElement('button');
      foldBtn.className = 'icon-btn side-fold'; foldBtn.dataset.act = 'fold-groups';
      newBtn.parentNode.insertBefore(foldBtn, newBtn);
    }
    if (foldBtn) {
      var allClosed = grouped && groups.every(function (g) { return closed[g.name.toLowerCase()]; });
      var foldTip = (allClosed ? 'Expand' : 'Collapse') + ' all projects';
      foldBtn.hidden = !grouped || !!q;
      foldBtn.title = foldTip; foldBtn.setAttribute('aria-label', foldTip);
      foldBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        (allClosed ? '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>' : '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>') + '</svg>';
    }
    var people = $('#people-link');
    people.hidden = DEMO || !isFte();
    // Links to the rest of the suite (hub, the other Signoff tool, Fabcheck) show for everyone:
    // FTEs, contractors, and the demo. In the demo they point at the other tools' demos. A link
    // marked data-internal is for FTEs only (Signoff PL), and for everyone in the demo, whose
    // product view is Signoff PL's demo.
    var tools = $('#side-tools');
    if (tools) {
      tools.hidden = false;
      if (!tools.dataset.fold) setupToolsFold(tools);
      tools.querySelectorAll('[data-internal]').forEach(function (a) { a.hidden = !DEMO && !isFte(); });
      if (DEMO) {
        tools.querySelectorAll('a.side-link').forEach(function (a) {
          var href = a.getAttribute('href');
          if (!/[?&]demo\b/.test(href)) a.setAttribute('href', href + (href.indexOf('?') >= 0 ? '&' : '?') + 'demo');
        });
      }
    }
    people.classList.toggle('active', !!(PEOPLE && PEOPLE.isOpen()));
  }

  // The suite switcher starts folded to a row of tool icons. The chevron opens the full list,
  // which folds again 10 s after the pointer and keyboard focus have left it.
  var TOOLS_FOLD_MS = 10000;
  function setupToolsFold(tools) {
    var head = tools.querySelector('.side-head');
    if (!head) return;
    tools.dataset.fold = '1';
    var label = head.textContent.trim() || 'Dovetail Signoff';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-tools-toggle';
    btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>' +
      '<span class="side-label">' + esc(label) + '</span>';
    head.textContent = '';
    head.appendChild(btn);
    // In use while hovered, or while keyboard focus (not the focus a click leaves) is inside.
    var timer = null;
    function inUse() { return tools.matches(':hover') || !!tools.querySelector(':focus-visible'); }
    function stop() { if (timer) { clearTimeout(timer); timer = null; } }
    function arm() { stop(); if (!tools.classList.contains('folded') && !inUse()) timer = setTimeout(function () { set(true); }, TOOLS_FOLD_MS); }
    function set(folded) {
      tools.classList.toggle('folded', folded);
      var tip = (folded ? 'Show ' : 'Hide ') + label + ' tools';
      btn.setAttribute('aria-expanded', String(!folded));
      btn.title = tip; btn.setAttribute('aria-label', tip);
      if (folded) stop(); else arm();
    }
    btn.addEventListener('click', function () { set(!tools.classList.contains('folded')); });
    tools.addEventListener('mouseenter', stop);
    tools.addEventListener('mouseleave', function () { setTimeout(arm, 0); });
    tools.addEventListener('focusin', function () { if (inUse()) stop(); });
    tools.addEventListener('focusout', function () { setTimeout(arm, 0); });
    set(true);
  }

  function renderSyncState(state) {
    if (syncing && !state) state = 'busy';   // a render during a sync keeps showing it
    markSyncButtons();
    var dot = $('#sync-dot'), title = $('#sync-title'), sub = $('#sync-sub');
    var n = Object.keys(dirty).length;
    syncDetailsButton(!DEMO && n > 0 && state !== 'busy');
    sub.classList.remove('sync-who');
    // Line 1 is the sync state (and when it last synced); line 2 the GitHub account, when it's known (Chris, 2026-11-10).
    var who = settings.login && getToken() ? '@' + settings.login + (myRole() === 'contractor' ? ' (shared access)' : '') : '';
    function line2(fallback) { sub.textContent = who || fallback; if (who) sub.classList.add('sync-who'); }
    if (DEMO) { dot.dataset.tone = 'idle'; title.textContent = 'Demo mode'; sub.textContent = 'Changes stay in this browser'; return; }
    if (state === 'busy') { dot.dataset.tone = 'busy'; title.textContent = 'Syncing\u2026'; line2(settings.owner); return; }
    if (state === 'error') { dot.dataset.tone = 'error'; title.textContent = 'Sync failed'; sub.textContent = 'Click for details'; return; }
    if (!getToken()) { dot.dataset.tone = n ? 'warn' : 'idle'; title.textContent = n ? plural(n, 'unsynced change') : 'Local only'; sub.textContent = 'Set up Git sync'; return; }
    if (n) { dot.dataset.tone = 'warn'; title.textContent = plural(n, 'unsynced change'); line2('Click to sync'); return; }
    dot.dataset.tone = 'ok';
    var errs = lastSync && lastSync.errors && lastSync.errors.length;
    if (errs) { dot.dataset.tone = 'warn'; title.textContent = 'Synced with problems'; sub.textContent = lastSync.errors[0].message; return; }
    title.textContent = lastSync ? 'Synced ' + relTime(lastSync.at) : 'Ready';
    line2(lastSync ? '' : 'Click to sync');
  }

  // ── What's unsynced ─────────────────────────────────────
  // Read-only: what the dirty list holds, itemized from each project's records edited since the
  // last sync started (model.changesSince). A project with no home repo was never synced, so
  // all of it is new. A project left dirty by a failed repo may have nothing newer than that;
  // it's listed without details. Nothing here touches dirty or sync.
  var CHANGE_KIND = { meta: 'Details', check: 'Check', section: 'Section', comment: 'Comment', custom: 'Added check', req: 'Requirement', revision: 'Revision', spec: 'Scribe' };
  var CHANGES_SHOWN = 8;
  function slugOfId(id) { return Object.keys(projects).filter(function (k) { return projects[k].id === id; })[0] || ''; }
  function unsyncedList() {
    var base = lastSync ? (lastSync.startedAt || lastSync.at || '') : '';
    return Object.keys(dirty).sort(function (a, b) { return (dirty[b] || '') < (dirty[a] || '') ? -1 : 1; }).map(function (k) {
      if (k === 'roster') return { roster: true, at: dirty[k] };
      var slug = slugOfId(k), p = slug && projects[slug];
      if (!p) return { id: k, missing: true, at: dirty[k] };
      if (!visible()) return { id: k, hidden: true, at: dirty[k] };   // signed out: nothing real shows
      var fresh = !homes[k];
      return { id: k, slug: slug, name: p.meta.name, fresh: fresh, at: dirty[k], changes: M.changesSince(p, fresh ? '' : base, TEMPLATES) };
    });
  }
  function syncDetailsButton(show) {
    var pill = $('#sync-pill'), btn = $('#sync-details');
    if (!pill) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.className = 'icon-btn sync-details'; btn.id = 'sync-details'; btn.dataset.act = 'sync-details';
      btn.title = 'What isn’t synced yet'; btn.setAttribute('aria-label', 'What isn’t synced yet'); btn.setAttribute('aria-haspopup', 'true');
      btn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 5.5h9M7 10h9M7 14.5h9"/><circle cx="3.6" cy="5.5" r=".9" fill="currentColor"/><circle cx="3.6" cy="10" r=".9" fill="currentColor"/><circle cx="3.6" cy="14.5" r=".9" fill="currentColor"/></svg>';
      pill.parentNode.insertBefore(btn, pill.nextSibling);
    }
    btn.hidden = !show;
    // The pill's tooltip names what changed (plain text: set as a property, never as HTML).
    // Names only, so it stays cheap on every render; the list button has the details.
    pill.title = show ? 'Not synced yet:\n' + Object.keys(dirty).map(function (k) {
      var slug = k !== 'roster' && slugOfId(k), p = slug && projects[slug];
      return '• ' + (k === 'roster' ? 'People & access' : !p ? 'A ' + UNIT + ' not in this browser' : visible() ? p.meta.name + (homes[k] ? '' : ' (new)') : 'A ' + UNIT + ' (sign in to see it)');
    }).join('\n') + '\n\nClick to sync (Ctrl+S)' : 'Sync with GitHub (Ctrl+S)';
    if (!show && $('#menu.sync-pop')) closeMenu();
  }
  function syncDetails(anchor) {
    closeMenu();
    var groups = unsyncedList();
    var html = '<div class="sync-pop-head">' + esc(plural(groups.length, 'unsynced change')) + '<small>' + (DEMO || !getToken() ? 'Only in this browser' : 'Since the last sync' + (lastSync ? ', ' + esc(relTime(lastSync.at)) : '')) + '</small></div>';
    html += groups.map(function (g) {
      if (g.roster) return '<div class="sync-pop-group"><button data-act="people"><span class="sync-pop-name">People &amp; access</span><span class="sync-pop-sub">Edited ' + esc(relTime(g.at)) + '</span></button></div>';
      if (g.missing) return '<div class="sync-pop-group"><div class="sync-pop-note">A ' + esc(UNIT) + ' that isn’t in this browser any more</div></div>';
      if (g.hidden) return '<div class="sync-pop-group"><div class="sync-pop-note">A ' + esc(UNIT) + ' edited ' + esc(relTime(g.at)) + ' (sign in to see it)</div></div>';
      var rows = g.changes.slice(0, CHANGES_SHOWN).map(function (c) {
        return '<button data-act="goto-change" data-pid="' + esc(g.id) + '" data-kind="' + esc(c.kind) + '" data-id="' + esc(c.id) + '" data-item="' + esc(c.item) + '"' + (c.deleted ? ' data-deleted="1"' : '') + '>' +
          '<span class="sync-pop-kind">' + esc((c.deleted ? 'Deleted ' + CHANGE_KIND[c.kind].toLowerCase() : CHANGE_KIND[c.kind]) || c.kind) + '</span>' +
          '<span class="sync-pop-text">' + esc(c.label) + (c.detail ? ' <em>' + esc(c.detail) + '</em>' : '') + '</span>' +
          '<span class="sync-pop-sub">' + esc([c.by, relTime(c.at)].filter(Boolean).join(' · ')) + '</span></button>';
      }).join('');
      var more = g.changes.length > CHANGES_SHOWN ? '<div class="sync-pop-note">+ ' + esc(plural(g.changes.length - CHANGES_SHOWN, 'more change')) + '</div>' : '';
      var none = g.changes.length ? '' : '<div class="sync-pop-note">Changed, but no edits after the last sync to list (its repository may have failed then)</div>';
      return '<div class="sync-pop-group"><button data-act="goto-change" data-pid="' + esc(g.id) + '" data-kind="project"><span class="sync-pop-name">' + esc(g.name) + '</span>' +
        (g.fresh ? '<span class="sync-pop-badge">Not on GitHub yet</span>' : '') + '</button>' + rows + more + none + '</div>';
    }).join('');
    var m = document.createElement('div');
    m.className = 'menu sync-pop'; m.id = 'menu'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Unsynced changes');
    m.innerHTML = html;
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect(), foot = anchor.closest('.side-foot') || anchor;
    m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, foot.getBoundingClientRect().left)) + 'px';
  }
  // Jump to an unsynced change: the project, then the check, requirement, or revision.
  function gotoChange(el) {
    var slug = slugOfId(el.dataset.pid), p = slug && projects[slug];
    closeMenu();
    if (!p) return;
    var kind = el.dataset.kind, id = el.dataset.id, item = el.dataset.item, gone = !!el.dataset.deleted;
    ui.slug = slug; ui.page = ''; ui.query = ''; ui.filter = 'all'; ui.home = false; selected = null;
    ui.view = kind === 'req' && reqsOn(p) ? 'reqs' : kind === 'revision' && C.runs ? 'revisions' : kind === 'spec' && specOn(p) ? 'spec' : 'overview';
    closeInspector(); saveUi(); render(); $('#app').classList.remove('nav-open');
    if (kind === 'req' && !gone && ui.view === 'reqs' && reqOf(p, id)) openReq(id);
    else if ((kind === 'check' || kind === 'custom' || kind === 'comment') && item && (!gone || kind === 'comment') && !itemDef(p, item).retired) gotoItem(item);
    else if (kind === 'spec' && !gone && ui.view === 'spec') specGoto(id);
    else $('#main').scrollTop = 0;
  }

  // ── Toolbar ──────────────────────────────────────────────
  // Sync, plus Discard while there are unsynced changes.
  function syncButtons() {
    if (DEMO) return '';
    var n = Object.keys(dirty).length;
    return '<button class="btn' + (syncing ? ' is-syncing' : '') + '" data-act="sync" title="' + (syncing ? 'Syncing with GitHub…' : 'Sync with GitHub (Ctrl+S)') + '">' + ICON.sync + '<span class="btn-label">' + (syncing ? 'Syncing…' : 'Sync') + '</span>' + (n ? '<span class="badge">' + n + '</span>' : '') + '</button>' +
      (n ? '<button class="btn" data-act="discard" title="Throw away unsynced changes and go back to what’s on GitHub">' + ICON.undo + '<span class="btn-label">Discard</span></button>' : '');
  }
  // A sync button on a page (the empty pages' Sync now): it turns while a sync runs.
  function syncNowButton(label, primary) {
    return '<button class="btn' + (primary ? ' btn-primary' : '') + (syncing ? ' is-syncing' : '') + '" data-act="sync" data-label="' + esc(label) + '">' +
      ICON.sync + '<span class="btn-label">' + (syncing ? 'Syncing…' : esc(label)) + '</span></button>';
  }
  // Starting or ending a sync updates every Sync button in place, without a render.
  function markSyncButtons() {
    var on = !!syncing;
    document.querySelectorAll('.btn[data-act="sync"]').forEach(function (b) {
      if (b.classList.contains('is-syncing') === on) return;
      b.classList.toggle('is-syncing', on);
      var label = b.querySelector('.btn-label');
      if (label) label.textContent = on ? 'Syncing…' : (b.dataset.label || 'Sync');
      if (!b.dataset.label) b.title = on ? 'Syncing with GitHub…' : 'Sync with GitHub (Ctrl+S)';
    });
  }
  function renderToolbar() {
    var p = current();
    $('#toolbar-title').textContent = p ? p.meta.name : '';
    var seg = $('#view-seg'), acts = $('#toolbar-actions');
    if (!p) {
      seg.innerHTML = '';
      acts.innerHTML = syncButtons() + (ticketsOn() ? moreButton() : '');
      return;
    }
    var st = M.projectStats(p, TEMPLATES);
    var reqIdx = checkIdx(p), reqFail = M.liveReqs(p).some(function (q) { return reqTrouble(q, reqIdx); });
    var specFlags = specOn(p) ? M.specAnalysis(p).tags.length + M.specCommentTags(p).length : 0;
    var views = [{ id: 'overview', label: 'Overview' }].concat(specOn(p) ? [{ id: 'spec', label: SPEC_LABEL, extra: specFlags ? '<span class="count" title="Flagged for a requirement">' + specFlags + '</span>' : '' }] : [], reqsOn(p) ? [{ id: 'reqs', label: 'Requirements', extra: reqFail ? '<span class="dot"></span>' : '' }] : [], projectTemplates(p).map(function (t) {
      var c = st.per[t.id];
      return { id: t.id, label: t.short, extra: c && c.issuesOpen ? '<span class="dot"></span>' : '' };
    }));
    views.push({ id: 'findings', label: 'Findings', extra: st.issue ? '<span class="count">' + st.issue + '</span>' : '' });
    if (C.runs) views.push({ id: 'revisions', label: 'Revisions' });
    if (views.map(function (v) { return v.id; }).indexOf(ui.view) < 0) ui.view = 'overview';
    var segLeft = seg.scrollLeft;   // a narrow window scrolls the tabs sideways; keep the place
    seg.innerHTML = views.map(function (v) {
      return '<button role="tab" class="' + (v.id === ui.view ? 'on' : '') + '" data-act="view" data-view="' + v.id + '">' + esc(v.label) + (v.extra || '') + '</button>';
    }).join('');
    seg.scrollLeft = segLeft;
    var onTab = seg.querySelector('.on');   // ...but bring the current tab into view if it's hidden
    if (onTab) onTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    acts.innerHTML = syncButtons() +
      '<button class="btn" data-act="report" title="Review report">' + ICON.doc + '<span class="btn-label">Report</span></button>' +
      moreButton();
  }
  // Tickets (signoff/assets/tickets.js): Open ticket… and Tickets in the ⋯ menu, for FTEs, on every page.
  function ticketsOn() { return !!(window.SignoffTickets && window.SignoffTickets.can()); }
  function moreButton() { return '<button class="icon-btn" data-act="project-menu" title="More" aria-label="More">' + ICON.more + '</button>'; }
  function ticketEntries() { return ticketsOn() ? [['ticket', 'Open ticket\u2026'], ['tickets', 'Tickets']] : []; }

  // ── Pages ────────────────────────────────────────────────
  function renderPage() { var f = focusNow(); drawPage(); restoreFocus(f); }   // keeps the field being typed in (focusNow)
  function drawPage() {
    var p = current();
    var page = $('#page');
    var scroll = $('#main').scrollTop;
    drawPeople();
    if (EMBED) { page.innerHTML = peopleOrNotice(); return; }
    ui.page = '';
    if (!p) { page.innerHTML = emptyPage(); renderToolbar(); return; }
    renderToolbar();
    if (ui.view === 'overview') { page.innerHTML = overviewPage(p); loadPicture(p); }
    else if (ui.view === 'findings') page.innerHTML = findingsPage(p);
    else if (ui.view === 'revisions') { loadRuns(p); page.innerHTML = revisionsPage(p); }
    else if (ui.view === 'reqs') page.innerHTML = reqsPage(p);
    else if (ui.view === 'spec') page.innerHTML = specPage(p);
    else page.innerHTML = checklistPage(p, templateById(ui.view));
    $('#main').scrollTop = scroll;
  }

  function emptyPage() {
    if (signedOut()) {
      return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
        '<h2>Sign in with GitHub</h2><p>Reviews live in private GitHub repositories. ' + (signIn() ? 'Sign in with your GitHub account' : 'Add your GitHub token in Settings') + ' to see the ' + UNITS + ' shared with you, or explore the demo.</p>' +
        (signIn() ? '<button class="btn btn-primary" data-act="signin">Sign in with GitHub</button> <button class="btn" data-act="settings">Use a token</button>'
          : '<button class="btn btn-primary" data-act="settings">Set up GitHub</button>') +
        ' <a class="btn" href="' + esc(location.pathname) + '?demo">Open the demo</a></div></div>';
    }
    if (checking()) {
      return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
        '<h2>' + (syncing ? 'Syncing with GitHub' : 'Checking who’s signed in') + '</h2><p>' + (syncing ? 'Checking which ' + UNITS + ' this GitHub token can open. They show here as soon as the sync finishes.' : 'Your ' + UNITS + ' show once a sync confirms which ones this GitHub token can open.') + '</p>' +
        syncNowButton('Sync now', true) + '</div></div>';
    }
    if (!isFte()) {
      return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
        '<h2>' + (!visibleProjects().length ? 'No ' + UNITS + ' shared with you yet' : 'Pick a ' + UNIT) + '</h2>' +
        '<p>' + (!visibleProjects().length ? 'Signed in as <b>' + esc(settings.login) + '</b>. ' + (waitingInvites() ? 'Accept your invitation in the sidebar.' : 'Ask your Dovetail contact to add you to a ' + UNIT + ', then sync.') : 'Choose a ' + UNIT + ' from the sidebar.') + '</p>' +
        syncNowButton('Sync now', true) + '</div></div>';
    }
    var none = !visibleProjects().length;
    return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
      '<h2>' + (none ? 'Start a design review' : 'Pick a ' + UNIT) + '</h2>' +
      '<p>' + (none ? 'Create a review, choose the checklists and what kind of ' + W.thing + ' it is, and Signoff builds a review tailored to it.' : 'Choose a ' + UNIT + ' from the sidebar, or start a new one.') + '</p>' +
      '<button class="btn btn-primary" data-act="new-project">New project</button>' +
      (none && !DEMO ? ' ' + syncNowButton('Pull from GitHub') : '') +
      (none ? '<p class="note" style="margin-top:18px">' + TEMPLATES.length + ' checklists · ' + Object.keys(INDEX.items).length + ' checks available</p>' : '') +
      '</div></div>';
  }

  function headBlock(p, eyebrow) {
    var m = p.meta;
    var sub = [m.client, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    return '<div class="eyebrow">' + esc(m.project ? m.project + ' · ' + eyebrow : eyebrow) + '</div><h1 class="page-title">' + esc(m.name) + '</h1>' +
      '<div class="page-sub">' + (sub ? '<span>' + sub + '</span>' : '') + (C.assemblies && M.isAssembly(p) ? '<span class="chip">Assembly</span>' : '') + '<span class="chip accent">' + esc(m.stage) + '</span></div>';
  }

  function overviewPage(p) {
    var st = M.projectStats(p, TEMPLATES);
    // A review with no checks (only Requirements, or Requirements and Scribe) shows its requirements on
    // the ring and in the counts: how many are verified (Chris, 2026-11-09; it read "100% reviewed, 0 to
    // review"). Its pct, the sidebar's ring, and the summary stay 100%: nothing to review.
    var rq = !st.total && reqsOn(p) ? M.reqStats(p, checkIdx(p)) : null;
    if (rq && !rq.total) rq = null;
    var rqPct = rq ? Math.round(100 * (rq.pass || 0) / rq.total) : 0;
    var tpls = projectTemplates(p);
    var people = {};
    M.liveComments(p).forEach(function (c) { people[c.author] = 1; });
    Object.keys(p.items).forEach(function (k) { if (p.items[k].updatedBy) people[p.items[k].updatedBy] = 1; });
    var recent = M.liveComments(p).slice(-6).reverse();
    var profile = (p.meta.profile || []).map(function (t) {
      var tag = M.TAGS.filter(function (x) { return x.id === t; })[0];
      return '<span class="chip">' + esc(tag ? tag.label : t) + '</span>';
    }).join('');
    var html = '<div class="page">' +
      '<div class="page-head"><div class="page-head-text">' + headBlock(p, 'Design review') +
      (p.meta.description ? '<p style="color:var(--text-2);margin:14px 0 0;max-width:62ch">' + esc(p.meta.description) + '</p>' : '') +
      '<div class="chips" style="margin-top:14px">' + (profile || '<span class="chip">' + esc(W.general) + '</span>') +
      (isFte() ? '<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="edit-project">Edit profile</button>' : '') + '</div>' +
      (!DEMO && isFte() ? '<p class="note" style="margin-top:10px">' + (M.sharedRepo(roster, p.id) ? 'Shared through ' + esc(M.sharedRepo(roster, p.id)) + (assignedContractors(p.id).length ? ' with ' + assignedContractors(p.id).map(function (u) { return esc(u.name || u.login); }).join(', ') : '') : 'Internal \u2014 FTEs only') + '</p>' : '') + '</div>' +
      '<div class="head-visual"><div class="head-pic" data-pic="' + esc(p.id) + '">' + picHtml(p) + '</div>' +
      '<div class="head-ring">' + (rq ? ring(rqPct, 132, 11, rqPct + '%', 'requirements verified') : ring(st.pct, 132, 11, st.pct + '%', 'reviewed')) + revisionLine(p) + '</div></div></div>' +
      '<div class="grid grid-4">' +
      (rq ? stat(rq.pass || 0, 'Verified', 'pass', 'reqs') + stat(rq.fail || 0, 'Failing', 'issue', 'reqs') + stat(rq.open || 0, 'Not verified', '', 'reqs') + stat(rq.total, plural(rq.total, 'Requirement').replace(/^\d+ /, ''), '', 'reqs') :
      stat(st.pass, 'Passed', 'pass') + stat(st.issue, plural(st.issue, 'Issue').replace(/^\d+ /, '') + (st.issuesOpen ? ' · ' + st.issuesOpen + ' open' : ''), 'issue', 'findings') +
      stat(st.open, 'To review', '') + stat(st.na, 'Not applicable', '')) + '</div>' +
      (st.outside ? '<p class="note" style="margin-top:10px">' + plural(st.outside, 'check') + ' outside this ' + W.thing + '’s profile ' + (st.outside === 1 ? 'is' : 'are') + ' set aside and not counted.</p>' : '') +
      '<div class="section-title">Checklists</div><div class="grid grid-3">' + (reqsOn(p) ? reqsCard(p) : '') +
      tpls.map(function (t) {
        var c = st.per[t.id];
        return '<button class="card cl-card" data-act="view" data-view="' + t.id + '">' +
          '<div class="cl-card-top"><div><div class="cl-card-title">' + esc(t.title) + '</div><div class="cl-card-desc">' + esc(t.description) + '</div></div>' + ring(c.pct, 46, 5, c.pct, '') + '</div>' +
          bar(c) + '<div class="cl-card-foot"><span><b>' + c.reviewed + '</b>/' + c.total + ' reviewed</span>' + (c.issue ? '<span style="color:var(--issue)"><b>' + c.issue + '</b> ' + (c.issue === 1 ? 'issue' : 'issues') + '</span>' : '') + '</div></button>';
      }).join('') + '</div>';
    if (recent.length) {
      html += '<div class="section-title">Recent discussion</div><div class="card" style="padding:16px 18px 2px">' +
        recent.map(function (c) {
          var d = c.item ? itemDef(p, c.item) : null;
          return '<div class="cmt" style="cursor:pointer" data-act="goto-item" data-id="' + esc(c.item || '') + '">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span>' + relTime(c.at) + '</span></div>' +
            (d ? '<div class="muted" style="font-size:12px;color:var(--text-3)">' + esc(d.def.text) + '</div>' : '') +
            '<div class="cmt-text">' + esc(c.text) + '</div></div></div>';
        }).join('') + '</div>';
    }
    html += '<p class="note" style="margin-top:28px">Created ' + fmtDate(p.createdAt) + (p.createdBy ? ' by ' + esc(p.createdBy) : '') +
      (Object.keys(people).length ? ' · Reviewers: ' + Object.keys(people).map(esc).join(', ') : '') + '</p></div>';
    return html;
  }
  // A stat with a view opens that tab when clicked (Issues opens Findings).
  function stat(n, label, cls, view) {
    var inner = '<div class="stat-num">' + n + '</div><div class="stat-label">' + esc(label) + '</div>';
    return view ? '<button class="card stat stat-link ' + cls + '" data-act="view" data-view="' + esc(view) + '" title="Open ' + esc(view[0].toUpperCase() + view.slice(1)) + '">' + inner + '</button>' :
      '<div class="card stat ' + cls + '">' + inner + '</div>';
  }
  function avatar(name) { return '<div class="avatar" style="background:hsl(' + hue(name) + ' 45% 42%)">' + esc(initials(name)) + '</div>'; }

  var showHidden = {};   // section id -> show profile-hidden items
  var collapsed = load('collapsed', {});

  function commentCounts(p) {
    var n = {};
    M.liveComments(p).forEach(function (c) { if (c.item) n[c.item] = (n[c.item] || 0) + 1; });
    return n;
  }

  function matches(r, counts) {
    if (ui.query) {
      var q = ui.query.toLowerCase();
      if ((r.def.text + ' ' + (r.def.hint || '')).toLowerCase().indexOf(q) < 0) return false;
    }
    if (ui.filter === 'open') return r.status === 'open' && !r.reference;
    if (ui.filter === 'issue') return r.status === 'issue' && !r.reference;
    if (ui.filter === 'comments') return !!counts[r.id];
    return true;
  }

  // The checks in a section still blank (open), among those the filter and search show.
  function blankIn(g, counts) {
    return g.rows.filter(function (r) { return r.status === 'open' && matches(r, counts); });
  }
  // Pass every blank check a section shows, as one change (and one sync).
  function passBlank(secId) {
    var p = current(), t = templateById(ui.view); if (!p || !t) return;
    var g = M.checklistRows(p, t).filter(function (x) { return x.section.id === secId; })[0]; if (!g) return;
    var rows = blankIn(g, commentCounts(p));
    if (!rows.length) return;
    if (rows.length > 1 && !confirm('Pass ' + plural(rows.length, 'unreviewed check') + ' in ' + g.section.title + '?')) return;
    rows.forEach(function (r) {
      var next = Object.assign({}, p.items[r.id] || {}, { status: 'pass' });
      var d = itemDef(p, r.id);
      if (!d.retired) { next.text = d.def.text; if (d.template) next.checklist = d.template.id; }
      p.items[r.id] = M.stamp(next, me());
    });
    touch(p); renderPage(); renderInspector();
    toast('Passed ' + plural(rows.length, 'check') + ' in ' + g.section.title);
    syncSoon();
  }
  function checklistPage(p, t) {
    if (!t) return emptyPage();
    var groups = M.checklistRows(p, t);
    var counts = commentCounts(p);
    var all = [];
    groups.forEach(function (g) { all = all.concat(g.rows); });
    var c = M.countStatuses(all);
    var filters = [['all', 'All', c.total], ['open', 'To review', c.open], ['issue', 'Issues', c.issue], ['comments', 'Discussed', Object.keys(counts).filter(function (k) { return all.some(function (r) { return r.id === k; }); }).length]];
    var html = '<div class="page">' +
      '<div class="cl-head"><div>' + '<div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">' + esc(t.title) + '</h1>' +
      '<div class="page-sub"><span>' + c.reviewed + ' of ' + c.total + ' reviewed</span>' + (c.issue ? '<span class="sep">·</span><span style="color:var(--issue)">' + plural(c.issue, 'issue') + '</span>' : '') + '</div></div>' +
      ring(c.pct, 64, 6, c.pct + '%', '') + '</div>' +
      '<div class="filters"><div class="seg">' + filters.map(function (f) {
        return '<button class="' + (ui.filter === f[0] ? 'on' : '') + '" data-act="filter" data-filter="' + f[0] + '">' + f[1] + ' <span class="count">' + f[2] + '</span></button>';
      }).join('') + '</div>' +
      '<div class="search">' + ICON.search + '<input id="item-search" type="search" placeholder="Filter checks  /" value="' + esc(ui.query) + '" autocomplete="off"></div>' +
      '<span style="flex:1"></span><button class="btn btn-plain" data-act="collapse-all">' + (groups.every(function (g) { return collapsed[g.section.id]; }) ? 'Expand all' : 'Collapse all') + '</button></div>';

    var shown = 0;
    groups.forEach(function (g) {
      var rows = g.rows.filter(function (r) { return matches(r, counts); });
      var visible = rows.filter(function (r) { return !r.hidden || showHidden[g.section.id] || ui.filter !== 'all' || ui.query; });
      var hiddenCount = rows.length - visible.length;
      if (!rows.length && (ui.filter !== 'all' || ui.query)) return;
      shown += rows.length;
      var gc = M.countStatuses(g.rows);
      var isCollapsed = collapsed[g.section.id] && ui.filter === 'all' && !ui.query;
      html += '<section class="card sec' + (isCollapsed ? ' collapsed' : '') + (g.state.na ? ' is-na' : '') + '" data-sec="' + esc(g.section.id) + '">' +
        '<div class="sec-head" data-act="toggle-sec" data-sec="' + esc(g.section.id) + '">' + ICON.chev +
        '<div class="sec-title">' + esc(g.section.title) + (!g.applies ? '<small>Not in profile</small>' : '') + '</div>' +
        '<div class="sec-meta">' + (gc.issue ? '<span style="color:var(--issue)">' + gc.issue + ' !</span>' : '') + '<span>' + gc.reviewed + '/' + gc.total + '</span>' + bar(gc) +
        (blankIn(g, counts).length ? '<button class="sec-na sec-pass" data-act="sec-pass" data-sec="' + esc(g.section.id) + '" title="Pass the ' + plural(blankIn(g, counts).length, 'unreviewed check') + ' shown in this section" aria-label="Pass all unreviewed checks in this section">' + ICON.check + 'All</button>' : '') +
        '<button class="sec-na' + (g.state.na ? ' on' : '') + '" data-act="sec-na" data-sec="' + esc(g.section.id) + '" title="Mark the whole section not applicable">N/A</button></div></div>' +
        '<div class="sec-body">' + visible.map(function (r) { return itemRow(r, counts); }).join('') +
        (hiddenCount ? '<div class="hidden-rows"><span>' + plural(hiddenCount, 'check') + ' not applicable to this ' + W.thing + '’s profile</span><button data-act="show-hidden" data-sec="' + esc(g.section.id) + '">Show</button></div>' :
          (showHidden[g.section.id] && g.rows.some(function (r) { return r.hidden; }) ? '<div class="hidden-rows"><span>Showing checks outside the profile</span><button data-act="show-hidden" data-sec="' + esc(g.section.id) + '">Hide</button></div>' : '')) +
        (ui.filter === 'all' && !ui.query ? '<div class="add-row"><input data-add="' + esc(t.id) + '|' + esc(g.section.id) + '" placeholder="+ Add a check for this ' + UNIT + '" maxlength="400"></div>' : '') +
        '</div></section>';
    });
    if (!shown) html += '<div class="empty"><h2>Nothing here</h2><p>No checks match this filter.</p></div>';

    // Item state left over from checks this template no longer has.
    var retired = M.retiredItems(p, INDEX).filter(function (id) { return (p.items[id] || {}).checklist === t.id; });
    if (retired.length) {
      html += '<div class="retired"><div class="section-title">Retired checks</div><section class="card sec"><div class="sec-body" style="border:none">' +
        retired.map(function (id) { var r = { id: id, def: itemDef(p, id).def, state: p.items[id] || {}, status: (p.items[id] || {}).status || 'open', severity: 'minor' }; return itemRow(r, counts); }).join('') + '</div></section></div>';
    }
    return html + '</div>';
  }

  // A reference row (findings Fabcheck waived, kept to read): no severity, status, or quick buttons,
  // and it counts nowhere (model.row, countStatuses).
  function referenceRow(r, counts) {
    var n = counts[r.id] || 0;
    var sub = '<span class="res waived">Waived</span><span class="tag">' + (checkerName(r.def) || cap(UNIT) + ' check') + '</span><span class="tag">Reference, not counted</span>';
    return '<div class="item st-reference' + (selected === r.id ? ' sel' : '') + '" data-act="select" data-id="' + esc(r.id) + '">' +
      '<span class="ref-dot" aria-hidden="true">i</span>' +
      '<div><div class="item-text">' + esc(r.def.text) + '</div><div class="item-sub">' + sub + '</div></div>' +
      '<div class="item-right">' + (n ? '<span class="cmt-count">' + ICON.bubble + n + '</span>' : '') + '</div></div>';
  }

  function itemRow(r, counts) {
    if (r.reference) return referenceRow(r, counts);
    var n = counts[r.id] || 0;
    var sub = '';
    if (r.severity !== 'minor' || r.status === 'issue') sub += '<span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span>';
    if (r.status === 'issue') {
      var res = r.resolution;
      sub += '<span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</span>';
      if (r.state.assignee) sub += '<span>→ ' + esc(r.state.assignee) + '</span>';
    }
    if (r.auto === 'profile') sub += '<span class="tag">Outside profile</span>';
    if (r.custom) sub += '<span class="tag">' + (checkerName(r.def) || cap(UNIT) + ' check') + '</span>';
    (r.def.tags || []).forEach(function (tg) { sub += '<span class="tag">' + esc(tg) + '</span>'; });
    var stCls = r.status === 'open' ? '' : r.status;
    return '<div class="item st-' + r.status + (r.auto ? ' auto-na' : '') + (selected === r.id ? ' sel' : '') + '" data-act="select" data-id="' + esc(r.id) + '">' +
      '<button class="status ' + stCls + '" data-act="cycle" data-id="' + esc(r.id) + '" title="Pass (P) · Issue (I) · N/A (N)" aria-label="Status: ' + r.status + '">' + ICON.check + ICON.bang + ICON.dash + '</button>' +
      '<div><div class="item-text">' + esc(r.def.text) + '</div><div class="item-sub">' + sub + '</div></div>' +
      '<div class="item-right"><div class="quick">' +
      '<button class="q-pass" data-act="set" data-status="pass" data-id="' + esc(r.id) + '">Pass</button>' +
      '<button class="q-issue" data-act="set" data-status="issue" data-id="' + esc(r.id) + '">Issue</button>' +
      '<button data-act="set" data-status="na" data-id="' + esc(r.id) + '">N/A</button></div>' +
      (n ? '<span class="cmt-count">' + ICON.bubble + n + '</span>' : '') + '</div></div>';
  }

  // The review's issues; reference rows (waived findings kept to read) go to `refs` when given.
  function allFindings(p, refs) {
    var out = [];
    projectTemplates(p).forEach(function (t) {
      M.checklistRows(p, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          if (r.reference) { if (refs) refs.push({ row: r, template: t, section: g.section }); }
          else if (r.status === 'issue') out.push({ row: r, template: t, section: g.section });
        });
      });
    });
    var rank = { critical: 0, major: 1, minor: 2 };
    var resRank = { '': 0, fixed: 1, waived: 2 };
    return out.sort(function (a, b) {
      return (resRank[a.row.resolution] - resRank[b.row.resolution]) || (rank[a.row.severity] - rank[b.row.severity]);
    });
  }

  // Waived findings a checker sent for reference: listed apart, after the issues, counted nowhere.
  function referenceHtml(p, refs, counts) {
    if (!refs.length) return '';
    var by = refs.map(function (x) { return checkerName(x.row.def); }).filter(function (n, i, a) { return n && a.indexOf(n) === i; }).sort();
    return '<div class="section-title">Waived in ' + esc(by.length ? by.join(' and ') : 'a checker') + '</div><p class="note" style="margin:-6px 0 10px">Kept for reference: these aren’t issues and aren’t counted anywhere.</p>' +
      '<div class="card table-scroll"><table class="table ref-table"><tbody>' +
      refs.map(function (x) {
        var r = x.row;
        return '<tr data-act="goto-item" data-id="' + esc(r.id) + '"><td style="width:1%"><span class="ref-dot" aria-hidden="true">i</span></td>' +
          '<td>' + esc(r.def.text) + '<div class="muted">' + esc(x.template.short + ' › ' + x.section.title) + '</div></td>' +
          '<td style="width:1%"><span class="res waived">Waived</span></td>' +
          '<td class="muted" style="width:1%">' + (counts[r.id] ? '<span class="cmt-count">' + ICON.bubble + counts[r.id] + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function findingsPage(p) {
    var refs = [];
    var f = allFindings(p, refs);
    var counts = commentCounts(p);
    var open = f.filter(function (x) { return !x.row.resolution; }).length;
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Findings</h1>' +
      '<div class="page-sub"><span>' + plural(f.length, 'issue') + '</span><span class="sep">·</span><span>' + open + ' open</span></div></div>' +
      '<button class="btn" data-act="export-csv">Export CSV</button></div>';
    if (!f.length) return html + '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>No issues raised</h2><p>Mark a check as an Issue to add it here, with its severity, owner, and resolution.</p></div>' + referenceHtml(p, refs, counts) + '</div>';
    html += '<div class="card table-scroll"><table class="table"><thead><tr><th>Severity</th><th>Check</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>' +
      f.map(function (x) {
        var r = x.row, res = r.resolution;
        var last = M.liveComments(p, r.id).slice(-1)[0];
        return '<tr data-act="goto-item" data-id="' + esc(r.id) + '"><td><span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span></td>' +
          '<td>' + esc(r.def.text) + '<div class="muted">' + esc(x.template.short + ' › ' + x.section.title) + '</div>' + (last ? '<div class="muted" style="margin-top:4px">“' + esc(last.text.slice(0, 140)) + (last.text.length > 140 ? '…' : '') + '” — ' + esc(last.author) + '</div>' : '') + '</td>' +
          '<td class="muted">' + esc(r.state.assignee || '—') + '</td>' +
          '<td><span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</span></td>' +
          '<td class="muted">' + (counts[r.id] ? '<span class="cmt-count">' + ICON.bubble + counts[r.id] + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' + referenceHtml(p, refs, counts) + '</div>';
    return html;
  }

  // ── Inspector ────────────────────────────────────────────
  var selected = null;

  function select(id, open) {
    selected = id;
    document.querySelectorAll('.item.sel').forEach(function (el) { el.classList.remove('sel'); });
    var el = document.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
    if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    if (open) { $('#inspector').classList.add('open'); renderInspector(); }
    else if ($('#inspector').classList.contains('open')) renderInspector();
  }
  function closeInspector() { $('#inspector').classList.remove('open'); }
  // Closing the pane by hand (×, Esc, a blank click) also lets go of a Scribe diagram block, so it
  // doesn't stay ringed with its lines forward after its panel has gone (Chris, 2026-11-09).
  function closePanel() {
    closeInspector();
    if (specBlockSel() || specEdgeSel()) { selected = null; renderPage(); }
  }
  // A click on blank space in the main area (nothing to click or type in there, no text being
  // selected) closes an open details pane, as × and Esc do.
  var LIVE = 'a, button, input, select, textarea, label, summary, [contenteditable], [role="button"], [tabindex], .item, canvas, svg';
  function blankClick(e) {
    return $('#inspector').classList.contains('open') && !!e.target.closest('#main') && !e.target.closest(LIVE) &&
      !String(window.getSelection ? window.getSelection() : '');
  }
  // In a Scribe diagram, empty canvas counts as blank too: anything that isn't a block, section, line,
  // label, flag, or + (those carry data-act, so they never get here), and not the end of a drag.
  function specBlankClick(e) {
    return !!e.target.closest('svg.spec-map') && !e.target.closest('.spec-handle') && !specDragJustEnded &&
      ($('#inspector').classList.contains('open') || !!specBlockSel() || !!specEdgeSel());
  }
  // Show a check in its checklist (even if its section is collapsed or set aside) and open it.
  function gotoItem(id) {
    var d = itemDef(current(), id);
    if (d.template) { ui.view = d.template.id; ui.filter = 'all'; ui.query = ''; collapsed[(d.section || {}).id] = false; showHidden[(d.section || {}).id] = true; saveUi(); renderPage(); }
    select(id, true);
  }

  // ── Picture beside the progress ring (docs/fabcheck-link.md, "Board previews") ──
  // The pictures a checker stored with the latest run, read from the project's home repo once
  // per page load. A tool sets config.previews.dir (Fabcheck's folder for Signoff EE); without
  // it, or without a stored picture, the header shows the ring alone.
  var pics = {};   // project id -> { state: 'loading' | 'none' | 'ok', images: [{ key, url }], hero, runId }
  var PIC_TYPES = { 'image/webp': 1, 'image/png': 1 };
  // A checker's folder for this review in its home repo (Fabcheck's fabcheck/<id>/), under the
  // data path when the review lives in the data repo.
  function checkerDir(p, dir) {
    var home = homeOf(p), isData = home.toLowerCase() === (settings.owner + '/' + settings.dataRepo).toLowerCase();
    return (isData && settings.dataPath ? settings.dataPath.replace(/\/+$/, '') + '/' : '') + dir + p.id + '/';
  }
  function picDir(p) { return checkerDir(p, C.previews.dir) + 'preview/'; }
  function loadPicture(p) {
    if (!C.previews || pics[p.id]) return;
    if (DEMO) {
      // ["top", ...] (SVGs), or { run, keys, ext }: the board's Fabcheck pictures and its demo run.
      var dp = ((C.demo || {}).pictures || {})[p.id], keys = dp && (Array.isArray(dp) ? dp : dp.keys), ext = (dp && dp.ext) || 'svg';
      pics[p.id] = keys ? { state: 'ok', hero: keys[0], runId: (dp && dp.run) || '', images: keys.map(function (k) { return { key: k, url: 'assets/demo-previews/' + p.id + '-' + k + '.' + ext }; }) } : { state: 'none' };
      return showPicture(p);
    }
    if (!getToken()) return;
    pics[p.id] = { state: 'loading' };
    var store = workspace().store(homeOf(p)), dir = picDir(p);
    store.listTree(dir).then(function (entries) {
      var sha = {};
      entries.forEach(function (e) { sha[e.path] = e.sha; });
      if (!sha[dir + 'index.json']) return null;
      return store.blobBytes(sha[dir + 'index.json']).then(function (bytes) {
        var doc = JSON.parse(new TextDecoder().decode(bytes)) || {};
        // Stored by a tool contractors can run, so only known names and types are used.
        var want = (Array.isArray(doc.images) ? doc.images : []).filter(function (i) {
          return i && /^[a-z0-9-]{1,32}$/.test(i.key) && /^[a-z0-9-]{1,32}\.(webp|png)$/.test(i.file) && PIC_TYPES[i.type] && sha[dir + i.file];
        });
        return Promise.all(want.map(function (i) {
          return store.blobBytes(sha[dir + i.file]).then(function (b) { return { key: i.key, url: URL.createObjectURL(new Blob([b], { type: i.type })) }; });
        })).then(function (images) {
          if (!images.length) return null;
          return { state: 'ok', images: images, hero: images.some(function (x) { return x.key === doc.hero; }) ? doc.hero : images[0].key,
            runId: /^[A-Za-z0-9_-]{1,64}$/.test(doc.runId || '') ? doc.runId : '' };
        });
      });
    }).then(function (got) { pics[p.id] = got || { state: 'none' }; showPicture(p); }, function () { pics[p.id] = { state: 'none' }; });
  }
  function showPicture(p) {
    var box = document.querySelector('.head-pic[data-pic="' + p.id + '"]');
    if (!box) return;
    var was = box.childElementCount;
    box.innerHTML = picHtml(p);
    if (!was && box.childElementCount) scootIn(box);
  }
  // A picture arriving after the header drew grows in from nothing and pushes the ring over.
  // It stays collapsed until the image has decoded, so the push is one smooth move.
  function scootIn(box) {
    if (!box.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var gap = parseFloat(getComputedStyle(box.parentElement).columnGap) || 0, img = box.querySelector('img');
    var shut = { width: '0px', marginRight: -gap + 'px', opacity: 0 };
    Object.assign(box.style, shut, { overflow: 'hidden' });
    (img && img.decode ? img.decode() : Promise.resolve()).catch(function () {}).then(function () {
      if (!box.isConnected) return;
      Object.assign(box.style, { width: '', marginRight: '', opacity: '' });
      var w = box.offsetWidth;
      box.animate([
        { width: '0px', marginRight: -gap + 'px', opacity: 0, transform: 'translateX(-12px)' },
        { opacity: 0, offset: 0.25 },
        { width: w + 'px', marginRight: '0px', opacity: 1, transform: 'none' }
      ], { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }).onfinish = function () { box.style.overflow = ''; };
    });
  }
  function picHtml(p) {
    var pc = pics[p.id];
    if (!pc || pc.state !== 'ok') return '';
    var key = pc.images.some(function (i) { return i.key === ui.picSide; }) ? ui.picSide : pc.hero;
    var img = pc.images.filter(function (i) { return i.key === key; })[0];
    var pic = '<img alt="' + esc(p.meta.name + ', ' + key) + '" src="' + esc(img.url) + '">';
    return (pc.runId ? '<button class="head-pic-img" data-act="open-fabcheck" data-run="' + esc(pc.runId) + '" data-href="' + esc(fabcheckUrl(p, { run: { id: pc.runId } })) + '" title="Open the latest stored run in Fabcheck">' + pic + '</button>'
      : '<span class="head-pic-img">' + pic + '</span>') +
      (pc.images.length > 1 ? '<div class="seg">' + pc.images.map(function (i) {
        return '<button class="' + (i.key === key ? 'on' : '') + '" data-act="pic-side" data-key="' + esc(i.key) + '">' + esc(i.key.charAt(0).toUpperCase() + i.key.slice(1)) + '</button>';
      }).join('') + '</div>' : '');
  }

  // ── Fabcheck runs (docs/fabcheck-link.md) ────────────────
  function isFabcheck(def) { return !!(def && def.source && def.source.tool === 'fabcheck'); }

  // Link that opens the run in Fabcheck, zoomed to a location when one is given. It names no repo:
  // Fabcheck never reads one. Signoff hands it the run first (openFabcheck).
  function fabcheckUrl(p, src, loc) {
    var run = src.run || {};
    var q = ['run=' + encodeURIComponent(run.id || ''), 'project=' + encodeURIComponent(p.id), 'check=' + encodeURIComponent(src.check || '')];
    if (loc) {
      q.push('x=' + encodeURIComponent(loc.x), 'y=' + encodeURIComponent(loc.y));
      if (loc.layer) q.push('layer=' + encodeURIComponent(loc.layer));
    }
    return '../pcb_dfm/index.html' + (DEMO ? '?demo' : '') + '#/board?' + q.join('&');
  }

  function fabcheckBlock(p, def) {
    if (!isFabcheck(def)) return '';
    var src = def.source, run = src.run || null, locs = src.locations || [];
    // Anyone with access to the board's repo can open a stored run (contractors too). The demo's
    // runs open in Fabcheck's demo, which has their boards.
    var canOpen = run && run.id;
    var stored = run && run.stored && run.stored.repo;
    var rev = canOpen && M.revisionForRun(p, run.id), runAttr = canOpen ? ' data-run="' + esc(run.id) + '"' : '';
    var h = '<div class="fab-card"><div class="fab-head"><span><b>From Fabcheck</b>' +
      (rev ? ' <button class="chip fab-rev" data-act="view" data-view="revisions" title="This run is tagged as revision ' + esc(revName(rev)) + '">from ' + esc(rev.label) + '</button>' : '') + '</span>' +
      (canOpen ? '<button class="btn btn-primary" data-act="open-fabcheck"' + runAttr + ' data-href="' + esc(fabcheckUrl(p, src, locs[0])) + '">Open in Fabcheck</button>' : '') + '</div>';
    if (run) {
      h += '<div class="fab-meta">' + esc(run.package && run.package.name || 'Package') +
        (run.package && run.package.key ? ' <span class="muted">· ' + esc(run.package.key.slice(0, 8)) + '</span>' : '') + '<br>' +
        esc([fmtDate(run.at), run.by, run.settings && run.settings.profile && run.settings.profile + ' profile'].filter(Boolean).join(' · ')) + '<br>' +
        (stored ? 'Package and results stored in this ' + UNIT + '’s private repository'
          : 'Not stored with the ' + UNIT + ': anyone can drop the same package into Fabcheck to see it') + '</div>';
    } else {
      h += '<div class="fab-meta">Sent before Fabcheck kept runs. Run Fabcheck on the package again and send it to link this check to the board.</div>';
    }
    if (src.gone) h += '<div class="note" style="margin:6px 0 0">Not found in the latest Fabcheck run.</div>';
    if (locs.length) {
      h += '<div class="fab-locs">' + locs.map(function (l, i) {
        var label = (l.label ? l.label + ' — ' : '') + Number(l.x).toFixed(2) + ', ' + Number(l.y).toFixed(2) + ' mm' + (l.layer ? ' · ' + l.layer : '');
        return canOpen ? '<button class="fab-loc" data-act="open-fabcheck"' + runAttr + ' data-href="' + esc(fabcheckUrl(p, src, l)) + '">' + esc(label) + '</button>'
          : '<span class="fab-loc">' + esc(label) + '</span>';
      }).join('') + '</div>';
    }
    if (def.hint) h += '<details class="fab-detail"><summary>Details</summary><div>' + esc(def.hint) + '</div></details>';
    return h + '</div>';
  }

  // ── Pincheck runs (pincheck/docs/send-to-signoff-ee.md) ──
  // Pincheck sends schematic findings as Fabcheck sends fab findings, and stores its run next to the
  // review (config.pincheck.dir), but its runs are never revisions: no Revisions tab, no pictures.
  function isPincheck(def) { return !!(def && def.source && def.source.tool === 'pincheck'); }
  // The checker that wrote a custom check, by name, or '' for one a person added.
  function checkerName(def) { return isFabcheck(def) ? 'Fabcheck' : isPincheck(def) ? 'Pincheck' : ''; }
  var PK_RUN = /^pk[a-z0-9]{6,40}$/;
  function pincheckUrl(p, src, loc) {
    var run = src.run || {};
    var q = ['run=' + encodeURIComponent(run.id || ''), 'project=' + encodeURIComponent(p.id), 'check=' + encodeURIComponent(src.check || '')];
    if (loc && loc.finding) q.push('finding=' + encodeURIComponent(loc.finding));
    return '../pincheck/index.html' + (DEMO ? '?demo' : '') + '#/findings?' + q.join('&');
  }
  function pincheckBlock(p, def) {
    if (!isPincheck(def)) return '';
    var src = def.source, run = src.run && typeof src.run === 'object' ? src.run : null, locs = Array.isArray(src.locations) ? src.locations : [];
    var canOpen = run && PK_RUN.test(run.id || ''), runAttr = canOpen ? ' data-run="' + esc(run.id) + '"' : '';
    var dz = (run && run.design) || {};
    var h = '<div class="fab-card"><div class="fab-head"><span><b>From Pincheck</b></span>' +
      (canOpen ? '<button class="btn btn-primary" data-act="open-pincheck"' + runAttr + ' data-href="' + esc(pincheckUrl(p, src, locs[0])) + '">Open in Pincheck</button>' : '') + '</div>';
    if (run) {
      h += '<div class="fab-meta">' + esc(dz.name || 'Schematic') +
        (dz.parts ? ' <span class="muted">· ' + esc(dz.parts + ' parts' + (dz.nets ? ', ' + dz.nets + ' nets' : '')) + '</span>' : '') + '<br>' +
        esc([fmtDate(run.at), run.by, run.library && run.library.files != null && run.library.files + ' part file' + (run.library.files === 1 ? '' : 's')].filter(Boolean).join(' · ')) + '<br>' +
        (run.stored && run.stored.repo === 'demo' ? 'Demo: the run is kept in this browser' : run.stored && run.stored.repo ? 'Run stored in this ' + UNIT + '’s private repository' : 'Not stored with the ' + UNIT + ': open the schematic in Pincheck again to see it') + '</div>';
    }
    if (src.gone) h += '<div class="note" style="margin:6px 0 0">Not found in the latest Pincheck run.</div>';
    if (locs.length) {
      h += '<div class="fab-locs">' + locs.map(function (l) {
        var label = String(l.label || l.finding || '') + ((l.refs || []).length ? ' — ' + l.refs.slice(0, 4).join(', ') : '') + ((l.nets || []).length ? ' · ' + l.nets.slice(0, 3).join(', ') : '');
        return canOpen && l.finding ? '<button class="fab-loc" data-act="open-pincheck"' + runAttr + ' data-href="' + esc(pincheckUrl(p, src, l)) + '">' + esc(label) + '</button>'
          : '<span class="fab-loc">' + esc(label) + '</span>';
      }).join('') + '</div>';
    }
    if (def.hint) h += '<details class="fab-detail"><summary>Details</summary><div>' + esc(def.hint) + '</div></details>';
    return h + '</div>';
  }
  // A run file Pincheck stored ({ run, findings }) as Signoff hands it on, or null. Anyone who can write the
  // review's repo wrote it, so the id, hashes, and the bundle's place are checked: the bundle is taken
  // relative to the run's folder (designs/<key>.json.gz), as cleanRun does for Fabcheck's zip.
  function cleanPincheckRun(file) {
    var run = file && file.run;
    if (!run || typeof run !== 'object' || !PK_RUN.test(run.id || '')) return null;
    var dz = run.design && typeof run.design === 'object' ? run.design : {};
    var m = typeof dz.path === 'string' && dz.path.indexOf('..') < 0 && /(?:^|\/)designs\/([0-9a-f]{16})\.json\.gz$/.exec(dz.path);
    if (!m || m[1] !== dz.key || !/^[0-9a-f]{64}$/.test(String(dz.sha256 || ''))) return { id: run.id, raw: run, bundle: null, findings: [] };
    return { id: run.id, raw: run, bundle: { rel: 'designs/' + m[1] + '.json.gz', sha256: dz.sha256, size: +dz.size || 0 },
      findings: Array.isArray(file.findings) ? file.findings : [] };
  }
  // Read a stored Pincheck run and its bundle with this tab's token and leave them for Pincheck
  // (S.handoff, entry tool 'pincheck'). Resolves 'ok', 'missing', or 'nobundle'.
  function handOffPincheck(p, runId, step) {
    step = step || function () {};
    var dir = checkerDir(p, C.pincheck.dir), store = workspace().store(homeOf(p));
    step('Listing the ' + UNIT + '’s stored Pincheck runs…', 0.1);
    return store.listTree(dir).then(function (entries) {
      step('Reading run ' + runId + '…', 0.3);
      return store.readBytes(dir + 'runs/' + runId + '.json', entries).then(function (b) {
        var r = null;
        try { r = b && cleanPincheckRun(JSON.parse(new TextDecoder().decode(b))); } catch (e) { r = null; }
        if (!r || r.id !== runId) return 'missing';
        if (!r.bundle) return 'nobundle';
        step('Reading the design' + (r.bundle.size ? ' (' + Math.max(1, Math.round(r.bundle.size / 1024)) + ' KB)' : '') + '…', 0.5);
        return store.readVerified(dir + r.bundle.rel, r.bundle.sha256, entries).then(function (bundle) {
          step('Handing the run to Pincheck…', 0.9);
          return S.handoff.put({ id: runId, tool: 'pincheck', run: r.raw, findings: r.findings, bundle: bundle, at: M.now() }, DEMO);
        }).then(function () { return 'ok'; });
      });
    });
  }
  // Open in Pincheck, in this tab, as Open in Fabcheck: a card while the run is handed over, then Pincheck.
  // The demo's runs are kept in Pincheck's own browser storage, so the demo goes straight there.
  function openPincheck(el) {
    var href = new URL(el.dataset.href, location.href).href, runId = el.dataset.run || '', p = current();
    if (p) save('fabReturn', { project: p.id, view: ui.view, selected: selected || '', scroll: $('#main').scrollTop, at: M.now() });
    var card = busyCard('Opening in Pincheck');
    function go() { card.step('Opening Pincheck…', 1); location.href = href; }
    if (DEMO || !C.pincheck || !p || !getToken() || !PK_RUN.test(runId)) return go();
    function ask(why) {
      card.stop(why + ' Pincheck can open it only if this browser sent it.', [['Stay here', card.close], ['Open Pincheck', go, true]], 'The run can’t be handed over');
    }
    handOffPincheck(p, runId, card.step).then(function (res) {
      if (res === 'missing') ask('This run isn’t stored with the ' + UNIT + '.');
      else if (res === 'nobundle') ask('This run was stored without its design.');
      else go();
    }, function (err) {
      ask(err.code === 'mismatch' ? 'The stored design doesn’t match its SHA-256.' : 'Couldn’t read the run from GitHub' + (err.message ? ' (' + err.message + ')' : '') + '.');
    });
  }

  // ── Revisions: runs stored with the review, some tagged (docs/fabcheck-link.md, "Revisions") ──
  // A tool lists runs when config.runs names the checker and its folder. Runs are read from the
  // review's home repo once per page load (Refresh reads again); the tags are review records.
  function revName(r) { return r.label + (r.title ? ' · ' + r.title : ''); }
  function revStatus(r) { return M.REV_STATUS_LABEL[r.status] || ''; }
  function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' kB' : n + ' B'; }

  // The Overview's line under the ring: the latest revision and its status.
  function revisionLine(p) {
    var r = C.runs && M.latestRevision(p);
    return r ? '<button class="head-rev" data-act="view" data-view="revisions" title="' + esc(revName(r)) + '"><b>' + esc(r.label) + '</b> · ' + esc(revStatus(r).toLowerCase()) + '</button>' : '';
  }

  var runsOf = {};   // project id -> { state: 'loading' | 'ok' | 'error' | 'none', runs: [model.cleanRun], entries, error, demo }
  function loadRuns(p, again) {
    if (!C.runs || (runsOf[p.id] && !again)) return;
    if (DEMO) {
      // The demo has no repo: its runs are the ones its Fabcheck issues carry, without a stored zip.
      var seen = {}, runs = [];
      Object.keys(p.custom).forEach(function (k) {
        var c = p.custom[k], r = !c.deleted && isFabcheck(c) && c.source.run && M.cleanRun({ run: c.source.run, findings: [] });
        if (r && !seen[r.id]) { seen[r.id] = 1; runs.push(r); }
      });
      runsOf[p.id] = { state: 'ok', runs: runs, demo: true };
      return;
    }
    if (!getToken()) { runsOf[p.id] = { state: 'none' }; return; }
    runsOf[p.id] = { state: 'loading' };
    var dir = checkerDir(p, C.runs.dir);
    workspace().store(homeOf(p)).listRuns(dir).then(function (got) {
      // A run file holds the run its name says, or it's left out.
      var runs = got.runs.map(function (f) { var r = M.cleanRun(f.data); return r && f.path === dir + 'runs/' + r.id + '.json' ? r : null; }).filter(Boolean);
      runsOf[p.id] = { state: 'ok', runs: runs, entries: got.entries };
    }, function (err) {
      runsOf[p.id] = { state: 'error', error: err.message || String(err) };
    }).then(function () { if (current() === p && ui.view === 'revisions') renderPage(); });
  }
  function runById(p, id) { var st = runsOf[p.id]; return st && st.runs ? st.runs.filter(function (r) { return r.id === id; })[0] || null : null; }

  // Fabcheck issues a run raised or last updated (source.run is the latest run that saw them).
  function runIssues(p, runId) {
    return Object.keys(p.custom).map(function (k) { return p.custom[k]; }).filter(function (c) {
      return !c.deleted && isFabcheck(c) && c.source.run && c.source.run.id === runId;
    });
  }

  var revOpen = {};   // package key -> expanded
  function revisionsPage(p) {
    var st = runsOf[p.id] || { state: 'loading' }, revs = M.liveRevisions(p), latest = M.latestRevision(p);
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Revisions</h1>' +
      '<div class="page-sub"><span>' + plural(revs.length, 'revision') + '</span>' + (latest ? '<span class="sep">·</span><span>Latest ' + esc(latest.label) + ', ' + esc(revStatus(latest).toLowerCase()) + '</span>' : '') + '</div></div>' +
      (DEMO ? '' : '<button class="btn" data-act="runs-reload">Refresh</button>') + '</div>';
    if (st.state === 'none') return html + emptyCard('Sign in to see stored runs', 'Fabcheck stores each run it sends with this ' + UNIT + ', in its private repository. Add your GitHub token in Settings to list them.') + revNotesSection(p) + '</div>';
    if (st.state === 'loading') return html + '<div class="card empty"><p>Reading the runs stored with this ' + UNIT + '…</p></div>' + revNotesSection(p) + '</div>';
    if (st.state === 'error') return html + emptyCard('Couldn’t read the stored runs', esc(st.error)) + revNotesSection(p) + '</div>';
    if (!st.runs.length) return html + emptyCard('No runs stored yet', 'Check the fab package in Fabcheck and send it to this ' + UNIT + '. Each run sent is stored here, and you can tag one as a revision: sent to fab, used for builds, or withdrawn.') + revNotesSection(p) + '</div>';
    if (st.demo) html += '<p class="note" style="margin:0 0 14px">In the demo, the runs are the ones the Fabcheck issues came from. A real ' + UNIT + ' stores each run’s fab package, which you can download here.</p>';
    html += M.groupRuns(st.runs).map(function (g) {
      var head = g.runs[0], open = !!revOpen[g.key];
      return '<section class="card sec rev-group' + (open ? '' : ' collapsed') + '">' +
        '<div class="sec-head" data-act="rev-toggle" data-key="' + esc(g.key) + '">' + ICON.chev + runLine(p, head, g.runs.length) + '</div>' +
        (open ? '<div class="sec-body rev-body">' + runDetail(p, head) +
          (g.runs.length > 1 ? '<div class="rev-sub">Earlier runs of this package</div>' + g.runs.slice(1).map(function (r) {
            return '<div class="rev-older">' + runLine(p, r, 0) + runActions(p, r) + '</div>';
          }).join('') : '') + '</div>' : '') + '</section>';
    }).join('');
    return html + revNotesSection(p) + '</div>';
  }
  // Next revision updates: comments tagged @revnotes (model.revNotes), under the runs.
  function revNotesSection(p) {
    var groups = M.revNotes(p);
    var html = '<div class="section-title">Next revision updates' + (groups.length ? ' <span class="muted rev-notes-count">' + plural(groups.length, 'item') + '</span>' : '') + '</div>';
    if (!groups.length) return html + '<div class="card empty rev-notes-empty"><p>Nothing noted yet. Write <b>@revnotes</b> in a comment on any check or issue, and it’s listed here for the next revision.</p></div>';
    return html + '<div class="card rev-notes-list">' + groups.map(function (g) {
      var q = g.item && reqOf(p, g.item);
      if (q) return revNoteGroup('open-req', g, '<span class="muted rev-note-cl">' + esc(q.ref || 'Requirement') + '</span><span>' + esc(q.text) + '</span>');
      var d = g.item ? itemDef(p, g.item) : null, it = (g.item && p.items[g.item]) || {};
      var st = M.oneOf(M.STATUSES, it.status, ''), res = M.oneOf(M.RESOLUTIONS, it.resolution, '');
      var chip = st === 'issue' ? '<span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open issue') + '</span>'
        : st === 'pass' ? '<span class="res fixed">Pass</span>' : st === 'na' ? '<span class="res waived">N/A</span>' : '';
      var title = d ? M.stripRevNote(d.def.text) || d.def.text : 'On the whole ' + UNIT;
      return revNoteGroup('goto-item', g, (d && d.template ? '<span class="muted rev-note-cl">' + esc(d.template.short || d.template.title || '') + '</span>' : '<span></span>') +
        '<span>' + esc(title) + '</span>' + chip);
    }).join('') + '</div>';
  }
  function revNoteGroup(act, g, head) {
    return '<div class="rev-note">' +
      '<button class="rev-issue rev-note-head" data-act="' + act + '" data-id="' + esc(g.item) + '"' + (g.item ? '' : ' disabled') + '>' + head + '</button>' +
      g.comments.map(function (c) {
        return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span>' + relTime(c.at) + '</span></div>' +
          '<div class="cmt-text">' + esc(M.stripRevNote(c.text) || c.text) + '</div></div></div>';
      }).join('') + '</div>';
  }
  // The composer's foot: the @revnotes hint (EE, where the Revisions tab lists them) over the post shortcut.
  function composerFoot() {
    return '<div class="composer-foot"><span class="composer-hints">' +
      (C.runs ? '<span><b>@revnotes</b> notes it for the next revision</span>' : '') +
      (SPEC ? '<span><b>@req</b> flags it to become a requirement</span>' : '') +
      '<span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to post</span></span><button class="btn btn-primary" data-act="post-comment">Comment</button></div>';
  }
  function emptyCard(title, text) { return '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>' + esc(title) + '</h2><p>' + text + '</p></div>'; }
  function runCounts(r) {
    var s = r.summary;
    return [s.error && plural(s.error, 'error'), s.warn && plural(s.warn, 'warning'), s.info && s.info + ' info'].filter(Boolean).join(' · ') || 'No findings';
  }
  function revChip(p, rev) {
    var next = M.supersededBy(p, rev.id);
    return '<span class="chip rev-chip ' + rev.status + '">' + esc(revName(rev)) + ' · ' + esc(revStatus(rev)) + '</span>' +
      (next ? '<span class="muted rev-sup">superseded by ' + esc(next.label) + '</span>' : '');
  }
  function runLine(p, r, n) {
    var rev = M.revisionForRun(p, r.id);
    return '<div class="rev-line"><div class="rev-name">' + esc(r.package.name || 'Package') + (n > 1 ? ' <span class="muted">· ' + plural(n, 'run') + '</span>' : '') + '</div>' +
      '<div class="rev-meta muted">' + esc([fmtDate(r.at), r.by, r.profile].filter(Boolean).join(' · ')) + ' · ' + esc(runCounts(r)) + '</div></div>' +
      (rev ? '<div class="rev-tag">' + revChip(p, rev) + '</div>' : '');
  }
  function runActions(p, r) {
    var rev = M.revisionForRun(p, r.id);
    return '<div class="rev-acts">' +
      '<button class="btn btn-primary" data-act="open-fabcheck" data-run="' + esc(r.id) + '" data-href="' + esc(fabcheckUrl(p, { run: r })) + '">Open in Fabcheck</button>' +
      (r.zip && !DEMO ? '<button class="btn" data-act="run-download" data-run="' + esc(r.id) + '" title="SHA-256 ' + esc(r.zip.sha256) + '">Download ' + esc(fmtSize(r.zip.size)) + '</button>' : '') +
      '<button class="btn" data-act="rev-tag" data-run="' + esc(r.id) + '">' + (rev ? 'Edit revision' : 'Tag as revision') + '</button></div>';
  }
  function runDetail(p, r) {
    var rev = M.revisionForRun(p, r.id), h = runActions(p, r);
    if (rev) {
      var fab = [rev.fab.house, rev.fab.sentAt && 'sent ' + rev.fab.sentAt, rev.fab.ref && 'order ' + rev.fab.ref].filter(Boolean).join(' · ');
      h += '<div class="rev-info">' + (fab ? '<div>' + esc(fab) + '</div>' : '') + (rev.notes ? '<div class="rev-notes">' + esc(rev.notes) + '</div>' : '') +
        '<div class="muted">Tagged by ' + esc(rev.updatedBy || 'someone') + (rev.updatedAt ? ', ' + relTime(rev.updatedAt) : '') + '</div></div>';
    }
    if (r.zip) {
      h += '<div class="rev-sub">' + esc(r.zip.name) + ' <span class="muted">· ' + esc(fmtSize(r.zip.size)) + '</span></div><div class="rev-files">' +
        M.zipFolders(r.zip).map(function (g) {
          return '<div class="rev-folder"><b>' + esc(g.folder ? g.folder + '/' : 'Top level') + '</b>' + g.files.map(function (f) {
            return '<div class="rev-file"><span title="' + esc(f.path) + '">' + esc(f.name) + '</span><span class="muted">' + esc(fmtSize(f.size)) + '</span></div>';
          }).join('') + '</div>';
        }).join('') + '</div>';
    } else if (!DEMO) {
      h += '<p class="note">This run was stored without a package zip, so there’s nothing to download. Open in Fabcheck asks for the package to be dropped in.</p>';
    }
    var issues = runIssues(p, r.id);
    h += '<div class="rev-sub">' + (issues.length ? 'Issues from this run' : 'No Fabcheck issues name this run') + '</div>';
    if (issues.length) {
      h += '<div class="rev-issues">' + issues.map(function (c) {
        var it = p.items[c.id] || {}, res = M.oneOf(M.RESOLUTIONS, it.resolution, ''), sev = M.oneOf(M.SEVERITIES, it.severity, M.oneOf(M.SEVERITIES, c.severity, 'minor'));
        return '<button class="rev-issue" data-act="goto-item" data-id="' + esc(c.id) + '"><span class="sev ' + sev + '">' + cap(sev) + '</span><span>' + esc(c.text) + '</span>' +
          '<span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</span></button>';
      }).join('') + '</div>';
    }
    return h;
  }

  // Tag a run as a revision, or edit its tag. Anyone on the review can, like any review record.
  function revisionSheet(p, run) {
    var rev = M.revisionForRun(p, run.id);
    var r = rev || { label: M.nextRevLabel(p), title: '', status: 'sent', fab: { house: '', sentAt: new Date().toISOString().slice(0, 10), ref: '' }, notes: '' };
    var w = sheet('<div class="sheet-head"><h2>' + (rev ? 'Revision ' + esc(rev.label) : 'Tag as revision') + '</h2><p>' + esc(run.package.name || 'Package') + ' · ' + esc(fmtDate(run.at)) + (run.by ? ' · ' + esc(run.by) : '') + '</p></div>' +
      '<div class="sheet-body">' +
      '<div class="row2"><div class="field"><label for="v-label">Label</label><input class="input" id="v-label" value="' + esc(r.label) + '" maxlength="40" placeholder="e.g. 3.2"></div>' +
      '<div class="field"><label for="v-status">Status</label><select class="input" id="v-status">' + M.REV_STATUS.map(function (s) { return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + esc(M.REV_STATUS_LABEL[s]) + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="field"><label for="v-title">Title</label><input class="input" id="v-title" value="' + esc(r.title) + '" maxlength="200" placeholder="e.g. DFM updates"></div>' +
      '<div class="row2"><div class="field"><label for="v-house">Fab house</label><input class="input" id="v-house" value="' + esc(r.fab.house) + '" maxlength="100" placeholder="Optional"></div>' +
      '<div class="field"><label for="v-sent">Date sent</label><input class="input" type="date" id="v-sent" value="' + esc(r.fab.sentAt) + '"></div></div>' +
      '<div class="field"><label for="v-ref">Order or quote ref</label><input class="input" id="v-ref" value="' + esc(r.fab.ref) + '" maxlength="100" placeholder="Optional"></div>' +
      '<div class="field"><label for="v-notes">Notes</label><textarea class="input" id="v-notes" maxlength="4000" placeholder="What changed, what it was used for">' + esc(r.notes) + '</textarea></div>' +
      '</div><div class="sheet-foot">' + (rev ? '<button class="btn btn-danger" data-sheet="untag">Remove tag</button><span class="spacer"></span>' : '') +
      '<button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">' + (rev ? 'Save' : 'Tag') + '</button></div>');
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      p.revisions = p.revisions || {};
      if (b.dataset.sheet === 'untag') {
        p.revisions[rev.id] = M.stamp(Object.assign({}, p.revisions[rev.id], { deleted: true }), me());
        closeSheet(); touch(p); renderPage(); toast('Tag removed'); syncSoon(); return;
      }
      var val = function (id) { return w.querySelector('#' + id).value.trim(); };
      var fields = { label: val('v-label'), title: val('v-title'), status: val('v-status'), house: val('v-house'), sentAt: val('v-sent'), ref: val('v-ref'), notes: val('v-notes') };
      if (!fields.label) { w.querySelector('#v-label').focus(); return; }
      var rec = M.newRevision(run, fields, me());
      if (rev) p.revisions[rev.id] = M.stamp(Object.assign({}, p.revisions[rev.id], { label: rec.label, title: rec.title, status: rec.status, fab: rec.fab, notes: rec.notes }), me());
      else p.revisions[rec.id] = rec;
      closeSheet(); touch(p); renderPage(); toast(rev ? 'Revision saved' : 'Tagged as ' + rec.label); syncSoon();
    });
  }

  // Download a run's package zip from the review's repo, checked against its recorded SHA-256.
  function downloadRun(p, r) {
    if (!r || !r.zip) return;
    var st = runsOf[p.id], path = checkerDir(p, C.runs.dir) + r.zip.rel;
    var entries = st && st.entries && st.entries.some(function (e) { return e.path === path; }) ? st.entries : undefined;
    toast('Downloading ' + r.zip.name + '…');
    workspace().store(homeOf(p)).readVerified(path, r.zip.sha256, entries).then(function (bytes) {
      download(r.zip.name, bytes, 'application/zip');
      toast('Saved ' + r.zip.name + ' (SHA-256 checked)');
    }, function (err) {
      toast(err.code === 'mismatch' ? 'Not saved: the stored zip doesn’t match its recorded SHA-256' : err.code === 'missing' ? 'Not saved: the zip isn’t in the repository' : 'Not saved: ' + (err.message || err));
    });
  }

  // Read a stored run and its zip with this tab's token and leave them for Fabcheck (S.handoff).
  // Resolves 'ok', 'missing' (no such run file) or 'nozip' (stored without a zip).
  // step(text, fraction) reports progress, if given.
  function handOff(p, runId, step) {
    step = step || function () {};
    var dir = checkerDir(p, C.runs.dir), store = workspace().store(homeOf(p));
    step('Listing the ' + UNIT + '’s stored runs…', 0.1);
    return store.listTree(dir).then(function (entries) {
      step('Reading run ' + runId + '…', 0.3);
      return store.readBytes(dir + 'runs/' + runId + '.json', entries).then(function (b) {
        var r = null;
        try { r = b && M.cleanRun(JSON.parse(new TextDecoder().decode(b))); } catch (e) { r = null; }
        if (!r || r.id !== runId) return 'missing';
        if (!r.zip) return 'nozip';
        step('Downloading the fab package' + (r.zip.size ? ' (' + (r.zip.size / 1048576).toFixed(1) + ' MB)' : '') + '…', 0.5);
        return store.readVerified(dir + r.zip.rel, r.zip.sha256, entries).then(function (zip) {
          step('Handing the run to Fabcheck…', 0.9);
          return S.handoff.put({ id: runId, run: r.raw, findings: r.findings, zip: zip, at: M.now() }, DEMO);
        }).then(function () { return 'ok'; });
      });
    });
  }

  // A wait that says what it is doing: a card over the page with a spinner, a step line, and a bar.
  // Returns { step(text, fraction), stop(text, actions) , close() }; actions are [label, fn, primary].
  function busyCard(title) {
    var old = $('#busy-wrap'); if (old) old.remove();
    var w = document.createElement('div');
    w.className = 'sheet-wrap'; w.id = 'busy-wrap';
    w.innerHTML = '<div class="sheet busy" role="status" aria-live="polite"><div class="busy-row"><span class="busy-spin" aria-hidden="true"></span><div style="flex:1;min-width:0">' +
      '<div class="busy-title">' + esc(title) + '</div><div class="busy-step"></div><div class="busy-bar"><i></i></div></div></div><div class="busy-acts"></div></div>';
    document.body.appendChild(w);
    var card = w.firstChild, stepEl = w.querySelector('.busy-step'), bar = w.querySelector('.busy-bar i'), acts = w.querySelector('.busy-acts');
    return {
      step: function (text, frac) { stepEl.textContent = text; if (frac != null) bar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%'; },
      stop: function (text, actions, newTitle) {
        card.classList.add('done'); stepEl.textContent = text;
        if (newTitle) w.querySelector('.busy-title').textContent = newTitle;
        acts.innerHTML = '';
        (actions || []).forEach(function (a) {
          var b = document.createElement('button');
          b.className = 'btn' + (a[2] ? ' btn-primary' : ''); b.textContent = a[0];
          b.addEventListener('click', a[1]); acts.appendChild(b);
        });
        var first = acts.querySelector('.btn-primary'); if (first) first.focus();
      },
      close: function () { w.remove(); }
    };
  }
  // Back from Fabcheck restores this page from the browser's cache, card and all.
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) { var b = $('#busy-wrap'); if (b) b.remove(); try { localStorage.removeItem(NS + 'fabReturn'); } catch (e) { /* storage blocked */ } } });
  // Fabcheck's "Back to Signoff EE" loads this page again. Open in Fabcheck left a return point
  // (fabReturn: the board, tab, open check, and scroll), and Fabcheck sets the board and tab from
  // it (signoff.js openFindings); this puts back the check and the scroll. It's used once, and
  // only within the hour.
  function returnFromFabcheck() {
    var r = load('fabReturn', null);
    if (!r) return;
    try { localStorage.removeItem(NS + 'fabReturn'); } catch (e) { /* storage blocked */ }
    var p = current();
    if (!p || p.id !== r.project || ui.view !== r.view || !(Date.now() - Date.parse(r.at) < 3600000)) return;
    $('#main').scrollTop = r.scroll || 0;
    if (!r.selected) return;
    selected = r.selected;
    var el = document.querySelector('.item[data-id="' + CSS.escape(r.selected) + '"]');
    if (el) el.classList.add('sel');
    $('#inspector').classList.add('open'); renderInspector();
  }

  // Open in Fabcheck, in this tab: a card says what Signoff is reading while it hands the run off,
  // then the tab goes to the run's link. The demo's runs open in Fabcheck's demo, which has their
  // boards; without a token Fabcheck asks for the package.
  function openFabcheck(el) {
    var href = new URL(el.dataset.href, location.href).href, runId = el.dataset.run || '', p = current();
    if (p) save('fabReturn', { project: p.id, view: ui.view, selected: selected || '', scroll: $('#main').scrollTop, at: M.now() });
    var card = busyCard('Opening in Fabcheck');
    function go() { card.step('Opening Fabcheck…', 1); location.href = href; }
    if (DEMO || !C.runs || !p || !getToken() || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return go();
    // If the run can't be handed over, say why and let them choose; Fabcheck would ask for the package.
    function ask(why) {
      card.stop(why + ' Fabcheck will ask for the package instead.', [['Stay here', card.close], ['Open Fabcheck', go, true]], 'The run can’t be handed over');
    }
    handOff(p, runId, card.step).then(function (res) {
      if (res === 'missing') ask('This run isn’t stored with the ' + UNIT + '.');
      else if (res === 'nozip') ask('This run was stored without a package zip.');
      else go();
    }, function (err) {
      ask(err.code === 'mismatch' ? 'The stored zip doesn’t match its SHA-256.' : 'Couldn’t read the run from GitHub' + (err.message ? ' (' + err.message + ')' : '') + '.');
    });
  }

  // Redraws keep the field you're typing in. A sync that finishes while you write a comment
  // redraws the page and the details pane; without this the new text box wasn't focused, and the
  // next keys went to the page's shortcuts. Fields are found again by id, with the caret and
  // scroll they had.
  function focusNow() {
    var a = document.activeElement;
    if (!a || !a.id || !/^(INPUT|TEXTAREA)$/.test(a.tagName)) return null;
    var f = { el: a, id: a.id, top: a.scrollTop };
    try { f.start = a.selectionStart; f.end = a.selectionEnd; f.dir = a.selectionDirection; } catch (e) { /* no selection on this input type */ }
    return f;
  }
  function restoreFocus(f) {
    if (!f || f.el.isConnected) return;   // not redrawn: nothing to do
    var a = document.getElementById(f.id);
    if (!a || a === document.activeElement || !/^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
    a.focus({ preventScroll: true });
    try { if (f.start != null) a.setSelectionRange(f.start, f.end, f.dir); } catch (e) { /* no selection on this input type */ }
    a.scrollTop = f.top;
  }
  function renderInspector() { var f = focusNow(); drawInspector(); restoreFocus(f); }
  function drawInspector() {
    var el = $('#inspector'), p = current();
    if (!p || !selected || !el.classList.contains('open')) return;
    var rq = reqOf(p, selected);
    if (rq) return renderReqInspector(p, rq);
    if (specSel()) return renderSpecInspector(p);
    if (specBlockSel()) return renderSpecBlockInspector(p);
    if (specEdgeSel()) return renderSpecEdgeInspector(p);
    var d = itemDef(p, selected);
    var st = p.items[selected] || {};
    var row = null;
    if (d.template) {
      M.checklistRows(p, d.template).forEach(function (g) { g.rows.forEach(function (r) { if (r.id === selected) row = r; }); });
    }
    var status = row ? row.status : M.oneOf(M.STATUSES, st.status, 'open');
    var sev = M.oneOf(M.SEVERITIES, st.severity, M.oneOf(M.SEVERITIES, d.def.severity, 'minor'));
    var comments = M.liveComments(p, selected);
    var draft = el.querySelector('#comment-input');
    var draftText = draft ? draft.value : '';
    // Redrawing the same check (a status or field change) keeps where the panel was scrolled
    // and what was expanded; opening a different check starts at the top.
    var keep = el.dataset.item === selected ? {
      body: (el.querySelector('.insp-body') || {}).scrollTop || 0,
      locs: (el.querySelector('.fab-locs') || {}).scrollTop || 0,
      details: !!(el.querySelector('.fab-detail') || {}).open
    } : null;
    var statusBtn = function (s, label) { return '<button class="s-' + s + (status === s ? ' on' : '') + '" data-act="set" data-status="' + s + '" data-id="' + esc(selected) + '">' + label + '</button>'; };
    el.classList.toggle('is-reference', !!(row && row.reference));
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">' + esc(d.template ? d.template.short + ' › ' + (d.section ? d.section.title : '') : 'Retired check') + '</div>' +
      '<button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="insp-title"' + (d.custom ? ' contenteditable="true" data-edit-custom="' + esc(selected) + '"' : '') + '>' + esc(d.def.text) + '</div>' +
      fabcheckBlock(p, d.def) + pincheckBlock(p, d.def) +
      (row && row.reference ? '<div class="note ref-note">Waived in ' + esc(checkerName(d.def) || 'a checker') + ' and kept here for reference. It isn’t an issue and isn’t counted in progress, issues, or the project summary.</div>' : '') +
      (d.def.hint && !checkerName(d.def) ? '<div class="hint"><b>Guidance</b>' + esc(d.def.hint) + '</div>' : '') +
      tracedBy(p, selected) +
      (row && row.auto ? '<div class="note" style="margin:-4px 0 12px">' + (row.auto === 'section' ? 'Counted as N/A because the section is marked N/A.' : 'Counted as N/A: outside this ' + W.thing + '’s profile (' + esc((d.def.tags || d.section.tags || []).join(', ')) + '). Set a status to review it anyway.') + '</div>' : '') +
      '<div class="field"><span class="field-label">Status</span><div class="seg full">' + statusBtn('open', 'To review') + statusBtn('pass', 'Pass') + statusBtn('issue', 'Issue') + statusBtn('na', 'N/A') + '</div></div>' +
      (status === 'issue' ? '<div class="issue-box">' +
        '<div class="field"><span class="field-label">Severity</span><div class="seg full">' + M.SEVERITIES.map(function (s) {
          return '<button class="' + (sev === s ? 'on' : '') + '" data-act="item-field" data-key="severity" data-val="' + s + '"><span class="sev ' + s + '">' + s[0].toUpperCase() + s.slice(1) + '</span></button>';
        }).join('') + '</div></div>' +
        '<div class="field"><span class="field-label">Resolution</span><div class="seg full">' + [['', 'Open'], ['fixed', 'Fixed'], ['waived', 'Waived']].map(function (r) {
          return '<button class="' + ((st.resolution || '') === r[0] ? 'on' : '') + '" data-act="item-field" data-key="resolution" data-val="' + r[0] + '">' + r[1] + '</button>';
        }).join('') + '</div></div>' +
        '<div class="field"><label for="assignee">Owner</label><input class="input" id="assignee" value="' + esc(st.assignee || '') + '" placeholder="Who will fix it" data-item-input="assignee"></div>' +
        '<div class="field"><label for="ref">Reference</label><input class="input" id="ref" value="' + esc(st.ref || '') + '" placeholder="Designators, sheet, net, ticket…" data-item-input="ref"></div>' +
        '</div>' : '') +
      (st.updatedAt ? '<div class="meta-line">Last changed by ' + esc(st.updatedBy || 'someone') + ', ' + relTime(st.updatedAt) + '</div>' : '') +
      (d.custom ? '<button class="btn btn-danger" data-act="delete-custom" data-id="' + esc(selected) + '" style="margin-bottom:10px">Delete ' + UNIT + ' check</button>' : '') +
      '<div class="thread"><div class="thread-title">Discussion <span class="note" style="margin:0">' + (comments.length || '') + '</span></div>' +
      (comments.length ? comments.map(function (c) {
        return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span title="' + esc(new Date(c.at).toLocaleString()) + '">' + relTime(c.at) + '</span>' +
          (c.author === me() ? '<button class="cmt-del" data-act="del-comment" data-id="' + esc(c.id) + '">Delete</button>' : '') + '</div><div class="cmt-text">' + esc(c.text) + '</div></div></div>';
      }).join('') : '<p class="note">No comments yet. Note what you checked, what you found, or ask the designer a question.</p>') +
      '</div></div>' +
      '<div class="composer"><textarea class="input" id="comment-input" placeholder="Add a comment…" rows="2">' + esc(draftText) + '</textarea>' +
      composerFoot() + '</div>';
    el.dataset.item = selected;
    if (keep) {
      var det = el.querySelector('.fab-detail');
      if (det && keep.details) det.open = true;
      var locs = el.querySelector('.fab-locs');
      if (locs) locs.scrollTop = keep.locs;
      el.querySelector('.insp-body').scrollTop = keep.body;
    }
  }

  // ── Requirements ─────────────────────────────────────────
  // The project's own requirements (model.js: liveReqs, reqTrace…). Each one can trace to
  // checks in the project's checklists, whose status then shows next to it.
  var REQ_LABEL = { inspection: 'Inspection', analysis: 'Analysis', demonstration: 'Demonstration', test: 'Test',
    draft: 'Draft', approved: 'Approved', changed: 'Changed', deprecated: 'Deprecated', open: 'Not verified', pass: 'Pass', fail: 'Fail',
    shall: 'Shall', should: 'Should', sys: 'System', ee: 'EE', me: 'ME', fw: 'FW', other: 'Other' };
  function reqOf(p, id) { var q = p && p.reqs && p.reqs[id]; return q && !q.deleted ? q : null; }
  // Requirements is picked in the project sheet like a checklist ('reqs' in meta.checklists).
  // Projects from before that choice existed show it if they already have requirements.
  // Turning it off hides it but keeps the requirements, as a checklist's state is kept.
  function reqsOn(p) {
    return !!p && M.reqsEnabled(p);
  }
  function checkIdx(p) { return M.checkIndex(p, TEMPLATES); }

  function setReq(id, fields) {
    var p = current(); if (!p) return;
    var prev = reqOf(p, id); if (!prev) return;
    var next = Object.assign({}, prev, fields);
    // An approved requirement whose wording changes needs approving again.
    if (prev.status === 'approved' && fields.text !== undefined && fields.text !== prev.text) next.status = 'changed';
    p.reqs[id] = M.stamp(next, me());
    touch(p); renderPage(); renderInspector();
  }
  function addReq() {
    var p = current(); if (!p) return;
    p.reqs = p.reqs || {};
    var q = M.newReq(p, {}, me());
    p.reqs[q.id] = q;
    touch(p);
    ui.view = 'reqs'; saveUi();
    openReq(q.id);
    setTimeout(function () { var t = $('#req-text'); if (t) t.focus(); }, 60);
  }
  function openReq(id) {
    selected = id;
    closeInspector();
    renderPage();
    $('#inspector').classList.add('open');
    renderInspector();
    var row = document.querySelector('tr[data-act="select-req"][data-id="' + CSS.escape(id) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function traceChip(t) {
    if (t.state === 'none') return '<span class="res waived">Not traced</span>';
    var cls = t.state === 'issue' ? 'open' : t.state === 'pass' ? 'fixed' : 'waived';
    var label = t.state === 'issue' ? plural(t.issue, 'issue') : t.state === 'pass' ? 'Checks pass' : t.open + ' to review';
    var tip = t.pass + ' pass · ' + t.issue + ' issue · ' + t.open + ' to review' + (t.na ? ' · ' + t.na + ' N/A' : '') + (t.missing ? ' · ' + t.missing + ' no longer in the ' + UNIT : '');
    return '<span class="res ' + cls + '" title="' + tip + '">' + label + '</span>';
  }
  function verifyChip(v) { return '<span class="res ' + (v === 'pass' ? 'fixed' : v === 'fail' ? 'open' : 'waived') + '">' + REQ_LABEL[v] + '</span>'; }

  // Failing: its verification failed. At risk: an open issue on a check it traces to (model.reqState).
  function reqFailing(q, idx) { return M.reqState(q, idx) === 'fail'; }
  function reqAtRisk(q, idx) { return M.reqState(q, idx) === 'risk'; }
  function reqTrouble(q, idx) { var s = M.reqState(q, idx); return s === 'fail' || s === 'risk'; }
  // A requirement's discipline, shown only when it isn't this tool's own; and its Signoff PL parent.
  function disciplineChip(q) { var d = M.reqDiscipline(q); return d === M.ownDiscipline() ? '' : '<span class="chip">' + REQ_LABEL[d] + '</span> '; }
  function parentChip(q) {
    var par = M.reqParent(q);
    return par ? '<span class="chip accent" title="Flows down from ' + esc(par.ref) + ' in the project plan (Signoff PL): ' + esc(par.text) + '">↑ ' + esc(par.ref || 'project') + '</span> ' : '';
  }
  function reqMatches(q, idx) {
    var f = ui.reqFilter || 'all';
    if (ui.reqQuery) {
      var s = ui.reqQuery.toLowerCase();
      if ([q.ref, q.text, q.category, q.source, REQ_LABEL[M.reqDiscipline(q)], (M.reqParent(q) || {}).ref].join(' ').toLowerCase().indexOf(s) < 0) return false;
    }
    // Deprecated requirements stay in All, lined out, and have a filter of their own.
    if (f === 'deprecated') return q.status === 'deprecated';
    if (f !== 'all' && q.status === 'deprecated') return false;
    if (f === 'draft') return q.status !== 'approved';
    if (f === 'open') return q.verify === 'open';
    if (f === 'fail') return reqFailing(q, idx);
    if (f === 'risk') return reqAtRisk(q, idx);
    if (f === 'parent') return !!M.reqParent(q);
    if (f === 'unlinked') return !(q.links || []).length;
    return true;
  }

  function reqsPage(p) {
    var idx = checkIdx(p), all = M.liveReqs(p), st = M.reqStats(p);
    var list = all.filter(function (q) { return reqMatches(q, idx); });
    var failing = all.filter(function (q) { return reqFailing(q, idx); }).length;
    var atRisk = all.filter(function (q) { return reqAtRisk(q, idx); }).length;
    var fromPlan = all.filter(function (q) { return q.status !== 'deprecated' && M.reqParent(q); }).length;
    var filters = [['all', 'All', st.total], ['draft', 'Not approved', st.total - st.approved], ['open', 'Not verified', st.open],
      ['risk', 'At risk', atRisk], ['fail', 'Failing', failing], ['unlinked', 'Not traced', st.unlinked]]
      .concat(fromPlan ? [['parent', 'From the project plan', fromPlan]] : [], st.deprecated ? [['deprecated', 'Deprecated', st.deprecated]] : []);
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Requirements</h1>' +
      '<div class="page-sub"><span>' + plural(st.total, 'requirement') + '</span><span class="sep">·</span><span>' + st.approved + ' approved</span>' +
      '<span class="sep">·</span><span>' + st.pass + ' verified</span>' +
      (atRisk ? '<span class="sep">·</span><span style="color:var(--issue)">' + atRisk + ' at risk</span>' : '') +
      (failing ? '<span class="sep">·</span><span style="color:var(--issue)">' + failing + ' failing</span>' : '') +
      (st.deprecated ? '<span class="sep">·</span><span>' + st.deprecated + ' deprecated</span>' : '') + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="req-import">Import</button>' +
      (all.length ? '<button class="btn" data-act="req-export">Export CSV</button>' : '') +
      '<button class="btn btn-primary" data-act="req-add">Add requirement</button></div></div>';
    if (st.duplicates.length) {
      html += '<div class="card" style="padding:12px 16px;margin-bottom:14px;font-size:13px">More than one requirement uses ' +
        st.duplicates.map(esc).join(', ') + '. Renumber one so the trace stays unambiguous.</div>';
    }
    if (!all.length) {
      return html + '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>No requirements yet</h2>' +
        '<p>List what this ' + W.thing + ' must do, how each requirement will be verified, and which checks show it’s met. Add them one at a time, or import a spreadsheet with a Requirement column.</p>' +
        '<button class="btn btn-primary" data-act="req-add">Add requirement</button> <button class="btn" data-act="req-import">Import</button></div></div>';
    }
    html += '<div class="filters"><div class="seg">' + filters.map(function (f) {
      return '<button class="' + ((ui.reqFilter || 'all') === f[0] ? 'on' : '') + '" data-act="req-filter" data-filter="' + f[0] + '">' + f[1] + ' <span class="count">' + f[2] + '</span></button>';
    }).join('') + '</div><div class="search">' + ICON.search + '<input id="req-search" type="search" placeholder="Filter requirements" value="' + esc(ui.reqQuery || '') + '" autocomplete="off"></div></div>';
    if (!list.length) return html + '<div class="empty"><h2>Nothing here</h2><p>No requirements match this filter.</p></div></div>';
    html += '<div class="card table-scroll"><table class="table reqs"><thead><tr><th>ID</th><th>Requirement</th><th>Verify by</th><th>Status</th><th>Verified</th><th>Trace</th></tr></thead><tbody>' +
      list.map(function (q) {
        var n = M.liveComments(p, q.id).length;
        var cls = [selected === q.id ? 'sel' : '', q.status === 'deprecated' ? 'deprecated' : ''].filter(Boolean).join(' ');
        return '<tr data-act="select-req" data-id="' + esc(q.id) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
          '<td class="req-ref">' + esc(q.ref) + '</td>' +
          '<td>' + (q.text ? '<span class="req-text">' + esc(q.text) + '</span>' : '<span class="muted">No text yet</span>') +
          '<div class="muted">' + parentChip(q) + disciplineChip(q) + esc([REQ_LABEL[q.kind], q.category, q.source].filter(Boolean).join(' · ')) +
          (n ? ' <span class="cmt-count">' + ICON.bubble + n + '</span>' : '') + '</div></td>' +
          '<td class="muted">' + REQ_LABEL[q.method] + '</td>' +
          '<td><span class="chip' + (q.status === 'approved' ? ' accent' : '') + '">' + REQ_LABEL[q.status] + '</span></td>' +
          (q.status === 'deprecated' ? '<td></td><td></td></tr>' :
          '<td>' + verifyChip(q.verify) + (reqAtRisk(q, idx) ? ' <span class="res open" title="An open issue on a check it traces to">At risk</span>' : '') + '</td>' +
          '<td>' + traceChip(M.reqTrace(q, idx)) + '</td></tr>');
      }).join('') + '</tbody></table></div></div>';
    return html;
  }

  // On a requirement that flows down from Signoff PL: the parent's snapshot, read-only.
  function parentBlock(q) {
    var par = M.reqParent(q);
    return par ? '<div class="field"><span class="field-label">Flows down from</span><div class="card" style="padding:10px 12px;font-size:13px"><b>' + esc(par.ref) + '</b> · project plan<div>' + esc(par.text) + '</div>' +
      '<p class="note" style="margin:6px 0 0">Set in Signoff PL. Rewording this requirement marks it Changed, so the project lead approves it again.</p></div></div>' : '';
  }

  function renderReqInspector(p, q) {
    var el = $('#inspector'), idx = checkIdx(p);
    var keep = el.dataset.item === q.id ? { body: (el.querySelector('.insp-body') || {}).scrollTop || 0 } : null;
    var draft = el.querySelector('#comment-input'), draftText = draft ? draft.value : '';
    var search = el.dataset.item === q.id && el.querySelector('#req-link-search');
    var linkQuery = search ? search.value : '';
    var comments = M.liveComments(p, q.id);
    function seg(key, values) {
      return '<div class="seg full">' + values.map(function (v) {
        var tone = key === 'verify' && v !== 'open' ? ' s-' + (v === 'pass' ? 'pass' : 'issue') : '';
        return '<button class="' + ((key === 'discipline' ? M.reqDiscipline(q) : q[key]) === v ? 'on' : '') + tone + '" data-act="req-field" data-key="' + key + '" data-val="' + v + '">' + REQ_LABEL[v] + '</button>';
      }).join('') + '</div>';
    }
    var links = (q.links || []).map(function (id) {
      var c = idx[id];
      if (!c) {
        return '<div class="req-link missing"><span class="req-link-main"><span class="status-dot"></span><span><span class="req-link-text">' + esc(id) + '</span><span class="muted">No longer in this ' + UNIT + '</span></span></span>' +
          '<button class="cmt-del" style="opacity:1" data-act="req-unlink" data-id="' + esc(id) + '">Remove</button></div>';
      }
      var label = c.status === 'open' ? 'To review' : c.status === 'na' ? 'N/A' : c.status === 'pass' ? 'Pass' : 'Issue';
      return '<div class="req-link"><button class="req-link-main" data-act="goto-item" data-id="' + esc(id) + '"><span class="status-dot st-' + c.status + '"></span>' +
        '<span><span class="req-link-text">' + esc(c.text) + '</span><span class="muted">' + esc(c.template.short + ' › ' + c.section.title) + ' · ' + label + '</span></span></button>' +
        '<button class="cmt-del" style="opacity:1" data-act="req-unlink" data-id="' + esc(id) + '">Remove</button></div>';
    }).join('');
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Requirements › ' + esc(q.ref) + '</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="row2"><div class="field"><label for="req-ref">ID</label><input class="input" id="req-ref" value="' + esc(q.ref) + '" data-req-input="ref"></div>' +
      '<div class="field"><span class="field-label">Type</span>' + seg('kind', ['shall', 'should']) + '</div></div>' +
      parentBlock(q) +
      '<div class="field"><label for="req-text">Requirement</label><textarea class="input" id="req-text" rows="3" data-req-input="text" placeholder="e.g. The ' + esc(W.thing) + ' shall run from 24 V DC ±10%.">' + esc(q.text) + '</textarea></div>' +
      '<div class="row2"><div class="field"><label for="req-cat">Category</label><input class="input" id="req-cat" value="' + esc(q.category) + '" placeholder="Power, interfaces…" data-req-input="category"></div>' +
      '<div class="field"><label for="req-src">Source</label><input class="input" id="req-src" value="' + esc(q.source) + '" placeholder="Spec and section" data-req-input="source"></div></div>' +
      '<div class="field"><span class="field-label">Discipline</span>' + seg('discipline', M.REQ_DISCIPLINES) + '</div>' +
      '<div class="field"><span class="field-label">Verify by</span>' + seg('method', M.REQ_METHODS) + '</div>' +
      '<div class="field"><span class="field-label">Status</span>' + seg('status', M.REQ_STATUS) + '</div>' +
      '<div class="field"><span class="field-label">Verified</span>' + seg('verify', M.REQ_VERIFY) + '</div>' +
      '<div class="field"><label for="req-ev">Evidence</label><textarea class="input" id="req-ev" rows="2" data-req-input="evidence" placeholder="Test report, measurement, analysis…">' + esc(q.evidence) + '</textarea></div>' +
      specDescribedIn(p, q) +
      '<div class="field"><span class="field-label">Traced checks ' + traceChip(M.reqTrace(q, idx)) + '</span>' +
      (links || '<p class="note" style="margin:0 0 8px">Link the checks that show this requirement is met; their status shows here.</p>') +
      '<input class="input" id="req-link-search" placeholder="Search checks to link…" value="' + esc(linkQuery) + '" autocomplete="off">' +
      '<div id="req-link-results">' + linkResults(q, idx, linkQuery) + '</div></div>' +
      '<div class="meta-line">Added ' + fmtDate(q.createdAt) + (q.updatedBy ? ' · last changed by ' + esc(q.updatedBy) + ', ' + relTime(q.updatedAt) : '') + '</div>' +
      '<button class="btn btn-danger" data-act="req-delete" style="margin-bottom:10px">Delete requirement</button>' +
      '<div class="thread"><div class="thread-title">Discussion <span class="note" style="margin:0">' + (comments.length || '') + '</span></div>' +
      (comments.length ? comments.map(function (c) {
        return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span title="' + esc(new Date(c.at).toLocaleString()) + '">' + relTime(c.at) + '</span>' +
          (c.author === me() ? '<button class="cmt-del" data-act="del-comment" data-id="' + esc(c.id) + '">Delete</button>' : '') + '</div><div class="cmt-text">' + esc(c.text) + '</div></div></div>';
      }).join('') : '<p class="note">No comments yet.</p>') + '</div></div>' +
      '<div class="composer"><textarea class="input" id="comment-input" placeholder="Add a comment…" rows="2">' + esc(draftText) + '</textarea>' +
      composerFoot() + '</div>';
    el.dataset.item = q.id;
    if (keep) el.querySelector('.insp-body').scrollTop = keep.body;
  }

  function linkResults(q, idx, query) {
    query = (query || '').trim().toLowerCase();
    if (query.length < 2) return '';
    var have = q.links || [];
    var hits = Object.keys(idx).map(function (k) { return idx[k]; }).filter(function (c) {
      return have.indexOf(c.id) < 0 && [c.text, c.section.title, c.template.short].join(' ').toLowerCase().indexOf(query) >= 0;
    }).slice(0, 8);
    if (!hits.length) return '<p class="note">No checks match.</p>';
    return '<div class="req-results">' + hits.map(function (c) {
      return '<button data-act="req-link" data-id="' + esc(c.id) + '"><span>' + esc(c.text) + '</span><span class="muted">' + esc(c.template.short + ' › ' + c.section.title) + '</span></button>';
    }).join('') + '</div>';
  }

  // On a check: the requirements it helps show are met.
  function tracedBy(p, id) {
    if (!reqsOn(p)) return '';
    var hits = M.liveReqs(p).filter(function (q) { return q.status !== 'deprecated' && (q.links || []).indexOf(id) >= 0; });
    if (!hits.length) return '';
    return '<div class="field"><span class="field-label">Traces to</span><div class="chips">' + hits.map(function (q) {
      return '<button class="chip accent" style="border:none" data-act="open-req" data-id="' + esc(q.id) + '" title="' + esc(q.text) + '">' + esc(q.ref) + '</button>';
    }).join('') + '</div></div>';
  }

  function importReqsSheet() {
    var p = current(); if (!p) return;
    var w = sheet('<div class="sheet-head"><h2>Import requirements</h2><p>Paste rows from Excel or a CSV file, or choose a file. The first row names the columns: ' +
      '<b>Requirement</b> (or <b>Description</b>, needed), and optionally <b>ID</b>, <b>Name</b>, <b>Type</b> or <b>Priority</b> (shall / should), <b>Category</b>, <b>Source</b>, ' +
      '<b>Verification</b> (inspection, analysis, demonstration, test), <b>Discipline</b> (system, EE, ME, FW, other), and <b>Status</b> (obsolete rows come in as deprecated). A row whose ID already exists updates that requirement.</p></div>' +
      '<div class="sheet-body"><textarea class="input" id="req-paste" rows="8" placeholder="ID, Requirement, Type, Category, Source, Verification"></textarea>' +
      '<p class="note" id="req-preview"></p><input type="file" id="req-file" accept=".csv,.tsv,.txt,text/csv"></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Import</button></div>', { wide: true });
    var ta = w.querySelector('#req-paste');
    function preview() {
      var out = w.querySelector('#req-preview');
      if (!ta.value.trim()) { out.textContent = ''; return; }
      try {
        var r = M.importReqs(p, M.parseTable(ta.value), me());
        out.textContent = r.added + ' to add, ' + r.updated + ' to update' + (r.skipped ? ', ' + r.skipped + ' rows without text skipped' : '') + '.';
      } catch (e) { out.textContent = e.message; }
    }
    ta.addEventListener('input', preview);
    w.querySelector('#req-file').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { ta.value = rd.result; preview(); };
      rd.readAsText(f);
    });
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      var r;
      try { r = M.importReqs(p, M.parseTable(ta.value), me()); } catch (err) { toast(err.message); return; }
      if (!r.records.length) { toast('Nothing to import'); return; }
      p.reqs = p.reqs || {};
      r.records.forEach(function (q) { p.reqs[q.id] = q; });
      touch(p); closeSheet();
      ui.view = 'reqs'; saveUi(); renderPage();
      toast('Imported — ' + r.added + ' added, ' + r.updated + ' updated'); syncSoon();
    });
  }

  // ── Scribe, the description tab (config.spec; model.specAnalysis) ────────
  // A free-form description, top level to drivers, tied to the requirements both ways. Sentences
  // are linked, standard, flagged (@req), or untraced; a section is edited as text in place.
  var SPEC = C.spec ? (typeof C.spec === 'object' ? C.spec : {}) : null;
  var SPEC_LABEL = (SPEC && SPEC.label) || 'Scribe';
  // Kinds and link words are the tool's (config.spec.kinds, .links; model.specKinds): FW's layers and
  // Uses by default, EE's subcircuit kinds with Connects and Supplies.
  function kindLabel(k) { return k ? M.specKindLabel(k) : 'None'; }
  function kindPlural(k) { return M.specKindPlural(k); }
  // The diagram's layers (layers layout), top to bottom; interfaces draw as lines, not a layer.
  function specRows() { return M.specKinds().filter(function (k) { return k !== 'interface'; }).map(function (k) { return [k, kindPlural(k)]; }); }
  var SPEC_FLOW = !!(SPEC && SPEC.layout === 'flow');
  // How a link reads from the other end, and as a verb.
  function linkFrom(word) { return { uses: 'Used by', connects: 'Connected from', supplies: 'Supplied by' }[String(word).toLowerCase()] || word + ' from'; }
  function linkVerb(word) { return { uses: 'uses', connects: 'connects to', supplies: 'supplies' }[String(word).toLowerCase()] || String(word).toLowerCase(); }
  function linkItemText(it) { return it.name + (it.label ? ' · ' + it.label : ''); }
  // Untraced is "Unlinked" on screen (Chris, 2026-11-09), beside Linked; data keys stay 'untraced'.
  var STATE_LABEL = { linked: 'Linked', std: 'Standard', tag: 'Flagged for a requirement', untraced: 'Unlinked', note: 'Review note' };
  var specEditing = null, specDraft = '', specPhrase = '', specNewAfter = '';
  function specOn(p) { return !!SPEC && !!p && M.specEnabled(p); }
  function specSelKey(sec, start) { return 'spec|' + sec + '|' + start; }
  function specSel() {
    var m = /^spec\|(.+)\|(\d+)$/.exec(selected || '');
    return m ? { sec: m[1], start: parseInt(m[2], 10) } : null;
  }
  function specFind(a, sec, start) {
    var x = a.sections.filter(function (y) { return y.sec.id === sec; })[0], hit = null;
    if (x) x.blocks.forEach(function (b) { (b.units || []).forEach(function (u) { if (u.start === start) hit = u; }); });
    return x && hit ? { x: x, u: hit } : null;
  }
  // Rewrite one section's body (a sentence edit, a describe-in, a save).
  function specPut(p, id, fields) {
    p.spec = p.spec || {};
    p.spec[id] = M.specStamp(Object.assign({}, p.spec[id], fields), me());
    touch(p);
  }
  function specUnitEdit(p, sec, start, op, arg) {
    var a = M.specAnalysis(p), f = specFind(a, sec, start);
    if (!f) return false;
    var body = M.specEdit(f.x.sec.body, f.u.start, f.u.end, op, arg);
    if (body === f.x.sec.body) { if (f.u.broken) toast('A mark in this sentence didn’t parse. Fix it with Edit section first.'); return false; }
    specPut(p, sec, { body: body });
    return true;
  }
  function reqLabel(q) { return (q.ref || '?') + (q.text ? ': ' + q.text : ''); }

  function specUnitHtml(p, a, x, u) {
    var sel = specSel(), on = sel && sel.sec === x.sec.id && sel.start === u.start;
    var tip = u.reqs.map(function (id) { return reqLabel(a.ctx.reqs[id]); }).concat(u.missing.map(function (t) { return t + ': not found'; })).join('\n');
    var inner = u.tokens.map(function (t, i) {
      if (t.t === 'tag') return '<span class="sl-tag" title="Flagged to become a requirement">@req</span>';
      if (t.t === 'text' && i === 0 && u.note) {
        var nm = /^(\s*)(check:)\s*/i.exec(t.text);
        if (nm) return esc(nm[1]) + '<span class="sl-note" title="A review note: resolve it in its panel">Check</span> ' + esc(t.text.slice(nm[0].length));
      }
      if (t.t === 'text') return esc(t.text);
      return specSpanHtml(t);
    }).join('');
    if (u.row) inner = specRowCells(u).join(' <span class="muted">·</span> ');
    if (u.broken) { inner += '<span class="sl-broken" title="' + esc(BROKEN_TIP) + '">mark?</span>'; tip = (tip ? tip + '\n' : '') + BROKEN_TIP; }
    return '<span class="su su-' + u.state + (u.broken ? ' su-broken' : '') + (on ? ' sel' : '') + '" data-act="spec-unit" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '"' +
      (tip ? ' title="' + esc(tip) + '"' : ' title="' + STATE_LABEL[u.state] + '"') + '>' + inner + '</span>';
  }
  // A mark's words, drawn as in a sentence.
  function specSpanHtml(t) {
    return '<span class="sl' + (t.reqs.length ? ' sl-req' : '') + (t.secs.length ? ' sl-sec' : '') + (t.std ? ' sl-std' : '') + (t.missing.length ? ' sl-missing' : '') + '">' + esc(t.text) + '</span>';
  }
  // A table row unit's cells, with its marks drawn: its text split at bars that aren't escaped, without
  // the empty cells outside the first and last bar.
  function specRowCells(u) {
    var cells = [''];
    u.tokens.forEach(function (t) {
      if (t.t === 'span') { cells[cells.length - 1] += specSpanHtml(t); return; }
      if (t.t === 'tag') { cells[cells.length - 1] += '<span class="sl-tag">@req</span>'; return; }
      for (var i = 0; i < t.text.length; i++) {
        if (t.text[i] === '\\' && t.text[i + 1] === '|') { cells[cells.length - 1] += '|'; i++; }
        else if (t.text[i] === '|') cells.push('');
        else cells[cells.length - 1] += esc(t.text[i]);
      }
    });
    cells = cells.map(function (c) { return c.trim(); });
    if (cells.length > 1 && cells[0] === '') cells.shift();
    if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  }
  var BROKEN_TIP = 'A mark in this sentence didn’t parse, so its words show as typed. A mark is [words]{…} on one line; brackets inside the words go in pairs, or in `code`.';
  function specBlocksHtml(p, a, x) {
    var html = '', list = false;
    x.blocks.forEach(function (b) {
      if (b.type !== 'li' && list) { html += '</ul>'; list = false; }
      if (b.type === 'p') html += '<p class="spec-p">' + b.units.map(function (u) { return specUnitHtml(p, a, x, u); }).join(' ') + '</p>';
      else if (b.type === 'li') { if (!list) { html += '<ul class="spec-ul">'; list = true; } html += '<li>' + b.units.map(function (u) { return specUnitHtml(p, a, x, u); }).join(' ') + '</li>'; }
      else if (b.type === 'gist') html += '<p class="spec-gist">' + esc(b.text) + '</p>';
      else if (b.type === 'code') html += '<pre class="spec-code">' + esc(b.text) + '</pre>';
      else if (b.type === 'uses') {
        html += '<div class="spec-uses"><span>' + esc(b.word || 'Uses') + '</span>' + b.items.map(function (it) {
          var id = M.specUseId(a.ctx, it);
          return id ? '<button class="chip" data-act="spec-goto" data-id="' + esc(id) + '">' + esc(linkItemText(it)) + '</button>' : '<span class="chip spec-chip-missing" title="No section has this title">' + esc(linkItemText(it)) + '</span>';
        }).join('') + '</div>';
      } else if (b.type === 'parts') {
        html += '<div class="spec-uses spec-parts"><span>Parts</span>' + b.items.map(function (n) { return '<span class="chip spec-part">' + esc(n) + '</span>'; }).join('') + '</div>';
      } else if (b.type === 'table' && b.rows.length) {
        var units = b.rowUnits || [], cells = function (r, i) { return units[i] ? specRowCells(units[i]) : r.map(function (c) { return esc(M.specPlain(c)); }); };
        html += '<div class="table-scroll spec-table-wrap"><table class="table spec-table"><thead><tr>' + cells(b.rows[0], 0).map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead><tbody>' +
          b.rows.slice(1).map(function (r, i) {
            var u = units[i + 1], sel = u && specSel(), on = u && sel && sel.sec === x.sec.id && sel.start === u.start;
            return (u ? '<tr class="su su-' + u.state + (u.broken ? ' su-broken' : '') + (on ? ' sel' : '') + '" data-act="spec-unit" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '" title="' + esc(STATE_LABEL[u.state] + (u.reqs.length ? ': ' + u.reqs.map(function (id) { return a.ctx.reqs[id].ref; }).join(', ') : '')) + '">' : '<tr>') +
              cells(r, i + 1).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
      }
    });
    if (list) html += '</ul>';
    return html;
  }
  function gapMark(n, title) { return n ? '<span class="spec-gap" title="' + esc(title) + '">' + n + '</span>' : ''; }
  // A block's gaps, one row per sentence: click to open that sentence in the document, where it can be
  // linked to a requirement, made one, or marked standard.
  function specGapList(x) {
    var gaps = [];
    x.blocks.forEach(function (bk) { (bk.units || []).forEach(function (u) { if (u.state === 'untraced' || u.state === 'tag') gaps.push(u); }); });
    if (!gaps.length) return '';
    return '<div class="field"><span class="field-label">Gaps</span>' + gaps.map(function (u) {
      return '<div class="req-link"><button class="req-link-main" data-act="spec-open" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '"><span><span class="req-link-text">' + esc(u.text) + '</span><span class="muted">' +
        (u.broken ? 'A mark in it didn’t parse: fix it in Edit its text' : u.state === 'tag' ? 'Flagged to become a requirement' : 'Unlinked: link a requirement, make one, or mark it standard') + '</span></span></button></div>';
    }).join('') + '</div>';
  }
  function specGapTitle(x) {
    return [x.counts.untraced ? plural(x.counts.untraced, 'unlinked sentence') : '', x.counts.tag ? x.counts.tag + ' flagged for a requirement' : ''].filter(Boolean).join(', ');
  }
  // A section's review notes ("Check: …"): a count in the margin, drawn apart from the gap count (an
  // outline, not the warning hatch), and a list in a block's panel.
  function noteMark(x) { var n = x.notes.length; return n ? '<span class="spec-note-mark" title="' + esc(plural(n, 'review note')) + '">' + n + '</span>' : ''; }
  function specNoteList(x) {
    if (!x.notes.length) return '';
    return '<div class="field"><span class="field-label">Review notes</span>' + x.notes.map(function (u) {
      return '<div class="req-link"><button class="req-link-main" data-act="spec-open" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '"><span><span class="req-link-text">' + esc(u.text) + '</span><span class="muted">Answer it in the text, then resolve it in its panel</span></span></button></div>';
    }).join('') + '</div>';
  }
  // The bar over the editor: the kinds left to right, as the diagram's layers run top to bottom. The
  // one lit is the kind of the heading the cursor is under; a click sets it. Add to Uses… adds a
  // section to that heading's Uses line.
  function specKindBarHtml() {
    if (!M.specKinds().length) {
      return '<div class="spec-kindbar" role="toolbar" aria-label="Links of the heading at the cursor"><span class="spec-kindbar-label">Headings under a heading make a section</span><span class="spacer"></span>' + M.specLinkWords().map(function (w) {
        return '<button type="button" class="btn btn-sm" data-act="spec-uses-add" data-word="' + esc(w) + '" title="Add a block to the ' + esc(w) + ' line of the heading at the cursor">Add to ' + esc(w) + '…</button>';
      }).join('') + '</div>';
    }
    return '<div class="spec-kindbar" role="toolbar" aria-label="Kind of the heading at the cursor"><span class="spec-kindbar-label">Heading kind</span>' +
      M.specKinds().map(function (k) { return '<button type="button" data-act="spec-kind-set" data-kind="' + k + '" title="Make the heading at the cursor a ' + k + '">' + kindLabel(k) + '<span class="count"></span></button>'; }).join('<span class="spec-kindbar-arrow" aria-hidden="true">›</span>') +
      '<button type="button" data-act="spec-kind-set" data-kind="" title="No kind: in the outline only, not the diagram">None</button>' +
      '<span class="spacer"></span>' + M.specLinkWords().map(function (w) {
        return '<button type="button" class="btn btn-sm" data-act="spec-uses-add" data-word="' + esc(w) + '" title="Add a section to the ' + esc(w) + ' line of the heading at the cursor">Add to ' + esc(w) + '…</button>';
      }).join('') + '</div>';
  }
  // The heading the cursor is under: { lines, at (its line), head (specHeading), cursorLine }.
  function specCursorHeading(ta) {
    var lines = ta.value.split('\n'), cl = ta.value.slice(0, ta.selectionStart).split('\n').length - 1, fence = false, at = -1;
    for (var i = 0; i <= cl && i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
      if (!fence && M.specHeading(lines[i])) at = i;
    }
    return { lines: lines, at: at, head: at >= 0 ? M.specHeading(lines[at]) : null, cursorLine: cl };
  }
  function specBarRefresh() {
    var ta = $('#spec-editor'), bar = document.querySelector('.spec-kindbar'); if (!ta || !bar) return;
    var h = specCursorHeading(ta), counts = {};
    M.specSplit(ta.value).forEach(function (c) { if (c.heading && c.heading.kind) counts[c.heading.kind] = (counts[c.heading.kind] || 0) + 1; });
    bar.querySelectorAll('[data-act="spec-kind-set"]').forEach(function (b) {
      var k = b.dataset.kind, c = b.querySelector('.count');
      b.classList.toggle('on', !!h.head && h.head.kind === k);
      b.disabled = !h.head;
      if (c) c.textContent = counts[k] ? ' ' + counts[k] : '';
    });
    bar.querySelectorAll('[data-act="spec-uses-add"]').forEach(function (b) { b.disabled = !h.head; });
  }
  // Rewrite the editor's text, keeping the cursor where it was relative to the text around it.
  function specEditorReplace(ta, lines, cursor) {
    ta.value = lines.join('\n');
    ta.setSelectionRange(cursor, cursor);
    specDraft = ta.value;
    if (specEditing === 'all') { var lo = $('#spec-live-outline'); if (lo) lo.innerHTML = specLiveOutline(); }
    ta.focus(); specBarRefresh();
  }
  function specKindSet(kind) {
    var ta = $('#spec-editor'); if (!ta) return;
    var h = specCursorHeading(ta);
    if (!h.head) { toast('Put the cursor under a heading first'); return; }
    var before = h.lines.slice(0, h.at).join('\n').length + (h.at ? 1 : 0), old = h.lines[h.at], pos = ta.selectionStart;
    h.lines[h.at] = M.specHeadingLine({ level: h.head.level, title: h.head.title, kind: kind });
    var delta = h.lines[h.at].length - old.length;
    specEditorReplace(ta, h.lines, pos > before + old.length ? pos + delta : Math.min(pos, before + h.lines[h.at].length));
  }
  function specUsesAdd(anchor, word) {
    word = M.specLinkWord(word) || M.specLinkWords()[0];
    var ta = $('#spec-editor'); if (!ta) return;
    var h = specCursorHeading(ta);
    if (!h.head) { toast('Put the cursor under a heading first'); return; }
    var p = current(), titles = {}, entries = [];
    M.specSplit(ta.value).concat(specEditing === 'all' || !p ? [] : M.liveSpec(p).map(function (s) { return { heading: s }; })).forEach(function (c) {
      var t = c.heading && c.heading.title; if (!t || titles[t.toLowerCase()] || t.toLowerCase() === h.head.title.toLowerCase()) return;
      titles[t.toLowerCase()] = 1; entries.push([t, t + (c.heading.kind ? '  (' + c.heading.kind + ')' : '')]);
    });
    if (!entries.length) { toast('No other sections to use yet'); return; }
    menu(anchor, entries).then(function (title) {
      var t2 = $('#spec-editor'); if (!t2) return;
      var hh = specCursorHeading(t2), end = hh.lines.length;
      for (var i = hh.at + 1; i < hh.lines.length; i++) if (M.specHeading(hh.lines[i])) { end = i; break; }
      var body = hh.lines.slice(hh.at + 1, end).join('\n'), items = M.specUsesItems(body, word);
      if (items.some(function (n) { return M.specUseIs(n, title); })) { toast(title + ' is already in ' + word); return; }
      var nb = M.specSetLine(body, word, M.specLinkText(items.concat([{ name: title, label: '' }]))).split('\n');
      var tail = hh.lines.slice(end), lines = hh.lines.slice(0, hh.at + 1).concat(nb, end < hh.lines.length ? [''] : [], tail);
      specEditorReplace(t2, lines, lines.slice(0, hh.at + 1 + nb.length).join('\n').length);
      toast('Added ' + title + ' to ' + word);
    });
  }
  // Under the editor, while writing: marks that don't parse (their words would show as typed) and
  // sections too long to save. Each line number puts the cursor there.
  function specDraftWarnHtml() {
    var broken = M.specBrokenMarks(specDraft), long = M.specSplit(specDraft).filter(function (c) { return c.body.length > M.SPEC_BODY_MAX; });
    if (!broken.length && !long.length) return '';
    return '<div class="spec-warn">' + long.map(function (c) {
      return '<p><b>' + esc((c.heading && c.heading.title) || 'The text') + '</b> is ' + c.body.length.toLocaleString('en-US') + ' characters, and a section holds ' + M.SPEC_BODY_MAX.toLocaleString('en-US') + '. Split it with a heading to save.</p>';
    }).join('') + (broken.length ? '<p><b>' + (broken.length === 1 ? 'A mark doesn’t parse' : plural(broken.length, 'mark') + ' don’t parse') + '</b>, so ' + (broken.length === 1 ? 'its' : 'their') + ' words will show as typed. A mark is <code>[words]{…}</code> on one line; brackets inside the words go in pairs, or in <code>`code`</code>.</p><ul>' + broken.slice(0, 8).map(function (b) {
      return '<li><button type="button" class="btn btn-sm" data-act="spec-editor-line" data-line="' + b.line + '">Line ' + b.line + '</button>' + (b.heading ? ' <span class="muted">' + esc(b.heading) + '</span>' : '') + ' <code>' + esc(cutText(b.text, 90)) + '</code></li>';
    }).join('') + (broken.length > 8 ? '<li class="muted">and ' + (broken.length - 8) + ' more</li>' : '') + '</ul>' : '') + '</div>';
  }
  // Put the editor's cursor at the start of a line and bring it into view (the Edit all text grows
  // with its content, so the page scrolls, not the box).
  function specEditorLine(n) {
    var ta = $('#spec-editor'); if (!ta) return;
    var lines = ta.value.split('\n'), at = lines.slice(0, Math.max(0, n - 1)).join('\n').length + (n > 1 ? 1 : 0);
    ta.focus(); ta.setSelectionRange(at, at + (lines[n - 1] || '').length);
    var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20, y = (n - 1) * lh;
    if (ta.scrollHeight > ta.clientHeight + 4) ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    else {
      var dy = ta.getBoundingClientRect().top + y - window.innerHeight / 3, m = $('#main');
      if (m && m.scrollHeight > m.clientHeight + 4) m.scrollBy({ top: dy, behavior: 'smooth' }); else window.scrollBy({ top: dy, behavior: 'smooth' });
    }
  }
  function specEditorHtml(id, all) {
    var lines = specDraft.split('\n').length;
    return '<div class="spec-editor card' + (all ? ' spec-editor-all' : '') + '">' + specKindBarHtml() +
      '<textarea class="input" id="spec-editor" data-sec="' + esc(id || '') + '" rows="' + (all ? Math.max(20, lines + 3) : Math.max(6, Math.min(30, lines + 2))) + '" spellcheck="true">' + esc(specDraft) + '</textarea>' +
      '<div class="spec-help">Headings: <code># Title</code>, <code>## Title * task</code> (kinds: ' + M.specKinds().join(', ') + ') · link: <code>[text]{REQ-001}</code> · standard: <code>[text]{std}</code> · flag: <code>@req</code> · ' + M.specLinkWords().map(function (w) { return '<code>' + esc(w) + ': Title' + (M.specLinkWords().length > 1 ? ' (signal)' : ', Title') + '</code>'; }).join(' ') + (SPEC && SPEC.parts ? ' · <code>Parts: U1, C1–C3</code>' : '') + ' · gist: <code>&gt; one line</code> · <code>[text]{#Title}</code> points at a section · review note: <code>Check: …</code></div>' +
      '<div id="spec-editor-warn" aria-live="polite">' + specDraftWarnHtml() + '</div>' +
      '<div class="spec-editor-foot"><button class="btn" data-act="spec-guide" title="How to write headings, links, lists, and tables">Writing guide</button>' +
      (id ? '<button class="btn btn-danger" data-act="spec-delete" data-id="' + esc(id) + '">Delete section</button>' : '') +
      '<span class="spacer"></span><button class="btn" data-act="spec-cancel">Cancel</button><button class="btn btn-primary" data-act="spec-save">Save <span class="kbd">Ctrl+Enter</span></button></div></div>';
  }

  // The writing guide: everything the editor understands, as "type this / what it does", with
  // examples from the demo: FW's firmware (layers, kinds, Uses) or EE's board (blocks and sections,
  // Connects, Supplies, Parts). Opened from the editor's bottom row; the text being edited stays.
  function specGuideSheet() {
    function rows(list) {
      return '<table class="table spec-guide-table"><thead><tr><th>Type this</th><th>What it does</th></tr></thead><tbody>' + list.map(function (r) {
        return '<tr><td><code>' + esc(r[0]).replace(/\n/g, '<br>') + '</code></td><td>' + r[1] + '</td></tr>';
      }).join('') + '</tbody></table>';
    }
    var board = !M.specKinds().length && M.specLinkWords().length > 1;
    var kinds = M.specKinds().map(function (k) { return '<code>' + k + '</code>'; }).join(', ');
    var structure = board ?
      '<h3>Headings make blocks and sections</h3><p class="note">Every heading is a block in the diagram. A heading with headings under it is a section: a box around those blocks.</p>' + rows([
        ['# Main PCBA', 'The board itself. Its text is about the whole board, and it isn’t drawn as a box. Start the line with <b>#</b> and a space.'],
        ['## Power', 'With headings under it, a section. Text written right under it belongs to the whole section, like a power budget, and can be tied to its requirement.'],
        ['### 3V3 buck', 'A block: one subcircuit. Up to four levels: <b>#</b>, <b>##</b>, <b>###</b>, and <b>####</b>.'],
        ['> Steps 5 V down to the 3.3 V rail.', 'The block’s gist: one line shown at the Gists depth, on the block, and in Signoff PL. Without one, the first sentence is used.']
      ]) +
      '<p class="note">Moving a block into another section moves its heading in the text; the hierarchy under the diagram does that by dragging.</p>' +
      '<h3>How blocks connect</h3>' + rows([
        ['Connects: Wi-Fi module (UART), Display connector (I2C)', 'The blocks this one sends signals to, with the signal or bus in brackets. Write it in the direction signals go; it draws the diagram’s labeled arrows.'],
        ['Supplies: MCU (3V3), Wi-Fi module (3V3)', 'The blocks this one powers, with the rail in brackets. Each block fed shows a power flag with the rail’s name.'],
        ['Parts: U7, L1, C1–C3, C12', 'The reference designators the block covers, with ranges. Shown as chips on the block; not traced.']
      ]) +
      '<p class="note">Blocks are named by their heading, so <code>Connects: MCU</code> needs a heading called MCU. Rename a heading and every Connects and Supplies line follows.</p>'
      :
      '<h3>Headings make the outline</h3>' + rows([
        ['# Thermostat firmware', 'A top-level section. Start the line with <b>#</b> and a space.'],
        ['## Control loop', 'A section inside the one above. Up to four levels: <b>#</b>, <b>##</b>, <b>###</b>, and <b>####</b>.'],
        ['## Control loop * task', 'Adds a kind, which puts the section in the Diagram. Type a space, an asterisk (*), a space, and the kind: ' + kinds + '. Brackets work too: <code>## Control loop (task)</code>.'],
        ['> Reads the room once a second.', 'The section’s gist: one line shown at the Gists depth and in Signoff PL. Without one, the first sentence is used.'],
        ['Uses: Sensor driver, Relay driver', 'What the section uses, by heading title. Draws the Diagram’s lines.']
      ]);
    var tie = board ? [
      ['[The rail stays within ±3% at 1.5 A]{REQ-006}', 'Links the words in brackets to a requirement. The rest of the sentence counts as linked too.'],
      ['[off within 100 ms]{REQ-003, REQ-001}', 'Links to more than one requirement.'],
      ['[U7 is a 2 A synchronous buck.]{std}', 'Standard text: how the circuit works, which needs no requirement of its own.'],
      ['Keep the ripple under 30 mV at the Wi-Fi module @req', 'Flags the sentence to become a requirement. It shows under Write as requirements.'],
      ['the [display link]{#Display connector}', 'Points at another block by its heading; the sentence’s panel has a button to go there.']
    ] : [
      ['[the relays go off]{REQ-003}', 'Links the words in brackets to a requirement. The rest of the sentence counts as linked too.'],
      ['[off on reset]{REQ-003, REQ-001}', 'Links to more than one requirement.'],
      ['[It runs on FreeRTOS.]{std}', 'Standard text: background or explanation that needs no requirement.'],
      ['Make the LED pulse instead of blink @req', 'Flags the sentence to become a requirement. It shows under Write as requirements.'],
      ['the [status frame]{#Status frame}', 'Points at another section by its heading. Pointing at an interface section counts as linked.']
    ];
    var example = board ?
      '## Power\n> From mains to the 5 V and 3.3 V rails.\nThe whole board draws no more than 1.5 W @req\n\n### 3V3 buck\n> Steps 5 V down to the 3.3 V rail.\n[U7 is a 2 A synchronous buck.]{std} [The rail stays within ±3% at 1.5 A]{REQ-006}.\nParts: U7, L1, C1–C3\nSupplies: MCU (3V3), Wi-Fi module (3V3)'
      : '## Relay driver * driver\n> Switches the heat and cool relays.\n[Both outputs are held off through a reset]{REQ-003}. The driver turns one on only when the control loop asks.\nAdd a 2 s minimum off time @req\nUses: Relays';
    var w = sheet('<div class="sheet-head"><h2>Writing guide</h2><p>' + esc(SPEC_LABEL) + ' is plain text with a few marks. Anything else shows exactly as you type it.</p></div>' +
      '<div class="sheet-body spec-guide">' + structure +
      '<h3>Tie sentences to requirements</h3><p class="note">Every sentence is linked, standard, flagged, a review note, or unlinked. Unlinked sentences get a dotted underline until you do one of these.</p>' + rows(tie) +
      '<p class="note">You can also click a sentence when you’re not editing and use the buttons in its panel; they write these marks for you. Select a few words first to link just those.</p>' +
      '<h3>Marks and sentences</h3>' + rows([
        [board ? '[It reads ADC[0] first.]{std}' : '[It reads buf[0] first.]{std}', 'Brackets inside a mark’s words are fine in pairs. Anything else goes in backticks: <code>`buf[0`</code>. A mark stays on one line.'],
        ['[It reads x.]{std', 'A mark that doesn’t parse shows its words as typed, with <b>mark?</b> after the sentence; the editor lists it under the text while you write.'],
        [board ? 'Check: is the ripple measured at 1.5 A?' : 'Check: is the off time 100 ms or 200 ms?', 'A review note: a doubt or question for the review. It’s counted on its own, not as unlinked, and isn’t a gap in the diagram; <b>Notes</b> above the text shows only the sections with notes. <b>Resolve</b> in its panel takes it out once it’s answered. A line that starts <b>Check:</b> starts its own paragraph, and a list item works too.'],
        [board ? '[The rail stays within ±3%]{REQ-006}. Check: at 1.5 A?' : '[Relays go off on reset]{REQ-003}. Check: is it 100 ms?', 'A note is its own sentence. Words in the same sentence as a link count as linked, so end the sentence before the note with a full stop. A link inside a note doesn’t describe its requirement.']
      ]) +
      '<p class="note">A sentence ends at a full stop and a space, even when the next word starts in lowercase (<code>kff is added after.</code>), and at a question or exclamation mark before a capital. It doesn’t end after e.g., i.e., vs., or cf., inside a number (0.5), or after No., Fig., rev., or ref. before a number, letter, or ref (<code>rev. B</code>, <code>ref. REQ-004</code>). Units end it: <code>above 22 V. The pump stops.</code></p>' +
      '<h3>Paragraphs, lists, and tables</h3>' + rows([
        ['First paragraph.\n\nSecond paragraph.', 'A blank line starts a new paragraph. Lines without a blank between them run together.'],
        [board ? '- Line voltage\n- Neutral' : '- Heat call\n- Cool call', 'A list. Each item counts as one sentence for tracing.'],
        [board ? '| Rail | Max load |\n| --- | --- |\n| 3V3 | 1.5 A |' : '| Field | Units |\n| --- | --- |\n| temp | °C |', board ? 'A table: a header row, a row of dashes, then the rows. Good for a power budget or a pin list. Tables aren’t traced.' : 'A table: a header row, a row of dashes, then the rows. Good for interface fields. Tables aren’t traced.'],
        ['```\nstatus = 0x01\n```', 'Code, shown as typed. Put three backticks on their own line before and after.']
      ]) +
      '<h3>A short example</h3><pre class="spec-code">' + esc(example) + '</pre>' +
      '<p class="note">Not supported: bold, italics, and links to web pages show as typed.</p>' +
      (specGuideId() && window.SignoffSpecGuide ? '<p class="note">New to ' + esc(SPEC_LABEL) + '? <button class="btn btn-sm" data-act="spec-guide-start">Take the guide</button> walks through it on the demo.</p>' : '') +
      '</div><div class="sheet-foot"><span class="spacer"></span><button class="btn btn-primary" data-sheet="done">Back to writing</button></div>', { wide: true });
    w.querySelector('[data-sheet="done"]').addEventListener('click', function () { closeSheet(); var t = $('#spec-editor'); if (t) t.focus(); });
  }

  function specPage(p) {
    var a = M.specAnalysis(p), t = a.totals, depth = ui.specDepth || 3, view = ui.specView === 'map' ? 'map' : 'doc';
    specHistOf(p); specHistNote(p);
    // Gaps or Notes shows only the sections that have them, in full, with the other sentences dimmed.
    var show = ui.specShow === 'gaps' || ui.specShow === 'notes' ? ui.specShow : '';
    if (show) depth = 3;
    var shown = function (x) { return !show || (show === 'gaps' ? x.gaps : x.notes.length); };
    var html = '<div class="page spec-page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">' + esc(SPEC_LABEL) + '</h1>' +
      '<div class="page-sub"><span>' + plural(t.sections, 'section') + '</span>' +
      (t.units ? '<span class="sep">·</span><span>' + t.linked + ' linked</span><span class="sep">·</span><span>' + t.std + ' standard</span>' : '') +
      (t.untraced ? '<span class="sep">·</span><span>' + t.untraced + ' unlinked</span>' : '') +
      (t.note ? '<span class="sep">·</span><span>' + plural(t.note, 'review note') + '</span>' : '') +
      (a.undescribed.length ? '<span class="sep">·</span><span>' + plural(a.undescribed.length, 'requirement') + ' not described</span>' : '') +
      (a.tags.length ? '<span class="sep">·</span><span>' + a.tags.length + ' flagged</span>' : '') + '</div></div>' +
      // One row: back and forward, Edit all, Add section, and a menu for the rest (Chris, 2026-11-09).
      '<div class="spec-tools">' + (specEditing === 'all' ? '' : specHistHtml(p) +
      (t.sections ? '<button class="btn" data-act="spec-edit-all" title="Edit the whole description as one text">Edit all</button>' : '') +
      '<button class="btn btn-primary" data-act="spec-add">Add section</button>' +
      '<button class="icon-btn spec-more" data-act="spec-more" title="Guide, paste text, and export" aria-label="More" aria-haspopup="menu">' + ICON_MENU + '</button>') + '</div></div>';
    // Editing the whole description: the text, with its outline read live beside it.
    if (specEditing === 'all') {
      return html + '<div class="spec-wrap depth-3"><nav class="spec-outline" id="spec-live-outline" aria-label="Outline of the text">' + specLiveOutline() + '</nav>' +
        '<div class="spec-doc">' + specEditorHtml(null, true) + '</div></div></div>';
    }
    if (!t.sections && specEditing !== 'new' && ui.specView !== 'map') {
      return html + '<div class="card empty"><div class="empty-art">' + ICON.doc + '</div><h2>Describe what this ' + esc(W.thing) + ' does</h2>' +
        '<p>Write it the way you’d explain it: the product first, then its structure, down to the drivers. Headings make the outline. Link sentences to requirements, mark background as standard, and flag new behavior with @req to turn it into a requirement later.</p>' +
        (SPEC.template ? '<button class="btn btn-primary" data-act="spec-template">Start from template</button> <button class="btn" data-act="spec-add">Add section</button>' : '<button class="btn btn-primary" data-act="spec-add">Add section</button>') +
        ' <button class="btn" data-act="spec-paste">Paste text</button> <button class="btn" data-act="spec-view" data-view="map">Build it in the diagram</button></div></div>';
    }
    html += '<div class="filters"><div class="seg"><button class="' + (view === 'doc' ? 'on' : '') + '" data-act="spec-view" data-view="doc">Document</button><button class="' + (view === 'map' ? 'on' : '') + '" data-act="spec-view" data-view="map">Diagram</button></div>' +
      (view === 'doc' ? '<div class="seg" title="How much to show">' + [[1, 'Headings'], [2, 'Gists'], [3, 'Full text']].map(function (d) {
        return '<button class="' + (depth === d[0] && !show ? 'on' : '') + '" data-act="spec-depth" data-depth="' + d[0] + '">' + d[1] + '</button>';
      }).join('') + '</div>' : '') +
      (view === 'doc' && (t.untraced + t.tag || t.note || show) ? '<div class="seg" title="Show only the sections with gaps or with review notes">' + [['', 'Everything', 0], ['gaps', 'Gaps', t.untraced + t.tag], ['notes', 'Notes', t.note]].map(function (f) {
        return '<button class="' + (show === f[0] ? 'on' : '') + '" data-act="spec-show" data-show="' + f[0] + '">' + f[1] + (f[0] ? ' <span class="count">' + f[2] + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '') + '</div>';
    html += specNeedsHtml(p, a);
    if (view === 'map') return html + specMapHtml(p, a) + '</div>';
    var outline = '<nav class="spec-outline" aria-label="Outline">' + a.sections.filter(shown).map(function (x) {
      return '<button class="lv-' + x.sec.level + '" data-act="spec-goto" data-id="' + esc(x.sec.id) + '"><span>' + esc(x.sec.title || 'Untitled') + '</span>' + gapMark(x.gaps, specGapTitle(x)) + noteMark(x) + '</button>';
    }).join('') + '</nav>';
    var doc = a.sections.map(function (x, i) {
      if (!shown(x) && specEditing !== x.sec.id) return '';
      var s = x.sec, next = a.sections[i + 1], group = next && next.sec.level > s.level;
      if (specEditing === s.id) return '<section class="spec-sec lv-' + s.level + '" id="spec-' + esc(s.id) + '">' + specEditorHtml(s.id) + '</section>';
      var hn = 'h' + Math.min(5, s.level + 1);
      return '<section class="spec-sec lv-' + s.level + '" id="spec-' + esc(s.id) + '"><div class="spec-h"><' + hn + '>' + esc(s.title || 'Untitled') + '</' + hn + '>' +
        (s.kind ? '<span class="chip spec-kind">' + esc(s.kind) + '</span>' : '') + gapMark(x.gaps, specGapTitle(x)) + noteMark(x) +
        '<button class="icon-btn spec-edit spec-add-after" data-act="spec-add-after" data-id="' + esc(s.id) + '" title="Add a section below this one" aria-label="Add a section below ' + esc(s.title) + '">' + ICON_PLUS + '</button>' +
        '<button class="icon-btn spec-edit" data-act="spec-edit" data-id="' + esc(s.id) + '" title="Edit this section" aria-label="Edit ' + esc(s.title) + '">' + ICON.pencil + '</button></div>' +
        (depth === 2 && x.gist ? '<p class="spec-gist">' + esc(x.gist) + '</p>' : '') +
        (depth === 3 ? (x.blocks.length ? specBlocksHtml(p, a, x) : group ? '' : '<p class="note">Nothing written yet.</p>') : '') + '</section>' +
        (specEditing === 'new' && specNewAfter === s.id ? '<section class="spec-sec">' + specEditorHtml(null) + '</section>' : '');
    }).join('') + (specEditing === 'new' && !specNewAt(p) ? '<section class="spec-sec">' + specEditorHtml(null) + '</section>' : '');
    if (show && !a.sections.some(shown)) doc = '<p class="note">' + (show === 'gaps' ? 'No gaps: every sentence is linked, standard, or a review note.' : 'No review notes.') + '</p>';
    return html + '<div class="spec-wrap depth-' + depth + (show ? ' spec-show-' + show : '') + '">' + outline + '<div class="spec-doc">' + doc + '</div></div></div>';
  }

  // The two lists that need someone: flagged sentences and requirements nothing describes.
  function specNeedsHtml(p, a) {
    var copies = a.sections.filter(function (x) { return x.sec.conflictOf; }), ctags = M.specCommentTags(p);
    if (!a.tags.length && !a.undescribed.length && !copies.length && !ctags.length) return '';
    var secTitle = function (id) { var s = a.ctx.secs[id]; return s ? s.title || 'Untitled' : ''; };
    var tags = a.tags.map(function (t) {
      var d = ' data-sec="' + esc(t.sec) + '" data-u="' + t.start + '"';
      var changes = t.sectionReqs.filter(function (id) { return t.reqs.indexOf(id) < 0; }).slice(0, 3).map(function (id) {
        return '<button class="btn btn-sm" data-act="spec-change"' + d + ' data-id="' + esc(id) + '" title="' + esc(reqLabel(a.ctx.reqs[id])) + '">Change ' + esc(a.ctx.reqs[id].ref || 'requirement') + '</button>';
      }).join('');
      var tsec = a.ctx.secs[t.sec] || {};
      var from = 'Tagged @req in ' + SPEC_LABEL + ', in ' + secTitle(t.sec) + (tsec.updatedBy ? ', by ' + tsec.updatedBy : '') + (tsec.updatedAt ? ', ' + relTime(tsec.updatedAt) : '');
      return '<div class="spec-need"><button class="spec-need-text" data-act="spec-jump"' + d + ' title="Show it in the text"><span>' + esc(t.text) + '</span><span class="muted">' + esc(from) + '</span></button>' +
        '<div class="spec-need-acts"><button class="btn btn-sm btn-primary" data-act="spec-make"' + d + '>New requirement</button>' + changes +
        '<button class="btn btn-sm" data-act="spec-untag"' + d + ' title="Remove the @req flag">Remove flag</button></div></div>';
    }).join('');
    // @req in comments: on a check (New requirement traces to it), on a requirement (Change it), or general.
    tags += ctags.map(function (c) {
      var q = reqOf(p, c.item), d = itemDef(p, c.item), on = q ? q.ref + ' ' + (q.text || '') : c.item ? d.def.text : 'the whole ' + UNIT;
      return '<div class="spec-need"><button class="spec-need-text" data-act="spec-ctag-open" data-id="' + esc(c.id) + '"><span>' + esc(c.text) + '</span>' +
        '<span class="muted">' + esc('Tagged @req in a comment from ' + (c.author || 'someone') + ' on ' + cutText(on, 90) + ', ' + relTime(c.at)) + '</span></button>' +
        '<div class="spec-need-acts">' + (q ? '<button class="btn btn-sm btn-primary" data-act="spec-ctag-change" data-id="' + esc(c.id) + '">Change ' + esc(q.ref) + '</button>' : '') +
        '<button class="btn btn-sm' + (q ? '' : ' btn-primary') + '" data-act="spec-ctag-make" data-id="' + esc(c.id) + '">New requirement</button>' +
        '<button class="btn btn-sm" data-act="spec-ctag-untag" data-id="' + esc(c.id) + '" title="Remove the @req flag from the comment">Remove flag</button></div></div>';
    }).join('');
    var nTags = a.tags.length + ctags.length;
    var missing = a.undescribed.map(function (id) {
      var q = a.ctx.reqs[id];
      return '<div class="spec-need"><button class="spec-need-text" data-act="open-req" data-id="' + esc(id) + '"><span><b>' + esc(q.ref) + '</b> ' + esc(q.text || 'No text yet') + '</span></button>' +
        '<div class="spec-need-acts"><button class="btn btn-sm" data-act="spec-describe" data-id="' + esc(id) + '">Describe in…</button></div></div>';
    }).join('');
    var conflicts = copies.map(function (x) {
      var orig = a.ctx.secs[x.sec.conflictOf];
      return '<div class="spec-need"><button class="spec-need-text" data-act="spec-goto" data-id="' + esc(x.sec.id) + '"><span>' + esc(orig ? orig.title || 'Untitled' : x.sec.title) + '</span>' +
        '<span class="muted">' + esc((x.sec.updatedBy ? x.sec.updatedBy + '’s' : 'An') + ' edit from ' + relTime(x.sec.updatedAt) + ', kept beside the newer one') + '</span></button>' +
        '<div class="spec-need-acts">' + (orig ? '<button class="btn btn-sm" data-act="spec-goto" data-id="' + esc(orig.id) + '">Newer version</button>' : '') +
        '<button class="btn btn-sm" data-act="spec-edit" data-id="' + esc(x.sec.id) + '">Edit copy</button>' +
        '<button class="btn btn-sm" data-act="spec-copy-delete" data-id="' + esc(x.sec.id) + '" title="Delete the copy once its text is merged into the newer version">Delete copy</button></div></div>';
    }).join('');
    return '<div class="spec-needs">' +
      (copies.length ? '<div class="card spec-needs-card"><div class="spec-needs-title">Edited in two places <span class="count">' + copies.length + '</span></div>' +
        '<p class="note" style="margin:0 0 6px">Two people changed the same section at once. The newer edit won; the other is kept as a copy. Move what you need from the copy into the section, then delete the copy.</p>' + conflicts + '</div>' : '') +
      (nTags ? '<div class="card spec-needs-card"><div class="spec-needs-title">Write as requirements <span class="count">' + nTags + '</span></div>' + tags + '</div>' : '') +
      (a.undescribed.length ? '<div class="card spec-needs-card"><div class="spec-needs-title">Not described <span class="count">' + a.undescribed.length + '</span></div>' + missing + '</div>' : '') + '</div>';
  }

  // The layered diagram, drawn from the outline: one block per section with a kind, lines from
  // Uses (or to the nearest section above it in the outline), interfaces as labeled dashed lines.
  function specMapHtml(p, a) {
    if (SPEC_FLOW) return specFlowHtml(p, a);
    // A crowded layer wraps onto more lines rather than shrink its blocks below MINW (names were cut to a
    // few letters at 9–12 blocks in a row); LINE is the pitch of a layer's lines.
    var byId = {}, rows = [], MW = 1000, LBL = 124, GAP = 16, BH = 54, RH = 112, TOP = 24, MINW = 150, LINE = BH + 22;
    a.sections.forEach(function (x) { byId[x.sec.id] = x; });
    var ifaces = a.sections.filter(function (x) { return x.sec.kind === 'interface'; });
    // Every interface is a block in the Interfaces layer (Chris, 2026-11-09): one used by two blocks was
    // a pill on the line between them, with its name cut short.
    var looseIf = ifaces;
    // Every layer is drawn, empty ones too, so a design can be built here from nothing.
    specRows().concat(M.specKinds().indexOf('interface') >= 0 ? [['interface', 'Interfaces']] : []).forEach(function (r) {
      var xs = r[0] === 'interface' ? looseIf : a.sections.filter(function (x) { return x.sec.kind === r[0]; });
      rows.push({ kind: r[0], label: r[1], xs: xs });
    });
    var pos = {}, selBlock = specBlockSel(), per = Math.max(1, Math.floor((MW - LBL - GAP) / (MINW + GAP))), y0 = TOP, gl = 0;
    rows.forEach(function (r, ri) {
      var n = r.xs.length, lines = Math.max(1, Math.ceil(n / per)), cols = Math.ceil(n / lines) || 1;
      var bw = Math.min(210, (MW - LBL - GAP * (cols + 1)) / cols);
      r.y = y0; r.lines = lines; r.h = RH + (lines - 1) * LINE;
      r.xs.forEach(function (x, i) {
        var li = Math.floor(i / cols), ci = i % cols, inLine = Math.min(cols, n - li * cols), span = inLine * bw + (inLine - 1) * GAP, x0 = LBL + (MW - LBL - span) / 2;
        pos[x.sec.id] = { x: x0 + ci * (bw + GAP), y: y0 + li * LINE, w: bw, h: BH, row: ri, gl: gl + li };
      });
      gl += lines; y0 += r.h;
    });
    var H = y0 - (RH - BH) + 24;
    function inMap(id) { return !!pos[id]; }
    // An ancestor in the outline that's on the map, for sections without Uses.
    function mapParent(x) { for (var id = x.parent; id; id = byId[id] && byId[id].parent) if (inMap(id)) return id; return ''; }
    var edges = [], incoming = {};
    a.sections.forEach(function (x) {
      if (!inMap(x.sec.id) || x.sec.kind === 'interface') return;
      x.uses.filter(inMap).forEach(function (id) { edges.push({ a: x.sec.id, b: id, cls: 'uses' }); incoming[id] = 1; });
    });
    // A block nothing uses hangs from the nearest section above it in the outline.
    a.sections.forEach(function (x) {
      if (!inMap(x.sec.id) || x.sec.kind === 'interface' || incoming[x.sec.id]) return;
      var par = mapParent(x);
      if (par) edges.push({ a: par, b: x.sec.id, cls: 'tree' });
    });
    ifaces.forEach(function (x) {
      x.uses.filter(inMap).forEach(function (id) { edges.push({ a: id, b: x.sec.id, cls: 'iface', link: x.sec.id }); });
    });
    // E: lines from one block to three or more on one line below share a trunk down to a split point
    // just above that line, then fan out to each (the fan-out is what a click removes); hovering or
    // selecting a block brings its own lines forward and fades the rest (CSS, specHoverMap).
    var fan = {};
    edges.forEach(function (e) {
      if (!e.a || !e.b || !pos[e.a] || !pos[e.b] || pos[e.a].gl === pos[e.b].gl) return;
      e.up = pos[e.a].gl < pos[e.b].gl ? e.a : e.b; e.lo = e.up === e.a ? e.b : e.a;
      e.fan = e.up + '|' + pos[e.lo].gl + '|' + e.cls;
      (fan[e.fan] = fan[e.fan] || []).push(e.lo);
    });
    function path(e) {
      var A = pos[e.a], B = pos[e.b];
      if (e.fan && fan[e.fan].length >= 3) {
        var U = pos[e.up], L = pos[e.lo], xs = fan[e.fan].map(function (id) { return pos[id].x + pos[id].w / 2; });
        var sx = xs.reduce(function (t, v) { return t + v; }, 0) / xs.length, x1 = U.x + U.w / 2, y1 = U.y + U.h, x2 = L.x + L.w / 2, y2 = L.y;
        var sy = y2 - Math.min(26, (y2 - y1) * 0.45), my1 = (y1 + sy) / 2;
        var out = 'M' + sx + ' ' + sy + ' C' + (sx + (x2 - sx) / 2) + ' ' + sy + ' ' + x2 + ' ' + (sy + (y2 - sy) * 0.3) + ' ' + x2 + ' ' + y2;
        return { d: 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + my1 + ' ' + sx + ' ' + my1 + ' ' + sx + ' ' + sy + ' ' + out.slice(out.indexOf('C')), hit: out, mx: (sx + x2) / 2, my: sy };
      }
      if (A.gl > B.gl) { var t = A; A = B; B = t; }
      if (A.gl === B.gl) {
        var l = A.x < B.x ? A : B, r2 = A.x < B.x ? B : A, y = A.y + A.h, dy = 34;
        return { d: 'M' + (l.x + l.w / 2) + ' ' + y + ' C' + (l.x + l.w / 2) + ' ' + (y + dy) + ' ' + (r2.x + r2.w / 2) + ' ' + (y + dy) + ' ' + (r2.x + r2.w / 2) + ' ' + y, mx: (l.x + l.w / 2 + r2.x + r2.w / 2) / 2, my: y + dy * 0.75 };
      }
      var x1 = A.x + A.w / 2, y1 = A.y + A.h, x2 = B.x + B.w / 2, y2 = B.y, my = (y1 + y2) / 2;
      return { d: 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + my + ' ' + x2 + ' ' + my + ' ' + x2 + ' ' + y2, mx: (x1 + x2) / 2, my: my };
    }
    // data-bands: each layer's top and bottom, for dragging a block into it (specMoveMove).
    var svg = '<svg class="spec-map' + ((selBlock && pos[selBlock]) || specEdgeSel() ? ' focus' : '') + '" viewBox="0 0 ' + MW + ' ' + H + '" role="img" aria-label="Diagram of the ' + esc(W.thing) + ' from the outline" data-rows="' + rows.map(function (r) { return r.kind; }).join(',') + '" data-bands="' + rows.map(function (r) { return Math.round(r.y - (RH - BH) / 2) + ':' + Math.round(r.y + r.h - (RH - BH) / 2); }).join(',') + '" data-bh="' + BH + '">' +
      '<defs><pattern id="spec-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.1" class="spec-dot"/></pattern></defs>';
    rows.forEach(function (r, ri) {
      var y = r.y + (r.lines - 1) * LINE / 2;
      svg += '<text class="spec-row-label" x="8" y="' + (y + BH / 2 + 4) + '">' + esc(r.label) + '</text>' +
        '<g class="spec-row-add" data-act="spec-add-block" data-kind="' + r.kind + '"><title>Add a ' + esc(kindLabel(r.kind).toLowerCase()) + '</title>' +
        '<circle cx="' + (LBL - 10) + '" cy="' + (y + BH / 2) + '" r="10"/><path d="M' + (LBL - 14) + ' ' + (y + BH / 2) + 'h8M' + (LBL - 10) + ' ' + (y + BH / 2 - 4) + 'v8"/></g>' +
        (r.xs.length ? '' : '<text class="spec-row-empty" x="' + (LBL + 14) + '" y="' + (y + BH / 2 + 4) + '">No ' + esc(r.label.toLowerCase()) + ' yet</text>');
      if (ri) svg += '<line class="spec-row-line" x1="8" x2="' + MW + '" y1="' + (r.y - (RH - BH) / 2) + '" y2="' + (r.y - (RH - BH) / 2) + '"/>';
    });
    edges.forEach(function (e) {
      if (!e.a || !e.b || !pos[e.a] || !pos[e.b]) return;
      var pth = path(e), edgeOn = e.cls === 'uses' && specEdgeIs(e.a, e.b), on = (selBlock && (e.a === selBlock || e.b === selBlock)) || edgeOn;
      svg += '<path class="spec-edge ' + e.cls + (on ? ' on' : '') + (edgeOn ? ' sel' : '') + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + pth.d + '"/>' + (e.cls === 'tree' ? '' : specPulse(pth.d));
      if (e.cls === 'uses') svg += '<path class="spec-edge-hit" data-act="spec-edge" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" data-word="' + esc(M.specLinkWords()[0]) + '" d="' + (pth.hit || pth.d) + '"><title>' + esc(byId[e.a].sec.title + ' ' + linkVerb(M.specLinkWords()[0]) + ' ' + byId[e.b].sec.title + ' (click for its panel)') + '</title></path>';
      if (e.label) {
        var lw = Math.min(180, 12 + e.label.length * 6.4);
        svg += '<g class="spec-edge-label" data-act="spec-block" data-id="' + esc(e.link) + '"><title>' + esc(e.label) + '</title><rect x="' + (pth.mx - lw / 2) + '" y="' + (pth.my - 10) + '" width="' + lw + '" height="20" rx="10"/>' +
          '<text x="' + pth.mx + '" y="' + (pth.my + 4) + '" text-anchor="middle">' + esc(cutText(e.label, Math.floor((lw - 12) / 6.4))) + '</text></g>';
      }
    });
    rows.forEach(function (r) {
      r.xs.forEach(function (x) {
        var b = pos[x.sec.id], chars = Math.floor((b.w - 16) / 7.2), tl = specTitleLines(x.sec.title || 'Untitled', chars), two = tl.length > 1;
        svg += '<g class="spec-node' + (x.gaps ? ' gap' : '') + (x.sec.kind === 'interface' ? ' iface' : '') + (selBlock === x.sec.id ? ' sel' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" data-row="' + esc(r.kind) + '" data-cx="' + (b.x + b.w / 2) + '" data-y="' + b.y + '"><title>' + esc(x.sec.title + (x.gist ? '\n' + x.gist : '') + (x.gaps ? '\n' + specGapTitle(x) : '')) + '</title>' +
          '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="' + (x.sec.kind === 'interface' ? b.h / 2 : 10) + '"/>' +
          (x.gaps ? '<rect class="spec-node-dots" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="' + (x.sec.kind === 'interface' ? b.h / 2 : 10) + '"/>' : '') +
          tl.map(function (t, i) { return '<text class="spec-node-title" x="' + (b.x + b.w / 2) + '" y="' + (b.y + (two ? 17 + i * 14 : 23)) + '" text-anchor="middle">' + esc(t) + '</text>'; }).join('') +
          '<text class="spec-node-sub" x="' + (b.x + b.w / 2) + '" y="' + (b.y + (two ? 46 : 40)) + '" text-anchor="middle">' + esc(x.gaps ? '△ ' + plural(x.gaps, 'gap') : x.notes.length ? plural(x.notes.length, 'note') : x.links.length ? plural(x.links.length, 'requirement') : x.sec.kind) + '</text>' +
          '<circle class="spec-handle" data-src="' + esc(x.sec.id) + '" cx="' + (b.x + b.w / 2) + '" cy="' + (b.y + b.h) + '" r="7"><title>Drag to a block this one uses</title></circle></g>';
      });
    });
    svg += '</svg>';
    return '<div class="card spec-map-card">' + svg + '</div><p class="note">Drawn from the outline, and written back to it. + adds a block to a layer (a new section in the text). Drag from the dot under a block to another block to say it uses that one; click a line for its panel, where Delete removes it (Undo in the message brings it back). Drag a block itself to another layer to change its kind, or beside other blocks to move it there in the outline. Click a block to rename it, change its kind or gist, or choose what it uses. Lines come from each section’s <code>Uses:</code> line, or join it to the section above it; dashed lines join each interface to the blocks that use it. Lines from one block to several share a trunk, and pointing at a block brings its own lines forward. Dotted blocks have unlinked or flagged sentences.</p>';
  }
  // A block's name on one line, or two (broken at a space) when it's too long for one; the second is
  // cut if it still doesn't fit.
  function specTitleLines(t, chars) {
    t = String(t || '');
    if (t.length <= chars) return [t];
    var cut = t.lastIndexOf(' ', chars);
    if (cut < Math.floor(chars / 3)) cut = chars;
    return [t.slice(0, cut).trim(), cutText(t.slice(cut).trim(), chars)];
  }
  // The flow diagram (config.spec.layout 'flow', EE): a block diagram of the board. The outline is the
  // hierarchy (model.specNest): a heading with headings under it is a section, drawn as a box around
  // its blocks, and sections nest; the board's own level-1 heading isn't drawn. Laid out
  // automatically (sections as rows of their blocks, left to right in signal order) until someone
  // drags something; then every block's position is kept (pos) and boxes fit their blocks. Connects
  // lines carry their signals; Supplies show as a power flag on each block fed, or an arrow between
  // neighbors in one section.
  var SPEC_BW = 156, SPEC_BH = 54, SPEC_PAD = 14, SPEC_HEAD = 24, SPEC_GAP = 44, SPEC_ROWGAP = 60;
  function specFlowTree(a) {
    var kids = {}, hidden = {}, byId = {};
    a.sections.forEach(function (x) { byId[x.sec.id] = x; var pid = x.parent || ''; (kids[pid] = kids[pid] || []).push(x); });
    a.sections.forEach(function (x) { if (x.sec.level === 1 && (kids[x.sec.id] || []).length) hidden[x.sec.id] = 1; });
    function dparent(x) { var pid = x.parent || ''; return pid && !hidden[pid] ? pid : ''; }
    var items = a.sections.filter(function (x) { return !hidden[x.sec.id]; }), ch = {};
    items.forEach(function (x) { var d = dparent(x); (ch[d] = ch[d] || []).push(x); });
    function isSec(x) { return (ch[x.sec.id] || []).length > 0; }
    function anc(x) { var out = []; for (var d = dparent(x); d; d = dparent(byId[d])) out.push(d); return out; }
    return { byId: byId, items: items, ch: ch, dparent: dparent, isSec: isSec, anc: anc };
  }
  function bez(p0, p1, p2, p3, t) { var u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; }
  // A line from one block to another, out of the side facing it, with a point for its label.
  function specRoute(A, B) {
    var x1, y1, x2, y2, c1x, c1y, c2x, c2y;
    if (B.x >= A.x + A.w + 12) { x1 = A.x + A.w; y1 = A.y + A.h / 2; x2 = B.x - 4; y2 = B.y + B.h / 2; c1x = c2x = (x1 + x2) / 2; c1y = y1; c2y = y2; }
    else if (A.x >= B.x + B.w + 12) { x1 = A.x; y1 = A.y + A.h / 2; x2 = B.x + B.w + 4; y2 = B.y + B.h / 2; c1x = c2x = (x1 + x2) / 2; c1y = y1; c2y = y2; }
    else if (B.y > A.y + A.h) { x1 = A.x + A.w / 2; y1 = A.y + A.h; x2 = B.x + B.w / 2; y2 = B.y - 4; c1y = c2y = (y1 + y2) / 2; c1x = x1; c2x = x2; }
    else if (B.y + B.h < A.y) { x1 = A.x + A.w / 2; y1 = A.y; x2 = B.x + B.w / 2; y2 = B.y + B.h + 4; c1y = c2y = (y1 + y2) / 2; c1x = x1; c2x = x2; }
    else { x1 = A.x + A.w / 2; y1 = A.y + A.h; x2 = B.x + B.w / 2; y2 = B.y + B.h + 4; c1y = c2y = Math.max(y1, y2) + 28; c1x = x1; c2x = x2; }
    return { d: 'M' + x1 + ' ' + y1 + ' C' + c1x + ' ' + c1y + ' ' + c2x + ' ' + c2y + ' ' + x2 + ' ' + y2,
      mx: bez(x1, c1x, c2x, x2, 0.7), my: bez(y1, c1y, c2y, y2, 0.7) };
  }
  // Current along a line: beads that run its length while its block is selected or pointed at, after
  // Loom's pulse on a selected wire. Drawn right after its .spec-edge, which CSS keys on.
  function specPulse(d) { return '<path class="spec-pulse" d="' + d + '" pathLength="1"/>'; }
  function specFlowHtml(p, a) {
    var T = specFlowTree(a), sel = specBlockSel(), show = ui.specBoxes !== false, head = show ? SPEC_HEAD : 0, pad = show ? SPEC_PAD : 0;
    var supWord = (M.specLinkWord('supplies') || '').toLowerCase();
    var blocks = T.items.filter(function (x) { return !T.isSec(x); }), isBlock = {};
    blocks.forEach(function (x) { isBlock[x.sec.id] = 1; });
    var frozen = blocks.some(function (x) { return x.sec.pos; });
    var bar = '<div class="spec-flow-add"><button class="chip" data-act="spec-add-block" data-kind="">+ Add block</button>' +
      (frozen ? '<button class="chip" data-act="spec-auto-layout" title="Forget the arrangement and lay the diagram out again">Auto layout</button>' : '') +
      '<span class="spec-flow-hint">Drag on empty space to draw a section around blocks</span>' +
      '<label class="spec-boxes" title="Show section boxes"><input type="checkbox" data-act="spec-boxes"' + (show ? ' checked' : '') + '> Sections</label></div>';
    if (!blocks.length) {
      return bar + '<div class="card empty"><h2>Nothing to draw yet</h2><p>Every heading is a block, and a heading with headings under it is a section around them. Add a block above, or write headings in the Document view.</p></div>';
    }
    var conn = [], sup = [];
    blocks.forEach(function (x) {
      x.edges.forEach(function (e) { if (!isBlock[e.id]) return; (supWord && e.word.toLowerCase() === supWord ? sup : conn).push({ a: x.sec.id, b: e.id, label: e.label, word: e.word }); });
    });
    function under(x) { return T.isSec(x) ? T.ch[x.sec.id].reduce(function (acc, c) { return acc.concat(under(c)); }, []) : [x.sec.id]; }
    // Siblings in signal order: one goes right of another when a link runs from it into it.
    function orderRow(list) {
      var u = list.map(under), rank = list.map(function () { return 0; }), edges = conn.concat(sup);
      function link(i, j) { return edges.some(function (e) { return u[i].indexOf(e.a) >= 0 && u[j].indexOf(e.b) >= 0; }); }
      for (var it = 0; it < list.length; it++) {
        var mv = false;
        for (var i = 0; i < list.length; i++) for (var j = 0; j < list.length; j++) if (i !== j && link(i, j) && rank[j] < rank[i] + 1 && rank[i] + 1 < list.length) { rank[j] = rank[i] + 1; mv = true; }
        if (!mv) break;
      }
      return list.map(function (x, i) { return { x: x, r: rank[i], i: i }; }).sort(function (A, B) { return A.r - B.r || A.i - B.i; }).map(function (o) { return o.x; });
    }
    var size = {}, ord = {}, auto = {};
    function measure(x) {
      if (!T.isSec(x)) return (size[x.sec.id] = { w: SPEC_BW, h: SPEC_BH });
      var c = ord[x.sec.id] = orderRow(T.ch[x.sec.id]), w = 0, h = 0;
      c.forEach(function (k, i) { var sz = measure(k); w += sz.w + (i ? SPEC_GAP : 0); h = Math.max(h, sz.h); });
      return (size[x.sec.id] = { w: w + 2 * pad, h: h + 2 * pad + head });
    }
    function place(x, X, Y) {
      if (!T.isSec(x)) { auto[x.sec.id] = { x: X, y: Y }; return; }
      var cx = X + pad;
      ord[x.sec.id].forEach(function (k) { place(k, cx, Y + pad + head); cx += size[k.sec.id].w + SPEC_GAP; });
    }
    // The top level: each section is a row; blocks outside sections share rows between them.
    var rows = [], cur = null, Y = 40;
    (T.ch[''] || []).forEach(function (x) { if (T.isSec(x)) { rows.push([x]); cur = null; } else { if (!cur) { cur = []; rows.push(cur); } cur.push(x); } });
    rows.forEach(function (r) {
      var X = 20, h = 0;
      orderRow(r).forEach(function (x) { var sz = measure(x); place(x, X, Y); X += sz.w + SPEC_GAP; h = Math.max(h, sz.h); });
      Y += h + SPEC_ROWGAP;
    });
    var R = {};
    blocks.forEach(function (x) { var q = x.sec.pos || auto[x.sec.id] || { x: 20, y: Y }; R[x.sec.id] = { x: q.x, y: q.y, w: SPEC_BW, h: SPEC_BH }; });
    function boxOf(x) {
      if (!T.isSec(x)) return R[x.sec.id];
      var bs = T.ch[x.sec.id].map(boxOf).filter(Boolean);
      if (!bs.length) return null;
      var x0 = Math.min.apply(null, bs.map(function (b) { return b.x; })), y0 = Math.min.apply(null, bs.map(function (b) { return b.y; }));
      var x1 = Math.max.apply(null, bs.map(function (b) { return b.x + b.w; })), y1 = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
      var bp = Math.max(pad, 12), bh = Math.max(head, 20);
      return (R[x.sec.id] = { x: x0 - bp, y: y0 - bp - bh, w: x1 - x0 + 2 * bp, h: y1 - y0 + 2 * bp + bh });
    }
    (T.ch[''] || []).forEach(boxOf);
    var rects = Object.keys(R).map(function (k) { return R[k]; });
    var minX = Math.min.apply(null, rects.map(function (r) { return r.x; })) - 24, minY = Math.min.apply(null, rects.map(function (r) { return r.y; })) - 30;
    var maxX = Math.max.apply(null, rects.map(function (r) { return r.x + r.w; })) + 24, maxY = Math.max.apply(null, rects.map(function (r) { return r.y + r.h; })) + 40;
    var VW = Math.max(980, maxX - minX), VH = maxY - minY;
    if (maxX - minX < VW) minX -= (VW - (maxX - minX)) / 2;
    // A selected block brings its own lines forward, as in the layered map (CSS .focus, .on).
    // So does a selected line.
    function on(e) { return specEdgeIs(e.a, e.b, e.word) ? ' on sel' : isBlock[sel] && (e.a === sel || e.b === sel) ? ' on' : ''; }
    var svg = '<svg class="spec-map spec-flow' + (isBlock[sel] || specEdgeSel() ? ' focus' : '') + '" viewBox="' + minX + ' ' + minY + ' ' + VW + ' ' + VH + '" role="img" aria-label="Block diagram of the ' + esc(W.thing) + ' from the outline">' +
      '<defs><pattern id="spec-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.1" class="spec-dot"/></pattern>' +
      '<marker id="spec-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="spec-arrow"/></marker></defs>' +
      '<rect class="spec-flow-bg" x="' + minX + '" y="' + minY + '" width="' + VW + '" height="' + VH + '"/>';
    // Section boxes, outer ones first.
    if (show) {
      T.items.filter(function (x) { return T.isSec(x) && R[x.sec.id]; }).sort(function (x, y) { return T.anc(x).length - T.anc(y).length; }).forEach(function (x) {
        var b = R[x.sec.id];
        svg += '<g class="spec-group-g' + (sel === x.sec.id ? ' sel' : '') + (x.gaps ? ' gap' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" data-box="' + [b.x, b.y, b.w, b.h].join(' ') + '" data-anc="' + esc(T.anc(x).join(' ')) + '" data-parent="' + esc(T.dparent(x)) + '">' +
          '<title>' + esc(x.sec.title + (x.gist ? '\n' + x.gist : '') + (x.links.length ? '\n' + plural(x.links.length, 'requirement') + ' tied to the section itself' : '') + '\nDrag to move it with its blocks; click for its panel') + '</title>' +
          '<rect class="spec-group" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="12"/>' +
          '<text class="spec-group-label" x="' + (b.x + 12) + '" y="' + (b.y + 16) + '">' + esc(cutText(x.sec.title || 'Untitled', Math.floor((b.w - 24) / 7) - (x.links.length || x.gaps ? 8 : 0))) + '</text>' +
          (x.links.length || x.gaps ? '<text class="spec-group-meta" x="' + (b.x + b.w - 12) + '" y="' + (b.y + 16) + '" text-anchor="end">' + esc([x.links.length ? plural(x.links.length, 'req') : '', x.gaps ? '△ ' + x.gaps : ''].filter(Boolean).join(' · ')) + '</text>' : '') + '</g>';
      });
    }
    function pill(x, y, text) {
      var w = Math.min(150, 14 + text.length * 6.6);
      return '<g class="spec-edge-label"><rect x="' + (x - w / 2) + '" y="' + (y - 10) + '" width="' + w + '" height="20" rx="10"/><text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle">' + esc(cutText(text, Math.floor((w - 12) / 6.6))) + '</text></g>';
    }
    function hit(e, d) {
      return '<path class="spec-edge-hit" data-act="spec-edge" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" data-word="' + esc(e.word) + '" d="' + d + '"><title>' + esc(T.byId[e.a].sec.title + ' ' + linkVerb(e.word) + ' ' + T.byId[e.b].sec.title + (e.label ? ' (' + e.label + ')' : '') + ', click for its panel') + '</title></path>';
    }
    // Supplies between neighbors in one section draw as arrows; every other supply is a power flag.
    var flagged = [];
    sup.forEach(function (e) {
      var A = R[e.a], B = R[e.b];
      if (T.dparent(T.byId[e.a]) === T.dparent(T.byId[e.b]) && (B.x >= A.x + A.w + 12 || A.x >= B.x + B.w + 12) && Math.abs(A.y - B.y) < SPEC_BH) {
        var rt = specRoute(A, B);
        svg += '<path class="spec-edge supply' + on(e) + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + rt.d + '" marker-end="url(#spec-arrow)"/>' + specPulse(rt.d) + hit(e, rt.d);
        if (e.label) svg += pill((A.x + A.w + B.x) / 2, Math.min(A.y, B.y) + SPEC_BH / 2 - 14, e.label);
      } else flagged.push(e);
    });
    conn.forEach(function (e) {
      var rt = specRoute(R[e.a], R[e.b]);
      svg += '<path class="spec-edge uses' + on(e) + '" data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + rt.d + '" marker-end="url(#spec-arrow)"/>' + specPulse(rt.d) + hit(e, rt.d);
      if (e.label) svg += pill(rt.mx, rt.my, e.label);
    });
    blocks.forEach(function (x) {
      var b = R[x.sec.id], chars = Math.floor((b.w - 16) / 7.2);
      var sub = x.gaps ? '△ ' + plural(x.gaps, 'gap') : x.parts.length ? x.parts.slice(0, 4).join(' · ') + (x.parts.length > 4 ? ' …' : '') : '';
      svg += '<g class="spec-node' + (x.gaps ? ' gap' : '') + (sel === x.sec.id ? ' sel' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" data-x="' + b.x + '" data-y="' + b.y + '" data-anc="' + esc(T.anc(x).join(' ')) + '" data-parent="' + esc(T.dparent(x)) + '">' +
        '<title>' + esc(x.sec.title + (x.gist ? '\n' + x.gist : '') + (x.gaps ? '\n' + specGapTitle(x) : '') + '\nDrag to move it; drop it in a section to put it there') + '</title>' +
        '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="8"/>' +
        (x.gaps ? '<rect class="spec-node-dots" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="8"/>' : '') +
        '<text class="spec-node-title" x="' + (b.x + b.w / 2) + '" y="' + (b.y + (sub ? 23 : 31)) + '" text-anchor="middle">' + esc(cutText(x.sec.title || 'Untitled', chars)) + '</text>' +
        (sub ? '<text class="spec-node-sub" x="' + (b.x + b.w / 2) + '" y="' + (b.y + 40) + '" text-anchor="middle">' + esc(cutText(sub, chars + 4)) + '</text>' : '') +
        '<circle class="spec-handle" data-src="' + esc(x.sec.id) + '" cx="' + (b.x + b.w) + '" cy="' + (b.y + b.h / 2) + '" r="7"><title>Drag to a block this one connects to</title></circle></g>';
      var right = b.x + b.w - 6;
      flagged.filter(function (e) { return e.b === x.sec.id; }).forEach(function (e) {
        var name = e.label || T.byId[e.a].sec.title, fw = Math.min(110, 22 + name.length * 6.2), fx = right - fw, fy = b.y - 15;
        right = fx - 6;
        svg += '<g class="spec-flag" data-act="spec-block" data-id="' + esc(e.a) + '" data-for="' + esc(x.sec.id) + '"><title>' + esc('Supplied by ' + T.byId[e.a].sec.title + (e.label ? ' (' + e.label + ')' : '')) + '</title>' +
          '<path d="M' + (fx + 8) + ' ' + (fy + 15) + ' L' + (fx + 8) + ' ' + (fy + 7) + '"/><path class="spec-flag-head" d="M' + (fx + 3) + ' ' + (fy + 7) + ' L' + (fx + 13) + ' ' + (fy + 7) + ' L' + (fx + 8) + ' ' + (fy + 1) + 'z"/>' +
          '<text x="' + (fx + 17) + '" y="' + (fy + 9) + '">' + esc(cutText(name, Math.floor((fw - 20) / 6.2))) + '</text></g>';
      });
    });
    svg += '</svg>';
    return bar + '<div class="card spec-map-card">' + svg + '</div><p class="note">Drag blocks and sections to arrange the diagram; drag on empty space to draw a new section around blocks. Which section a block is in is set in the hierarchy below. Signals flow from each block’s <code>Connects:</code> line, and a <code>Supplies:</code> line puts a power flag with the rail’s name on each block it feeds. Drag from the dot on a block’s right edge to connect it; click a line for its panel, where Delete removes it (Undo in the message brings it back).</p>' +
      specTreeHtml(p, a, T);
  }

  // ── The hierarchy under the block diagram, after Signoff PL's Map ──
  // The board is the trunk, sections branch off it (nested sections branch again), and each
  // section's blocks are tiles on its branch. Drag a tile or a section onto a branch to move it into
  // that section, or onto a tile to put it just before; + on a branch adds a block inside. It is the
  // outline: every move is a heading moved in the text (model.specNest).
  var ICON_SECTION = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="2.5"/><path d="M2.5 7.5h15"/></svg>';
  function specTreeHtml(p, a, T) {
    var root = a.sections.filter(function (x) { return x.sec.level === 1 && (a.sections.some(function (y) { return y.parent === x.sec.id; })); })[0];
    var sel = specBlockSel();
    function counts(x) {
      return [x.links.length ? plural(x.links.length, 'requirement') : '', x.gaps ? '△ ' + plural(x.gaps, 'gap') : ''].filter(Boolean).join(' · ');
    }
    function tile(x) {
      return '<button class="st-tile' + (sel === x.sec.id ? ' sel' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" draggable="true" data-sdrag="' + esc(x.sec.id) + '" data-sbefore="' + esc(x.sec.id) + '">' +
        '<span class="st-name">' + esc(x.sec.title || 'Untitled') + '</span><span class="st-sub">' + esc(counts(x) || (x.parts.length ? x.parts.slice(0, 3).join(' · ') : 'Block')) + '</span></button>';
    }
    function kids(list) {
      var items = [], run = [];
      function flush() { if (run.length) items.push('<div class="st-item st-leaves">' + run.map(tile).join('') + '</div>'); run = []; }
      list.forEach(function (x) { if (!T.isSec(x)) { run.push(x); return; } flush(); items.push('<div class="st-item">' + branch(x) + '</div>'); });
      flush();
      return '<div class="st-kids">' + items.join('') + '</div>';
    }
    function branch(x) {
      var list = T.ch[x.sec.id] || [], closed = (ui.specClosed || {})[x.sec.id], n = list.filter(function (y) { return !T.isSec(y); }).length;
      return '<div class="st-sec" data-sdrop="' + esc(x.sec.id) + '"><div class="st-head">' +
        '<button class="st-node' + (sel === x.sec.id ? ' sel' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" draggable="true" data-sdrag="' + esc(x.sec.id) + '">' +
        '<span class="st-glyph">' + ICON_SECTION + '</span><span class="st-name">' + esc(x.sec.title || 'Untitled') + '</span>' +
        '<span class="st-sub">' + esc([plural(n, 'block'), counts(x)].filter(Boolean).join(' · ')) + '</span></button>' +
        '<button class="icon-btn st-fold' + (closed ? ' closed' : '') + '" data-act="spec-tree-fold" data-id="' + esc(x.sec.id) + '" title="' + (closed ? 'Expand' : 'Collapse') + '" aria-expanded="' + !closed + '">' + ICON.chev + '</button>' +
        '<button class="icon-btn" data-act="spec-add-block" data-kind="" data-section="' + esc(x.sec.id) + '" title="Add a block inside" aria-label="Add a block inside ' + esc(x.sec.title) + '">+</button></div>' +
        (closed ? '' : kids(list)) + '</div>';
    }
    var top = T.ch[''] || [];
    return '<div class="card spec-tree" aria-label="Hierarchy"><div class="st-title"><b>Hierarchy</b><span>Drag a block or section onto a section to move it in, onto a block to put it just before, or onto the board to take it out of its section. The text follows.</span>' +
      '<span class="spacer"></span><button class="btn btn-sm" data-act="spec-new-section">+ Section</button><button class="btn btn-sm btn-primary" data-act="spec-add-block" data-kind="">+ Block</button></div>' +
      '<div class="st"><div class="st-trunk" data-sdrop=""><div class="st-head st-top-head"><span class="st-top"><span class="st-eyebrow">Board</span><span class="st-top-name">' + esc(root ? root.sec.title : p.meta.name) + '</span>' +
      (root && root.links.length ? '<span class="st-sub">' + esc(plural(root.links.length, 'requirement') + ' on the board itself') + '</span>' : '') + '</span></div>' +
      (top.length ? kids(top) : '<div class="st-kids"><div class="st-item st-leaves"><div class="map-empty">Nothing yet: add a block.</div></div></div>') + '</div></div></div>';
  }
  // A new section from the hierarchy: a name and the blocks to put in it.
  function specNewSectionSheet() {
    var p = current(); if (!p) return;
    var T = specFlowTree(M.specAnalysis(p)), blocks = T.items.filter(function (x) { return !T.isSec(x); });
    var w = sheet('<div class="sheet-head"><h2>New section</h2><p>A section groups blocks, and is a heading in the text with them under it. Give it text of its own for what belongs to the whole section, like a power budget, and link that to its requirement.</p></div>' +
      '<div class="sheet-body"><div class="field"><label for="spec-sec-title">Name</label><input class="input" id="spec-sec-title" placeholder="Power"></div>' +
      '<div class="field"><span class="field-label">Blocks to put in it</span><div class="pick-grid" id="spec-sec-picks">' + blocks.map(function (x) {
        var par = T.dparent(x);
        return '<button type="button" class="pick" data-pick="' + esc(x.sec.id) + '"><b>' + esc(x.sec.title) + '</b><span>' + esc(par ? 'In ' + T.byId[par].sec.title : 'Not in a section') + '</span></button>';
      }).join('') + '</div></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Make section</button></div>', { wide: true });
    w.addEventListener('click', function (e) {
      var pk = e.target.closest('.pick'); if (pk) { pk.classList.toggle('on'); return; }
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      var title = w.querySelector('#spec-sec-title').value.trim();
      var ids = Array.prototype.map.call(w.querySelectorAll('#spec-sec-picks .pick.on'), function (x) { return x.dataset.pick; });
      if (!title) { toast('Give it a name'); return; }
      if (!ids.length) { toast('Pick at least one block to put in it'); return; }
      if (M.liveSpec(p).some(function (s2) { return s2.title.toLowerCase() === title.toLowerCase(); })) { toast('Another section is already called ' + title); return; }
      closeSheet();
      specPutAll(p, M.specGroup(p, ids, title, me()));
      toast('Made the section ' + title);
    });
  }
  // Dragging in the hierarchy (HTML drag and drop, as Signoff PL's Map).
  var stDrag = '';
  document.addEventListener('dragstart', function (e) {
    var d = e.target.closest && e.target.closest('[data-sdrag]'); if (!d) return;
    stDrag = d.dataset.sdrag; e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', stDrag); } catch (err) { /* some browsers refuse */ }
    document.body.classList.add('st-dragging');
  });
  function stDone() { stDrag = ''; document.body.classList.remove('st-dragging'); document.querySelectorAll('.st-drop-on, .st-before').forEach(function (x) { x.classList.remove('st-drop-on'); x.classList.remove('st-before'); }); }
  document.addEventListener('dragend', stDone);
  function stTarget(e) {
    if (!stDrag) return null;
    var before = e.target.closest && e.target.closest('[data-sbefore]');
    if (before && before.dataset.sbefore !== stDrag) return { el: before, before: before.dataset.sbefore };
    var z = e.target.closest && e.target.closest('[data-sdrop]');
    return z ? { el: z, parent: z.dataset.sdrop } : null;
  }
  document.addEventListener('dragover', function (e) {
    var t = stTarget(e);
    document.querySelectorAll('.st-drop-on, .st-before').forEach(function (x) { if (!t || x !== t.el) { x.classList.remove('st-drop-on'); x.classList.remove('st-before'); } });
    if (!t) return;
    e.preventDefault(); t.el.classList.add(t.before ? 'st-before' : 'st-drop-on');
  });
  document.addEventListener('drop', function (e) {
    var t = stTarget(e), id = stDrag, p = current();
    if (!t || !p || !id) return;
    e.preventDefault(); stDone();
    var T = specFlowTree(M.specAnalysis(p)), parent, before = '';
    if (t.before) { var bx = T.byId[t.before]; if (!bx) return; parent = T.dparent(bx); before = t.before; }
    else parent = t.parent;
    var x = T.byId[id]; if (!x) return;
    if (parent === id || (parent && T.anc(T.byId[parent]).indexOf(id) >= 0)) { toast('A section can’t go inside itself'); return; }
    if (!before && T.dparent(x) === parent) return;
    var recs = M.specNest(p, [id], parent || null, me(), before || undefined);
    if (recs.length) { specPutAll(p, recs); toast(x.sec.title + (parent ? ' is in ' + T.byId[parent].sec.title : ' is under the board') + '. The text follows.'); }
  });

  // ── Dragging in the flow diagram: blocks, sections, and drawing a new section ──
  var flowDrag = null;
  function flowDown(e) {
    var svg = e.target.closest && e.target.closest('svg.spec-flow');
    if (!svg || e.button !== 0 || e.target.closest('.spec-handle, .spec-edge-hit, .spec-flag')) return;
    var node = e.target.closest('.spec-node'), box = e.target.closest('.spec-group-g');
    var m = svg.getScreenCTM().inverse(), pt = svg.createSVGPoint();
    function local(ev) { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(m); }
    flowDrag = { svg: svg, local: local, start: local(e), cx: e.clientX, cy: e.clientY, on: false,
      type: node ? 'block' : box ? 'section' : 'draw', id: node ? node.dataset.id : box ? box.dataset.id : '' };
    if (flowDrag.type === 'draw') e.preventDefault();
  }
  // The deepest section box under a point, leaving out `skip` and everything inside it.
  function flowBoxAt(svg, q, skip) {
    var best = null, area = Infinity;
    Array.prototype.forEach.call(svg.querySelectorAll('.spec-group-g'), function (g) {
      if (skip && (g.dataset.id === skip || (' ' + g.dataset.anc + ' ').indexOf(' ' + skip + ' ') >= 0)) return;
      var b = g.dataset.box.split(' ').map(Number);
      if (q.x >= b[0] && q.x <= b[0] + b[2] && q.y >= b[1] && q.y <= b[1] + b[3] && b[2] * b[3] < area) { best = g; area = b[2] * b[3]; }
    });
    return best;
  }
  function flowMove(e) {
    var d = flowDrag; if (!d) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) < 6) return;
      d.on = true; d.svg.classList.add('moving');
      if (d.type === 'draw') { d.rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); d.rect.setAttribute('class', 'spec-draw'); d.svg.appendChild(d.rect); }
      else d.els = d.type === 'block' ? [d.svg.querySelector('.spec-node[data-id="' + CSS.escape(d.id) + '"]')].concat(Array.prototype.slice.call(d.svg.querySelectorAll('.spec-flag[data-for="' + CSS.escape(d.id) + '"]')))
        : [d.svg.querySelector('.spec-group-g[data-id="' + CSS.escape(d.id) + '"]')].concat(Array.prototype.slice.call(d.svg.querySelectorAll('[data-anc~="' + CSS.escape(d.id) + '"]')));
    }
    e.preventDefault();
    var q = d.local(e), dx = q.x - d.start.x, dy = q.y - d.start.y;
    if (d.type === 'draw') {
      d.rect.setAttribute('x', Math.min(q.x, d.start.x)); d.rect.setAttribute('y', Math.min(q.y, d.start.y));
      d.rect.setAttribute('width', Math.abs(dx)); d.rect.setAttribute('height', Math.abs(dy));
      return;
    }
    d.els.forEach(function (el) { if (el) el.setAttribute('transform', 'translate(' + dx + ' ' + dy + ')'); });
  }
  function flowUp(e) {
    var d = flowDrag; flowDrag = null;
    if (!d || !d.on) return;
    d.svg.classList.remove('moving');
    specDragJustEnded = true; setTimeout(function () { specDragJustEnded = false; }, 0);
    var p = current(); if (!p) return;
    var q = d.local(e);
    if (d.type === 'draw') {
      var x0 = Math.min(q.x, d.start.x), y0 = Math.min(q.y, d.start.y), x1 = Math.max(q.x, d.start.x), y1 = Math.max(q.y, d.start.y);
      d.rect.remove();
      var ids = Array.prototype.filter.call(d.svg.querySelectorAll('.spec-node'), function (g) {
        var cx = +g.dataset.x + SPEC_BW / 2, cy = +g.dataset.y + SPEC_BH / 2;
        return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
      }).map(function (g) { return g.dataset.id; });
      if (!ids.length) { if (x1 - x0 > 20) toast('Draw the box around one or more blocks'); return; }
      var name = prompt('Name the new section around ' + plural(ids.length, 'block'), 'New section');
      if (!name || !name.trim()) return;
      if (M.liveSpec(p).some(function (s) { return s.title.toLowerCase() === name.trim().toLowerCase(); })) { toast('Another section is already called ' + name.trim()); return; }
      var gr = M.specGroup(p, ids, name, me());
      if (gr.length) { specPutAll(p, gr); toast('Made the section ' + name.trim() + '. It’s a heading in the text, with its blocks under it.'); }
      return;
    }
    // Dragging only arranges (Chris: membership moved invisibly); which section a block is in is
    // changed in the hierarchy under the diagram.
    var snap = function (v) { return Math.round(v / 10) * 10; };
    var dx = snap(q.x - d.start.x), dy = snap(q.y - d.start.y);
    // Every block's place is kept from now on (the arrangement freezes), and the dragged ones move.
    var stored = {}; M.liveSpec(p).forEach(function (s) { stored[s.id] = s.pos; });
    var moving = {};
    if (d.type === 'block') moving[d.id] = 1;
    else Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node[data-anc~="' + CSS.escape(d.id) + '"]'), function (g) { moving[g.dataset.id] = 1; });
    var view = Object.assign({}, p, { spec: Object.assign({}, p.spec) }), upd = {};
    Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node'), function (g) {
      var id = g.dataset.id, x = +g.dataset.x + (moving[id] ? dx : 0), y = +g.dataset.y + (moving[id] ? dy : 0), was = stored[id];
      if (was && was.x === x && was.y === y) return;
      upd[id] = Object.assign({}, p.spec[id], { pos: { x: x, y: y } }); view.spec[id] = upd[id];
    });
    Object.keys(upd).forEach(function (id) { upd[id] = M.specStamp(upd[id], me()); });
    var recs = Object.keys(upd).map(function (k) { return upd[k]; });
    if (!recs.length) { renderPage(); return; }
    specPutAll(p, recs);
  }
  function T_title(p, id) { var s = M.liveSpec(p).filter(function (x) { return x.id === id; })[0]; return s ? s.title : 'It'; }
  function specAutoLayout() {
    var p = current(); if (!p) return;
    var recs = M.liveSpec(p).filter(function (s) { return s.pos; }).map(function (s) { return M.specStamp(Object.assign({}, p.spec[s.id], { pos: null }), me()); });
    if (recs.length) { specPutAll(p, recs); toast('Laid out again'); }
  }
  function cutText(t, n) { t = String(t || ''); return n > 1 && t.length > n ? t.slice(0, n - 1) + '…' : t; }

  // ── Blocks (the diagram's sections) ──
  function specBlockSel() { var m = /^specblock\|(.+)$/.exec(selected || ''); return m ? m[1] : ''; }
  function specOpenBlock(id) {
    selected = 'specblock|' + id;
    $('#inspector').classList.add('open');
    renderPage(); renderInspector();
  }
  function specPutAll(p, recs) {
    if (!recs.length) return;
    p.spec = p.spec || {};
    recs.forEach(function (r) { p.spec[r.id] = r; });
    touch(p); renderPage(); renderInspector(); renderToolbar(); syncSoon();
  }
  var ICON_MENU = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h12M4 10h12M4 14h12"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4.5v11M4.5 10h11"/></svg>';
  var ICON_REDO = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.5L16.5 8 13 11.5"/><path d="M16.5 8H8a4.5 4.5 0 000 9h4"/></svg>';
  // Where a section added with + on a heading goes: between that section and the next, at the level
  // of the next when it's a subsection, else at the heading's own level.
  function specNewAt(p) {
    if (!specNewAfter || !p) return null;
    var secs = M.liveSpec(p);
    for (var i = 0; i < secs.length; i++) if (secs[i].id === specNewAfter) {
      var nx = secs[i + 1];
      return { lo: secs[i].order, hi: nx ? nx.order : secs[i].order + 1, level: nx && nx.level > secs[i].level ? nx.level : secs[i].level };
    }
    return null;
  }

  // ── Back and forward (Chris, 2026-11-09) ──
  // Every Scribe edit made in this page (a sentence, a section, a move, the diagram) can be taken back
  // and redone. A step writes the earlier text as a new edit, stamped now, so it syncs like any other
  // and auto-sync carries on. A step is refused when its sections changed since (a sync brought
  // someone's newer edit), so it never overwrites that. Kept per review while the page is open.
  var specHists = {}, specHistOff = false;
  function specRecKey(r) { return r ? (r.updatedAt || '') + '|' + (r.updatedBy || '') : ''; }
  function specHistOf(p) {
    if (!specHists[p.id]) {
      var seen = {};
      Object.keys(p.spec || {}).forEach(function (id) { seen[id] = p.spec[id]; });
      specHists[p.id] = { seen: seen, undo: [], redo: [] };
    }
    return specHists[p.id];
  }
  // From touch (and as Scribe draws): sections whose stamp changed since last seen. Fresh ones stamped
  // by this person are this page's edit; older ones came in from a sync and are only noted.
  function specHistNote(p) {
    var h = specHists[p.id]; if (!h) return;
    var spec = p.spec || {}, now = Date.now(), old = {}, cur = {}, any = false, who = me();
    Object.keys(spec).forEach(function (id) {
      var r = spec[id], was = h.seen[id];
      if (!r || specRecKey(r) === specRecKey(was)) return;
      h.seen[id] = r;
      if (specHistOff || r.updatedBy !== who || !(Date.parse(r.updatedAt || '') > now - 10000)) return;
      old[id] = was || null; cur[id] = r; any = true;
    });
    if (!any) return;
    var last = h.undo[h.undo.length - 1];
    if (last && now - last.at < 600) Object.keys(cur).forEach(function (id) { if (!(id in last.old)) last.old[id] = old[id]; last.cur[id] = cur[id]; });
    else { h.undo.push({ old: old, cur: cur, at: now }); if (h.undo.length > 100) h.undo.shift(); }
    last = h.undo[h.undo.length - 1]; last.label = specHistLabel(last);
    h.redo = [];
  }
  function specHistLabel(e) {
    var ids = Object.keys(e.cur);
    var title = function (id) { var r = e.cur[id], o = e.old[id]; return (r && r.title) || (o && o.title) || 'Untitled'; };
    var moved = function (id) { var r = e.cur[id], o = e.old[id]; return !!(o && r && !r.deleted && (o.order !== r.order || o.level !== r.level) && o.body === r.body && o.title === r.title); };
    if (ids.every(moved)) return 'moving ' + title(ids[0]);
    if (ids.length === 1) {
      var r = e.cur[ids[0]], o = e.old[ids[0]];
      if (!o) return 'adding ' + title(ids[0]);
      if (r.deleted && !o.deleted) return 'deleting ' + title(ids[0]);
      if (o.title !== r.title && o.body === r.body) return 'renaming ' + (o.title || 'Untitled') + ' to ' + title(ids[0]);
      return 'the change to ' + title(ids[0]);
    }
    var added = ids.filter(function (k) { return !e.old[k]; }).length;
    return added === ids.length ? 'adding ' + plural(ids.length, 'section') : 'the change to ' + title(ids[0]) + ' and ' + plural(ids.length - 1, 'other section');
  }
  function specHistHtml(p) {
    var h = specHistOf(p), u = h.undo[h.undo.length - 1], r = h.redo[h.redo.length - 1], mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
    return '<span class="spec-hist">' +
      '<button class="icon-btn" data-act="spec-undo"' + (u ? ' title="' + esc('Back: undo ' + u.label + ' (' + mod + 'Z)') + '"' : ' disabled title="Nothing to undo yet"') + ' aria-label="Undo">' + ICON.undo + '</button>' +
      '<button class="icon-btn" data-act="spec-redo"' + (r ? ' title="' + esc('Forward: redo ' + r.label + ' (' + mod + 'Shift+Z)') + '"' : ' disabled title="Nothing to redo"') + ' aria-label="Redo">' + ICON_REDO + '</button></span>';
  }
  function specHistStep(back) {
    var p = current(); if (!p) return;
    if (specEditing) { toast('Save or cancel the edit first'); return; }
    var h = specHistOf(p), from = back ? h.undo : h.redo, to = back ? h.redo : h.undo, e = from[from.length - 1];
    if (!e) { toast(back ? 'Nothing to undo' : 'Nothing to redo'); return; }
    var spec = p.spec || {}, ids = Object.keys(e.cur);
    if (ids.some(function (id) { return specRecKey(spec[id]) !== specRecKey(e.cur[id]); })) {
      from.length = 0;
      toast('Can’t ' + (back ? 'undo ' : 'redo ') + e.label + ': it changed since, in an edit that came in from a sync', null, 6000);
      renderPage(); return;
    }
    from.pop();
    // The earlier text, stamped as a successor of what's there now, so a merge sees a plain newer edit.
    var recs = ids.map(function (id) {
      var c = spec[id], o = e.old[id];
      var r = o ? Object.assign({}, o) : Object.assign({}, c, { deleted: true });
      r.updatedAt = c.updatedAt; r.updatedBy = c.updatedBy; r.hist = c.hist;
      return M.specStamp(r, me());
    });
    var now = {}, was = {};
    recs.forEach(function (r) { now[r.id] = r; was[r.id] = e.cur[r.id]; });
    specHistOff = true;
    try { specPutAll(p, recs); } finally { specHistOff = false; }
    to.push({ old: was, cur: now, at: 0, label: e.label });
    renderPage();
    toast((back ? 'Undone: ' : 'Redone: ') + e.label, { label: back ? 'Redo' : 'Undo', run: function () { specHistStep(!back); } });
    // Show where it happened.
    var live = recs.filter(function (r) { return !r.deleted; })[0];
    if (live && ui.specView !== 'map') {
      var el = document.getElementById('spec-' + live.id);
      if (el) { specScrollTo(el, 'start'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }
  }

  // ── Dragging sections in the Document (Chris, 2026-11-09) ──
  // Drag a heading in the text, or a name in the outline, to move that section with its subsections.
  // The line shows where it lands: before the section under the pointer, at that section's level; in
  // the gap after a subsection, toward the right keeps it a subsection there. The page (or the outline)
  // scrolls while the pointer is near or past its top or bottom edge, faster the further out it is.
  var docDrag = null, docDragJust = false;
  var DOC_DRAG_SEL = { doc: '.spec-doc > .spec-sec[id^="spec-"]', outline: '.spec-outline [data-act="spec-goto"]' };
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || e.pointerType === 'touch' || specEditing || ui.view !== 'spec' || ui.specView === 'map') return;
    var h = e.target.closest && e.target.closest('.spec-doc .spec-h > h2, .spec-doc .spec-h > h3, .spec-doc .spec-h > h4, .spec-doc .spec-h > h5, .spec-outline [data-act="spec-goto"]');
    if (!h) return;
    var outline = !!h.closest('.spec-outline'), sec = !outline && h.closest('.spec-sec');
    var id = outline ? h.dataset.id : sec && sec.id.slice(5);
    if (!id) return;
    docDrag = { id: id, outline: outline, el: h, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, pointer: e.pointerId, on: false };
  });
  document.addEventListener('pointermove', function (e) {
    var d = docDrag; if (!d || e.pointerId !== d.pointer) return;
    d.px = e.clientX; d.py = e.clientY;
    if (!d.on) {
      if (Math.abs(d.px - d.x) + Math.abs(d.py - d.y) < 7) return;
      if (!docDragBegin(d)) { docDrag = null; return; }
    }
    e.preventDefault();
    d.ghost.style.left = (d.px + 14) + 'px'; d.ghost.style.top = (d.py + 10) + 'px';
  });
  function docDragBegin(d) {
    var p = current(); if (!p) return false;
    var secs = M.liveSpec(p), i = -1, k;
    for (k = 0; k < secs.length; k++) if (secs[k].id === d.id) i = k;
    if (i < 0) return false;
    d.tree = {}; d.levels = {};
    secs.forEach(function (s) { d.levels[s.id] = s.level; });
    for (k = i; k < secs.length && (k === i || secs[k].level > secs[i].level); k++) d.tree[secs[k].id] = 1;
    d.on = true; d.level = secs[i].level; d.title = secs[i].title || 'Untitled';
    try { window.getSelection().removeAllRanges(); } catch (err) { /* nothing selected */ }
    try { d.el.setPointerCapture(d.pointer); } catch (err) { /* old browsers */ }
    document.body.classList.add('spec-dragging');
    d.ghost = document.createElement('div'); d.ghost.className = 'spec-drag-ghost';
    var n = Object.keys(d.tree).length - 1;
    d.ghost.textContent = d.title + (n ? ' + ' + plural(n, 'subsection') : '');
    d.line = document.createElement('div'); d.line.className = 'spec-drop-line'; d.line.style.display = 'none';
    document.body.appendChild(d.ghost); document.body.appendChild(d.line);
    d.box = d.outline ? d.el.closest('.spec-outline') : d.el.closest('.spec-doc');
    var main = d.el.closest('.main') || document.scrollingElement;
    d.scrollers = d.outline ? [d.box, main] : [main];
    Array.prototype.forEach.call(document.querySelectorAll(d.outline ? DOC_DRAG_SEL.outline : DOC_DRAG_SEL.doc), function (el) {
      if (d.tree[d.outline ? el.dataset.id : el.id.slice(5)]) el.classList.add('spec-dragged');
    });
    d.raf = requestAnimationFrame(docDragTick);
    return true;
  }
  function docDragTick() {
    var d = docDrag; if (!d || !d.on) return;
    // Speed in px per 16 ms frame, scaled by the real frame time so a slow page still scrolls on.
    var t = performance.now(), dt = Math.min(64, d.t ? t - d.t : 16) / 16, y = d.py, vh = window.innerHeight;
    d.t = t;
    for (var i = 0; i < d.scrollers.length; i++) {
      var s = d.scrollers[i]; if (!s) continue;
      var r = s === document.scrollingElement ? { top: 0, bottom: vh } : s.getBoundingClientRect();
      var top = Math.max(0, r.top), bot = Math.min(vh, r.bottom), zone = Math.min(64, (bot - top) / 4), v = 0;
      if (y < top + zone) v = -(4 + 36 * Math.min(1, (top + zone - y) / (2 * zone)));
      else if (y > bot - zone) v = 4 + 36 * Math.min(1, (y - bot + zone) / (2 * zone));
      if (!v) continue;
      var room = v < 0 ? s.scrollTop : s.scrollHeight - s.clientHeight - s.scrollTop;
      if (room > 0) { s.scrollBy({ top: Math.round(v * dt), behavior: 'instant' }); break; }
    }
    docDragFind();
    d.raf = requestAnimationFrame(docDragTick);
  }
  // Where a drop at the pointer would put the section: { f: specMoveBlock's place, level, y }.
  function docDragFind() {
    var d = docDrag; if (!d) return;
    var list = Array.prototype.map.call(document.querySelectorAll(d.outline ? DOC_DRAG_SEL.outline : DOC_DRAG_SEL.doc), function (el) {
      var id = d.outline ? el.dataset.id : el.id.slice(5);
      return { id: id, el: el, r: el.getBoundingClientRect(), level: d.levels[id] || 1 };
    }).filter(function (t) { return t.id && !d.tree[t.id] && d.levels[t.id]; });
    var box = d.box.getBoundingClientRect(), at = list.length, i;
    var indent = function (lv) { return d.outline ? (lv - 1) * 12 : Math.max(0, lv - 2) * 18; };   // as .lv-N indents
    for (i = 0; i < list.length; i++) if (list[i].r.top + list[i].r.height / 2 > d.py) { at = i; break; }
    var next = list[at], prev = list[at - 1], t = null;
    if (prev && (!next || prev.level > next.level) && d.px - box.left > (d.outline ? 40 : 90)) t = { f: { after: prev.id }, level: prev.level, y: prev.r.bottom };
    else if (next) t = { f: { before: next.id }, level: next.level, y: next.r.top };
    else if (prev) {
      // The end of the text: after the last section at this one's level or above, keeping its level.
      var end = null;
      for (i = list.length - 1; i >= 0 && !end; i--) if (list[i].level <= d.level) end = list[i];
      end = end || prev;
      t = { f: { after: end.id }, level: end.level, y: prev.r.bottom };
    }
    d.target = t;
    if (!t) { d.line.style.display = 'none'; return; }
    var left = box.left + indent(t.level);
    d.line.style.display = ''; d.line.style.left = left + 'px'; d.line.style.width = Math.max(40, box.right - left) + 'px';
    d.line.style.top = Math.round(t.y - (d.outline ? 1 : 4)) + 'px';
  }
  function docDragEnd(drop) {
    var d = docDrag; docDrag = null;
    if (!d || !d.on) return;
    cancelAnimationFrame(d.raf);
    d.ghost.remove(); d.line.remove(); document.body.classList.remove('spec-dragging');
    document.querySelectorAll('.spec-dragged').forEach(function (el) { el.classList.remove('spec-dragged'); });
    docDragJust = true; setTimeout(function () { docDragJust = false; }, 0);
    var p = current(); if (!drop || !p || !d.target) return;
    var recs = M.specMoveBlock(p, d.id, d.target.f, me());
    // Nothing to write when it lands where it was.
    var view = Object.assign({}, p, { spec: Object.assign({}, p.spec) });
    var shape = function (q) { return M.liveSpec(q).map(function (s) { return s.id + ':' + s.level; }).join(','); };
    recs.forEach(function (r) { view.spec[r.id] = r; });
    if (!recs.length || shape(view) === shape(p)) return;
    specPutAll(p, recs);
    toast('Moved ' + d.title, { label: 'Undo', run: function () { specHistStep(true); } });
    var el = document.getElementById('spec-' + d.id);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  document.addEventListener('pointerup', function (e) { if (docDrag && e.pointerId === docDrag.pointer) docDragEnd(true); });
  document.addEventListener('pointercancel', function (e) { if (docDrag && e.pointerId === docDrag.pointer) docDragEnd(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && docDrag && docDrag.on) { e.stopPropagation(); docDragEnd(false); } }, true);
  // The click that ends a drag doesn't also jump to the section.
  document.addEventListener('click', function (e) { if (docDragJust) { e.stopPropagation(); e.preventDefault(); docDragJust = false; } }, true);
  function renderSpecBlockInspector(p) {
    var el = $('#inspector'), id = specBlockSel(), a = M.specAnalysis(p), x = a.sections.filter(function (y) { return y.sec.id === id; })[0];
    if (!x) { closeInspector(); return; }
    var FT = SPEC_FLOW ? specFlowTree(a) : null;
    if (FT && FT.isSec(x)) {
      // A section: its name, gist, what's in it, and grouping.
      el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram › ' + esc(x.sec.title || 'Untitled') + ' (section)</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
        '<div class="insp-body">' +
        '<div class="field"><label for="spec-block-title">Name</label><input class="input" id="spec-block-title" value="' + esc(x.sec.title) + '"></div>' +
        '<div class="field"><label for="spec-block-gist">Gist</label><input class="input" id="spec-block-gist" value="' + esc(x.blocks.filter(function (b) { return b.type === 'gist'; }).map(function (b) { return b.text; })[0] || '') + '" placeholder="' + esc(x.gist || 'One line: what this section does') + '"></div>' +
        '<div class="field"><span class="field-label">In this section</span><div class="chips">' + FT.ch[x.sec.id].map(function (c) {
          return '<button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(c.sec.id) + '">' + esc(c.sec.title + (FT.isSec(c) ? ' (section)' : '')) + '</button>';
        }).join('') + '</div><p class="note">Move blocks in or out in the hierarchy under the diagram. The section is a heading in the text, and its blocks are the headings under it.</p></div>' +
        '<div class="field"><span class="field-label">Requirements on the whole section</span>' + (x.links.length ? x.links.map(function (qid) {
          var q = a.ctx.reqs[qid];
          return '<div class="req-link"><button class="req-link-main" data-act="open-req" data-id="' + esc(qid) + '"><span><span class="req-link-text"><b>' + esc(q.ref) + '</b> ' + esc(q.text || 'No text yet') + '</span></span></button></div>';
        }).join('') : '<p class="note" style="margin:0">None yet. Write text for the whole section, such as its power budget, and link it to the requirement it meets.</p>') + '</div>' +
        '<div class="spec-acts"><button class="btn btn-primary" data-act="spec-add-block" data-kind="" data-section="' + esc(id) + '">Add a block here</button><button class="btn" data-act="spec-edit" data-id="' + esc(id) + '">Edit its text</button>' +
        '<button class="btn" data-act="spec-goto" data-id="' + esc(id) + '">Show in document</button><button class="btn" data-act="spec-ungroup" data-id="' + esc(id) + '">Ungroup</button></div>' +
        '<p class="note">Last changed ' + (x.sec.updatedBy ? 'by ' + esc(x.sec.updatedBy) + ', ' : '') + relTime(x.sec.updatedAt) + '.</p></div>';
      el.dataset.item = selected;
      return;
    }
    var s = x.sec, byTitle = a.ctx.titles, words = M.specLinkWords();
    var kinds = [''].concat(M.specKinds());
    var lower = SPEC_FLOW ? '' : { product: 'task', task: 'module', module: 'driver', driver: 'hardware' }[s.kind] || '';
    var groups = specRows().concat(M.specKinds().indexOf('interface') >= 0 ? [['interface', 'Interfaces']] : [], [['', 'Other sections']]);
    // One field per link word: its names (with signal or rail), remove, rename the signal, add more.
    var linkFields = words.map(function (w) {
      var items = M.specUsesItems(s.body, w), have = items.map(function (n) { return (M.specUseId(a.ctx, n) && a.ctx.secs[M.specUseId(a.ctx, n)].title || n.name).toLowerCase(); });
      var opts = a.sections.filter(function (y) { return y.sec.id !== id && y.sec.title && have.indexOf(y.sec.title.toLowerCase()) < 0; });
      return '<div class="field"><span class="field-label">' + esc(w) + '</span><div class="chips">' + (items.length ? items.map(function (it) {
        var tid = M.specUseId(a.ctx, it);
        return '<span class="chip spec-use-chip' + (tid ? '' : ' spec-chip-missing') + '">' + (tid ? '<button data-act="spec-block" data-id="' + esc(tid) + '">' + esc(it.name) + '</button>' : esc(it.name)) +
          (words.length > 1 ? '<button class="spec-use-label" data-act="spec-block-label" data-word="' + esc(w) + '" data-name="' + esc(it.name) + '" title="Name the signal or rail">' + (it.label ? esc(it.label) : '+ name') + '</button>' : '') +
          '<button class="spec-use-x" data-act="spec-block-unuse" data-word="' + esc(w) + '" data-name="' + esc(it.name) + '" aria-label="Remove ' + esc(it.name) + '">×</button></span>';
      }).join('') : '<span class="note" style="margin:0">Nothing yet</span>') + '</div>' +
      (opts.length ? '<select class="input spec-block-use" data-word="' + esc(w) + '" style="margin-top:8px"><option value="">Add a block it ' + esc(linkVerb(w)) + '…</option>' + groups.map(function (r) {
        var o = opts.filter(function (y) { return y.sec.kind === r[0]; });
        return o.length ? '<optgroup label="' + esc(r[1]) + '">' + o.map(function (y) { return '<option value="' + esc(y.sec.title) + '">' + esc(y.sec.title) + '</option>'; }).join('') + '</optgroup>' : '';
      }).join('') + '</select>' : '') + '</div>';
    }).join('');
    var fromFields = words.map(function (w) {
      var from = a.sections.filter(function (y) { return y.edges.some(function (e) { return e.id === id && e.word.toLowerCase() === w.toLowerCase(); }); });
      return from.length ? '<div class="field"><span class="field-label">' + esc(linkFrom(w)) + '</span><div class="chips">' + from.map(function (y) {
        var e = y.edges.filter(function (e2) { return e2.id === id && e2.word.toLowerCase() === w.toLowerCase(); })[0];
        return '<button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(y.sec.id) + '">' + esc(y.sec.title + (e && e.label ? ' · ' + e.label : '')) + '</button>';
      }).join('') + '</div></div>' : '';
    }).join('');
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram › ' + esc(s.title || 'Untitled') + '</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="field"><label for="spec-block-title">Name</label><input class="input" id="spec-block-title" value="' + esc(s.title) + '"></div>' +
      (kinds.length > 1 ? '<div class="field"><span class="field-label">Kind</span><div class="seg full spec-kind-seg">' + kinds.map(function (k) {
        return '<button class="' + (s.kind === k ? 'on' : '') + '" data-act="spec-block-kind" data-kind="' + k + '">' + (k ? kindLabel(k) : 'None') + '</button>';
      }).join('') + '</div></div>' : '') +
      '<div class="field"><label for="spec-block-gist">Gist</label><input class="input" id="spec-block-gist" value="' + esc(x.blocks.filter(function (b) { return b.type === 'gist'; }).map(function (b) { return b.text; })[0] || '') + '" placeholder="' + esc(x.gist || 'One line: what it does') + '"></div>' +
      linkFields + fromFields +
      (SPEC && SPEC.parts ? '<div class="field"><label for="spec-block-parts">Parts</label><input class="input" id="spec-block-parts" value="' + esc(x.parts.join(', ')) + '" placeholder="U7, L1, C1–C3"></div>' : '') +
      '<div class="field"><span class="field-label">Text</span><p class="note" style="margin:0">' + esc([plural(x.counts.linked + x.counts.std + x.counts.tag + x.counts.untraced + x.counts.note, 'sentence'), x.links.length ? plural(x.links.length, 'requirement') + ' linked' : '', x.gaps ? specGapTitle(x) : '', x.notes.length ? plural(x.notes.length, 'review note') : ''].filter(Boolean).join(' · ')) + '</p></div>' +
      specGapList(x) + specNoteList(x) +
      '<div class="spec-acts"><button class="btn btn-primary" data-act="spec-edit" data-id="' + esc(id) + '">Edit its text</button><button class="btn" data-act="spec-goto" data-id="' + esc(id) + '">Show in document</button>' +
      (lower ? '<button class="btn" data-act="spec-add-block" data-kind="' + lower + '" data-parent="' + esc(id) + '">Add a ' + lower + ' it uses</button>' : '') +
      '<button class="btn btn-danger" data-act="spec-block-delete" data-id="' + esc(id) + '">Delete</button></div>' +
      '<p class="note">Last changed ' + (s.updatedBy ? 'by ' + esc(s.updatedBy) + ', ' : '') + relTime(s.updatedAt) + '.</p></div>';
    el.dataset.item = selected;
  }
  function specBlockField(key, value, word) {
    var p = current(), id = specBlockSel(), cur = p && (p.spec || {})[id]; if (!cur) return;
    if (key === 'title') {
      value = String(value || '').trim();
      if (!value) { renderInspector(); return; }
      var clash = M.liveSpec(p).some(function (s) { return s.id !== id && s.title.toLowerCase() === value.toLowerCase(); });
      if (clash) { toast('Another section is already called ' + value); renderInspector(); return; }
      return specPutAll(p, M.specRename(p, id, value, me()));
    }
    var f = {};
    if (key === 'kind') f.kind = M.oneOf(M.specKinds(), value, '');
    if (key === 'gist') f.body = M.specSetLine(cur.body, 'gist', value);
    if (key === 'link') f.body = M.specSetLine(cur.body, word, value);
    if (key === 'parts') f.body = M.specSetLine(cur.body, 'parts', value);
    specPutAll(p, [M.specStamp(Object.assign({}, cur, f), me())]);
  }
  // Drag-to-connect: `from` gains a link to `to`, with the link its kind makes (Uses in FW; Connects in
  // EE, Supplies from a power block).
  function specConnect(from, to) {
    var p = current(), a = p && (p.spec || {})[from], b = p && (p.spec || {})[to];
    if (!a || !b || from === to) return;
    var word = M.specKindLink(M.oneOf(M.specKinds(), a.kind, ''));
    if (!M.specKinds().length && M.specLinkWord('supplies') && M.specUsesItems(a.body, 'supplies').length) word = M.specLinkWord('supplies');
    var items = M.specUsesItems(a.body, word), t = M.liveSpec(p).filter(function (s) { return s.id === to; })[0].title;
    if (items.some(function (n) { return M.specUseIs(n, t); })) { toast((a.title || 'It') + ' already ' + linkVerb(word) + ' ' + t); return; }
    specPutAll(p, [M.specStamp(Object.assign({}, a, { body: M.specSetLine(a.body, word, M.specLinkText(items.concat([{ name: t, label: '' }]))) }), me())]);
    toast((a.title || 'It') + ' ' + linkVerb(word) + ' ' + t + (M.specLinkWords().length > 1 ? '. Name the signal in its panel.' : ''));
  }
  // Removing a link (a click on its line, or × in the block panel) happens at once, with Undo in the
  // toast: Undo puts the section's text back as it was, unless it has changed since.
  function specDisconnect(from, to, word) {
    var p = current(), a = p && (p.spec || {})[from], b = p && (p.spec || {})[to]; if (!a || !b) return;
    specUnlinkName(from, word, b.title);
  }
  function specUnlinkName(from, word, name) {
    var p = current(), a = p && (p.spec || {})[from]; if (!a) return;
    word = M.specLinkWord(word) || M.specLinkWords()[0];
    var t = String(name || '').toLowerCase(), before = a.body;
    var after = M.specSetLine(a.body, word, M.specLinkText(M.specUsesItems(a.body, word).filter(function (n) { return !M.specUseIs(n, t); })));
    if (after === before) return;
    var rec = M.specStamp(Object.assign({}, a, { body: after }), me());
    specPutAll(p, [rec]);
    toast('Removed: ' + (a.title || 'It') + ' ' + linkVerb(word) + ' ' + name, { label: 'Undo', run: function () {
      var q = current(), cur = q && (q.spec || {})[from];
      if (!cur || cur.updatedAt !== rec.updatedAt) { toast('It has changed since; add the link again'); return; }
      specPutAll(q, [M.specStamp(Object.assign({}, cur, { body: before }), me())]);
    } });
  }
  // ── Lines (links between blocks) ──
  // A click on a line opens its own panel (Chris, 2026-11-09: a click used to remove it at once):
  // the two ends, its signal or rail, and Delete. selected is 'specedge|' + JSON [from, to, word].
  function specEdgeSel() {
    var m = /^specedge\|(.+)$/.exec(selected || ''); if (!m) return null;
    try { var v = JSON.parse(m[1]); return { a: v[0], b: v[1], word: v[2] }; } catch (err) { return null; }
  }
  function specEdgeIs(a, b, word) {
    var s = specEdgeSel();
    return !!s && s.a === a && s.b === b && (!word || String(s.word).toLowerCase() === String(word).toLowerCase());
  }
  function specOpenEdge(a, b, word) {
    selected = 'specedge|' + JSON.stringify([a, b, word]);
    $('#inspector').classList.add('open');
    renderPage(); renderInspector();
  }
  // The link's entry in its from-block's Uses / Connects / Supplies line, or null once it's gone.
  function specEdgeItem(p) {
    var s = specEdgeSel(), a = s && p && (p.spec || {})[s.a], b = s && p && (p.spec || {})[s.b];
    if (!a || !b || a.deleted || b.deleted) return null;
    var word = M.specLinkWord(s.word) || M.specLinkWords()[0], items = M.specUsesItems(a.body, word);
    var it = items.filter(function (n) { return M.specUseIs(n, b.title); })[0];
    return it ? { s: s, from: a, to: b, word: word, items: items, it: it } : null;
  }
  function renderSpecEdgeInspector(p) {
    var el = $('#inspector'), L = specEdgeItem(p);
    if (!L) { selected = null; closeInspector(); renderPage(); return; }
    var words = M.specLinkWords();
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram › Line</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<h2 class="spec-edge-title">' + esc(L.from.title || 'Untitled') + ' <span>' + esc(linkVerb(L.word)) + '</span> ' + esc(L.to.title || 'Untitled') + '</h2>' +
      '<div class="field"><span class="field-label">From</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(L.s.a) + '">' + esc(L.from.title || 'Untitled') + '</button></div></div>' +
      '<div class="field"><span class="field-label">To</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(L.s.b) + '">' + esc(L.to.title || 'Untitled') + '</button></div></div>' +
      (words.length > 1 ? '<div class="field"><label for="spec-edge-label">Signal, bus, or rail</label><input class="input" id="spec-edge-label" value="' + esc(L.it.label || '') + '" placeholder="' + (M.specLinkWord('supplies') && L.word.toLowerCase() === M.specLinkWord('supplies').toLowerCase() ? '3V3' : 'I2C') + '"></div>' : '') +
      '<p class="note">It’s the <code>' + esc(L.word) + ':</code> line in ' + esc(L.from.title || 'its block') + '’s text.</p>' +
      '<div class="spec-acts"><button class="btn" data-act="spec-goto" data-id="' + esc(L.s.a) + '">Show in document</button>' +
      '<button class="btn btn-danger" data-act="spec-edge-delete">Delete line</button></div></div>';
    el.dataset.item = selected;
  }
  function specEdgeLabel(value) {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    var v = String(value || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
    if (v === (L.it.label || '')) return;
    L.it.label = v;
    specPutAll(p, [M.specStamp(Object.assign({}, L.from, { body: M.specSetLine(L.from.body, L.word, M.specLinkText(L.items)) }), me())]);
  }
  function specEdgeDelete() {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    selected = null; closeInspector();
    specUnlinkName(L.s.a, L.word, L.it.name);
  }
  // A link's signal or rail name, from the block panel.
  function specLinkLabel(word, name) {
    var p = current(), cur = p && (p.spec || {})[specBlockSel()]; if (!cur) return;
    var items = M.specUsesItems(cur.body, word), it = items.filter(function (n) { return n.name === name; })[0]; if (!it) return;
    var v = prompt('Signal, bus, or rail for ' + name + ' (blank for none)', it.label);
    if (v === null) return;
    it.label = v.replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
    specBlockField('link', M.specLinkText(items), word);
  }
  var specDrag = null;
  function specDragStart(e, handle) {
    var svg = handle.ownerSVGElement; if (!svg) return;
    e.preventDefault(); e.stopPropagation();
    var m = svg.getScreenCTM().inverse(), pt = svg.createSVGPoint();
    function local(ev) { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(m); }
    var x0 = +handle.getAttribute('cx'), y0 = +handle.getAttribute('cy');
    var line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'spec-drag-line'); svg.appendChild(line);
    svg.classList.add('dragging');
    specDrag = { from: handle.dataset.src, line: line, svg: svg, local: local, x0: x0, y0: y0, over: null, moved: false };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
    specDragMove(e);
  }
  function specDragMove(e) {
    var d = specDrag; if (!d) return;
    var q = d.local(e), my = (d.y0 + q.y) / 2;
    if (Math.abs(q.x - d.x0) + Math.abs(q.y - d.y0) > 6) d.moved = true;
    d.line.setAttribute('d', 'M' + d.x0 + ' ' + d.y0 + ' C' + d.x0 + ' ' + my + ' ' + q.x + ' ' + my + ' ' + q.x + ' ' + q.y);
    var el = document.elementFromPoint(e.clientX, e.clientY), node = el && el.closest && el.closest('.spec-node');
    var over = node && node.dataset.id !== d.from ? node : null;
    if (d.over !== over) { if (d.over) d.over.classList.remove('drop'); if (over) over.classList.add('drop'); d.over = over; }
  }
  function specDragEnd() {
    var d = specDrag; if (!d) return;
    specDrag = null;
    d.line.remove(); d.svg.classList.remove('dragging');
    if (d.over) { d.over.classList.remove('drop'); specConnect(d.from, d.over.dataset.id); }
    else if (d.moved) toast('Drop on a block to connect');
    specDragJustEnded = d.moved;
    setTimeout(function () { specDragJustEnded = false; }, 0);
  }
  var specDragJustEnded = false;
  // Dragging a block: a ghost follows the pointer, the layer under it lights up, and the drop sets
  // the kind (the layer) and the place (beside the nearest blocks), written to the text.
  var specMove = null;
  function specMoveDown(e, node) {
    if (e.button !== 0) return;
    var svg = node.ownerSVGElement; if (!svg || !svg.dataset.rows || svg.querySelector('.spec-node.dragging')) return;
    specMove = { node: node, svg: svg, x: e.clientX, y: e.clientY, on: false };
  }
  function specMoveMove(e) {
    var d = specMove; if (!d) return;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 8) return;
      d.on = true;
      var m = d.svg.getScreenCTM().inverse(), pt = d.svg.createSVGPoint();
      d.local = function (ev) { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(m); };
      d.start = d.local(e); d.ghost = d.node.cloneNode(true);
      d.ghost.classList.add('ghost'); d.ghost.removeAttribute('data-act');
      d.svg.appendChild(d.ghost); d.node.classList.add('dragging'); d.svg.classList.add('moving');
      d.band = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); d.band.setAttribute('class', 'spec-row-band');
      d.band.setAttribute('x', 0); d.band.setAttribute('width', 1000); d.svg.insertBefore(d.band, d.svg.firstChild.nextSibling);
      d.mark = document.createElementNS('http://www.w3.org/2000/svg', 'line'); d.mark.setAttribute('class', 'spec-drop-mark'); d.svg.appendChild(d.mark);
    }
    e.preventDefault();
    var q = d.local(e), rows = d.svg.dataset.rows.split(','), bh = +d.svg.dataset.bh;
    var bands = d.svg.dataset.bands.split(',').map(function (b) { return b.split(':').map(Number); });
    d.ghost.setAttribute('transform', 'translate(' + (q.x - d.start.x) + ' ' + (q.y - d.start.y) + ')');
    var ri = 0; bands.forEach(function (b, i) { if (q.y >= b[0]) ri = i; });
    d.kind = rows[ri];
    d.band.setAttribute('y', bands[ri][0]); d.band.setAttribute('height', bands[ri][1] - bands[ri][0]);
    // The blocks in that layer (not this one) in reading order, line by line: sit before the first
    // after the pointer on its line, or on a later line.
    var others = Array.prototype.filter.call(d.svg.querySelectorAll('.spec-node[data-row="' + d.kind + '"]'), function (g) { return g !== d.node && !g.classList.contains('ghost'); })
      .sort(function (a, b) { return a.dataset.y - b.dataset.y || a.dataset.cx - b.dataset.cx; });
    var lineY = others.length ? others.map(function (g) { return +g.dataset.y; }).reduce(function (best, y) { return Math.abs(q.y - (y + bh / 2)) < Math.abs(q.y - (best + bh / 2)) ? y : best; }) : 0;
    var after = function (g) { return +g.dataset.y > lineY || (+g.dataset.y === lineY && +g.dataset.cx > q.x); };
    var next = others.filter(after)[0], prev = others.filter(function (g) { return !after(g); }).pop();
    if (next && prev && +next.dataset.y !== lineY && +prev.dataset.y === lineY) next = null;
    d.before = next ? next.dataset.id : ''; d.after = !next && prev ? prev.dataset.id : '';
    var ref = next || prev;
    if (ref) {
      var bb = ref.querySelector('rect').getBBox(), mx = next ? bb.x - 8 : bb.x + bb.width + 8;
      d.mark.setAttribute('x1', mx); d.mark.setAttribute('x2', mx); d.mark.setAttribute('y1', bb.y - 4); d.mark.setAttribute('y2', bb.y + bb.height + 4); d.mark.style.display = '';
    } else d.mark.style.display = 'none';
  }
  function specMoveUp() {
    var d = specMove; specMove = null; if (!d || !d.on) return;
    d.ghost.remove(); d.band.remove(); d.mark.remove(); d.node.classList.remove('dragging'); d.svg.classList.remove('moving');
    specDragJustEnded = true; setTimeout(function () { specDragJustEnded = false; }, 0);
    var p = current(), id = d.node.dataset.id, recs = p ? M.specMoveBlock(p, id, { kind: d.kind, before: d.before, after: d.after }, me()) : [];
    if (!recs.length) return;
    specPutAll(p, recs);
    toast('Moved ' + ((p.spec[id] || {}).title || 'the block') + (d.kind !== d.node.dataset.row ? ' to ' + kindPlural(d.kind).toLowerCase() : ''));
  }

  function specAddBlockSheet(kind, parent, section) {
    var p = current(); if (!p) return;
    var secs = M.liveSpec(p), label = kind ? kindLabel(kind).toLowerCase() : 'block';
    var FT = SPEC_FLOW ? specFlowTree(M.specAnalysis(p)) : null, groups = FT ? FT.items.filter(function (x) { return FT.isSec(x); }) : [];
    var w = sheet('<div class="sheet-head"><h2>Add a ' + esc(label) + '</h2><p>It becomes a section in the text, ready to write. You can fill it out there later.</p></div>' +
      '<div class="sheet-body"><div class="field"><label for="spec-new-title">Name</label><input class="input" id="spec-new-title" placeholder="' + esc({ product: 'Thermostat firmware', task: 'Control loop', module: 'Scheduler', driver: 'Relay driver', hardware: 'Relays', interface: 'Status frame' }[kind] || 'Name') + '"></div>' +
      '<div class="field"><label for="spec-new-gist">Gist (optional)</label><input class="input" id="spec-new-gist" placeholder="One line: what it does"></div>' +
      (FT ? '<div class="field"><label for="spec-new-section">In section</label><select class="input" id="spec-new-section"><option value="">None</option>' + groups.map(function (g) {
        return '<option value="' + esc(g.sec.id) + '"' + (g.sec.id === section ? ' selected' : '') + '>' + esc(g.sec.title || 'Untitled') + '</option>';
      }).join('') + '</select></div>' : '') +
      '<div class="field"><label for="spec-new-parent">' + esc(M.specLinkWords().length > 1 ? 'Connected from, or supplied by' : linkFrom(M.specLinkWords()[0])) + '</label><select class="input" id="spec-new-parent"><option value="">Nothing yet</option>' + secs.map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === parent ? ' selected' : '') + '>' + esc(s.title || 'Untitled') + (s.kind ? ' (' + esc(s.kind) + ')' : '') + '</option>';
      }).join('') + '</select></div>' + (M.specLinkWords().length > 1 ? '<div class="field"><label for="spec-new-label">Signal or rail (optional)</label><input class="input" id="spec-new-label" placeholder="UART, I2C, 3V3…"></div>' : '') + '</div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Add</button></div>');
    function ok() {
      var title = w.querySelector('#spec-new-title').value.trim();
      if (!title) { toast('Give it a name'); return; }
      if (M.liveSpec(p).some(function (s) { return s.title.toLowerCase() === title.toLowerCase(); })) { toast('Another section is already called ' + title); return; }
      var lab = w.querySelector('#spec-new-label');
      var recs = M.specAddBlock(p, { title: title, kind: kind, gist: w.querySelector('#spec-new-gist').value, parent: w.querySelector('#spec-new-parent').value, label: lab ? lab.value.replace(/[(),]/g, ' ').trim() : '' }, me());
      var secSel = w.querySelector('#spec-new-section'), into = secSel ? secSel.value : '';
      if (recs.length && FT) {
        // Into its section, and, once the layout is kept, a place beside what's there (else laid out).
        var view = Object.assign({}, p, { spec: Object.assign({}, p.spec) });
        recs.forEach(function (r) { view.spec[r.id] = r; });
        var all = {}; recs.forEach(function (r) { all[r.id] = r; });
        if (into) M.specNest(view, [recs[0].id], into, me()).forEach(function (r) { all[r.id] = r; });
        var svgEl = document.querySelector('svg.spec-flow');
        if (svgEl && M.liveSpec(p).some(function (s2) { return s2.pos; })) {
          var box = into && svgEl.querySelector('.spec-group-g[data-id="' + CSS.escape(into) + '"]'), at;
          if (box) { var bb = box.dataset.box.split(' ').map(Number); at = { x: bb[0] + bb[2] + 6, y: bb[1] + 20 + 12 }; }
          else { var ys = Array.prototype.map.call(svgEl.querySelectorAll('.spec-node'), function (g) { return +g.dataset.y; }); at = { x: 20, y: (ys.length ? Math.max.apply(null, ys) : 0) + SPEC_BH + 60 }; }
          all[recs[0].id] = Object.assign({}, all[recs[0].id], { pos: { x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10 } });
        }
        recs = [all[recs[0].id]].concat(Object.keys(all).filter(function (k) { return k !== recs[0].id; }).map(function (k) { return all[k]; }));
      }
      closeSheet();
      ui.view = 'spec'; ui.specView = 'map'; saveUi();
      // Stay on the diagram (Chris: the panel hid where the block landed): select it, bring it into
      // view, and flash it. Clicking it opens its panel.
      selected = 'specblock|' + recs[0].id; closeInspector();
      specPutAll(p, recs);
      var nn = document.querySelector('.spec-node[data-id="' + CSS.escape(recs[0].id) + '"]');
      if (nn) { nn.scrollIntoView({ block: 'center', behavior: 'smooth' }); nn.classList.add('flash'); }
      toast('Added ' + title + '. Click it to name its links or write its text.');
    }
    w.addEventListener('click', function (e) { var b = e.target.closest('[data-sheet]'); if (!b) return; if (b.dataset.sheet === 'cancel') closeSheet(); else ok(); });
    w.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); ok(); } });
  }

  function renderSpecInspector(p) {
    var el = $('#inspector'), sel = specSel(), a = M.specAnalysis(p), f = sel && specFind(a, sel.sec, sel.start);
    if (!f) { closeInspector(); return; }
    var u = f.u, search = el.dataset.item === selected && el.querySelector('#spec-link-search'), query = search ? search.value : '';
    var links = u.reqs.map(function (id) {
      var q = a.ctx.reqs[id];
      return '<div class="req-link"><button class="req-link-main" data-act="open-req" data-id="' + esc(id) + '"><span><span class="req-link-text"><b>' + esc(q.ref) + '</b> ' + esc(q.text || 'No text yet') + '</span>' +
        '<span class="muted">' + esc(REQ_LABEL[q.status] + ' · ' + REQ_LABEL[q.verify]) + '</span></span></button>' +
        '<button class="cmt-del" style="opacity:1" data-act="spec-unlink" data-id="' + esc(id) + '">Remove</button></div>';
    }).join('') + u.missing.map(function (t) {
      return '<div class="req-link missing"><span class="req-link-main"><span><span class="req-link-text">' + esc(t) + '</span><span class="muted">Not found: no requirement or section by that name</span></span></span></div>';
    }).join('');
    var secLinks = [];
    u.tokens.forEach(function (t) { if (t.t === 'span') t.secs.forEach(function (id) { if (secLinks.indexOf(id) < 0) secLinks.push(id); }); });
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">' + esc(SPEC_LABEL) + ' › ' + esc(f.x.sec.title || 'Untitled') + '</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="field"><span class="field-label">Sentence <span class="spec-state st-' + u.state + '">' + STATE_LABEL[u.state] + '</span></span>' +
      '<div class="spec-quote">' + specUnitHtml(p, a, f.x, u).replace(' data-act="spec-unit"', '') + '</div></div>' +
      (u.broken ? '<p class="note spec-broken-note">' + esc(BROKEN_TIP) + ' Fix it with <b>Edit section</b>; until then the buttons here leave the sentence alone.</p>' : '') +
      (specPhrase ? '<div class="spec-phrase"><span>Linking just <b>“' + esc(specPhrase) + '”</b></span><button class="btn btn-sm" data-act="spec-phrase-clear">Whole sentence</button></div>' :
        '<p class="note" style="margin:-6px 0 10px">Select words in the sentence to link just those.</p>') +
      '<div class="field"><span class="field-label">Requirements</span>' + (links || '<p class="note" style="margin:0 0 8px">' + (u.state === 'std' ? 'Standard text: description that needs no requirement.' : 'Not linked to a requirement yet.') + '</p>') +
      '<input class="input" id="spec-link-search" placeholder="Search requirements to link…" value="' + esc(query) + '" autocomplete="off">' +
      '<div id="spec-link-results">' + specLinkResults(p, u, query) + '</div></div>' +
      (secLinks.length ? '<div class="field"><span class="field-label">Points at</span><div class="chips">' + secLinks.map(function (id) { return '<button class="chip" data-act="spec-goto" data-id="' + esc(id) + '">' + esc(a.ctx.secs[id].title) + '</button>'; }).join('') + '</div></div>' : '') +
      (u.state === 'note' ? '<p class="note">A review note: a question for the review, counted on its own and not a gap. Answer it in the text, then resolve it.</p>' : '') +
      '<div class="spec-acts">' +
      (u.note ? '<button class="btn btn-primary" data-act="spec-resolve" data-sec="' + esc(f.x.sec.id) + '" data-u="' + u.start + '" title="Take the note out of the text">Resolve</button>' :
      '<button class="btn btn-primary" data-act="spec-make" data-sec="' + esc(f.x.sec.id) + '" data-u="' + u.start + '">Make requirement</button>') +
      (u.tag ? f.x.links.filter(function (id) { return u.reqs.indexOf(id) < 0; }).slice(0, 3).map(function (id) {
        return '<button class="btn" data-act="spec-change" data-sec="' + esc(f.x.sec.id) + '" data-u="' + u.start + '" data-id="' + esc(id) + '" title="' + esc(reqLabel(a.ctx.reqs[id])) + '">Change ' + esc(a.ctx.reqs[id].ref || 'requirement') + '</button>';
      }).join('') : '') +
      (u.note ? '' : u.std ? '<button class="btn" data-act="spec-std" data-on="">Not standard</button>' : !u.reqs.length ? '<button class="btn" data-act="spec-std" data-on="1" title="Description that needs no requirement">Mark standard</button>' : '') +
      (u.tag ? '<button class="btn" data-act="spec-tag" data-on="">Remove @req flag</button>' : u.row ? '' : '<button class="btn" data-act="spec-tag" data-on="1" title="Flag it to turn into a requirement later">Flag @req</button>') +
      '<button class="btn" data-act="spec-edit" data-id="' + esc(f.x.sec.id) + '">Edit section</button></div>' +
      '<p class="note">Last changed ' + (f.x.sec.updatedBy ? 'by ' + esc(f.x.sec.updatedBy) + ', ' : '') + relTime(f.x.sec.updatedAt) + '.</p></div>';
    el.dataset.item = selected;
  }
  // Resolving a review note takes it out of the text (its line, when it has one to itself), with Undo.
  function specResolve(sec, start) {
    var p = current(), a = p && M.specAnalysis(p), f = a && specFind(a, sec, start); if (!f || !f.u.note) return;
    var cur = p.spec[sec], before = String(cur.body || ''), after = M.specRemoveUnit(before, f.u.start, f.u.end);
    if (after === before) return;
    selected = null; closeInspector();
    specPutAll(p, [M.specStamp(Object.assign({}, cur, { body: after }), me())]);
    var rec = p.spec[sec];
    toast('Resolved: ' + cutText(f.u.text, 60), { label: 'Undo', run: function () {
      var q = current(), now = q && (q.spec || {})[sec];
      if (!now || now.updatedAt !== rec.updatedAt) { toast('The section has changed since; type the note again'); return; }
      specPutAll(q, [M.specStamp(Object.assign({}, now, { body: before }), me())]);
    } });
  }
  function specLinkResults(p, u, query) {
    query = (query || '').trim().toLowerCase();
    if (query.length < 2) return '';
    var hits = M.liveReqs(p).filter(function (q) { return q.status !== 'deprecated' && u.reqs.indexOf(q.id) < 0 && [q.ref, q.text, q.category].join(' ').toLowerCase().indexOf(query) >= 0; }).slice(0, 8);
    if (!hits.length) return '<p class="note">No requirements match.</p>';
    return '<div class="req-results">' + hits.map(function (q) { return '<button data-act="spec-link" data-id="' + esc(q.id) + '"><span><b>' + esc(q.ref) + '</b> ' + esc(q.text) + '</span></button>'; }).join('') + '</div>';
  }
  // On a requirement: the sentences that describe it.
  function specDescribedIn(p, q) {
    if (!specOn(p)) return '';
    var a = M.specAnalysis(p), uses = a.uses[q.id] || [];
    return '<div class="field"><span class="field-label">Described in</span>' + (uses.length ? uses.map(function (w) {
      var s = a.ctx.secs[w.sec];
      return '<div class="req-link"><button class="req-link-main" data-act="spec-open" data-sec="' + esc(w.sec) + '" data-u="' + w.start + '"><span><span class="req-link-text">' + esc(w.text) + '</span><span class="muted">' + esc(SPEC_LABEL + ' › ' + (s.title || 'Untitled')) + '</span></span></button></div>';
    }).join('') : '<p class="note" style="margin:0 0 8px">Nothing in ' + esc(SPEC_LABEL) + ' describes it yet.</p><button class="btn btn-sm" data-act="spec-describe" data-id="' + esc(q.id) + '">Describe in…</button>') + '</div>';
  }

  function specOpenUnit(sec, start, phrase) {
    var p = current(); if (!p) return;
    specPhrase = phrase || '';
    ui.view = 'spec'; ui.specView = 'doc'; if ((ui.specDepth || 3) < 3) ui.specDepth = 3; saveUi();
    selected = specSelKey(sec, start);
    $('#inspector').classList.add('open');
    renderPage(); renderInspector();
    var el = document.querySelector('.su.sel');
    if (!el && specUnfilter()) el = document.querySelector('.su.sel');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // ── The Scribe guide's way in (assets/specguide.js) ──
  // The guide runs on the demo review named by config.spec.guide (a demo seed) and drives the page
  // through these calls rather than clicks, since the page is redrawn with innerHTML.
  function specGuideId() { return SPEC && SPEC.guide != null && S.demo ? S.demo.id(SPEC.guide) : ''; }
  function specGuideSlug() { var id = specGuideId(); return Object.keys(projects).filter(function (k) { return projects[k].id === id; })[0] || ''; }
  function specGuideOpen(view, depth) {
    var slug = specGuideSlug(); if (!slug) return false;
    ui.slug = slug; ui.home = false; ui.page = '';
    ui.view = view === 'reqs' ? 'reqs' : 'spec';
    if (view === 'doc' || view === 'map') ui.specView = view;
    if (depth) ui.specDepth = depth;
    ui.specShow = '';
    specEditing = null; specDraft = ''; selected = null; closeInspector(); saveUi(); render();
    return true;
  }
  function specGuideSec(title) {
    var p = current(), t = String(title || '').toLowerCase();
    return p ? M.liveSpec(p).filter(function (s) { return s.title.toLowerCase() === t; })[0] || null : null;
  }
  // The pristine demo review, to tell whether the visitor's copy has changed and to rebuild it.
  function specGuidePristine() { var id = specGuideId(); return id ? S.demo.projects(TEMPLATES).filter(function (p) { return p.id === id; })[0] : null; }
  function specGuideSig(p) {
    return p ? JSON.stringify([M.specToText(p), M.liveReqs(p).map(function (q) { return q.ref + ' ' + q.text; }), M.specCommentTags(p).length]) : '';
  }
  function specHook() {
    return {
      available: function () { return !!specGuideId() && !!specGuidePristine(); },
      demoId: specGuideId,
      narrow: function () { return window.innerWidth <= 860; },
      open: specGuideOpen,
      project: function () { return current(); },
      analysis: function () { var p = current(); return p && specOn(p) ? M.specAnalysis(p) : null; },
      section: specGuideSec,
      // The visitor's newest section (not one of the demo's fixed s<seed>-<n> ids), or null.
      newest: function () {
        var p = current(); if (!p) return null;
        return M.liveSpec(p).filter(function (s) { return !/^s\d+-\d+$/.test(s.id); }).sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); }).pop() || null;
      },
      // Open the sentence that contains `text` in its panel; false when there's none.
      unit: function (text, panel) {
        var p = current(); if (!p) return false;
        var a = M.specAnalysis(p), hit = null, want = String(text).toLowerCase();
        a.sections.forEach(function (x) { x.blocks.forEach(function (b) { (b.units || []).forEach(function (u) { if (!hit && u.text.toLowerCase().indexOf(want) >= 0) hit = { sec: x.sec.id, start: u.start }; }); }); });
        if (!hit) return false;
        if (panel === false) { specGoto(hit.sec); return true; }
        specOpenUnit(hit.sec, hit.start); return true;
      },
      block: function (id) { if (!id) return false; ui.view = 'spec'; ui.specView = 'map'; saveUi(); specOpenBlock(id); return true; },
      edit: function (id) { if (!id) return false; specStartEdit(id); return true; },
      editAll: function () { var p = current(); if (!p) return; ui.view = 'spec'; ui.specView = 'doc'; saveUi(); specEditing = 'all'; specDraft = M.specToText(p); closeInspector(); selected = null; renderPage(); specFocusEditor(); },
      goto: specGoto,
      req: function (ref) {
        var p = current(), q = p && M.liveReqs(p).filter(function (r) { return r.ref === ref; })[0];
        if (!q) return false; ui.view = 'reqs'; saveUi(); openReq(q.id); return true;
      },
      close: function () { selected = null; closeInspector(); renderPage(); },
      stale: function () { var p = projects[specGuideSlug()]; return !!p && specGuideSig(p) !== specGuideSig(specGuidePristine()); },
      fresh: function () {
        var slug = specGuideSlug(), fresh = specGuidePristine(); if (!slug || !fresh) return;
        projects[slug] = fresh; delete dirty[fresh.id]; persist(); render();
      }
    };
  }

  // From the Write as requirements list: show the sentence in the document, highlighted, without
  // opening its panel (Chris: the text is where to write it up).
  function specJumpUnit(sec, start) {
    ui.view = 'spec'; ui.specView = 'doc'; if ((ui.specDepth || 3) < 3) ui.specDepth = 3; saveUi();
    selected = null; closeInspector(); renderPage();
    var el = document.querySelector('.su[data-sec="' + CSS.escape(sec) + '"][data-u="' + start + '"]');
    if (!el && specUnfilter()) el = document.querySelector('.su[data-sec="' + CSS.escape(sec) + '"][data-u="' + start + '"]');
    if (el) { specScrollTo(el, 'center'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  // Scroll a section or sentence into view smoothly, then, once the scroll ends, check where it landed
  // and put it right: the first jump after opening the tab sometimes stopped a section or two short,
  // while the page above was still settling (its own scroll back to the top, fonts).
  function specScrollTo(el, block) {
    var main = $('#main'), done = false;
    el.scrollIntoView({ block: block, behavior: 'smooth' });
    // Someone scrolling by hand meanwhile wins.
    function mine() { done = true; off(); }
    function off() { main.removeEventListener('scrollend', check); ['wheel', 'touchstart', 'keydown'].forEach(function (t) { main.removeEventListener(t, mine); }); }
    ['wheel', 'touchstart', 'keydown'].forEach(function (t) { main.addEventListener(t, mine, { passive: true }); });
    function check() {
      if (done) return; done = true; off();
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect(), m = main.getBoundingClientRect(), margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      var want = block === 'center' ? m.top + (m.height - r.height) / 2 : m.top + margin;
      if (Math.abs(r.top - want) > 24) el.scrollIntoView({ block: block, behavior: 'instant' });
    }
    main.addEventListener('scrollend', check);
    setTimeout(check, 1500);
  }
  // A jump to a section or sentence the Gaps or Notes filter hides turns the filter off first (it's kept
  // across reloads, so a link from elsewhere may land while it's on). True when it did, after a redraw.
  function specUnfilter() {
    if (!ui.specShow) return false;
    ui.specShow = ''; saveUi(); renderPage();
    return true;
  }
  function specGoto(id) {
    if (ui.view !== 'spec' || ui.specView === 'map') { ui.view = 'spec'; ui.specView = 'doc'; saveUi(); renderPage(); }
    var el = document.getElementById('spec-' + id);
    if (!el && specUnfilter()) el = document.getElementById('spec-' + id);
    if (el) { specScrollTo(el, 'start'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  function specStartEdit(id) {
    var p = current(); if (!p) return;
    var a = M.specAnalysis(p), x = a.sections.filter(function (y) { return y.sec.id === id; })[0];
    if (!x) return;
    ui.view = 'spec'; ui.specView = 'doc'; saveUi();
    specEditing = id;
    specDraft = M.specHeadingLine(x.sec) + '\n' + M.specToEditor(x.sec.body, a.ctx);
    closeInspector(); renderPage(); specFocusEditor();
  }
  function specFocusEditor() {
    setTimeout(function () {
      var t = $('#spec-editor'); if (!t) return;
      t.focus(); t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); specBarRefresh();
    }, 30);
  }
  // The outline of the text being edited, read as the editor would save it.
  function specLiveOutline() {
    var heads = M.specSplit(specDraft).map(function (c) { return c.heading || { level: 1, title: 'Untitled', kind: '' }; });
    return heads.map(function (h) { return '<button class="lv-' + h.level + '" tabindex="-1"><span>' + esc(h.title || 'Untitled') + '</span>' + (h.kind ? '<span class="chip spec-kind">' + esc(h.kind) + '</span>' : '') + '</button>'; }).join('') ||
      '<p class="note">Headings (# Title) make the outline.</p>';
  }
  // Sections longer than a review keeps (model.SPEC_BODY_MAX) would be cut when read: say so and save
  // nothing. Returns true when it refused.
  function specRefuseLong(recs) {
    var long = M.specTooLong(recs);
    if (!long.length) return false;
    toast('Not saved: ' + long.map(function (x) { return x.title + ' is ' + x.length.toLocaleString('en-US') + ' characters'; }).join(', ') + '. A section holds ' + M.SPEC_BODY_MAX.toLocaleString('en-US') + '; split it with a heading.', null, 8000);
    return true;
  }
  // After a save: marks in the saved text that didn't parse are flagged in the document.
  function specBrokenNote(text) { var n = M.specBrokenMarks(text).length; return n ? '; ' + plural(n, 'mark') + ' didn’t parse and ' + (n === 1 ? 'is' : 'are') + ' flagged in the text' : ''; }
  function specSaveAll() {
    var p = current(); if (!p) return;
    var recs = M.specSaveAll(p, specDraft, me());
    if (specRefuseLong(recs)) return;
    var gone = recs.filter(function (r) { return r.deleted; });
    if (gone.length && !confirm('Saving removes ' + plural(gone.length, 'section') + ': ' + gone.map(function (r) { return r.title || 'Untitled'; }).join(', ') + '. Links to them stop working. Save anyway?')) return;
    p.spec = p.spec || {};
    recs.forEach(function (r) { p.spec[r.id] = r; });
    var note = specBrokenNote(specDraft);
    specEditing = null; specDraft = '';
    if (recs.length) touch(p);
    renderPage(); renderToolbar(); syncSoon();
    toast((recs.length ? 'Saved: ' + plural(recs.length - gone.length, 'section') + ' changed or added' + (gone.length ? ', ' + gone.length + ' removed' : '') : 'No changes') + note);
  }
  function specSaveEdit() {
    var p = current(); if (!p || !specEditing) return;
    if (specEditing === 'all') return specSaveAll();
    var id = specEditing === 'new' ? null : specEditing;
    if (id && !specDraft.trim() && !confirm('Delete this section?')) return;
    var recs = M.specSave(p, id, specDraft, me());
    if (specRefuseLong(recs)) return;
    p.spec = p.spec || {};
    // From + on a heading: the new sections go right under that one, not at the end.
    var at = id ? null : specNewAt(p);
    if (at) {
      var fresh = recs.filter(function (r) { return !p.spec[r.id]; });
      fresh.forEach(function (r, i) { r.order = at.lo + (at.hi - at.lo) * (i + 1) / (fresh.length + 1); });
    }
    recs.forEach(function (r) { p.spec[r.id] = r; });
    var note = specBrokenNote(specDraft);
    specEditing = null; specDraft = ''; specNewAfter = '';
    if (recs.length) touch(p);
    renderPage(); syncSoon();
    if (note) toast('Saved' + note);
  }
  function specPasteSheet() {
    var p = current(); if (!p) return;
    var w = sheet('<div class="sheet-head"><h2>Paste text</h2><p>Paste a description, for example from meeting notes or a design document. Lines starting with <b>#</b>, <b>##</b>, <b>###</b>, or <b>####</b> start sections; text before the first heading goes in a section of its own. Sections are added after the ones already here.</p></div>' +
      '<div class="sheet-body"><textarea class="input" id="spec-paste" rows="14" placeholder="# Overview&#10;The thermostat runs a home’s heating and cooling.&#10;&#10;## Control loop * task&#10;…"></textarea></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Add</button></div>', { wide: true });
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      var text = w.querySelector('#spec-paste').value;
      if (!text.trim()) { toast('Nothing to add'); return; }
      var chunks = M.specSplit(text);
      if (chunks.length && !chunks[0].heading) text = '# Overview\n' + text;
      var recs = M.specSave(p, null, text, me());
      if (specRefuseLong(recs)) return;
      p.spec = p.spec || {};
      recs.forEach(function (r) { p.spec[r.id] = r; });
      touch(p); closeSheet();
      ui.view = 'spec'; saveUi(); renderPage(); syncSoon();
      toast('Added ' + plural(recs.length, 'section'));
    });
  }
  // Start from the tool's template (config.spec.template, model.specTemplate), shaped by the review's
  // profile: the text, editable, before it's added.
  function specTemplateSheet() {
    var p = current(); if (!p) return;
    var text = M.specTemplate(p); if (!text) return;
    var prof = (p.meta.profile || []).map(function (id) { var t = M.TAGS.filter(function (x) { return x.id === id; })[0]; return t ? t.label : ''; }).filter(Boolean);
    var w = sheet('<div class="sheet-head"><h2>Start from template</h2><p>Headings for the usual parts of ' + esc(W.thing) + ' like this, ' +
      (prof.length ? 'chosen from its ' + esc((W.profile || 'profile').toLowerCase()) + ' (' + esc(prof.join(', ')) + ')' : 'from the general template (set a ' + esc((W.profile || 'profile').toLowerCase()) + ' in the details for more)') +
      ', each with a question to answer in its place. Change anything here first, or later; leave out what doesn’t apply.</p></div>' +
      '<div class="sheet-body"><textarea class="input" id="spec-template" rows="18"></textarea></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Add</button></div>', { wide: true });
    var ta = w.querySelector('#spec-template');
    ta.value = text; ta.scrollTop = 0;
    setTimeout(function () { try { ta.setSelectionRange(0, 0); ta.scrollTop = 0; } catch (e) { /* ignore */ } }, 0);
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      var t = w.querySelector('#spec-template').value;
      if (!t.trim()) { toast('Nothing to add'); return; }
      if (M.specSplit(t).length && !M.specSplit(t)[0].heading) t = '# Overview\n' + t;
      var recs = M.specSave(p, null, t, me());
      if (specRefuseLong(recs)) return;
      p.spec = p.spec || {};
      recs.forEach(function (r) { p.spec[r.id] = r; });
      touch(p); closeSheet();
      ui.view = 'spec'; saveUi(); renderPage(); syncSoon();
      toast('Added ' + plural(recs.length, 'section'));
    });
  }
  // A new requirement from a sentence: draft, its text the sentence without the flag, the section
  // and date as its source; the sentence then links to it.
  function specMakeReq(sec, start) {
    var p = current(); if (!p) return;
    var a = M.specAnalysis(p), f = specFind(a, sec, start); if (!f) return;
    if (f.u.broken) { toast('A mark in this sentence didn’t parse. Fix it with Edit section first.'); return; }
    p.reqs = p.reqs || {};
    var q = M.newReq(p, { text: f.u.text, source: SPEC_LABEL + ': ' + (f.x.sec.title || 'Untitled') + ', ' + M.now().slice(0, 10) }, me());
    p.reqs[q.id] = q;
    specUnitEdit(p, sec, start, 'link', q.id);
    selected = specSelKey(sec, start);
    $('#inspector').classList.add('open');
    renderPage(); renderInspector(); renderToolbar(); syncSoon();
    toast(q.ref + ' added as a draft');
  }
  // A flagged sentence that changes a requirement the section already links: link it, mark the
  // requirement Changed (approved ones need approving again), and put the sentence in its discussion.
  function specChangeReq(sec, start, reqId) {
    var p = current(); if (!p) return;
    var a = M.specAnalysis(p), f = specFind(a, sec, start), q = reqOf(p, reqId); if (!f || !q) return;
    if (f.u.broken) { toast('A mark in this sentence didn’t parse. Fix it with Edit section first.'); return; }
    var text = f.u.text;
    specUnitEdit(p, sec, start, 'link', reqId);
    if (q.status === 'approved') p.reqs[reqId] = M.stamp(Object.assign({}, q, { status: 'changed' }), me());
    var cid = M.uid(C.ids.comment || 'c');
    p.comments[cid] = M.stamp({ id: cid, item: reqId, author: me(), at: M.now(), text: 'From ' + SPEC_LABEL + ' (' + (f.x.sec.title || 'Untitled') + '): ' + text }, me());
    touch(p); renderPage(); renderToolbar(); syncSoon();
    toast(q.ref + (q.status === 'approved' ? ' marked Changed; ' : ': ') + 'the note is in its discussion');
  }
  // A comment flagged @req: make a draft requirement from it (traced to the check it's on), mark the
  // requirement it's on Changed, or just drop the flag. Each way the comment is marked handled.
  function specCommentTag(op, cid) {
    var p = current(), c = p && p.comments[cid]; if (!c) return;
    var text = M.specPlain(c.text), q = reqOf(p, c.item);
    if (op === 'make') {
      var links = c.item && checkIdx(p)[c.item] ? [c.item] : [];
      var nq = M.newReq(p, { text: text, source: 'Comment by ' + (c.author || '?') + ', ' + String(c.at || M.now()).slice(0, 10), links: links }, me());
      p.reqs = p.reqs || {}; p.reqs[nq.id] = nq;
      toast(nq.ref + ' added as a draft' + (links.length ? ', traced to that check' : ''));
    } else if (op === 'change' && q) {
      if (q.status === 'approved') p.reqs[q.id] = M.stamp(Object.assign({}, q, { status: 'changed' }), me());
      toast(q.ref + (q.status === 'approved' ? ' marked Changed' : '') + '; the comment is in its discussion');
    }
    p.comments[cid] = M.stamp(Object.assign({}, c, { reqDone: true }), me());
    touch(p); renderPage(); renderToolbar(); syncSoon();
  }
  // The description on paper: the report overlay (whose print styles show only it), with the
  // document at full text and the requirements it describes.
  function specPrint(p) {
    var a = M.specAnalysis(p), m = p.meta;
    var body = a.sections.map(function (x) {
      var hn = 'h' + Math.min(5, x.sec.level + 1);
      return '<section class="spec-sec lv-' + x.sec.level + '"><div class="spec-h"><' + hn + '>' + esc(x.sec.title || 'Untitled') + '</' + hn + '>' + (x.sec.kind ? '<span class="chip spec-kind">' + esc(x.sec.kind) + '</span>' : '') + '</div>' +
        specBlocksHtml(p, a, x).replace(/ data-act="[^"]*"/g, '') + '</section>';
    }).join('');
    var reqs = M.liveReqs(p).filter(function (q) { return q.status !== 'deprecated'; });
    var table = reqs.length ? '<h2 style="margin-top:28px">Requirements</h2><table class="table"><thead><tr><th>ID</th><th>Requirement</th><th>Described in</th></tr></thead><tbody>' + reqs.map(function (q) {
      var where = (a.uses[q.id] || []).map(function (w) { return a.ctx.secs[w.sec].title; }).filter(function (t, i, all) { return all.indexOf(t) === i; });
      return '<tr><td>' + esc(q.ref) + '</td><td>' + esc(q.text) + '</td><td>' + esc(where.join(', ') || 'Not described') + '</td></tr>';
    }).join('') + '</tbody></table>' : '';
    var r = $('#report');
    r.innerHTML = '<div class="report-bar"><b>' + esc(SPEC_LABEL) + '</b><div style="display:flex;gap:8px"><button class="btn" data-act="close-report">Close</button><button class="btn btn-primary" data-act="print">Print / Save PDF</button></div></div>' +
      '<div class="paper spec-paper"><h1>' + esc(m.name) + '</h1><div style="color:#515154;margin-bottom:18px">' + esc([SPEC_LABEL, m.project, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).join(' · ')) + '</div>' + body + table + '</div>';
    r.hidden = false;
  }
  function specDescribe(anchor, reqId) {
    var p = current(), q = reqOf(p, reqId); if (!q) return;
    var secs = M.liveSpec(p);
    if (!secs.length) { toast('Add a section first'); return; }
    menu(anchor, secs.slice(0, 40).map(function (s) { return [s.id, new Array(s.level).join(' ') + (s.title || 'Untitled')]; })).then(function (id) {
      var cur = (p.spec || {})[id]; if (!cur) return;
      var body = String(cur.body || '').replace(/\s+$/, '');
      var line = '[' + (q.text || q.ref).replace(/[\[\]{}]/g, '') + ']{q:' + q.id + '}';
      specPut(p, id, { body: (body ? body + '\n\n' : '') + line });
      var a = M.specAnalysis(p), w = (a.uses[q.id] || [])[0];
      if (w) specOpenUnit(w.sec, w.start); else renderPage();
      syncSoon();
      toast('Added to ' + (cur.title || 'the section') + '. Rewrite it as prose with Edit section.');
    });
  }

  // Overview card next to the checklists.
  function reqsCard(p) {
    var st = M.reqStats(p), idx = checkIdx(p);
    var failing = M.liveReqs(p).filter(function (q) { return reqFailing(q, idx); }).length;
    var atRisk = M.liveReqs(p).filter(function (q) { return reqAtRisk(q, idx); }).length;
    var pct = st.total ? Math.round(100 * st.pass / st.total) : 0;
    return '<button class="card cl-card" data-act="view" data-view="reqs">' +
      '<div class="cl-card-top"><div><div class="cl-card-title">Requirements</div><div class="cl-card-desc">' +
      (st.total ? 'What this ' + W.thing + ' must do, how each is verified, and the checks that show it.' : 'None yet. List what this ' + W.thing + ' must do and trace each to the checks that prove it.') +
      '</div></div>' + ring(pct, 46, 5, pct, '') + '</div>' +
      '<div class="bar"><i class="b-pass" style="width:' + (st.total ? 100 * st.pass / st.total : 0) + '%"></i><i class="b-issue" style="width:' + (st.total ? 100 * st.fail / st.total : 0) + '%"></i></div>' +
      '<div class="cl-card-foot"><span><b>' + st.pass + '</b>/' + st.total + ' verified</span>' +
      (atRisk ? '<span style="color:var(--issue)"><b>' + atRisk + '</b> at risk</span>' : '') +
      (failing ? '<span style="color:var(--issue)"><b>' + failing + '</b> failing</span>' : '') +
      (st.total && st.unlinked ? '<span>' + st.unlinked + ' not traced</span>' : '') + '</div></button>';
  }

  function reqsReport(p) {
    var all = M.liveReqs(p);
    if (!all.length) return '';
    var idx = checkIdx(p), st = M.reqStats(p, idx);
    return '<h2>Requirements</h2><p class="r-cmt" style="margin:0 0 8px">' + plural(st.total, 'requirement') + ', ' + st.approved + ' approved, ' + st.pass + ' verified' + (st.risk ? ', ' + st.risk + ' at risk' : '') + (st.fail ? ', ' + st.fail + ' failed' : '') +
      (st.deprecated ? '; ' + st.deprecated + ' deprecated, kept for reference' : '') + '.</p>' +
      '<table><thead><tr><th>ID</th><th>Requirement</th><th>Verify by</th><th>Status</th><th>Verified</th><th>Traced checks</th></tr></thead><tbody>' +
      all.map(function (q) {
        var t = M.reqTrace(q, idx);
        if (q.status === 'deprecated') {
          return '<tr style="color:#86868b"><td><s>' + esc(q.ref) + '</s></td><td><s>' + esc(q.text) + '</s></td><td></td><td>Deprecated</td><td></td><td></td></tr>';
        }
        return '<tr><td>' + esc(q.ref) + '</td><td>' + esc(q.text) + (q.source ? '<div class="r-cmt">' + esc(q.source) + '</div>' : '') + (q.evidence ? '<div class="r-cmt">Evidence: ' + esc(q.evidence) + '</div>' : '') + '</td>' +
          '<td>' + REQ_LABEL[q.method] + '</td><td>' + REQ_LABEL[q.status] + '</td><td>' + REQ_LABEL[q.verify] + '</td>' +
          '<td>' + (t.state === 'none' ? 'None' : t.pass + ' pass' + (t.issue ? ', ' + t.issue + ' issue' : '') + (t.open ? ', ' + t.open + ' to review' : '')) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  // ── Sheets ───────────────────────────────────────────────
  function sheet(html, opts) {
    closeSheet();
    var wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.id = 'sheet';
    wrap.innerHTML = '<div class="sheet' + (opts && opts.wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap && !(opts && opts.sticky)) closeSheet(); });
    document.body.appendChild(wrap);
    var first = wrap.querySelector('input:not([type=checkbox]),textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
    return wrap;
  }
  function closeSheet() { var s = $('#sheet'); if (s) s.remove(); }

  // preset (a new review only): fields to start from, and plPart, the Signoff PL Part it's started from.
  function projectSheet(p, preset) {
    var editing = !!p;
    var contractors = M.liveUsers(roster).filter(M.isOutside);   // clients and contractors
    var defaults = C.defaultChecklists || TEMPLATES.map(function (t) { return t.id; });
    // A new review starts in the project of the one that's open, the usual next step.
    var cur = !p && current();
    var m = p ? p.meta : { name: (preset && preset.name) || '', project: preset ? preset.project || '' : (cur && cur.meta.project) || '', client: preset ? '' : (cur && cur.meta.client) || '', board: (preset && preset.board) || '', revision: '', stage: C.defaultStage, description: '', profile: [], checklists: TEMPLATES.map(function (t) { return t.id; }).filter(function (id) { return defaults.indexOf(id) >= 0; }).concat(['reqs']) };
    var reqsPicked = p ? reqsOn(p) : true;
    // Scribe, where the tool offers it: off for a new review unless config.spec.default.
    var specPicked = p ? specOn(p) : !!(SPEC && SPEC.default), specCount = p && SPEC ? M.liveSpec(p).length : 0;
    var reqCount = p ? M.liveReqs(p).length : 0;
    // Projects and clients already in use, offered as suggestions so a product's reviews group.
    var known = { project: {}, client: {} };
    visibleProjects().forEach(function (d) { ['project', 'client'].forEach(function (k) { var v = String(d.meta[k] || '').trim(); if (v) known[k][v] = 1; }); });
    function options(k) { return Object.keys(known[k]).sort().map(function (v) { return '<option value="' + esc(v) + '">'; }).join(''); }
    var from = !editing && preset && preset.from;
    var w = sheet('<div class="sheet-head"><h2>' + (editing ? cap(UNIT) + ' details' : 'New design review') + '</h2><p>' + (editing ? 'Changes sync to everyone on this ' + UNIT + '.' : (from ? esc('Started from ' + from.projectName + '’s Part in Signoff PL' + (from.path.length ? ' (' + from.path.join(' › ') + ')' : '') + '. PL links the Part to this review at its next sync. ') : '') + 'Pick the checklists and describe the ' + W.thing + '. Checks that don’t fit its profile are set aside as N/A, and you can still bring any of them back.') + '</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field"><label for="f-name">' + cap(UNIT) + ' name</label><input class="input" id="f-name" value="' + esc(m.name) + '" placeholder="' + esc(W.namePlaceholder) + '" maxlength="120"></div>' +
      '<div class="row2"><div class="field"><label for="f-project">Project</label><input class="input" id="f-project" list="f-project-list" value="' + esc(m.project || '') + '" placeholder="The product it belongs to, e.g. Smart Thermostat" maxlength="80"><datalist id="f-project-list">' + options('project') + '</datalist></div>' +
      '<div class="field"><label for="f-client">Client</label><input class="input" id="f-client" list="f-client-list" value="' + esc(m.client) + '" placeholder="Optional"><datalist id="f-client-list">' + options('client') + '</datalist></div></div>' +
      // Part or assembly, where the tool reviews both (config.assemblies, Signoff ME): meta.kind.
      (C.assemblies ? '<div class="field"><span class="field-label">This ' + UNIT + ' is</span><div class="seg" id="f-kind" role="group" aria-label="Part or assembly">' +
        [['', 'A single part'], ['assembly', 'An assembly']].map(function (k) { return '<button type="button" data-kind="' + k[0] + '" aria-pressed="' + ((m.kind === 'assembly' ? 'assembly' : '') === k[0]) + '"' + ((m.kind === 'assembly' ? 'assembly' : '') === k[0] ? ' class="on"' : '') + '>' + k[1] + '</button>'; }).join('') + '</div></div>' : '') +
      '<div class="row2">' +
      '<div class="field"><label for="f-board">' + esc(W.number) + '</label><input class="input" id="f-board" value="' + esc(m.board) + '" placeholder="' + esc(W.numberPlaceholder) + '"></div>' +
      '<div class="field"><label for="f-rev">Revision</label><input class="input" id="f-rev" value="' + esc(m.revision) + '" placeholder="e.g. 03"></div></div>' +
      '<div class="field"><label for="f-stage">Stage</label><select class="input" id="f-stage">' + M.STAGES.map(function (s) { return '<option' + (s === m.stage ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="f-desc">Scope / notes</label><textarea class="input" id="f-desc" placeholder="What is being reviewed, which documents, anything reviewers should know">' + esc(m.description) + '</textarea></div>' +
      '<div class="field"><span class="field-label">Checklists</span><div class="pick-grid" id="f-checklists">' +
      '<button type="button" class="pick' + (reqsPicked ? ' on' : '') + '" data-pick="reqs"><b>Requirements</b><span>' +
      (reqCount ? plural(reqCount, 'requirement') : 'Your own list, traced to checks') + '</span></button>' +
      (SPEC ? '<button type="button" class="pick' + (specPicked ? ' on' : '') + '" data-pick="spec"><b>' + esc(SPEC_LABEL) + '</b><span>' +
        (specCount ? plural(specCount, 'section') : 'What it does, in words and a diagram, tied to requirements') + '</span></button>' : '') +
      TEMPLATES.map(function (t) {
        var n = 0; t.sections.forEach(function (s) { n += s.items.length; });
        return '<button type="button" class="pick' + (m.checklists.indexOf(t.id) >= 0 ? ' on' : '') + '" data-pick="' + t.id + '"><b>' + esc(t.short) + '</b><span>' + n + ' checks</span></button>';
      }).join('') + '</div></div>' +
      '<div class="field"><span class="field-label">' + esc(W.profile) + ' — select everything that applies</span><div class="pick-grid" id="f-profile">' + M.TAGS.map(function (t) {
        return '<button type="button" class="pick' + (m.profile.indexOf(t.id) >= 0 ? ' on' : '') + '" data-pick="' + t.id + '"><b>' + esc(t.label) + '</b><span>' + esc(t.desc) + '</span></button>';
      }).join('') + '</div><p class="note" id="f-count"></p></div>' +
      (!DEMO && contractors.length ? '<div class="field"><span class="field-label">Clients and contractors on this ' + UNIT + ' \u2014 ' + (editing && M.sharedRepo(roster, p.id) ? 'shared as ' + esc(M.sharedRepo(roster, p.id)) : 'adding one moves it into its own private repository') + '</span><div class="pick-grid" id="f-people">' + contractors.map(function (u) {
        return '<button type="button" class="pick' + (editing && (u.projects || []).indexOf(p.id) >= 0 ? ' on' : '') + '" data-pick="' + esc(u.login) + '"><b>' + esc(u.name || u.login) + '</b><span>@' + esc(u.login) + '</span></button>';
      }).join('') + '</div></div>' : '') +
      '</div><div class="sheet-foot">' +
      (editing ? '<button class="btn btn-danger" data-sheet="archive">' + (m.archived ? 'Unarchive' : 'Archive') + '</button><span class="spacer"></span>' : '') +
      '<button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">' + (editing ? 'Save' : 'Create review') + '</button></div>', { wide: true });

    function picked(id) { return Array.prototype.map.call(w.querySelectorAll('#' + id + ' .pick.on'), function (b) { return b.dataset.pick; }); }
    function updateCount() {
      var profile = picked('f-profile'), lists = picked('f-checklists'), total = 0, apply = 0;
      TEMPLATES.forEach(function (t) {
        if (lists.indexOf(t.id) < 0) return;
        t.sections.forEach(function (s) { s.items.forEach(function (it) { total++; if (M.applies(s.tags, profile) && M.applies(it.tags, profile)) apply++; }); });
      });
      w.querySelector('#f-count').textContent = apply + ' of ' + total + ' checks apply to this profile.';
    }
    updateCount();
    w.addEventListener('click', function (e) {
      var pk = e.target.closest('.pick');
      if (pk) { pk.classList.toggle('on'); updateCount(); return; }
      var kb = e.target.closest('#f-kind button');
      if (kb) { Array.prototype.forEach.call(w.querySelectorAll('#f-kind button'), function (x) { x.classList.toggle('on', x === kb); x.setAttribute('aria-pressed', String(x === kb)); }); return; }
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      if (b.dataset.sheet === 'archive') { updateMeta({ archived: !m.archived }); closeSheet(); toast(m.archived ? cap(UNIT) + ' restored' : cap(UNIT) + ' archived'); syncSoon(); return; }
      var name = w.querySelector('#f-name').value.trim();
      if (!name) { w.querySelector('#f-name').focus(); return; }
      var fields = {
        name: name, project: w.querySelector('#f-project').value.trim(), client: w.querySelector('#f-client').value.trim(), board: w.querySelector('#f-board').value.trim(),
        revision: w.querySelector('#f-rev').value.trim(), stage: w.querySelector('#f-stage').value,
        description: w.querySelector('#f-desc').value.trim(), profile: picked('f-profile'), checklists: picked('f-checklists')
      };
      if (!fields.checklists.length) { toast('Pick at least one checklist'); return; }
      // meta.kind is stored only for an assembly; a part leaves it out (undefined isn't written).
      if (C.assemblies) { var kon = w.querySelector('#f-kind button.on'); fields.kind = kon && kon.dataset.kind === 'assembly' ? 'assembly' : undefined; }
      var people = w.querySelector('#f-people') ? picked('f-people') : null;
      function assign(projectId) {
        if (!people) return;
        var adds = [], drops = [];
        contractors.forEach(function (u) {
          var has = (u.projects || []).indexOf(projectId) >= 0, want = people.indexOf(u.login) >= 0;
          if (has === want) return;
          setPerson(u.login, { projects: want ? (u.projects || []).concat([projectId]) : u.projects.filter(function (x) { return x !== projectId; }) });
          (want ? adds : drops).push(u.login);
        });
        if (!adds.length && !drops.length) return;
        var share = adds.length && !M.sharedRepo(roster, projectId);
        if (!getToken()) { toast('Saved. GitHub access is applied once you sync.'); return; }
        // Removals always go through, so a removed contractor's copy goes at their next sync;
        // only invitations (which email people) ask first.
        if (adds.length && !confirm((share ? 'Move this ' + UNIT + ' into its own private repository and invite ' : 'Invite ') + adds.join(', ') + '?\n\nGitHub emails the invitations.')) {
          adds = []; share = false;
          if (!drops.length) return;
        }
        setTimeout(function () {
          runAccessOps('Updating who can open this ' + UNIT, adds.map(function (l, i) { return { login: l, share: share && i === 0 ? [projectId] : [], invite: share ? [] : [projectId] }; })
            .concat(drops.map(function (l) { return { login: l, revoke: [projectId] }; })));
        }, 0);
      }
      // Requirements is chosen like a checklist; from now on that choice is explicit.
      fields.reqsDecided = true;
      if (SPEC) fields.specDecided = true;
      if (editing) { assign(p.id); updateMeta(fields); closeSheet(); syncSoon(); return; }
      var doc = M.newProject(fields, me(), TEMPLATES);
      if (fields.kind === 'assembly') doc.meta.kind = 'assembly';
      doc.meta.reqsDecided = true;
      if (SPEC) doc.meta.specDecided = true;
      if (from) doc.meta.plPart = { project: preset.plPart.project, node: preset.plPart.node, at: M.now() };   // at: PL's tie-break
      // A new review with Scribe picked starts from the tool's template (config.spec.template).
      if (SPEC && SPEC.template && M.specEnabled(doc)) {
        doc.spec = {};
        M.specSave(doc, null, M.specTemplate(doc), me()).forEach(function (r) { doc.spec[r.id] = r; });
      }
      var slug = doc.slug, n = 2;
      while (projects[slug]) slug = doc.slug + '-' + n++;
      doc.slug = slug;
      projects[slug] = doc;
      ui.slug = slug; ui.view = 'overview'; ui.page = '';
      assign(doc.id);
      touch(doc); saveUi(); closeSheet(); render();
      toast('Review created'); syncSoon();
    });
  }

  // first: the demo's first opening, which welcomes the visitor and asks only for a name.
  function settingsSheet(first) {
    var token = getToken();
    var remembered = false;
    try { remembered = !!localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    var welcome = DEMO && first;
    var auth = signIn();   // Sign in with GitHub: hides the token field while signed in
    var viaSignIn = !!(auth && auth.signedIn);
    var userName = settings.user || (viaSignIn ? auth.name || auth.login : '');
    var w = sheet('<div class="sheet-head"><h2>' + (welcome ? 'Welcome to the ' + esc(C.product) + ' demo' : 'Settings') + '</h2><p>' +
      (welcome ? 'A made-up product, a Smart Thermostat for Acme Climate, part way through its design reviews. Open a checklist, mark checks Pass, Issue, or N/A, and comment on what you find. ' +
        'Everything stays in this browser, and <b>Reset demo</b> in the banner starts over. Your name goes on what you change.'
      : DEMO ? 'Your name goes on the comments and changes you make in this demo. Everything stays in this browser.' : 'Your name goes on comments and changes. Reviews sync through private GitHub repositories, so everyone works on the same copy.') + '</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field"><label for="s-user">Your name</label><input class="input" id="s-user" value="' + esc(userName) + '" placeholder="First Last"></div>' +
      (welcome ? '' : '<div class="field"><span class="field-label">Appearance</span><div class="seg full" id="s-theme">' + [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(function (t) {
        return '<button type="button" class="' + (settings.theme === t[0] ? 'on' : '') + '" data-theme="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>') +
      (welcome ? '' : DEMO ? '<p class="note">Git sync is off in demo mode. <a href="' + esc(location.pathname) + '">Open the full tool</a>.</p>' :
        '<div class="field-label" style="margin-top:20px;font-size:13px;color:var(--text);font-weight:600">Signoff Repository Access</div>' +
        (viaSignIn || settings.login ? '<p class="note" style="margin:0 0 12px">Signed in ' + (viaSignIn ? 'with GitHub ' : '') + 'as <b>' + esc(viaSignIn ? '@' + auth.login : settings.login) + '</b> · ' +
          (dataAccess === 'none' ? 'Client or contractor: you see the ' + UNITS + ' shared with you' : dataAccess === 'ok' ? 'FTE: you see every ' + UNIT : 'not synced yet') + '</p>' : '') +
        (viaSignIn ? '' : signInBlock(auth, token)) +
        '<div class="log" id="s-log" hidden></div>' +
        '<details class="guide" style="margin-top:14px"><summary>Repositories</summary>' +
        '<div class="row2" style="margin-top:10px"><div class="field"><label for="s-owner">Account or organization</label><input class="input" id="s-owner" value="' + esc(settings.owner) + '"></div>' +
        '<div class="field"><label for="s-branch">Branch</label><input class="input" id="s-branch" value="' + esc(settings.branch) + '"></div></div>' +
        '<div class="row2"><div class="field"><label for="s-data">Data repo (FTEs)</label><input class="input" id="s-data" value="' + esc(settings.dataRepo) + '"></div>' +
        '<div class="field"><label for="s-tool">Tool repo (FTEs)</label><input class="input" id="s-tool" value="' + esc(settings.toolRepo) + '"></div></div>' +
        '<div class="field"><label for="s-prefix">Shared review repos start with</label><input class="input" id="s-prefix" value="' + esc(settings.prefix) + '"></div>' +
        (settings.suiteRepos.length ? '<p class="note">FTEs are also invited to the rest of the suite: ' + settings.suiteRepos.map(esc).join(', ') + ', and every repo starting ' + settings.sharedPrefixes.map(esc).join(', ') + ' (set in assets/config.js).</p>' : '') + '</details>') +
      '</div><div class="sheet-foot">' + (DEMO ? '' : '<button class="btn" data-sheet="test">Test connection</button><button class="btn" data-sheet="signout" title="' + (viaSignIn ? 'Sign out of GitHub here, and remove' : 'Remove the token and') + ' every Signoff and Fabcheck copy kept in this browser">Sign out</button>') + '<span class="spacer"></span>' +
      '<button class="btn" data-sheet="cancel">' + (welcome ? 'Skip' : 'Cancel') + '</button><button class="btn btn-primary" data-sheet="ok">' + (welcome ? 'Start' : DEMO ? 'Done' : 'Save & sync') + '</button></div>');

    var theme = settings.theme;
    function read() {
      var s = Object.assign({}, settings, { user: w.querySelector('#s-user').value.trim(), theme: theme });
      if (!DEMO) {
        s.owner = w.querySelector('#s-owner').value.trim(); s.branch = w.querySelector('#s-branch').value.trim() || 'main';
        s.dataRepo = w.querySelector('#s-data').value.trim(); s.toolRepo = w.querySelector('#s-tool').value.trim();
        s.prefix = w.querySelector('#s-prefix').value.trim() || C.repos.prefix;
      }
      return s;
    }
    function log(text, cls) { var l = w.querySelector('#s-log'); l.hidden = false; l.innerHTML += '<div class="' + (cls || '') + '">' + esc(text) + '</div>'; l.scrollTop = 1e6; }
    w.addEventListener('click', function (e) {
      var t = e.target.closest('#s-theme [data-theme]');
      if (t) { theme = t.dataset.theme; w.querySelectorAll('#s-theme button').forEach(function (b) { b.classList.toggle('on', b === t); }); applyTheme(theme); return; }
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') { applyTheme(settings.theme); return closeSheet(); }
      if (b.dataset.sheet === 'signout') return signOut();
      if (b.dataset.sheet === 'token') return toggleTokenPanel(b, w);
      var s = read();
      if (b.dataset.sheet === 'signin') {
        // Keep the name and repositories typed so far; the token comes back from GitHub.
        settings = s; save('settings', settings); saveSharedTheme(settings.theme);
        b.disabled = true;
        return startSignIn().catch(function (err) { b.disabled = false; log(err.message, 'err'); });
      }
      // Signed in with GitHub: the token is the sign-in's, never the (absent) token field's.
      var tokField = w.querySelector('#s-token');
      var tok = DEMO ? '' : tokField ? cleanToken(tokField.value) : getToken();
      if (b.dataset.sheet === 'test') {
        var ws = new S.Workspace(s, tok);
        log('Checking ' + (tokField ? 'your token' : 'your sign-in') + '…');
        ws.account.user().then(function (u) {
          log('Signed in as ' + u.login, 'ok');
          if (!w.querySelector('#s-user').value.trim()) w.querySelector('#s-user').value = u.name || u.login;
          return ws.dataStore().snapshot().then(function () { log('Data repo ' + ws.dataFull() + ': OK (FTE access)', 'ok'); },
            function () { log('Data repo ' + ws.dataFull() + ': no access (fine for contractors)'); });
        }).then(function () {
          return ws.account.listRepos(s.owner, s.prefix).then(function (names) { log(plural(names.length, 'shared review repo') + ' reachable', 'ok'); });
        }).then(function () {
          return ws.account.invitations().then(function (inv) { if (inv.length) log(plural(inv.length, 'invitation') + ' waiting — accept them after saving'); });
        }).catch(function (err) { log(err.message, 'err'); });
        return;
      }
      if (!s.user) { w.querySelector('#s-user').focus(); toast('Add your name so others know who commented'); return; }
      if (!DEMO) {
        // A different token or account may be a different person: start the identity over.
        if (tok !== getToken() || s.owner !== settings.owner || s.dataRepo !== settings.dataRepo) { s.login = ''; dataAccess = ''; save('dataAccess', dataAccess); accessMap = {}; }
        if (tokField) setToken(tok, w.querySelector('#s-remember').checked);
      }
      settings = s; save('settings', settings); saveSharedTheme(settings.theme);
      closeSheet(); render();
      if (!DEMO && tok) sync();
    });
  }

  // Sign in with GitHub (assets/auth.js), where this site has a GitHub App; null where it hasn't, and
  // the token field is then the only way in.
  function signIn() {
    var A = !DEMO && window.SignoffAuth;
    if (!A) return null;
    var s = A.status();
    return s.available || s.signedIn ? s : null;
  }
  function startSignIn() { return window.SignoffAuth.signIn(location.href); }

  // Settings' way in while signed out: the Sign in with GitHub button where it's set up, with the
  // token field folded under it; the token field and its guide alone where it isn't.
  function signInBlock(auth, token) {
    var remembered = false;
    try { remembered = !!localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    var tokenHtml =
      '<details class="guide"' + (getToken() || auth ? '' : ' open') + '><summary>New to GitHub? Set up in four steps</summary><ol>' +
        '<li>Create a free account at <a href="https://github.com/signup" target="_blank" rel="noopener">github.com/signup</a>.</li>' +
        '<li>Send your username to your Dovetail contact.</li>' +
        '<li><a href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Dovetail%20Signoff" target="_blank" rel="noopener">Create a token</a> (the link fills in the settings; pick an expiry and click <i>Generate token</i>).</li>' +
        '<li>Paste the token below and click <b>Save &amp; sync</b>. Signoff shows any invitations waiting for you, with an Accept button.</li></ol></details>' +
        '<div class="field"><label for="s-token">Access token</label><input class="input" id="s-token" type="password" value="' + esc(token) + '" placeholder="ghp_… or github_pat_…" autocomplete="off">' +
        '<p class="note">Kept in this browser and sent only to api.github.com. Collaborators use a classic token with the <b>repo</b> scope. The account owner can use a fine-grained token with <b>All repositories</b> and <b>Contents</b> and <b>Administration</b> set to read and write; sharing creates new repositories, which a token limited to selected repositories can’t reach.</p></div>' +
        '<label class="check"><input type="checkbox" id="s-remember"' + (remembered ? ' checked' : '') + '> Remember the token after closing the browser (avoid on shared computers)</label>';
    if (!auth) return tokenHtml;
    // The token is the second way in: a gray button beside Sign in that drops its panel down.
    var open = !!getToken();
    return '<div class="signin-row"><button type="button" class="btn btn-primary" data-sheet="signin">Sign in with GitHub</button>' +
      '<button type="button" class="btn token-toggle" data-sheet="token" aria-expanded="' + open + '" aria-controls="s-token-panel">Use a token instead</button></div>' +
      '<p class="note" style="margin:0 0 12px">Uses your GitHub login, with its two-factor step. No token to create or keep track of.</p>' +
      '<div class="token-panel" id="s-token-panel"' + (open ? '' : ' hidden') + '>' + tokenHtml + '</div>';
  }

  // Use a token instead: opens or closes the token panel under the sign-in row.
  function toggleTokenPanel(btn, root) {
    var panel = root.querySelector('#' + btn.getAttribute('aria-controls'));
    if (!panel) return;
    var open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { var f = panel.querySelector('input[type="password"]'); if (f && !f.value) f.focus(); }
  }

  // Sign out of this browser: the token goes, and so does every copy the suite keeps here
  // (Signoff EE, ME, FW, and PL working copies, PL's pictures and waiting model files, Fabcheck's
  // runs and packages). Only the theme stays.
  // Unsynced changes would be lost, so they're counted and named first.
  var SUITE_NS = ['signoff.v1.', 'signoff-me.v1.', 'signoff-fw.v1.', 'signoff-pl.v1.', 'fabcheck.v1.'];
  // IndexedDB: Fabcheck's runs, hand-offs, and PL's pictures and model files waiting to upload.
  var SUITE_DBS = ['fabcheck', 'dovetail-handoff', 'dovetail-handoff-demo', 'signoff-pl-pictures', 'signoff-pl-uploads', 'pincheck-runs'];
  function signOut() {
    var unsynced = 0;
    SUITE_NS.forEach(function (ns) {
      try { unsynced += Object.keys(JSON.parse(localStorage.getItem(ns + 'dirty') || '{}') || {}).length; } catch (e) { /* unreadable: nothing counted */ }
    });
    try { unsynced += Object.keys((JSON.parse(localStorage.getItem('signoff.v1.held') || '{}') || {}).projects || {}).length; } catch (e) { /* ignore */ }
    var ask = 'Sign out of this browser? This removes your GitHub token and every Signoff and Fabcheck copy kept here. Your reviews stay on GitHub.';
    if (unsynced) ask = plural(unsynced, UNIT + ' or list has', UNITS + ' or lists have') + ' changes that aren’t on GitHub yet and would be lost. Sync first unless you mean to throw them away.\n\n' + ask;
    if (!confirm(ask)) return;
    var theme = settings.theme;
    // A sign-in is revoked on GitHub first; the reload waits for it, or the request is cut off.
    var A = window.SignoffAuth;
    (A ? A.signOut() : Promise.resolve()).catch(function () { /* cleared below anyway */ }).then(function () {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
        Object.keys(localStorage).forEach(function (k) {
          if (k === TOKEN_KEY || k === 'signoff.login' || k.indexOf('signoff.auth') === 0 || SUITE_NS.some(function (ns) { return k.indexOf(ns) === 0; })) localStorage.removeItem(k);
        });
      } catch (e) { /* storage blocked */ }
      try { SUITE_DBS.forEach(function (db) { indexedDB.deleteDatabase(db); }); } catch (e) { /* no IndexedDB */ }
      saveSharedTheme(theme);
      location.reload();
    });
  }

  // A sheet that shows the steps of a multi-step GitHub operation.
  function progressSheet(title) {
    var w = sheet('<div class="sheet-head"><h2>' + esc(title) + '</h2></div><div class="sheet-body"><div class="log" id="op-log"></div></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn btn-primary" data-sheet="done" disabled>Done</button></div>', { sticky: true });
    w.querySelector('[data-sheet="done"]').addEventListener('click', closeSheet);
    return {
      log: function (text, cls) { var l = w.querySelector('#op-log'); if (!l) return; l.innerHTML += '<div class="' + (cls || '') + '">' + esc(text) + '</div>'; l.scrollTop = 1e6; },
      done: function () { var d = w.querySelector('[data-sheet="done"]'); if (d) d.disabled = false; }
    };
  }

  // ── People & access (FTEs only) ──────────────────────────
  // accessMap: 'owner/repo' -> { collaborators, invited } | { error }, loaded when People opens.
  var accessMap = {}, accessLoading = false;
  // Every tool's shared review repos (workspace.suiteShared), found when People & access is checked.
  var suiteShared = load('suiteShared', []), suiteListed = false;
  function allFteRepos() { return workspace().fteRepos(stateNow(), suiteShared); }
  // Another tool's shared repo: who's on it is that tool's business, except that FTEs belong on it.
  function otherToolsRepo(r) { return suiteShared.indexOf(r) >= 0 && repoName(r).indexOf(settings.prefix) !== 0; }

  function stateNow() {
    var byId = {};
    Object.keys(projects).forEach(function (k) { byId[projects[k].id] = projects[k]; });
    return { login: settings.login, projects: byId, roster: roster, homes: homes, cache: cache, dataAccess: dataAccess };
  }

  function loadAccess(force) {
    if (DEMO || !getToken() || accessLoading) return;
    var ws = workspace();
    if (suiteListed && !force && !allFteRepos().some(function (r) { return !accessMap[r]; })) return;
    accessLoading = true;
    // The other tools' shared repos first (once a page, or on Refresh), so the FTE list is whole; the
    // last list is kept if listing fails.
    var listed = suiteListed && !force ? Promise.resolve() : ws.suiteShared().then(function (list) { suiteShared = list; save('suiteShared', suiteShared); }, function () { /* keep the last list */ });
    suiteListed = true;
    listed.then(function () {
      var repos = allFteRepos().filter(function (r) { return force || !accessMap[r]; });
      return Promise.all(repos.map(function (r) {
        return ws.access(r).then(function (a) { accessMap[r] = a; }, function (err) {
          accessMap[r] = { error: err.status === 403 || err.status === 404 ? 'needs an admin token' : err.message };
        });
      }));
    }).then(function () { accessLoading = false; if (peopleShown()) renderPage(); });
  }

  function repoName(full) { return full.split('/')[1]; }
  // For one person: the repos they should be on and aren't, and the ones with an invite pending.
  function accessGaps(u) {
    var ws = workspace(), want;
    if (u.role === 'fte') want = ws.fteRepos(stateNow(), suiteShared);
    else want = (u.projects || []).map(function (id) { return M.sharedRepo(roster, id); }).filter(Boolean);
    var missing = [], pending = [], unknown = false;
    want.forEach(function (r) {
      var a = accessMap[r];
      if (!a || a.error) { unknown = true; return; }
      if (a.collaborators.indexOf(u.login) >= 0) return;
      (a.invited.indexOf(u.login) >= 0 ? pending : missing).push(r);
    });
    var unshared = M.isOutside(u) ? (u.projects || []).filter(function (id) { return !M.sharedRepo(roster, id); }) : [];
    // A contractor still on (or invited to) a repo they aren't meant to be on, e.g. after
    // being taken off a project when the access change didn't go through.
    var extra = M.isOutside(u) ? Object.keys(accessMap).filter(function (r) {
      var a = accessMap[r];
      return a && !a.error && want.indexOf(r) < 0 && !otherToolsRepo(r) && (a.collaborators.indexOf(u.login) >= 0 || a.invited.indexOf(u.login) >= 0);
    }) : [];
    return { want: want, missing: missing, pending: pending, unknown: unknown, unshared: unshared, extra: extra };
  }

  function accessCell(u) {
    if (u.login === String(settings.owner).toLowerCase()) return '<span class="res fixed">Owner</span>';
    if (!getToken()) return '<span class="muted">Sync to check</span>';
    if (accessLoading) return '<span class="muted">Checking…</span>';
    var g = accessGaps(u);
    if (g.unknown && !g.missing.length) return '<span class="muted">Only the owner can see this</span>';
    var parts = [];
    if (g.missing.length || g.unshared.length) {
      parts.push('<span class="res open">' + (g.missing.length ? 'Not on ' + g.missing.map(repoName).join(', ') : plural(g.unshared.length, UNIT, UNITS) + ' not shared yet') + '</span>');
      parts.push('<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="fix-access" data-login="' + esc(u.login) + '">Give access</button>');
    }
    if (g.pending.length) parts.push('<span class="res waived">Invite pending' + (g.pending.length > 1 ? ' ×' + g.pending.length : '') + '</span>');
    if (g.extra.length) {
      parts.push('<span class="res open">Still on ' + g.extra.map(repoName).map(esc).join(', ') + '</span>');
      parts.push('<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="trim-access" data-login="' + esc(u.login) + '">Remove access</button>');
    }
    if (!parts.length) parts.push('<span class="res fixed">' + (u.role === 'fte' ? 'All repos' : g.want.length ? 'Has access' : 'No ' + UNITS) + '</span>');
    return parts.join(' ');
  }

  // People & access opens as a sheet over the page (signoff/assets/people.js), with this tool's
  // tab drawn here and the other tools' tabs framed. Without people.js it can't open.
  function openPeople() {
    if (!PEOPLE) return;
    closeInspector(); $('#app').classList.remove('nav-open');
    PEOPLE.open();
  }
  function peopleShown() { return EMBED || !!(PEOPLE && PEOPLE.pane(C.repos.toolRepo)); }
  function drawPeople() {
    var el = PEOPLE && PEOPLE.pane(C.repos.toolRepo);
    if (!el) return;
    var top = el.scrollTop;
    el.innerHTML = peopleOrNotice();
    el.scrollTop = top;
  }
  // Only FTEs see People; anyone else (in a frame from another tool) is told why.
  function peopleOrNotice() {
    if (isFte() && !DEMO) return peoplePage();
    var role = myRole(), here = esc(C.product);
    var msg = role === 'signedout' ? ['Sign in to ' + here, 'Add your GitHub token in ' + here + '’s Settings to manage who can open its ' + UNITS + '.']
      : role === 'checking' ? ['Checking access…', 'Seeing whether your token can open <b>' + esc(settings.dataRepo) + '</b>.']
      : ['Only FTEs manage ' + here + '’s people', 'Your token can’t open <b>' + esc(settings.dataRepo) + '</b>, so this list isn’t yours to change.'];
    return '<div class="page"><div class="empty"><h2>' + msg[0] + '</h2><p>' + msg[1] + '</p>' +
      (role === 'checking' || !EMBED ? '' : '<p><a class="btn" href="' + esc(location.pathname) + '" target="_top">Open ' + here + '</a></p>') + '</div></div>';
  }

  var ROLES = [['fte', 'FTE'], ['client', 'Client'], ['contractor', 'Contractor']];
  function peoplePage() {
    loadAccess(false);
    var people = M.liveUsers(roster);
    var byId = stateNow().projects;
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">People &amp; access · ' + esc(settings.owner) + '</div><h1 class="page-title">' + esc(C.product) + '</h1>' +
      '<div class="page-sub"><span>FTEs can open every ' + UNIT + '. Clients and contractors can open only the ' + UNITS + ' shared with them, each in its own private repository.</span></div></div>' +
      '<div style="display:flex;gap:8px"><button class="btn" data-act="refresh-access">Refresh</button><button class="btn btn-primary" data-act="add-person">Add person</button></div></div>';
    if (!isOwner()) {
      html += '<div class="card" style="padding:14px 18px;margin-bottom:14px;font-size:13.5px">Only <b>' + esc(settings.owner) + '</b> can create review repositories and invite people while the repos are in a personal account. You can still edit this list; the owner applies the access.</div>';
    }
    if (!people.length) {
      html += '<div class="card" style="padding:18px 20px;margin-bottom:14px"><b>No one is listed yet.</b> Add yourself and the other FTEs first, then clients and contractors.' +
        (settings.login ? ' <button class="btn btn-plain" data-act="add-self">Add me (' + esc(settings.login) + ') as FTE</button>' : '') + '</div>';
    } else {
      html += '<div class="card table-scroll"><table class="table people"><thead><tr><th>Person</th><th>Role</th><th>' + cap(UNITS) + '</th><th>GitHub access</th><th></th></tr></thead><tbody>' +
        people.map(function (u) {
          var projs = u.role === 'fte' ? '<span class="muted">All ' + UNITS + '</span>' :
            ((u.projects || []).map(function (id) { return byId[id] ? '<span class="chip">' + esc(byId[id].meta.name) + '</span>' : ''; }).join(' ') || '<span class="muted">None yet</span>') +
            ' <button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="person-projects" data-login="' + esc(u.login) + '">Edit</button>';
          return '<tr><td><div style="display:flex;gap:10px;align-items:center">' + avatar(u.name || u.login) + '<div><div>' + esc(u.name || u.login) + (u.login === settings.login ? ' <span class="muted">(you)</span>' : '') + '</div><div class="muted">@' + esc(u.login) + '</div></div></div></td>' +
            '<td><div class="seg">' + ROLES.map(function (r) {
              return '<button class="' + (u.role === r[0] ? 'on' : '') + '" data-act="person-role" data-login="' + esc(u.login) + '" data-role="' + r[0] + '">' + r[1] + '</button>';
            }).join('') + '</div></td>' +
            '<td style="max-width:300px">' + projs + '</td>' +
            '<td style="max-width:260px">' + accessCell(u) + '</td>' +
            '<td><button class="cmt-del" style="opacity:1" data-act="remove-person" data-login="' + esc(u.login) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var sharedIds = Object.keys(roster.shared || {}).filter(function (id) { return M.sharedRepo(roster, id); });
    if (sharedIds.length) {
      html += '<div class="section-title">Shared review repositories</div><div class="card table-scroll"><table class="table people"><thead><tr><th>' + cap(UNIT) + '</th><th>Repository</th><th>Clients and contractors</th></tr></thead><tbody>' +
        sharedIds.map(function (id) {
          var repo = M.sharedRepo(roster, id), p = byId[id];
          var names = assignedContractors(id).map(function (u) { return esc(u.name || u.login); }).join(', ') || '<span class="muted">None</span>';
          return '<tr><td>' + esc(p ? p.meta.name : roster.shared[id].name || id) + '</td><td><a href="https://github.com/' + esc(repo) + '" target="_blank" rel="noopener">' + esc(repo) + '</a></td><td>' + names + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '<p class="note" style="margin-top:14px">Internal ' + UNITS + ' live in <b>' + esc(settings.dataRepo) + '</b>, which only FTEs can open. ' +
      'Adding a client or contractor to a ' + UNIT + ' moves it into its own private <b>' + esc(settings.prefix) + '…</b> repository and invites them to that one repository only. ' +
      (settings.suiteRepos.length ? 'FTEs are also invited to ' + settings.suiteRepos.map(function (r) { return '<b>' + esc(r) + '</b>'; }).join(', ') + ', and every tool’s shared repos (' + settings.sharedPrefixes.map(function (p) { return '<b>' + esc(p) + '…</b>'; }).join(', ') + '). ' : '') +
      'On a personal account every collaborator can push to the repositories they’re on; an organization allows narrower roles.</p></div>';
    return html;
  }

  function personSheet(login) {
    var u = login ? roster.users[login] : null;
    var list = visibleProjects().filter(function (p) { return !p.meta.archived; }).sort(function (a, b) { return a.meta.name.localeCompare(b.meta.name); });
    var role = u ? u.role : 'contractor';
    var picked = u ? (u.projects || []).slice() : [];
    var w = sheet('<div class="sheet-head"><h2>' + (u ? esc(u.name || u.login) : 'Add person') + '</h2><p>' + (u ? 'Choose the ' + UNITS + ' ' + (u.role === 'client' ? 'this client sees' : 'this contractor works on') + '. Each one is shared through its own private repository.' : 'They’ll need a free GitHub account. Use their GitHub username here.') + '</p></div>' +
      '<div class="sheet-body">' +
      (u ? '' : '<div class="row2"><div class="field"><label for="p-name">Name</label><input class="input" id="p-name" placeholder="First Last"></div>' +
        '<div class="field"><label for="p-login">GitHub username</label><input class="input" id="p-login" placeholder="username" autocomplete="off"></div></div>' +
        '<div class="field"><span class="field-label">Role</span><div class="seg full" id="p-role"><button type="button" data-role="fte">FTE — every ' + UNIT + '</button><button type="button" data-role="client">Client — chosen ' + UNITS + '</button><button type="button" class="on" data-role="contractor">Contractor — chosen ' + UNITS + '</button></div></div>') +
      '<div class="field" id="p-projects-field"' + (role === 'fte' ? ' hidden' : '') + '><span class="field-label">Projects</span><div class="pick-grid" id="p-projects">' +
      (list.length ? list.map(function (p) {
        var shared = !!M.sharedRepo(roster, p.id);
        return '<button type="button" class="pick' + (picked.indexOf(p.id) >= 0 ? ' on' : '') + '" data-pick="' + esc(p.id) + '"><b>' + esc(p.meta.name) + '</b><span>' + (shared ? 'Shared' : 'Internal') + (p.meta.client ? ' · ' + esc(p.meta.client) : '') + '</span></button>';
      }).join('') : '<p class="note">No ' + UNITS + ' yet.</p>') + '</div></div>' +
      '</div><div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">' + (u ? 'Save' : 'Add') + '</button></div>');
    w.addEventListener('click', function (e) {
      var rb = e.target.closest('[data-role]');
      if (rb) {
        role = rb.dataset.role;
        w.querySelectorAll('#p-role button').forEach(function (b) { b.classList.toggle('on', b === rb); });
        w.querySelector('#p-projects-field').hidden = role === 'fte';
        return;
      }
      var pk = e.target.closest('.pick');
      if (pk) { pk.classList.toggle('on'); return; }
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      var chosen = Array.prototype.map.call(w.querySelectorAll('#p-projects .pick.on'), function (x) { return x.dataset.pick; });
      if (u) {
        var before = (u.projects || []).slice();
        setPerson(login, { projects: chosen }); closeSheet(); renderPage();
        applyContractorChange(login, before, chosen);
        return;
      }
      var l = w.querySelector('#p-login').value.trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(l)) { w.querySelector('#p-login').focus(); toast('Enter their GitHub username'); return; }
      setPerson(l, { name: w.querySelector('#p-name').value.trim() || l, role: role, projects: role === 'fte' ? [] : chosen, deleted: false });
      closeSheet(); renderPage();
      if (role === 'fte') fixAccess(l); else applyContractorChange(l, [], chosen);
    });
  }

  // Give GitHub access to match the People list, sharing internal projects as needed.
  function applyContractorChange(login, before, after) {
    var added = after.filter(function (id) { return before.indexOf(id) < 0; });
    var removed = before.filter(function (id) { return after.indexOf(id) < 0; });
    if (!added.length && !removed.length) return;
    if (!getToken() || !isFte()) { toast('Saved. Access is applied when someone with GitHub admin rights syncs.'); return; }
    var byId = stateNow().projects;
    var toShare = added.filter(function (id) { return !M.sharedRepo(roster, id); });
    // Taking someone off a project always takes away their GitHub access, so their copy goes
    // at their next sync. Only sharing and inviting (which email people) ask first.
    var op = { login: login, revoke: removed };
    if (added.length) {
      var lines = [];
      if (toShare.length) lines.push('Move ' + toShare.map(function (id) { return byId[id] ? byId[id].meta.name : id; }).join(', ') + ' into ' + (toShare.length === 1 ? 'its own private repository' : 'their own private repositories'));
      lines.push('Invite ' + login + ' to ' + plural(added.length, UNIT, UNITS));
      if (confirm(lines.join('\n') + '\n\nGitHub emails the invitations. Go ahead?')) {
        op.share = toShare; op.invite = added.filter(function (id) { return toShare.indexOf(id) < 0; });
      } else if (!removed.length) { toast('Saved in People. Use “Give access” when you’re ready.'); return; }
      else toast('Saved in People. The invitations wait for “Give access”.');
    }
    runAccessOps('Updating access for ' + login, [op]);
  }

  // ops: [{ login, share: [ids], invite: [ids], revoke: [ids], repos: [full] }]
  function runAccessOps(title, ops) {
    var ui2 = progressSheet(title), ws = workspace(), failures = [];
    var chain = Promise.resolve();
    ops.forEach(function (op) {
      (op.share || []).forEach(function (id) {
        chain = chain.then(function () {
          var contractors = assignedContractors(id).map(function (u) { return u.login; });
          return ws.share(stateNow(), id, contractors, ui2.log).then(function (res) {
            roster = res.state.roster; homes = res.state.homes; cache = res.state.cache;
            touchRoster();
            failures = failures.concat(res.failedInvites);
            ui2.log('Shared as ' + res.repo, 'ok');
          });
        });
      });
      (op.invite || []).forEach(function (id) {
        chain = chain.then(function () { var r = M.sharedRepo(roster, id); return r ? ws.inviteTo(r, [op.login], ui2.log).then(function (f) { failures = failures.concat(f); }) : null; });
      });
      (op.revoke || []).forEach(function (id) {
        chain = chain.then(function () { var r = M.sharedRepo(roster, id); return r ? ws.revokeFrom(r, [op.login], ui2.log).then(function (f) { failures = failures.concat(f); }) : null; });
      });
      if (op.repos && op.repos.length) {
        chain = chain.then(function () {
          return op.repos.reduce(function (c, r) { return c.then(function () { return ws.inviteTo(r, [op.login], ui2.log).then(function (f) { failures = failures.concat(f); }); }); }, Promise.resolve());
        });
      }
      if (op.revokeRepos && op.revokeRepos.length) {
        chain = chain.then(function () {
          return op.revokeRepos.reduce(function (c, r) { return c.then(function () { return ws.revokeFrom(r, [op.login], ui2.log).then(function (f) { failures = failures.concat(f); }); }); }, Promise.resolve());
        });
      }
    });
    chain.then(function () {
      failures.forEach(function (f) {
        ui2.log(f.login + ' on ' + f.repo + ': ' + (f.status === 403 || f.status === 404 ? 'only the owner (or an org admin) can change access, and the token needs Administration: write' : f.message), 'err');
      });
      ui2.log(failures.length ? 'Finished with problems.' : 'Done. Syncing…', failures.length ? 'err' : 'ok');
    }, function (err) {
      ui2.log('Stopped: ' + err.message + (err.status === 403 || err.status === 404 ? ' — creating repositories needs the owner’s token with Administration: write on All repositories.' : ''), 'err');
    }).then(function () {
      ui2.done(); accessMap = {}; persist(); sync(); if (peopleShown()) renderPage();
    });
  }

  // Invite (or share) whatever this person is missing according to the People list.
  function fixAccess(login) {
    var u = roster.users[login];
    if (!u || !getToken()) return;
    var g = accessGaps(u);
    var repos = u.role === 'fte' ? (Object.keys(accessMap).length ? g.missing : allFteRepos()) : [];
    var invite = M.isOutside(u) ? (u.projects || []).filter(function (id) { var r = M.sharedRepo(roster, id); return r && (g.missing.indexOf(r) >= 0 || !accessMap[r]); }) : [];
    var share = g.unshared;
    if (!repos.length && !invite.length && !share.length) { toast((u.name || login) + ' already has access'); return; }
    var what = u.role === 'fte' ? 'Invite ' + login + ' to ' + repos.map(repoName).join(', ') :
      (share.length ? 'Share ' + plural(share.length, UNIT, UNITS) + ' (each gets its own private repository) and invite ' + login : 'Invite ' + login + ' to ' + plural(invite.length, 'review repository', 'review repositories'));
    if (!confirm(what + '?\n\nGitHub emails the invitations.')) return;
    runAccessOps('Giving access to ' + login, [{ login: login, repos: repos, invite: invite, share: share }]);
  }

  // ── Invitations waiting for me ───────────────────────────
  // Invitations waiting, from the suite's shared card when it's loaded (it sees private repos too).
  function waitingInvites() { return window.SignoffInvites ? window.SignoffInvites.count() : invitations.length; }
  function acceptInvitations() {
    var acc = new S.GitHubAccount(getToken());
    Promise.all(invitations.map(function (i) { return acc.acceptInvitation(i.id).then(function () { return i.repo; }); }))
      .then(function (repos) { toast('Joined ' + repos.join(', ')); invitations = []; save('invitations', invitations); sync(); })
      .catch(function (err) { toast('Couldn’t accept: ' + err.message); });
  }

  // ── Discard ──────────────────────────────────────────────
  // Throw away unsynced changes: each changed project goes back to the copy on GitHub, and a
  // project that was never synced is removed from this browser. Nothing is pushed.
  function discard() {
    var keys = Object.keys(dirty);
    if (!keys.length || syncing) return;
    var byId = stateNow().projects;
    // A change marker for a project that no longer exists here (e.g. deleted after another
    // tool marked it) has nothing to throw away: just clear it.
    var orphans = keys.filter(function (k) { return k !== 'roster' && !byId[k]; });
    var ids = keys.filter(function (k) { return k !== 'roster' && byId[k]; });
    if (!ids.length && !dirty.roster) {
      orphans.forEach(function (k) { delete dirty[k]; });
      persist(); render();
      toast('Nothing to discard — cleared ' + plural(orphans.length, 'leftover change marker'));
      return;
    }
    var names = ids.map(function (id) { return '• ' + byId[id].meta.name; });
    if (dirty.roster) names.push('• People & access');
    if (!confirm('Discard unsynced changes?\n\n' + names.join('\n') + '\n\nThey go back to the last version on GitHub. A ' + UNIT + ' that was never synced is removed from this browser. This can’t be undone.')) return;
    var started = Object.assign({}, dirty);
    orphans.forEach(function (k) { delete dirty[k]; });
    syncing = true; renderSyncState('busy');
    workspace().discard(stateNow(), ids, !!dirty.roster).then(function (res) {
      var removed = 0, restored = 0;
      Object.keys(res.projects).forEach(function (id) {
        if (dirty[id] !== started[id]) return;      // edited again while this ran: keep it
        var slug = Object.keys(projects).filter(function (k) { return projects[k].id === id; })[0];
        if (!slug) { delete dirty[id]; return; }
        if (res.projects[id]) { projects[slug] = Object.assign({}, res.projects[id], { slug: slug }); restored++; }
        else { delete projects[slug]; delete homes[id]; removed++; if (ui.slug === slug) ui.slug = ''; }
        delete dirty[id];
      });
      if (res.roster && dirty.roster && dirty.roster === started.roster) { roster = res.roster; delete dirty.roster; restored++; }
      persist(); saveUi();
      syncing = false;
      selected = null; closeInspector();
      render();
      var parts = [];
      if (restored) parts.push(plural(restored, 'item') + ' restored');
      if (removed) parts.push(plural(removed, 'unsynced ' + UNIT, 'unsynced ' + UNITS) + ' removed');
      if (res.failed.length) {
        var what = res.failed.map(function (f) { return f.id === 'roster' ? 'People & access' : (byId[f.id] ? byId[f.id].meta.name : f.id); });
        toast((parts.length ? 'Discarded ' + parts.join(', ') + '. ' : '') + 'Couldn’t reach GitHub for ' + what.join(', ') +
          (getToken() ? ' (' + res.failed[0].message + ')' : ' — connect to GitHub in Settings') + '; ' + (what.length === 1 ? 'it was' : 'they were') + ' left unchanged.');
      } else {
        toast('Discarded' + (parts.length ? ' — ' + parts.join(', ') : ''));
      }
    }).catch(function (err) {
      syncing = false; render();
      toast('Couldn’t discard: ' + err.message + '. Nothing was changed.');
    });
  }

  // ── Sync ─────────────────────────────────────────────────
  var syncing = false, lastError = '', syncAgain = false;
  // An automatic sync: quiet when GitHub isn't set up, and queued behind one already running.
  // It follows deliberate saves (Comment, Save, Create, Tag, Import, adding or deleting a check,
  // comment or requirement, archiving), not every click: statuses and typed notes wait for a sync.
  function syncSoon() {
    if (DEMO || !getToken() || !settings.owner || !settings.dataRepo || !settings.user) return;
    if (syncing) { syncAgain = true; return; }
    sync();
  }
  function sync() {
    if (DEMO) { toast('Demo mode keeps everything in this browser'); return; }
    if (syncing) return;
    if (!getToken() || !settings.owner || !settings.dataRepo) { settingsSheet(); return; }
    if (!settings.user) { settingsSheet(); return; }
    noticeToken();
    syncing = true; renderSyncState('busy');
    if (!current() || peopleShown()) renderPage();   // an empty page says the sync is running
    var startedAt = M.now();   // the cutoff for the unsynced list (unsyncedList)
    var started = Object.assign({}, dirty);
    var st0 = stateNow();
    var names = Object.keys(dirty).map(function (k) { return k === 'roster' ? 'people' : st0.projects[k] ? st0.projects[k].meta.name : k; });
    var message = names.length ? 'Review update: ' + names.join(', ') + ' (' + me() + ')' : 'Review update (' + me() + ')';
    workspace().sync(st0, { message: message, onRetry: function () { toast('Someone else just synced — merging their changes'); },
      keepLocal: function (id) { return !!dirty[id]; }, plCache: load('plCache', null) })
      .then(function (res) {
        var st = res.state;
        if (res.userName && !settings.user) settings.user = res.userName;
        settings.login = st.login; save('settings', settings);
        // Edits made while the sync ran are merged on top, and stay unsynced.
        var nowById = stateNow().projects, merged = {};
        Object.keys(st.projects).forEach(function (id) { merged[id] = nowById[id] ? M.mergeProjects(nowById[id], st.projects[id]) : st.projects[id]; });
        // Projects that only exist locally and weren't touched by this sync (e.g. its repo
        // failed) are kept. One deleted on GitHub goes, unless it was edited while this ran.
        var gone = (res.gone || []).filter(function (id) { return dirty[id] === started[id]; });
        Object.keys(nowById).forEach(function (id) { if (!merged[id] && res.dropped.indexOf(id) < 0 && gone.indexOf(id) < 0) merged[id] = nowById[id]; });
        var dataFull = settings.owner + '/' + settings.dataRepo;
        if (st.dataAccess === 'none') {
          // A contractor's token: unsynced internal work (an FTE's, in this browser) is held out
          // of sight, and the People list goes.
          res.dropped.forEach(function (id) {
            if (!dirty[id] || !nowById[id] || (homes[id] || dataFull) !== dataFull) return;
            held.projects[id] = held.projects[id] ? M.mergeProjects(held.projects[id], nowById[id]) : nowById[id];
            delete dirty[id];
          });
          if (dirty.roster) { held.roster = M.mergeRosters(held.roster || M.emptyRoster(), roster); delete dirty.roster; }
          roster = M.emptyRoster();
          save('held', held);
        } else if (st.dataAccess === 'ok' && (Object.keys(held.projects).length || held.roster)) {
          // An FTE again: bring the held work back and push it.
          Object.keys(held.projects).forEach(function (id) {
            merged[id] = merged[id] ? M.mergeProjects(merged[id], held.projects[id]) : held.projects[id];
            dirty[id] = M.now();
          });
          if (held.roster) { roster = M.mergeRosters(roster, held.roster); dirty.roster = M.now(); }
          held = { projects: {}, roster: null }; save('held', held);
          syncAgain = true;
        }
        // Slugs are only local handles for the sidebar; two projects with one name get a suffix.
        var next = {};
        Object.keys(merged).forEach(function (id) {
          var doc = merged[id], base = doc.slug || M.slugify(doc.meta.name), slug = base, n = 2;
          while (next[slug]) slug = base + '-' + n++;
          next[slug] = doc;
        });
        // Stay on whatever is open now: the user may have switched while the sync ran.
        var currentId = projects[ui.slug] && projects[ui.slug].id;
        projects = next;
        homes = st.homes; cache = st.cache; dataAccess = st.dataAccess;
        roster = M.mergeRosters(roster, st.roster);
        var failedRepos = res.errors.map(function (e) { return e.repo; });
        Object.keys(started).forEach(function (k) {
          if (dirty[k] !== started[k]) return;
          var repo = k === 'roster' ? settings.owner + '/' + settings.dataRepo : st.homes[k] || (settings.owner + '/' + settings.dataRepo);
          if (failedRepos.indexOf(repo) < 0) delete dirty[k];
        });
        res.dropped.concat(gone).forEach(function (id) { delete dirty[id]; });
        ui.slug = Object.keys(projects).filter(function (k) { return projects[k].id === currentId; })[0] || '';
        openWanted(true);
        if (res.templates && res.templates.length) { pulledTemplates = res.templates; save('templates', pulledTemplates); refreshTemplates(); }
        invitations = res.invitations || [];
        if (window.SignoffInvites) window.SignoffInvites.refresh();
        if (res.pl) { plRead = res.pl; save('pl', plRead); save('plCache', res.plCache); }
        lastSync = { at: M.now(), startedAt: startedAt, version: res.version || (lastSync && lastSync.version), errors: res.errors };
        save('cache2', cache); save('lastSync', lastSync); save('dataAccess', dataAccess); save('invitations', invitations); persist();
        lastError = res.errors.length ? res.errors[0].message : '';
        syncing = false;
        render();
        openWantedItem();
        if (res.dropped.length) toast(plural(res.dropped.length, UNIT, UNITS) + ' no longer shared with you ' + (res.dropped.length === 1 ? 'was' : 'were') + ' removed from this browser');
        if (gone.length) toast(plural(gone.length, UNIT, UNITS) + ' deleted on GitHub ' + (gone.length === 1 ? 'was' : 'were') + ' removed from this browser');
        if (res.errors.length) toast(res.errors[0].message + (res.errors.length > 1 ? ' (+' + (res.errors.length - 1) + ' more)' : ''));
        else toast(res.pushed ? 'Synced — ' + plural(res.pushed, 'change') + ' pushed' : 'Up to date');
        if (syncAgain) { syncAgain = false; sync(); }
        else checkForUpdate();
      })
      .catch(function (err) {
        syncing = false; syncAgain = false; lastError = err.message;
        renderSyncState('error');
        if (!current() || peopleShown()) renderPage();
        if (err.status === 401) {
          // GitHub doesn't recognize the token at all (not a permissions problem).
          lastError = 'GitHub didn’t accept the token saved in this browser. Paste the token again in Settings.';
          toast(lastError);
          settingsSheet();
          return;
        }
        toast('Sync failed: ' + err.message);
      });
  }

  // ── Report ───────────────────────────────────────────────
  function openReport() {
    var p = current(); if (!p) return;
    var st = M.projectStats(p, TEMPLATES);
    var f = allFindings(p);
    var reviewers = {};
    M.liveComments(p).forEach(function (c) { reviewers[c.author] = 1; });
    Object.keys(p.items).forEach(function (k) { if (p.items[k].updatedBy) reviewers[p.items[k].updatedBy] = 1; });
    var m = p.meta;
    var html = '<div class="report-bar"><b>Review report</b><div style="display:flex;gap:8px"><button class="btn" data-act="close-report">Close</button><button class="btn btn-primary" data-act="print">Print / Save PDF</button></div></div>' +
      '<div class="paper">' +
      '<div class="r-head"><div><div class="r-brand"><svg width="10" height="16" viewBox="0 0 59.21 98.68"><path d="M0 0h18.19v41.88H0zM0 56.79h18.19v41.88H0zM18.2 41.89h1.59v14.91H18.2zM19.79 0v41.89l24.96-6.63v28.16L19.79 56.79v41.89l39.42-10.47V10.47z" fill="#004952"/></svg>DOVETAIL · ' + esc(C.tagline.toUpperCase()) + '</div>' +
      '<h1 style="margin-top:14px">' + esc(m.name) + '</h1><div style="color:#515154">' + esc([m.client, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div style="text-align:right"><div style="font:600 30px var(--display);color:#004952">' + st.pct + '%</div><div style="color:#86868b;font-size:11px">reviewed</div></div></div>' +
      '<div class="r-meta"><div><span>Stage</span>' + esc(m.stage) + '</div><div><span>Date</span>' + fmtDate(M.now()) + '</div><div><span>Open issues</span>' + st.issuesOpen + '</div><div><span>Reviewers</span>' + (Object.keys(reviewers).map(esc).join(', ') || '—') + '</div></div>' +
      (m.description ? '<p style="color:#515154">' + esc(m.description) + '</p>' : '') +
      '<h2>Summary</h2><table><thead><tr><th>Checklist</th><th class="num">Checks</th><th class="num">Pass</th><th class="num">Issues</th><th class="num">N/A</th><th class="num">To review</th><th class="num">Reviewed</th></tr></thead><tbody>' +
      projectTemplates(p).map(function (t) {
        var c = st.per[t.id];
        return '<tr><td>' + esc(t.title) + '</td><td class="num">' + c.total + '</td><td class="num">' + c.pass + '</td><td class="num">' + c.issue + '</td><td class="num">' + c.na + '</td><td class="num">' + c.open + '</td><td class="num">' + c.pct + '%</td></tr>';
      }).join('') +
      '<tr><td><b>Total</b></td><td class="num"><b>' + st.total + '</b></td><td class="num"><b>' + st.pass + '</b></td><td class="num"><b>' + st.issue + '</b></td><td class="num"><b>' + st.na + '</b></td><td class="num"><b>' + st.open + '</b></td><td class="num"><b>' + st.pct + '%</b></td></tr></tbody></table>' +
      (st.outside ? '<p class="r-cmt">' + plural(st.outside, 'further check') + ' did not apply to this ' + W.thing + '’s profile (' + esc((m.profile || []).join(', ') || W.general.toLowerCase()) + ') and ' + (st.outside === 1 ? 'is' : 'are') + ' not counted.</p>' : '') +
      '<h2>Findings</h2>' + (f.length ? '<table><thead><tr><th>#</th><th>Severity</th><th>Finding</th><th>Owner</th><th>Status</th></tr></thead><tbody>' +
        f.map(function (x, i) {
          var r = x.row, res = r.resolution;
          var cm = M.liveComments(p, r.id);
          return '<tr><td>' + (i + 1) + '</td><td><span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span></td><td><b style="font-weight:500">' + esc(r.def.text) + '</b><div class="r-cmt">' + esc(x.template.short + ' › ' + x.section.title) + (r.state.ref ? ' · ' + esc(r.state.ref) : '') + '</div>' +
            cm.map(function (c) { return '<div class="r-cmt">' + esc(c.author) + ' (' + fmtDate(c.at) + '): ' + esc(c.text) + '</div>'; }).join('') + '</td>' +
            '<td>' + esc(r.state.assignee || '—') + '</td><td>' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p>No issues were raised.</p>') +
      (reqsOn(p) ? reqsReport(p) : '') +
      '<div class="sign"><div>Reviewed by</div><div>Approved by</div></div>' +
      '<div class="r-foot"><span>Generated by ' + esc(C.product) + ' ' + esc((window.SIGNOFF_VERSION || {}).hash || '') + '</span><span>' + esc(m.name) + '</span></div></div>';
    var r = $('#report'); r.innerHTML = html; r.hidden = false;
    // On a narrow screen a wide table scrolls inside the paper instead of pushing past it.
    r.querySelectorAll('.paper table').forEach(function (t) {
      var w = document.createElement('div'); w.className = 'r-scroll';
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });
  }

  function exportCsv() {
    var p = current(); if (!p) return;
    var rows = [['Severity', 'Checklist', 'Section', 'Check', 'Reference', 'Owner', 'Status', 'Comments']];
    allFindings(p).forEach(function (x) {
      var r = x.row;
      rows.push([r.severity, x.template.title, x.section.title, r.def.text, r.state.ref || '', r.state.assignee || '',
        r.resolution || 'open', M.liveComments(p, r.id).map(function (c) { return c.author + ': ' + c.text; }).join(' | ')]);
    });
    download(p.slug + '-findings.csv', rows.map(function (r) { return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n'), 'text/csv');
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('That file isn’t JSON'); return; }
      var doc;
      if (M.isLegacy(data)) doc = M.importLegacy(data, me(), TEMPLATES);
      else if (data && data.meta && data.items) doc = data;
      else { toast('Not a ' + C.product + ' review' + ((C.legacyTabs || []).length ? ' or old checklist export' : '')); return; }
      var slug = doc.slug || M.slugify(doc.meta.name);
      if (projects[slug] && projects[slug].id !== doc.id) { var n = 2; while (projects[slug + '-' + n]) n++; slug = slug + '-' + n; }
      doc.slug = slug;
      projects[slug] = M.mergeProjects(projects[slug], doc);
      ui.slug = slug; ui.view = 'overview';
      touch(projects[slug]); saveUi(); render();
      toast(M.isLegacy(data) ? 'Imported from the old checklist' : cap(UNIT) + ' imported'); syncSoon();
    };
    reader.readAsText(file);
  }

  // ── Menus & toasts ───────────────────────────────────────
  function menu(anchor, entries) {
    closeMenu();
    var m = document.createElement('div');
    m.className = 'menu'; m.id = 'menu';
    m.innerHTML = entries.map(function (e) { return e === '-' ? '<hr>' : '<button data-menu="' + e[0] + '"' + (e[2] ? ' class="danger"' : '') + '>' + esc(e[1]) + '</button>'; }).join('');
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
    // A long menu scrolls; with more room above the button than below, it opens upward.
    var vh = window.innerHeight, rt = Math.max(0, Math.min(r.top, vh)), rb = Math.max(0, Math.min(r.bottom, vh));
    var below = vh - rb - 14, above = rt - 14, h = m.offsetHeight;
    if (h > below && above > below) { m.style.maxHeight = above + 'px'; m.style.top = Math.max(8, rt - 6 - Math.min(h, above)) + 'px'; }
    else { m.style.maxHeight = Math.max(120, below) + 'px'; m.style.top = Math.min(rb + 6, vh - 128) + 'px'; }
    m.style.overflowY = 'auto';
    return new Promise(function (resolve) {
      m.addEventListener('click', function (e) { var b = e.target.closest('[data-menu]'); if (b) { closeMenu(); resolve(b.dataset.menu); } });
    });
  }
  function closeMenu() { var m = $('#menu'); if (m) m.remove(); }

  // A short message at the bottom. action { label, run } adds a button (Undo), and the toast stays
  // longer; ms sets how long it stays.
  function toast(text, action, ms) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    if (action) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
      b.addEventListener('click', function () { t.remove(); action.run(); });
      t.appendChild(b);
    }
    $('#toasts').appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, ms || (action ? 8000 : 3200));
  }

  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark(theme) { return theme === 'dark' || (theme !== 'light' && !!(darkQuery && darkQuery.matches)); }
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
    var btn = $('#theme-btn');
    if (btn) {
      var dark = isDark(theme);
      btn.innerHTML = dark ? ICON.sun : ICON.moon;
      btn.title = dark ? 'Light mode' : 'Dark mode';
    }
  }
  // The sidebar button flips whatever is showing now; Settings can set it back to Automatic.
  function toggleTheme() {
    settings.theme = isDark(settings.theme) ? 'light' : 'dark';
    save('settings', settings); saveSharedTheme(settings.theme);
    applyTheme(settings.theme);
  }
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', function () { applyTheme(settings.theme); });
  // Another Signoff tool (or Fabcheck) in another tab changed the theme.
  window.addEventListener('storage', function (e) {
    var t = e.key === THEME_KEY && sharedTheme();
    if (t && t !== settings.theme) { settings.theme = t; applyTheme(t); }
    // A refresh changes the token but not its tag (model.tokenTag), so only a new person re-syncs.
    if ((e.key === TOKEN_KEY || e.key === 'signoff.login') && !DEMO && noticeToken()) { render(); syncSoon(); return; }
    onExternalWrite(e);
  });

  // Another tab of this tool, or Fabcheck's "Send to Signoff", wrote our projects, dirty list
  // or ui. Merge it in rather than let our next persist() overwrite it. Storage events only
  // fire in other tabs, and we write back only when the merge changed something, so two
  // open tabs settle instead of echoing.
  function onExternalWrite(e) {
    if (!e.key || e.key.indexOf(NS) !== 0) return;
    var key = e.key.slice(NS.length), theirs;
    try { theirs = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) { return; }
    if (!theirs || typeof theirs !== 'object') return;
    if (key === 'projects') {
      var fresh = dropStaleDemo(theirs);
      var res = M.mergeLocalCopies(projects, fresh);
      // The other tab wrote stale demo copies over ours: write ours back.
      if (!res.changed && Object.keys(fresh).length !== Object.keys(theirs).length) { save('projects', projects); return; }
      if (!res.changed) return;
      projects = res.projects;
      save('projects', projects);
      render();
    } else if (key === 'roster') {
      // Another tab, or this tool's People tab framed in the hub or PL, edited People.
      var merged = M.mergeRosters(roster, theirs);
      if (JSON.stringify(merged) === JSON.stringify(roster)) return;
      roster = merged;
      if (JSON.stringify(merged) !== JSON.stringify(theirs)) save('roster', roster);
      renderSidebar(); if (peopleShown()) renderPage();
    } else if (key === 'dirty') {
      var added = Object.keys(theirs).filter(function (k) { return !dirty[k] || theirs[k] > dirty[k]; });
      if (!added.length) return;
      added.forEach(function (k) { dirty[k] = theirs[k]; });
      save('dirty', dirty);
      renderSidebar(); renderSyncState(); renderToolbar();
    } else if (key === 'ui' && !('filter' in theirs) && theirs.slug && projects[theirs.slug] && (theirs.slug !== ui.slug || (theirs.view && theirs.view !== ui.view))) {
      // A request from another tool, e.g. Fabcheck opening the findings it just sent:
      // { slug, view: 'findings' }. Our own saveUi() always writes filter, so navigating in a
      // second Signoff tab doesn't drag this one along.
      ui.slug = theirs.slug; ui.view = theirs.view || 'overview'; ui.page = ''; ui.query = ''; ui.filter = 'all'; selected = null;
      closeInspector(); render();
    }
  }

  // ── Events ───────────────────────────────────────────────
  function visibleItemIds() {
    return Array.prototype.map.call(document.querySelectorAll('#page .item'), function (el) { return el.dataset.id; });
  }

  document.addEventListener('click', function (e) {
    var popWasOpen = !!$('#menu.sync-pop');
    if (!e.target.closest('#menu')) closeMenu();
    var el = e.target.closest('[data-act]');
    if (!el) { if (blankClick(e) || specBlankClick(e)) closePanel(); return; }
    var act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'sync-details': if (popWasOpen) closeMenu(); else syncDetails(el); break;
      case 'goto-change': gotoChange(el); break;
      case 'new-project': if (isFte()) projectSheet(null); break;
      case 'pl-start': if (isFte()) startFromPl(el.dataset.pl); break;
      case 'people': closeMenu(); openPeople(); break;
      case 'edit-project': projectSheet(current()); break;
      case 'open-project':
        ui.slug = el.dataset.slug; ui.view = 'overview'; ui.page = ''; ui.query = ''; ui.filter = 'all'; ui.home = false; selected = null;
        closeInspector(); saveUi(); render(); $('#app').classList.remove('nav-open'); $('#main').scrollTop = 0; break;
      case 'toggle-archived': ui.showArchived = !ui.showArchived; saveUi(); renderSidebar(); break;
      case 'toggle-group': {
        var cg = Object.assign({}, ui.closedGroups || {}), gk = el.dataset.group;
        if (el.getAttribute('aria-expanded') === 'true') cg[gk] = true; else delete cg[gk];
        ui.closedGroups = cg;
        if (cg[gk] && el.hasAttribute('data-holds-open')) goHome(); else { saveUi(); renderSidebar(); }
        break;
      }
      case 'fold-groups': {
        var gs = M.projectGroups(visibleProjects().filter(function (p) { return !p.meta.archived; }));
        var shut = Object.assign({}, ui.closedGroups || {});
        var unfold = gs.every(function (g) { return shut[g.name.toLowerCase()]; });
        gs.forEach(function (g) { if (unfold) delete shut[g.name.toLowerCase()]; else shut[g.name.toLowerCase()] = true; });
        ui.closedGroups = shut;
        if (unfold) { saveUi(); renderSidebar(); } else goHome();
        break;
      }
      case 'view':
        specEditing = null;
        ui.view = el.dataset.view; ui.query = ''; selected = null; closeInspector(); saveUi(); renderPage(); $('#main').scrollTop = 0; break;
      case 'filter': ui.filter = el.dataset.filter; saveUi(); renderPage(); break;
      case 'toggle-sec':
        if (e.target.closest('[data-act="sec-na"], [data-act="sec-pass"]')) return;
        collapsed[el.dataset.sec] = !collapsed[el.dataset.sec]; save('collapsed', collapsed);
        el.closest('.sec').classList.toggle('collapsed'); break;
      case 'collapse-all': {
        var secs = Array.prototype.map.call(document.querySelectorAll('.sec[data-sec]'), function (s) { return s.dataset.sec; });
        var all = secs.every(function (s) { return collapsed[s]; });
        secs.forEach(function (s) { collapsed[s] = !all; }); save('collapsed', collapsed); renderPage(); break;
      }
      case 'sec-na': e.stopPropagation(); toggleSectionNA(el.dataset.sec); break;
      case 'sec-pass': e.stopPropagation(); passBlank(el.dataset.sec); break;
      case 'show-hidden': showHidden[el.dataset.sec] = !showHidden[el.dataset.sec]; renderPage(); break;
      case 'select':
        if (e.target.closest('button')) return;
        select(id, true); break;
      case 'cycle': {
        e.stopPropagation();
        var p = current(), cur = (p.items[id] || {}).status || 'open';
        setStatus(id, cur === 'open' ? 'pass' : 'open');
        select(id, false); break;
      }
      case 'set': e.stopPropagation(); setStatus(id, el.dataset.status); select(id, el.closest('.inspector') ? true : false); break;
      case 'item-field': { var f = {}; f[el.dataset.key] = el.dataset.val; setItem(selected, f); break; }
      case 'close-insp': closePanel(); break;
      case 'post-comment': { var ta = $('#comment-input'); addComment(selected, ta.value); var t2 = $('#comment-input'); if (t2) { t2.value = ''; t2.focus(); } break; }
      case 'del-comment': if (confirm('Delete this comment?')) deleteComment(id); break;
      case 'req-add': addReq(); break;
      case 'spec-view':
        // A block's panel belongs to the diagram and a sentence's to the document: switching closes them
        // (on a narrow screen the panel is a sheet over the depth buttons, which took the first click).
        if (ui.specView !== el.dataset.view && /^spec(block|edge)?\|/.test(selected || '')) { selected = null; closeInspector(); }
        ui.specView = el.dataset.view; specEditing = null; saveUi(); renderPage(); break;
      case 'spec-depth': ui.specDepth = parseInt(el.dataset.depth, 10) || 3; ui.specShow = ''; saveUi(); renderPage(); break;
      case 'spec-show': ui.specShow = el.dataset.show || ''; saveUi(); renderPage(); break;
      case 'spec-resolve': specResolve(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-goto': specGoto(id); break;
      case 'spec-jump': specJumpUnit(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-unit': case 'spec-open':
        if (window.getSelection && String(window.getSelection()) && act === 'spec-unit') break;   // selecting text to copy
        specOpenUnit(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-edit': specStartEdit(id); break;
      case 'spec-edit-all': {
        var ea = current(); if (!ea) break;
        ui.view = 'spec'; ui.specView = 'doc'; saveUi();
        specEditing = 'all'; specDraft = M.specToText(ea); closeInspector(); selected = null; renderPage(); specFocusEditor(); break;
      }
      case 'spec-add':
        ui.view = 'spec'; ui.specView = 'doc'; saveUi(); specNewAfter = '';
        specEditing = 'new'; specDraft = '## New section' + String.fromCharCode(10); closeInspector(); renderPage(); specFocusEditor(); break;
      case 'spec-add-after': {
        // + on a heading: a new section right under it, at the level of what follows it (its first
        // subsection when it has some, else beside it).
        var aa = current(); if (!aa) break;
        specNewAfter = id;
        var na = specNewAt(aa); if (!na) { specNewAfter = ''; break; }
        specEditing = 'new'; specDraft = new Array(na.level + 1).join('#') + ' New section' + String.fromCharCode(10);
        closeInspector(); selected = null; renderPage(); specFocusEditor(); break;
      }
      case 'spec-undo': specHistStep(true); break;
      case 'spec-redo': specHistStep(false); break;
      case 'spec-more': {
        var mp = current(); if (!mp) break;
        var has = M.liveSpec(mp).length, guide = specGuideId() && window.SignoffSpecGuide;
        menu(el, (guide ? [['guide', 'Guide: a walk through ' + SPEC_LABEL]] : []).concat([['writing', 'Writing guide'], '-', ['paste', 'Paste text…']])
          .concat(has ? ['-', ['md', 'Export as Markdown (.md)'], ['print', 'Print or save as PDF']] : [])).then(function (ch) {
          if (ch === 'guide') { closeSheet(); window.SignoffSpecGuide.start(); }
          else if (ch === 'writing') specGuideSheet();
          else if (ch === 'paste') specPasteSheet();
          else if (ch === 'md') download(mp.slug + '-description.md', M.specMarkdown(mp), 'text/markdown');
          else if (ch === 'print') specPrint(mp);
        });
        break;
      }
      case 'spec-save': specSaveEdit(); break;
      case 'spec-guide': specGuideSheet(); break;
      case 'spec-guide-start': closeSheet(); if (window.SignoffSpecGuide) window.SignoffSpecGuide.start(); break;
      case 'spec-kind-set': specKindSet(el.dataset.kind); break;
      case 'spec-uses-add': specUsesAdd(el, el.dataset.word); break;
      case 'spec-block': if (!specDragJustEnded) specOpenBlock(id); break;
      case 'spec-edge': if (!specDragJustEnded) specOpenEdge(el.dataset.a, el.dataset.b, el.dataset.word); break;
      case 'spec-edge-delete': specEdgeDelete(); break;
      case 'spec-boxes': ui.specBoxes = !!el.checked; saveUi(); renderPage(); break;
      case 'spec-auto-layout': specAutoLayout(); break;
      case 'spec-new-section': specNewSectionSheet(); break;
      case 'spec-tree-fold': { var fc = Object.assign({}, ui.specClosed || {}); if (fc[id]) delete fc[id]; else fc[id] = true; ui.specClosed = fc; saveUi(); renderPage(); break; }
      case 'spec-ungroup': {
        var gp = current(); if (!gp) break;
        if (confirm('Ungroup ' + T_title(gp, id) + '? Its blocks stay, one level up in the outline.')) { selected = null; closeInspector(); specPutAll(gp, M.specUngroup(gp, id, me())); }
        break;
      }
      case 'spec-block-label': specLinkLabel(el.dataset.word, el.dataset.name); break;
      case 'spec-ctag-open': {
        var op2 = current(), oc = op2 && op2.comments[id];
        if (!oc) break;
        if (reqOf(op2, oc.item)) { ui.view = 'reqs'; saveUi(); openReq(oc.item); }
        else if (oc.item) gotoItem(oc.item);
        else { ui.view = 'overview'; saveUi(); renderPage(); }
        break;
      }
      case 'spec-ctag-make': case 'spec-ctag-change': case 'spec-ctag-untag': specCommentTag(act.slice(10), id); break;
      case 'spec-export': {
        var xp = current(); if (!xp) break;
        menu(el, [['md', 'Markdown (.md)'], ['print', 'Print or save as PDF']]).then(function (ch) {
          if (ch === 'md') download(xp.slug + '-description.md', M.specMarkdown(xp), 'text/markdown');
          else if (ch === 'print') specPrint(xp);
        });
        break;
      }
      case 'spec-copy-delete': {
        var cp = current(), cc = cp && (cp.spec || {})[id];
        if (cc && confirm('Delete this conflict copy? Its text is gone once you do.')) specPutAll(cp, [M.specStamp(Object.assign({}, cc, { deleted: true }), me())]);
        break;
      }
      case 'spec-add-block': specAddBlockSheet(el.dataset.kind, el.dataset.parent || (SPEC_FLOW ? '' : specBlockSel()), el.dataset.section || ''); break;
      case 'spec-block-kind': specBlockField('kind', el.dataset.kind); break;
      case 'spec-block-unuse': specUnlinkName(specBlockSel(), el.dataset.word, el.dataset.name); break;
      case 'spec-editor-line': specEditorLine(parseInt(el.dataset.line, 10) || 1); break;
      case 'spec-block-delete': {
        var dp = current(), dc = dp && (dp.spec || {})[id];
        if (dc && confirm('Delete ' + (dc.title || 'this block') + ' and its text?')) { selected = null; closeInspector(); specPutAll(dp, [M.specStamp(Object.assign({}, dc, { deleted: true }), me())]); }
        break;
      }
      case 'spec-cancel': specEditing = null; specDraft = ''; renderPage(); break;
      case 'spec-delete':
        if (confirm('Delete this section?')) { var sp = current(); specPut(sp, id, { deleted: true }); specEditing = null; specDraft = ''; renderPage(); syncSoon(); }
        break;
      case 'spec-paste': specPasteSheet(); break;
      case 'spec-template': specTemplateSheet(); break;
      case 'spec-make': specMakeReq(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-change': specChangeReq(el.dataset.sec, parseInt(el.dataset.u, 10), id); break;
      case 'spec-untag': { var up = current(); if (specUnitEdit(up, el.dataset.sec, parseInt(el.dataset.u, 10), 'tag', false)) { renderPage(); renderInspector(); renderToolbar(); syncSoon(); } break; }
      case 'spec-describe': specDescribe(el, id); break;
      case 'spec-phrase-clear': specPhrase = ''; renderInspector(); break;
      case 'spec-link': case 'spec-unlink': case 'spec-std': case 'spec-tag': {
        var ss = specSel(), sp2 = current(); if (!ss || !sp2) break;
        var op = act.slice(5), arg = op === 'link' || op === 'unlink' ? id : !!el.dataset.on;
        if (op === 'link' && specPhrase) {
          var fa = specFind(M.specAnalysis(sp2), ss.sec, ss.start);
          if (fa && M.specEdit(fa.x.sec.body, fa.u.start, fa.u.end, 'phrase', { id: id, text: specPhrase }) === fa.x.sec.body) { toast('Pick words outside other links, or link the whole sentence'); break; }
          op = 'phrase'; arg = { id: id, text: specPhrase }; specPhrase = '';
        }
        if (specUnitEdit(sp2, ss.sec, ss.start, op, arg)) { renderPage(); renderInspector(); renderToolbar(); syncSoon(); }
        break;
      }
      case 'req-import': importReqsSheet(); break;
      case 'req-export': { var rp = current(); download(rp.slug + '-requirements.csv', M.reqsCsv(rp, checkIdx(rp)), 'text/csv'); break; }
      case 'req-filter': ui.reqFilter = el.dataset.filter; saveUi(); renderPage(); break;
      case 'select-req': openReq(id); break;
      case 'open-req': ui.view = 'reqs'; saveUi(); openReq(id); break;
      case 'req-field': { var rf = {}; rf[el.dataset.key] = el.dataset.val; setReq(selected, rf); break; }
      case 'req-link': {
        var rl = reqOf(current(), selected);
        if (rl) { var s1 = $('#req-link-search'); if (s1) s1.value = ''; setReq(selected, { links: (rl.links || []).concat([id]) }); var s2 = $('#req-link-search'); if (s2) s2.focus(); }
        break;
      }
      case 'req-unlink': { var ru = reqOf(current(), selected); if (ru) setReq(selected, { links: (ru.links || []).filter(function (x) { return x !== id; }) }); break; }
      case 'req-delete': {
        var rd = reqOf(current(), selected);
        if (rd && confirm('Delete ' + rd.ref + '? Its discussion is kept in the ' + UNIT + ' history.')) { setReq(selected, { deleted: true }); selected = null; closeInspector(); renderPage(); syncSoon(); }
        break;
      }
      case 'delete-custom':
        if (confirm('Delete this ' + UNIT + ' check?')) { var pp = current(); pp.custom[id] = M.stamp(Object.assign({}, pp.custom[id], { deleted: true }), me()); touch(pp); closeInspector(); renderPage(); syncSoon(); }
        break;
      case 'goto-item': if (id) gotoItem(id); break;
      case 'discard': discard(); break;
      case 'pic-side': { ui.picSide = el.dataset.key; var pp = current(); if (pp) showPicture(pp); break; }
      case 'open-fabcheck': openFabcheck(el); break;
      case 'open-pincheck': openPincheck(el); break;
      case 'runs-reload': { var rp = current(); if (rp) { loadRuns(rp, true); renderPage(); } break; }
      case 'rev-toggle': revOpen[el.dataset.key] = !revOpen[el.dataset.key]; renderPage(); break;
      case 'rev-tag': { var tp = current(), tr = tp && runById(tp, el.dataset.run); if (tr) revisionSheet(tp, tr); break; }
      case 'run-download': { var dp = current(); if (dp) downloadRun(dp, runById(dp, el.dataset.run)); break; }
      case 'sync': if (!DEMO && lastError && el.id === 'sync-pill' && !syncing) toast(lastError); sync(); break;
      case 'settings': settingsSheet(); break;
      case 'signin': el.disabled = true; startSignIn().catch(function (err) { el.disabled = false; toast(err.message); }); break;
      case 'theme': toggleTheme(); break;
      case 'add-person': personSheet(null); break;
      case 'add-self': setPerson(settings.login, { name: settings.user || settings.login, role: 'fte', projects: [], deleted: false }); renderPage(); break;
      case 'fix-access': fixAccess(el.dataset.login); break;
      case 'trim-access': {
        var tu = roster.users[el.dataset.login], extra = tu ? accessGaps(tu).extra : [];
        if (extra.length) runAccessOps('Removing access for ' + tu.login, [{ login: tu.login, revokeRepos: extra }]);
        break;
      }
      case 'refresh-access': accessMap = {}; loadAccess(true); renderPage(); break;
      case 'accept-invites': acceptInvitations(); break;
      case 'person-projects': personSheet(el.dataset.login); break;
      case 'person-role':
        var wasRole = (roster.users[el.dataset.login] || {}).role;
        if (wasRole === el.dataset.role) break;
        if (el.dataset.login === settings.login && wasRole === 'fte' && !confirm('Make yourself a ' + el.dataset.role + '? You would stop seeing most ' + UNITS + '.')) break;
        setPerson(el.dataset.login, { role: el.dataset.role }); renderPage();
        if (el.dataset.role === 'fte') fixAccess(el.dataset.login);
        else if (wasRole === 'fte' && getToken()) {   // client to contractor and back only changes the label
          // Everything FTEs get (Chris, 2026-11-12: the reverse of Give access), except this tool's repos
          // of projects they keep as a client or contractor.
          var keep = ((roster.users[el.dataset.login] || {}).projects || []).map(function (id) { return M.sharedRepo(roster, id); }).filter(Boolean);
          var internal = allFteRepos().filter(function (r) { return keep.indexOf(r) < 0; });
          if (confirm('Also remove ' + el.dataset.login + ' from ' + internal.map(repoName).join(', ') + ' on GitHub?')) runAccessOps('Removing FTE access', [{ login: el.dataset.login, revokeRepos: internal }]);
        }
        break;
      case 'remove-person':
        if (!confirm('Remove ' + el.dataset.login + ' from People?')) break;
        (function (login) {
          var u = roster.users[login], repos = u.role === 'fte' ? allFteRepos() : (u.projects || []).map(function (id) { return M.sharedRepo(roster, id); }).filter(Boolean);
          setPerson(login, { deleted: true, projects: [] }); renderPage();
          // A client's or contractor's access goes with them; for an FTE, ask first.
          if (getToken() && repos.length && (u.role !== 'fte' || confirm('Also take away their GitHub access to ' + repos.map(repoName).join(', ') + '?'))) runAccessOps('Removing ' + login, [{ login: login, revokeRepos: repos }]);
        })(el.dataset.login);
        break;

      case 'report': openReport(); break;
      case 'close-report': $('#report').hidden = true; break;
      case 'print': window.print(); break;
      case 'export-csv': exportCsv(); break;
      case 'nav': toggleSidebar(); break;
      case 'project-menu':
        menu(el, !current() ? ticketEntries() : (isFte() ? [['edit', cap(UNIT) + ' details\u2026']] : []).concat([['report', 'Review report'], ['csv', 'Export findings (CSV)'], ['json', 'Export ' + UNIT + ' (JSON)']],
          isFte() ? ['-', ['import', (C.legacyTabs || []).length ? 'Import ' + UNIT + ' or old checklist\u2026' : 'Import ' + UNIT + '\u2026'], '-', ['archive', current().meta.archived ? 'Unarchive ' + UNIT : 'Archive ' + UNIT, true]] : [],
          ticketsOn() ? ['-'].concat(ticketEntries()) : []))
          .then(function (choice) {
            if (choice === 'ticket') { window.SignoffTickets.newTicket(); return; }
            if (choice === 'tickets') { window.SignoffTickets.open(); return; }
            if (choice === 'edit') projectSheet(current());
            else if (choice === 'report') openReport();
            else if (choice === 'csv') exportCsv();
            else if (choice === 'json') download(current().slug + '.json', M.stableStringify(current()));
            else if (choice === 'import') $('#import-file').click();
            else if (choice === 'archive') { updateMeta({ archived: !current().meta.archived }); syncSoon(); }
          });
        break;
    }
  });

  document.addEventListener('keydown', function (e) {
    var inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); sync(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement.id === 'comment-input') { e.preventDefault(); $('[data-act="post-comment"]').click(); return; }
    if (document.activeElement.id === 'spec-editor') {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); specSaveEdit(); return; }
      if (e.key === 'Escape' && !$('#sheet')) { e.preventDefault(); specEditing = null; specDraft = ''; renderPage(); return; }
    }
    if (e.key === 'Escape') {
      if ($('#menu')) { closeMenu(); return; }
      if ($('#sheet')) { closeSheet(); applyTheme(settings.theme); return; }
      if (!$('#report').hidden) { $('#report').hidden = true; return; }
      if (inField) { document.activeElement.blur(); return; }
      if ($('#inspector').classList.contains('open')) { closePanel(); return; }
    }
    // Back and forward in Scribe: Ctrl+Z, and Ctrl+Shift+Z or Ctrl+Y.
    if (!inField && ui.view === 'spec' && (e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key) && !$('#sheet') && current()) {
      e.preventDefault(); specHistStep(e.key.toLowerCase() === 'z' && !e.shiftKey); return;
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey || $('#sheet') || (PEOPLE && PEOPLE.isOpen())) return;
    var ids = visibleItemIds();
    var i = ids.indexOf(selected);
    if (e.key === 'j' || e.key === 'ArrowDown') { if (ids.length) { e.preventDefault(); select(ids[Math.min(ids.length - 1, i + 1)], false); } }
    else if (e.key === 'k' || e.key === 'ArrowUp') { if (ids.length) { e.preventDefault(); select(ids[Math.max(0, i - 1)], false); } }
    else if (e.key === 'Enter' && selected) { select(selected, true); }
    else if (selected && ids.indexOf(selected) >= 0 && 'pino'.indexOf(e.key) >= 0) {
      setStatus(selected, { p: 'pass', i: 'issue', n: 'na', o: 'open' }[e.key]);
      // Passing or N/A moves on to the next check; an issue opens the detail to describe it.
      if (e.key === 'i') select(selected, true);
      else if (e.key !== 'o') { var nx = visibleItemIds(); select(nx[Math.min(nx.length - 1, nx.indexOf(selected) + 1)], false); }
      else select(selected, false);
    }
    else if (e.key === 'c' && selected) { select(selected, true); setTimeout(function () { var t = $('#comment-input'); if (t) t.focus(); }, 50); e.preventDefault(); }
    else if (e.key === '[') { e.preventDefault(); toggleSidebar(); }
    else if (e.key === '/') { var s = $('#item-search') || $('#project-search'); if (s) { e.preventDefault(); s.focus(); } }
    else if (e.key === 'N' && isFte()) { projectSheet(null); }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'project-search') renderSidebar();
    if (e.target.id === 'item-search') {
      ui.query = e.target.value;
      var pos = e.target.selectionStart;
      renderPage();
      var s = $('#item-search'); s.focus(); s.setSelectionRange(pos, pos);
    }
    if (e.target.id === 'req-search') {
      ui.reqQuery = e.target.value;
      var rpos = e.target.selectionStart;
      renderPage();
      var rs = $('#req-search'); rs.focus(); rs.setSelectionRange(rpos, rpos);
    }
    if (e.target.id === 'spec-editor') {
      specDraft = e.target.value;
      if (specEditing === 'all') { var lo = $('#spec-live-outline'); if (lo) lo.innerHTML = specLiveOutline(); }
      var wn = $('#spec-editor-warn'); if (wn) wn.innerHTML = specDraftWarnHtml();
      specBarRefresh();
    }
    if (e.target.id === 'spec-link-search') {
      var sp3 = current(), ss3 = specSel(), a3 = sp3 && ss3 && M.specAnalysis(sp3), f3 = a3 && specFind(a3, ss3.sec, ss3.start);
      if (f3) $('#spec-link-results').innerHTML = specLinkResults(sp3, f3.u, e.target.value);
    }
    if (e.target.id === 'req-link-search') {
      // Only the result list redraws, so typing isn't interrupted.
      var rp = current(), rq = reqOf(rp, selected);
      if (rq) $('#req-link-results').innerHTML = linkResults(rq, checkIdx(rp), e.target.value);
    }
  });
  document.addEventListener('change', function (e) {
    var k = e.target.dataset && e.target.dataset.itemInput;
    if (k && selected) { var f = {}; f[k] = e.target.value.trim(); setItem(selected, f); }
    var rk = e.target.dataset && e.target.dataset.reqInput;
    if (rk && selected) {
      var rv = rk === 'text' || rk === 'evidence' ? e.target.value.trim() : e.target.value.trim();
      var cur = reqOf(current(), selected);
      if (cur && cur[rk] !== rv) { var rf2 = {}; rf2[rk] = rv; setReq(selected, rf2); }
    }
    if (e.target.id === 'import-file' && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; }
    if (e.target.id === 'spec-block-title') specBlockField('title', e.target.value);
    if (e.target.id === 'spec-block-gist') specBlockField('gist', e.target.value);
    if (e.target.classList && e.target.classList.contains('spec-block-use') && e.target.value) {
      var up = current(), uc = up && (up.spec || {})[specBlockSel()], uw = e.target.dataset.word;
      if (uc) specBlockField('link', M.specLinkText(M.specUsesItems(uc.body, uw).concat([{ name: e.target.value, label: '' }])), uw);
    }
    if (e.target.id === 'spec-block-parts') specBlockField('parts', e.target.value);
    if (e.target.id === 'spec-edge-label') specEdgeLabel(e.target.value);
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.dataset && e.target.dataset.add && e.key === 'Enter') {
      var parts = e.target.dataset.add.split('|');
      var id = addCustom(parts[0], parts[1], e.target.value);
      if (id) { toast('Check added to this ' + UNIT); var inp = document.querySelector('[data-add="' + parts[0] + '|' + parts[1] + '"]'); if (inp) inp.focus(); }
    }
  });
  document.addEventListener('focusout', function (e) {
    var id = e.target.dataset && e.target.dataset.editCustom;
    if (!id) return;
    var p = current(), text = e.target.textContent.trim();
    if (p && p.custom[id] && text && text !== p.custom[id].text) {
      p.custom[id] = M.stamp(Object.assign({}, p.custom[id], { text: text }), me());
      touch(p); renderPage();
    }
  });
  // Selecting words inside one sentence (in the document or the sentence panel) opens the sentence
  // to link just those words.
  document.addEventListener('mouseup', function (e) {
    if (ui.view !== 'spec' || specEditing) return;
    setTimeout(function () {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var el = function (n) { return n && (n.nodeType === 1 ? n : n.parentElement); };
      var a = el(sel.anchorNode) && el(sel.anchorNode).closest('.su'), b = el(sel.focusNode) && el(sel.focusNode).closest('.su');
      var text = String(sel).replace(/\s+/g, ' ').trim();
      if (!a || a !== b || !text || text.length < 2) return;
      var whole = a.textContent.replace(/@req/g, '').replace(/\s+/g, ' ').trim();
      if (text === whole) return;
      specOpenUnit(a.dataset.sec, parseInt(a.dataset.u, 10), text);
    }, 0);
  });
  ['keyup', 'click', 'focusin'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { if (e.target && e.target.id === 'spec-editor') specBarRefresh(); });
  });
  document.addEventListener('pointerdown', function (e) {
    var h = e.target.closest && e.target.closest('.spec-handle');
    if (h) { specDragStart(e, h); return; }
    if (e.target.closest && e.target.closest('svg.spec-flow')) { if (e.pointerType !== 'touch' || !e.target.closest('svg.spec-flow') || e.target.closest('.spec-node, .spec-group-g')) flowDown(e); return; }
    var n = e.target.closest && e.target.closest('.spec-map .spec-node');
    if (n && e.pointerType !== 'touch') specMoveDown(e, n);
  });
  document.addEventListener('pointermove', function (e) { if (specDrag) specDragMove(e); else if (specMove) specMoveMove(e); else if (flowDrag) flowMove(e); });
  // Pointing at a block in a diagram brings its own lines forward and fades the others (fan-outs).
  var specHover = null;
  function specHoverMap(n) {
    if (specHover === n) return;
    if (specHover) { var old = specHover.ownerSVGElement; if (old) { old.classList.remove('hovering'); old.querySelectorAll('.spec-edge.hov').forEach(function (x) { x.classList.remove('hov'); }); } }
    specHover = n;
    if (!n || !n.ownerSVGElement) return;
    var id = n.dataset.id, svg = n.ownerSVGElement;
    svg.classList.add('hovering');
    svg.querySelectorAll('.spec-edge').forEach(function (x) { if (x.dataset.a === id || x.dataset.b === id) x.classList.add('hov'); });
  }
  document.addEventListener('pointerover', function (e) {
    if (specDrag || specMove || flowDrag) return;
    var n = e.target.closest && e.target.closest('.spec-map .spec-node');
    specHoverMap(n && n.dataset.id ? n : null);
  });
  document.addEventListener('pointerup', function (e) { if (specDrag) specDragEnd(); else if (specMove) specMoveUp(); else if (flowDrag) flowUp(e); });
  document.addEventListener('pointercancel', function () { if (specDrag) specDragEnd(); specMove = null; });
  document.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('.spec-kindbar') && document.activeElement && document.activeElement.id === 'spec-editor') e.preventDefault(); });
  $('#main').addEventListener('scroll', function () { $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 60); }, { passive: true });

  // ── Boot ─────────────────────────────────────────────────
  function render() { var f = focusNow(); renderSidebar(); renderSyncState(); drawPage(); drawInspector(); restoreFocus(f); }

  applyTheme(settings.theme);
  // Applied on narrow windows too (styles.css only hides it above 860 px), so widening the window
  // later shows the sidebar as it was left.
  if (ui.sideCollapsed) $('#app').classList.add('side-collapsed');
  if (DEMO) {
    var banner = $('#demo-banner');
    banner.hidden = false;
    document.body.classList.add('has-banner');
    banner.innerHTML = 'You’re exploring a demo of ' + esc(C.product) + ', Dovetail’s ' + esc(C.tagline.toLowerCase()) + ' tool. Changes stay in this browser.<button data-act="reset-demo" id="reset-demo">Reset demo</button>';
    banner.querySelector('#reset-demo').addEventListener('click', function () {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf(C.storage.demoNs) === 0) localStorage.removeItem(k); });
      location.reload();
    });
  }
  // ?project=<id> opens that project, &item=<check id> that check, and &req=<requirement id> that
  // requirement (Signoff PL links here).
  // A project not in this browser yet is looked for again after the first sync.
  function param(name) { var m = new RegExp('[?&]' + name + '=([^&#]+)').exec(location.search); return m ? decodeURIComponent(m[1]) : ''; }
  var wantProject = param('project'), wantItem = '', wantReq = '';
  // ?page=people opens People & access over the page (old links from the other tools).
  var wantPeople = param('page') === 'people' && !DEMO && !EMBED;
  function openWanted(final) {
    if (!wantProject) return;
    var slug = Object.keys(projects).filter(function (k) { return projects[k].id === wantProject; })[0];
    if (slug) { ui.slug = slug; ui.view = 'overview'; ui.page = ''; wantProject = ''; wantItem = param('item'); wantReq = param('req'); saveUi(); }
    else if (final) { toast('That ' + UNIT + ' isn’t in this browser. Check that your token reaches its repository.'); wantProject = ''; }
  }
  // After a render: open the check the link asked for, if this project has it.
  function openWantedItem() {
    var rid = wantReq; wantReq = '';
    if (rid && current()) {
      if (reqOf(current(), rid)) { ui.view = 'reqs'; saveUi(); openReq(rid); }
      else toast('That requirement isn’t in this ' + UNIT + '.');
    }
    var id = wantItem; wantItem = '';
    if (!id || !current()) return;
    if (!itemDef(current(), id).retired) gotoItem(id);
    else toast('That check isn’t in this ' + UNIT + '.');
  }
  // ── Tool updates ─────────────────────────────────────────
  // A page left open keeps running the version it loaded. Now and then (on opening, every few
  // minutes, when the tab comes back into view, after a sync) it asks this site which version it
  // serves now. If that's another one, it reloads into it as soon as nothing is being typed or
  // edited, and the new page says "Tool updated". Every saved change is already in the browser, so
  // the reload waits only for what lives on the page alone: a Scribe section open for editing, a
  // comment typed but not sent, a sheet, a ticket, or People & access (staged edits), and a sync.
  // A version it already reloaded for is never tried twice, so a stale cache can't make it loop.
  var UPDATE_KEY = 'signoff.toolUpdate';   // sessionStorage: { tried: hash, from: hash }
  var updateWaiting = '', updateBusy = false;
  function updateMemo(v) {
    try {
      if (v === undefined) return JSON.parse(sessionStorage.getItem(UPDATE_KEY) || '{}') || {};
      if (v) sessionStorage.setItem(UPDATE_KEY, JSON.stringify(v)); else sessionStorage.removeItem(UPDATE_KEY);
    } catch (e) { return null; }
  }
  function pageIdle() {
    var a = document.activeElement;
    var typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    var draft = $('#comment-input');
    return !syncing && !typing && !specEditing && !(draft && draft.value.trim()) && !$('#sheet') && !$('#busy-wrap') && !$('#menu')
      && !document.querySelector('.tk-wrap, .tk-new, #people-pop') && !document.hidden;
  }
  function reloadWhenIdle() {
    if (!updateWaiting) return;
    if (!pageIdle()) { setTimeout(reloadWhenIdle, 3000); return; }
    var have = (window.SIGNOFF_VERSION || {}).hash;
    if (updateMemo({ tried: updateWaiting, from: have }) === null) { updateWaiting = ''; return; }   // storage blocked: no loop guard, so no reload
    location.reload();
  }
  function checkForUpdate() {
    var have = (window.SIGNOFF_VERSION || {}).hash;
    if (!have || updateBusy || updateWaiting || !window.fetch) return;
    updateBusy = true;
    fetch('assets/version.js?nc=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        updateBusy = false;
        var m = /hash:\s*'([0-9a-f]+)'/.exec(text || '');
        if (!m || m[1] === have || (updateMemo() || {}).tried === m[1]) return;
        updateWaiting = m[1];
        reloadWhenIdle();
      }, function () { updateBusy = false; });
  }
  (function () {
    if (EMBED) return;   // a framed People tab never reloads under someone editing it
    var memo = updateMemo() || {};
    if (memo.from && memo.from !== (window.SIGNOFF_VERSION || {}).hash) { updateMemo({ tried: memo.tried }); setTimeout(function () { toast('Tool updated'); }, 300); }
    setTimeout(checkForUpdate, 5000);
    setInterval(checkForUpdate, 5 * 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkForUpdate(); });
  })();

  if (!DEMO) noticeToken();
  if (window.SignoffTickets) window.SignoffTickets.where(function () {
    var p = current();
    if (!p) return {};
    var item = typeof selected === 'string' && /^[\w.:-]{1,80}$/.test(selected) ? selected : '';
    var title = $('#inspector.open .insp-title');
    return {
      unit: p.meta.name, item: item, itemLabel: item && title ? title.textContent.trim().slice(0, 120) : '',
      url: location.pathname + '?project=' + encodeURIComponent(p.id) + (item ? '&item=' + encodeURIComponent(item) : '') + (DEMO ? '&demo' : '')
    };
  });
  openWanted(DEMO || !getToken());
  if (!projects[ui.slug] && !(ui.home && !ui.slug)) ui.slug =Object.keys(projects).filter(function (k) { return !projects[k].meta.archived; })[0] || '';
  render();
  openWantedItem();
  returnFromFabcheck();
  // In the demo the first sheet shows once per browser across EE, ME, and FW, even when it's
  // skipped, so a visitor moving between pages isn't asked again and again.
  function demoWelcomed() {
    if (!DEMO) return false;
    try { if (localStorage.getItem('signoff.demo.welcomed')) return true; localStorage.setItem('signoff.demo.welcomed', '1'); } catch (e) { /* storage blocked */ }
    return false;
  }
  if (EMBED) { if (getToken()) sync(); }
  else if (!settings.user && !demoWelcomed()) settingsSheet(true);   // first opening, the demo included: ask for a name
  else if (!DEMO && getToken()) sync();
  // Accepted from the suite's invitations card: sync to pick up what was just joined.
  window.addEventListener('signoff:invites-accepted', function () { if (!DEMO && getToken()) sync(); });
  if (PEOPLE) PEOPLE.register(C.repos.toolRepo, { draw: function () { renderPage(); }, changed: function () { renderSidebar(); } });
  if (wantPeople) openPeople();
  setInterval(function () { renderSyncState(syncing ? 'busy' : undefined); }, 60000);

  S.app = { sync: sync, render: render, spec: specHook() };
})(window.Signoff = window.Signoff || {});
