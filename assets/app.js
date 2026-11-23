/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff app: state, storage, rendering, and interaction. */
(function (S) {
  'use strict';
  var M = S.model;
  var HIST = window.SignoffHistory;   // History, version tags, and Version comparison (assets/history.js)
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
  // True when it was saved. A full browser storage (every tool on this site shares it) makes it false.
  function save(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); return true; } catch (e) { toast('Couldn’t save in this browser: ' + e.message); return false; }
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
  // The reviews, their change markers, homes, and sync record live in IndexedDB (assets/localstore.js,
  // 2026-11-19), loaded before anything is drawn (boot, at the end). Until then nothing is saved.
  var LOCAL = window.SignoffLocal ? window.SignoffLocal.store(NS) : null;
  var ready = false;
  var projects = {};                        // slug -> project document (working copy)
  var dirty = {};                           // project id (or 'roster') -> time of last unsynced edit
  var homes = {};                           // project id -> 'owner/repo' it lives in
  var touchedAt = {};                       // project id -> Date.now() of this tab's last edit
  var cache = {};                           // 'owner/repo' -> { path: { sha, fp } } as of the last sync
  var bases = {};                           // project id -> Scribe base as this browser last synced it
  var dataAccess = load('dataAccess', '');  // 'ok' (FTE) | 'none' (contractor) | '' (not synced yet)
  var roster = Object.assign(M.emptyRoster(), load('roster', {}));   // users.json from the data repo
  if (settings.prefix === 'review-' && settings.prefix !== C.repos.prefix && !Object.keys(roster.shared || {}).length) {
    // Shared repos used to be review-<project> for EE. Each tool now has its own prefix, so a
    // contractor's sync never picks up the other discipline's repos.
    settings.prefix = C.repos.prefix; save('settings', settings);
  }
  function tidyDirty() {
    Object.keys(dirty).forEach(function (k) { if (projects[k]) { dirty[projects[k].id] = dirty[k]; delete dirty[k]; } });
    // A change marker for a project that isn't here has nothing to sync.
    var ids = {}; Object.keys(projects).forEach(function (k) { ids[projects[k].id] = 1; });
    var gone = Object.keys(dirty).filter(function (k) { return k !== 'roster' && !ids[k]; });
    gone.forEach(function (k) { delete dirty[k]; });
    return gone.length > 0;
  }
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
  // built by an older version is rebuilt. (Run from boot, once the reviews have loaded.)
  function seedDemo() {
    if (!(DEMO && S.demo && (!Object.keys(projects).length || load('demoVersion', 0) !== S.demo.VERSION))) return false;
    projects = {};
    S.demo.projects(TEMPLATES).forEach(function (p) { projects[p.slug] = p; });
    save('demoVersion', S.demo.VERSION);
    return true;
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
  // ...and put back any sample project such a tab replaced, so none goes missing either. (From boot.)
  function fixDemo() {
    if (!(DEMO && S.demo)) return false;
    var cleaned = dropStaleDemo(projects), have = {}, fixed = Object.keys(cleaned).length !== Object.keys(projects).length;
    Object.keys(cleaned).forEach(function (k) { have[cleaned[k].id] = 1; });
    S.demo.projects(TEMPLATES).forEach(function (p) {
      if (have[p.id]) return;
      var key = p.slug, n = 2;
      while (cleaned[key]) key = p.slug + '-' + n++;
      cleaned[key] = p; fixed = true;
    });
    if (fixed) projects = cleaned;
    return fixed;
  }

  // Saves to the local store: the whole projects map (only changed reviews are written) and any of dirty,
  // homes, cache2, and bases given, in one transaction. Resolves true or false. Nothing before boot.
  function storeSave(state) {
    if (!ready) return Promise.resolve(false);
    var p = LOCAL ? LOCAL.save(state) : Promise.resolve(['projects', 'dirty', 'homes', 'cache2', 'bases'].every(function (k) { return !state[k] || save(k, state[k]); }));
    return p.then(function (ok) { if (!ok) toast('Couldn’t save in this browser. Your changes are on this page until it’s closed: sync now to keep them.'); return ok; });
  }
  function persist() { save('roster', roster); storeSave({ projects: projects, dirty: dirty, homes: homes }); }
  // How this browser's copy of a project merges with GitHub's (GitHubStore.sync, model.mergeSpec): three
  // ways against what it last pulled; without a base (not synced since this was added), a copy with
  // no unsynced edits counts as all synced. A copy with none isn't merged at all (syncEdited).
  // The bases (`bases`, kept in the local store: project id -> { section id: model.specStampKey } of its Scribe
  // as this browser last synced it) are taken when a sync starts and written only when one ends, with the
  // reviews they describe; a tab that didn't run the sync takes the newer ones when told (onLocalChange).
  function mergeOpts(id, all) { var b = (all || bases)[id]; return b ? { base: b } : { since: dirty[id] ? '' : '\uffff' }; }
  function syncEdited(id) { return !!dirty[id]; }

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
  function saveUi() { save('ui', { slug: ui.slug, view: ui.view, filter: ui.filter, showArchived: ui.showArchived, sideCollapsed: !!ui.sideCollapsed, reqFilter: ui.reqFilter || 'all', reworkView: ui.reworkView === 'rework' ? 'rework' : 'checklist', rwFilter: ui.rwFilter || 'all', closedGroups: ui.closedGroups || {}, home: !!ui.home }); }
  // Close the open review and show the home screen; it stays there on reload (ui.home).
  function goHome() {
    ui.slug = ''; ui.view = 'overview'; ui.page = ''; ui.query = ''; ui.filter = 'all'; ui.home = true; selected = null;
    closeInspector(); saveUi(); render(); $('#main').scrollTop = 0;
  }
  // The home page (config.home, assets/home.js; EE only): tools and the team's standards, shown in place of the
  // empty page once someone is signed in (any role: everyone reads the standards, FTEs edit them). The sidebar's
  // logo opens it.
  var HOME = C.home && window.SignoffHome ? window.SignoffHome : null;
  function homeShown() { return !!HOME && !EMBED && (DEMO || (!signedOut() && !checking())); }
  function homeCtx() {
    // With no boards yet, the empty page's message and buttons stay, above the tools.
    var none = !visibleProjects().length, note = '';
    if (none && isFte()) note = '<p>No ' + UNITS + ' yet. Create a review, choose the checklists and what kind of ' + W.thing + ' it is, and Signoff builds a review tailored to it.</p><button class="btn btn-primary" data-act="new-project">New ' + UNIT + '</button>' + (DEMO ? '' : ' ' + syncNowButton('Pull from GitHub'));
    else if (none) note = '<p>No ' + UNITS + ' shared with you yet. Signed in as <b>' + esc(settings.login) + '</b>. ' + (waitingInvites() ? 'Accept your invitation in the sidebar.' : 'Ask your Dovetail contact to add you to a ' + UNIT + ', then sync.') + '</p>' + syncNowButton('Sync now', true);
    return { demo: DEMO, fte: isFte(), login: DEMO ? DEMO_USER : (settings.login || ''), toast: toast, goHome: goHome, note: note };
  }
  function setupHome() {
    var brand = $('.brand');
    if (!HOME || !brand) return;
    brand.classList.add('brand-home');
    ['.brand-mark', '.brand-text'].forEach(function (sel) {
      var el = brand.querySelector(sel);
      if (!el) return;
      el.setAttribute('role', 'link'); el.setAttribute('tabindex', '0'); el.title = 'Home';
      if (sel === '.brand-mark') el.removeAttribute('aria-hidden');
      el.setAttribute('aria-label', 'Home');
      function open(e) { e.preventDefault(); HOME.reset(); goHome(); if (narrow.matches) $('#app').classList.remove('nav-open'); }
      el.addEventListener('click', open);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') open(e); });
    });
    // A link or reload into a standards deck (#standards/<deck>) opens the home page, not a board.
    if (/^#standards\//.test(location.hash)) { ui.slug = ''; ui.home = true; }
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
  // While a Version comparison shows its tagged side (assets/history.js), the page draws that version: a
  // copy that's never in `projects`, and that touch() refuses to save.
  function current() {
    var p = projects[ui.slug];
    if (!p || !visible(p)) { if (HIST.compare.active()) HIST.compare.exit(true); return null; }
    HIST.compare.check(p.id);
    return HIST.compare.view(p.id) || p;
  }
  function templateById(id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0]; }
  function projectTemplates(p) { return TEMPLATES.filter(function (t) { return p.meta.checklists.indexOf(t.id) >= 0; }); }

  function touch(p) {
    // An edit to the tagged version being compared is dropped, and the page goes back to it as stored.
    if (HIST.compare.isCopy(p)) { HIST.compare.refuse(); HIST.compare.reset(); render(); return; }
    if (specHists[p.id]) specHistNote(p);
    dirty[p.id] = M.now();
    touchedAt[p.id] = Date.now();
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
    // Before the first sync after a sign-in, the sign-in itself says who it is. Never the data repo's
    // owner: that read as the wrong account (Chris, 2026-11-13).
    var signedAs = !who && getToken() && window.SignoffAuth ? window.SignoffAuth.status().login : '';
    if (signedAs) who = '@' + signedAs;
    function line2(fallback) { sub.textContent = who || fallback; if (who) sub.classList.add('sync-who'); }
    if (DEMO) { dot.dataset.tone = 'idle'; title.textContent = 'Demo mode'; sub.textContent = 'Changes stay in this browser'; return; }
    if (state === 'busy') { dot.dataset.tone = 'busy'; title.textContent = 'Syncing\u2026'; line2('Checking your token'); return; }
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
  var CHANGE_KIND = { meta: 'Details', check: 'Check', section: 'Section', comment: 'Comment', custom: 'Added check', req: 'Requirement', revision: 'Revision', spec: 'Scribe', tag: 'Version tag', rework: 'Rework', release: 'Release' };
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
    ui.view = kind === 'req' && reqsOn(p) ? 'reqs' : kind === 'revision' && C.runs ? 'revisions' : kind === 'release' && C.releases ? 'releases' : kind === 'spec' && specOn(p) ? 'spec' : 'overview';
    closeInspector(); saveUi(); render(); $('#app').classList.remove('nav-open');
    if (kind === 'req' && !gone && ui.view === 'reqs' && reqOf(p, id)) openReq(id);
    else if ((kind === 'rework' && !gone && reworkOf(p, id)) || (kind === 'comment' && item && reworkOf(p, item))) openRework(kind === 'rework' ? id : item);
    else if ((kind === 'check' || kind === 'custom' || kind === 'comment') && item && (!gone || kind === 'comment') && !itemDef(p, item).retired) gotoItem(item);
    else if (kind === 'spec' && !gone && ui.view === 'spec') specGoto(id);
    else if (kind === 'release' && !gone && ui.view === 'releases') { relOpen[id] = true; renderPage(); }
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
    if (C.releases) views.push({ id: 'releases', label: 'Releases' });
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
  // Side by side (Chris, 2026-11-21): the section being edited glows and pulses in the diagrams, with its own blocks
  // and its lines, and everything else dims.
  var specEditSeen = null;   // the section the pane last scrolled to, so a redraw mid-edit doesn't pull it back
  function specEditMark(page) {
    var map = page.querySelector('.spec-side-map'), id = specEditing;
    if (!map || !id || id === 'all' || id === 'new') { specEditSeen = null; return; }
    var mine = function (el) { return el.dataset.id === id || (el.dataset.anc || '').split(' ').indexOf(id) >= 0; };
    var ids = {}, parts = '.spec-node[data-id], .spec-group-g[data-id]';
    ids[id] = 1;   // the power tree's blocks carry no ancestors, so gather the section's blocks from every diagram first
    Array.prototype.forEach.call(map.querySelectorAll(parts), function (g) { if (mine(g)) ids[g.dataset.id] = 1; });
    Array.prototype.forEach.call(map.querySelectorAll('svg.spec-map'), function (svg) {
      var hit = false;
      Array.prototype.forEach.call(svg.querySelectorAll(parts), function (g) {
        var m = !!ids[g.dataset.id]; if (m) hit = true;
        g.classList.add(m ? 'spec-edit-in' : 'spec-edit-out');
        if (g.dataset.id === id) g.classList.add('spec-edit-me');
      });
      if (!hit) return;
      svg.classList.add('spec-editing');
      Array.prototype.forEach.call(svg.querySelectorAll('.spec-edge[data-a], .spec-edge-hit[data-a]'), function (e) {
        e.classList.add(ids[e.dataset.a] || ids[e.dataset.b] ? 'spec-edit-in' : 'spec-edit-out');
      });
      Array.prototype.forEach.call(svg.querySelectorAll('.spec-edge-label'), function (l) {
        var ab = (l.dataset.line || '').split('|')[0].split('>');   // "a>b|word"; FW's map labels name their link
        l.classList.add(ids[ab[0]] || ids[ab[1]] || ids[l.dataset.from] || ids[l.dataset.id] ? 'spec-edit-in' : 'spec-edit-out');
      });
    });
    // Bring it into the pane when the edit opens, unless it's already in full view (Chris, 2026-11-21).
    var me = map.querySelector('.spec-edit-me');
    if (me && specEditSeen !== id) {
      specEditSeen = id;
      var r = me.getBoundingClientRect(), v = map.getBoundingClientRect();
      if (r.top < v.top || r.bottom > v.bottom) {
        var top = map.scrollTop + r.top - v.top - Math.max(16, (v.height - r.height) / 2);
        map.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    }
  }
  function renderPage() { var f = focusNow(); drawPage(); restoreFocus(f); }   // keeps the field being typed in (focusNow)
  function drawPage() {
    var p = current();
    var page = $('#page');
    var scroll = $('#main').scrollTop;
    var side = page.querySelector('.spec-side-map'), sideAt = side ? [side.scrollTop, side.scrollLeft] : null;   // Side by side's diagram scrolls by itself
    drawPeople();
    if (EMBED) { page.innerHTML = peopleOrNotice(); return; }
    ui.page = '';
    if (!p) { if (homeShown()) HOME.mount(page, homeCtx()); else page.innerHTML = emptyPage(); renderToolbar(); return; }
    if (HOME) HOME.leave();
    renderToolbar();
    if (ui.view === 'overview') { page.innerHTML = overviewPage(p); loadPicture(p); }
    else if (ui.view === 'findings') page.innerHTML = findingsPage(p);
    else if (ui.view === 'revisions') { loadRuns(p); page.innerHTML = revisionsPage(p); }
    else if (ui.view === 'releases') page.innerHTML = releasesPage(p);
    else if (ui.view === 'reqs') page.innerHTML = reqsPage(p);
    else if (ui.view === 'spec') { page.innerHTML = specPage(p); specMountEditor(); }
    else if (reworkTab(p) && ui.reworkView === 'rework') page.innerHTML = reworkPage(p);
    else page.innerHTML = checklistPage(p, templateById(ui.view));
    $('#main').scrollTop = scroll;
    var side2 = sideAt && page.querySelector('.spec-side-map'); if (side2) { side2.scrollTop = sideAt[0]; side2.scrollLeft = sideAt[1]; }
    if (ui.view === 'spec') specEditMark(page);
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
      (isFte() ? '<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="edit-project">Edit profile</button>' : '') +
      // The Scribe diagram, one click from the overview (Chris, 2026-11-21).
      (specOn(p) && M.liveSpec(p).length ? '<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="open-diagram" title="Open ' + esc(SPEC_LABEL) + '’s diagram">' + (SPEC_FLOW ? 'Block diagram' : 'Diagram') + '</button>' : '') + '</div>' +
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
    var html = '<div class="page">' + (C.rework && t.id === C.rework.template ? reworkSwitch(p) : '') +
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
    if (specBlockSel() || specEdgeSel() || selected === 'specdiagram') { selected = null; renderPage(); }
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
      ($('#inspector').classList.contains('open') || !!specBlockSel() || !!specEdgeSel() || !!specPtSel());
  }
  // Show a check in its checklist (even if its section is collapsed or set aside) and open it.
  function gotoItem(id) {
    if (reworkOf(current(), id)) { openRework(id); return; }
    var d = itemDef(current(), id);
    if (d.template) { ui.view = d.template.id; ui.filter = 'all'; ui.query = ''; collapsed[(d.section || {}).id] = false; showHidden[(d.section || {}).id] = true; saveUi(); renderPage(); }
    select(id, true);
  }

  // ── Picture beside the progress ring (docs/fabcheck-link.md, "Board previews") ──
  // The pictures a checker stored with the latest run, read from the project's home repo once
  // per page load. A tool sets config.previews.dir (Fabcheck's folder for Signoff EE); without
  // it, or without a stored picture, the header shows the ring alone.
  var pics = {};   // project id -> { state: 'loading' | 'none' | 'ok', images: [{ key, url }], hero, runId, parts, heroPart, store }
  var PIC_TYPES = { 'image/webp': 1, 'image/png': 1 };
  // A checker's folder for this review in its home repo (Fabcheck's fabcheck/<id>/), under the
  // data path when the review lives in the data repo.
  function checkerDir(p, dir) {
    var home = homeOf(p), isData = home.toLowerCase() === (settings.owner + '/' + settings.dataRepo).toLowerCase();
    return (isData && settings.dataPath ? settings.dataPath.replace(/\/+$/, '') + '/' : '') + dir + p.id + '/';
  }
  function picDir(p) { return checkerDir(p, C.previews.dir) + 'preview/'; }
  // Part models (config.previews.models, Signoff ME; signoff_pl/docs/part-models.md): the folder holds every
  // part's pictures and PL's mesh, written by Partcheck's Send, Signoff PL, and Attach a model here. The
  // overview shows one part (the hero, or the one picked), turns it in 3D, and attaches or removes a model.
  var MODELS = !!(C.previews && C.previews.models);
  if (MODELS && S.model3d) S.model3d.workerUrl = 'assets/vendor/occt-worker.js';
  var STORED_BY = { partcheck: ['From Partcheck', 'sent'], pl: ['Attached in Signoff PL', 'attached'], me: ['Attached in ' + C.product, 'attached'] };
  // The files an index names (as model3d.parts.named, which EE doesn't load).
  function folderFiles(doc) {
    var out = ['index.json'];
    ((doc && doc.images) || []).forEach(function (i) { if (i && i.file) out.push(i.file); });
    ((doc && doc.parts) || []).forEach(function (x) { [x && x.mesh, x && x.step].forEach(function (f) { if (f && f.file) out.push(f.file); }); });
    return out;
  }
  // The demo's folder: assets/demo-previews/<id>/ as Partcheck's demo Send stored it (partcheck/tools/pl_demo.html),
  // read through the same code as a repo; what's attached here stays in this page (a reload starts over).
  var demoFolders = {};
  function demoStore(p) {
    var base = 'assets/demo-previews/' + p.id + '/', dir = 'demo/' + p.id + '/';
    var mem = demoFolders[p.id] = demoFolders[p.id] || { files: {}, index: undefined };
    function index() {
      if (mem.index !== undefined) return Promise.resolve(mem.index);
      return fetch(base + 'index.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        .then(function (d) { if (mem.index === undefined) mem.index = d; return mem.index; });
    }
    function snapshot() {
      return index().then(function (d) {
        return { head: 'demo', entries: d ? folderFiles(d).map(function (n) { return { type: 'blob', path: dir + n, sha: dir + n }; }) : [] };
      });
    }
    return {
      dir: dir, snapshot: snapshot,
      listTree: function (prefix) { return snapshot().then(function (s) { return s.entries.filter(function (e) { return e.path.indexOf(prefix) === 0; }); }); },
      blobBytes: function (sha) {
        var name = sha.slice(dir.length);
        if (name === 'index.json') return Promise.resolve(new TextEncoder().encode(JSON.stringify(mem.index)));
        if (mem.files[name]) return Promise.resolve(mem.files[name]);
        return fetch(base + name).then(function (r) { if (!r.ok) throw new Error('not found'); return r.arrayBuffer(); }).then(function (b) { return new Uint8Array(b); });
      },
      putFiles: function (files) {
        files.forEach(function (f) {
          var name = f.path.slice(dir.length);
          if (name === 'index.json') { mem.index = f.remove ? null : JSON.parse(f.text); return; }
          if (f.remove) delete mem.files[name]; else mem.files[name] = f.bytes;
        });
        return Promise.resolve({ pushed: files.length });
      }
    };
  }
  // Where a review's pictures are, and a store to read (and, with models, write) them.
  function picHome(p) {
    if (DEMO) { var ds = demoStore(p); return { store: ds, dir: ds.dir }; }
    return { store: workspace().store(homeOf(p)), dir: picDir(p) };
  }
  function loadPicture(p) {
    if (!C.previews || pics[p.id]) return;
    var dp = DEMO && ((C.demo || {}).pictures || {})[p.id];
    if (DEMO && !(dp && dp.folder)) {
      // ["top", ...] (SVGs), or { run, keys, ext }: the board's Fabcheck pictures and its demo run.
      var keys = dp && (Array.isArray(dp) ? dp : dp.keys), ext = (dp && dp.ext) || 'svg';
      pics[p.id] = keys ? { state: 'ok', hero: keys[0], runId: (dp && dp.run) || '', images: keys.map(function (k) { return { key: k, url: 'assets/demo-previews/' + p.id + '-' + k + '.' + ext }; }) } : { state: 'none' };
      return showPicture(p);
    }
    if (!DEMO && !getToken()) return;
    pics[p.id] = { state: 'loading' };
    var h = picHome(p), store = h.store, dir = h.dir;
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
        // A review of several parts (Partcheck's `parts`, partcheck/docs/send-to-signoff-me.md): each part's
        // views (iso, top, front, right) and, with models, its mesh and STEP.
        var known = {};
        want.forEach(function (i) { known[i.key] = 1; });
        var file = function (f, re) { return f && re.test(String(f.file || '')) && sha[dir + f.file] ? sha[dir + f.file] : ''; };
        var parts = (Array.isArray(doc.parts) ? doc.parts : []).filter(function (x) { return x && x.views && typeof x.views === 'object'; }).map(function (x) {
          var views = {};
          Object.keys(x.views).forEach(function (v) { if (/^[a-z]{1,12}$/.test(v) && known[x.views[v]]) views[v] = x.views[v]; });
          return { key: String(x.key || ''), partNumber: String(x.partNumber || ''), name: String(x.name || ''), views: views,
            mesh: file(x.mesh, /^[a-z0-9-]{1,32}\.plm\.gz$/), step: file(x.step, /^[a-z0-9-]{1,32}\.step\.gz$/),
            source: STORED_BY[x.source] ? x.source : 'partcheck', at: String(x.at || doc.at || ''), by: String(x.by || ''), file: String(x.file || '') };
        }).filter(function (x) { return Object.keys(x.views).length || x.mesh; });
        var hp = parts.filter(function (x) { return Object.keys(x.views).some(function (v) { return x.views[v] === doc.hero; }); })[0];
        return Promise.all(want.map(function (i) {
          return store.blobBytes(sha[dir + i.file]).then(function (b) { return { key: i.key, url: URL.createObjectURL(new Blob([b], { type: i.type })) }; });
        })).then(function (images) {
          if (!images.length && !parts.length) return null;
          // Only Fabcheck's runs (config.runs) open from the picture.
          return { state: 'ok', images: images, parts: parts, heroPart: hp ? hp.key : '', store: store,
            hero: images.some(function (x) { return x.key === doc.hero; }) ? doc.hero : (images[0] ? images[0].key : ''),
            runId: C.runs && C.runs.tool === 'fabcheck' && /^[A-Za-z0-9_-]{1,64}$/.test(doc.runId || '') ? doc.runId : '' };
        });
      });
    }).then(function (got) { pics[p.id] = got || { state: 'none' }; showPicture(p); }, function () { pics[p.id] = { state: 'none' }; showPicture(p); });
  }
  function showPicture(p) {
    var box = document.querySelector('.head-pic[data-pic="' + p.id + '"]');
    if (!box) return;
    var was = box.childElementCount;
    box.innerHTML = picHtml(p);
    load3d(p, box);
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
  // The part the overview shows: the one picked (ui.picPart), else the hero part.
  function picPart(p, pc) {
    var parts = (pc && pc.parts) || [], want = (ui.picPart || {})[p.id] || pc.heroPart;
    return parts.filter(function (x) { return x.key === want; })[0] || parts.filter(function (x) { return x.key === pc.heroPart; })[0] || parts[0] || null;
  }
  // The pictures to show: a part's views named by view, else the folder's own.
  function picSides(pc, part) {
    if (!part) return pc.images;
    return Object.keys(part.views).map(function (v) {
      var i = pc.images.filter(function (x) { return x.key === part.views[v]; })[0];
      return i && { key: v, url: i.url };
    }).filter(Boolean);
  }
  function picHtml(p) {
    var pc = pics[p.id];
    // With models, a review with nothing stored yet still offers to attach one (once signed in, or in the demo).
    if (MODELS && pc && pc.state === 'none' && S.model3d && (DEMO || getToken())) return '<div class="head-pic-acts"><button class="btn btn-sm" data-act="model-attach">Attach a model…</button></div>';
    if (!pc || pc.state !== 'ok') return '';
    var part = picPart(p, pc), images = picSides(pc, part), three = MODELS && part && part.mesh && S.model3d;
    var sides = images.map(function (i) { return i.key; }).concat(three ? ['3d'] : []);
    var key = sides.indexOf(ui.picSide) >= 0 ? ui.picSide : (part ? (images.some(function (i) { return i.key === 'iso'; }) ? 'iso' : sides[0]) : pc.hero);
    var html;
    if (key === '3d') html = '<canvas class="m3d head-3d" data-mesh="' + esc(part.mesh) + '" aria-label="' + esc(p.meta.name) + ' in 3D: drag to turn, scroll to zoom"></canvas>';
    else {
      var img = images.filter(function (i) { return i.key === key; })[0] || images[0];
      if (!img) return '';
      var pic = '<img alt="' + esc(p.meta.name + ', ' + img.key) + '" src="' + esc(img.url) + '">';
      html = pc.runId ? '<button class="head-pic-img" data-act="open-fabcheck" data-run="' + esc(pc.runId) + '" data-href="' + esc(fabcheckUrl(p, { run: { id: pc.runId } })) + '" title="Open the latest stored run in Fabcheck">' + pic + '</button>'
        : '<span class="head-pic-img">' + pic + '</span>';
    }
    html += sides.length > 1 ? '<div class="seg">' + sides.map(function (k) {
      return '<button class="' + (k === key ? 'on' : '') + '" data-act="pic-side" data-key="' + esc(k) + '">' + (k === '3d' ? '3D' : esc(k.charAt(0).toUpperCase() + k.slice(1))) + '</button>';
    }).join('') + '</div>' : '';
    if (MODELS && part) {
      var w = STORED_BY[part.source] || STORED_BY.partcheck, multi = pc.parts.length > 1;
      html += '<div class="head-pic-by">' + (multi ? '<select class="head-pic-part" data-pic-part="' + esc(p.id) + '" aria-label="Part">' + pc.parts.map(function (x) {
        return '<option value="' + esc(x.key) + '"' + (x === part ? ' selected' : '') + '>' + esc(x.partNumber || x.name || x.key) + '</option>';
      }).join('') + '</select> ' : '') + esc(w[0] + (part.at ? ', ' + w[1] + ' ' + relTime(part.at) : '') + (part.by && part.source !== 'partcheck' ? ' by ' + part.by : '')) + '</div>';
      if (S.model3d && (DEMO || getToken())) html += '<div class="head-pic-acts"><button class="btn btn-sm" data-act="model-attach">Attach a model…</button>' +
        (part.step ? '<button class="btn btn-sm" data-act="model-step">Download STEP</button>' : '') +
        '<button class="btn btn-sm" data-act="model-remove">Remove</button></div>';
    }
    return html;
  }
  // The 3D side: PL's viewer over the part's stored mesh (decoded once per mesh).
  var meshes = {};
  function load3d(p, box) {
    var cv = box && box.querySelector('canvas.m3d[data-mesh]'), pc = pics[p.id];
    if (!cv || !pc || !pc.store) return;
    var sha = cv.getAttribute('data-mesh');
    cv.removeAttribute('data-mesh');
    if (!meshes[sha]) {
      meshes[sha] = pc.store.blobBytes(sha).then(function (b) { return S.model3d.decode(b); });
      meshes[sha].catch(function () { delete meshes[sha]; });
    }
    meshes[sha].then(function (mesh) { if (cv.isConnected) S.model3d.viewer(cv, mesh); }, function () { toast('Couldn’t load the 3D model'); });
  }
  // Attach a model: a STEP read in this page (model3d.prepare) and kept with the review for every tool
  // (model3d.parts.put): Signoff PL and Partcheck see it too, and anyone the review is shared with.
  function modelSheet(p) {
    var pc = pics[p.id] || {}, parts = pc.parts || [], cur = pc.state === 'ok' ? picPart(p, pc) : null, prep = null, busy = false;
    var w = sheet('<div class="sheet-head"><h2>Attach a model</h2><p>Read in this browser, then kept with this ' + esc(UNIT) + ': a simplified model (at most ' +
      S.model3d.MAX_TRIS.toLocaleString() + ' triangles), its pictures, and the STEP if you keep it, compressed. Signoff PL, Partcheck, and anyone this ' + esc(UNIT) +
      ' is shared with see it. It replaces any model with the same part number.</p></div><div class="sheet-body">' +
      '<div class="field"><label for="m-pn">Part number</label><input class="input" id="m-pn" list="m-pn-list" value="' + esc(cur ? cur.partNumber : p.meta.board || '') + '" maxlength="80">' +
      '<datalist id="m-pn-list">' + parts.map(function (x) { return '<option value="' + esc(x.partNumber) + '">'; }).join('') + '</datalist></div>' +
      '<div class="field"><label for="m-file">STEP file</label><input class="input" id="m-file" type="file" accept=".step,.stp"></div>' +
      '<p class="note" id="m-status">Pick a STEP (.step or .stp).</p>' +
      '<label class="check"><input type="checkbox" id="m-keep" checked> Also keep the original STEP (compressed)</label></div>' +
      '<div class="sheet-foot"><button class="btn" data-m="cancel">Cancel</button><button class="btn btn-primary" data-m="save" disabled>Attach</button></div>', { sticky: true });
    var status = w.querySelector('#m-status'), save = w.querySelector('[data-m="save"]');
    w.querySelector('#m-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      prep = null; save.disabled = true;
      if (!f) return;
      if (!/\.(step|stp)$/i.test(f.name)) { status.textContent = 'Pick a STEP file (.step or .stp).'; return; }
      if (f.size > 300 * 1048576) { status.textContent = 'That STEP is over 300 MB; export a lighter one and try again.'; return; }
      status.textContent = 'Reading ' + f.name + '…';
      f.arrayBuffer().then(function (buf) { return S.model3d.prepare(f.name, new Uint8Array(buf), function (msg) { status.textContent = msg; }); }).then(function (pr) {
        prep = pr; save.disabled = false;
        var keep = w.querySelector('#m-keep');
        keep.disabled = !pr.stepFits; if (!pr.stepFits) keep.checked = false;
        status.textContent = pr.name + ': ' + pr.bboxMm.join(' × ') + ' mm, ' + pr.tris.toLocaleString() + ' triangles' + (pr.srcTris > pr.tris ? ' (simplified from ' + pr.srcTris.toLocaleString() + ')' : '') +
          (pr.stepFits ? '' : '. The STEP is over ' + Math.round(S.model3d.STEP_CAP / 1048576) + ' MB compressed, so only the model and pictures are kept.');
      }, function (err) { status.textContent = 'Couldn’t read ' + f.name + ': ' + err.message; });
    });
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m]');
      if (!b || busy) return;
      if (b.dataset.m === 'cancel') return closeSheet();
      var pn = w.querySelector('#m-pn').value.trim();
      if (!prep) return;
      if (!pn) { w.querySelector('#m-pn').focus(); return; }
      busy = true; save.disabled = true; status.textContent = 'Saving with the ' + UNIT + '…';
      var h = picHome(p), old = parts.filter(function (x) { return x.partNumber.trim().toLowerCase() === pn.toLowerCase(); })[0];
      S.model3d.parts.put(h.store, h.dir, { prep: prep, partNumber: pn, name: old ? old.name : (pn === (p.meta.board || '') ? p.meta.name : ''), source: 'me', by: me(),
        keepStep: w.querySelector('#m-keep').checked, message: C.product + ': model for ' + pn + ' (' + me() + ')' }).then(function () {
        closeSheet();
        (ui.picPart = ui.picPart || {})[p.id] = '';
        reloadPicture(p);
        toast('Model attached: Signoff PL and Partcheck see it too');
      }, function (err) { busy = false; save.disabled = false; status.textContent = 'Couldn’t save it: ' + (err.code === 'moved' ? 'someone else kept changing it; try again' : err.message); });
    });
  }
  function reloadPicture(p) {
    var pc = pics[p.id];
    if (pc && pc.images) pc.images.forEach(function (i) { if (/^blob:/.test(i.url)) URL.revokeObjectURL(i.url); });
    delete pics[p.id];
    loadPicture(p);
  }
  function removeModel(p) {
    var pc = pics[p.id], part = pc && pc.state === 'ok' && picPart(p, pc);
    if (!part) return;
    if (!confirm('Remove the model of ' + (part.partNumber || 'this part') + ' from this ' + UNIT + '? Signoff PL and Partcheck stop showing it too. Git keeps the old files.')) return;
    var h = picHome(p);
    S.model3d.parts.remove(h.store, h.dir, part.partNumber, C.product + ': model for ' + (part.partNumber || 'a part') + ' removed (' + me() + ')')
      .then(function () { reloadPicture(p); toast('Model removed'); }, function (err) { toast('Couldn’t remove it: ' + err.message); });
  }
  function downloadModelStep(p) {
    var pc = pics[p.id], part = pc && pc.state === 'ok' && picPart(p, pc);
    if (!part || !part.step) return;
    pc.store.blobBytes(part.step).then(function (b) { return S.model3d.gzip(b, 'gunzip'); }).then(function (bytes) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/step' }));
      a.download = part.file || (part.partNumber || 'model') + '.step'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }, function () { toast('Couldn’t get the STEP file'); });
  }
  document.addEventListener('change', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-pic-part');
    if (!id) return;
    (ui.picPart = ui.picPart || {})[id] = e.target.value;
    var p = current();
    if (p && p.id === id) showPicture(p);
  });

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
  // Reworks ticked Fix in the next revision come first, with any @revnotes comments on them.
  function revNotesSection(p) {
    var groups = M.revNotes(p), on = C.rework && M.reworkOn(p);
    if (on) {
      var byItem = {}; groups.forEach(function (g) { byItem[g.item] = g; });
      var nexts = M.liveRework(p).filter(function (r) { return r.next; }).map(function (r) { return byItem[r.id] || { item: r.id, at: '', comments: [] }; });
      groups = nexts.concat(groups.filter(function (g) { return nexts.indexOf(g) < 0; }));
    }
    // Notes on the whole review (typed below, or @revnotes in a comment on the review) sit last, by the box.
    var whole = groups.filter(function (g) { return !g.item; })[0];
    groups = groups.filter(function (g) { return g.item; });
    var count = groups.length + (whole ? whole.comments.length : 0);
    var html = '<div class="section-title">Next revision updates' + (count ? ' <span class="muted rev-notes-count">' + plural(count, 'item') + '</span>' : '') + '</div>';
    var add = '<div class="rev-note-add"><textarea class="input" id="revnote-input" rows="2" placeholder="Add an update for the next revision…" aria-label="Add an update for the next revision">' + esc(revDraftId === p.id ? revDraft : '') +'</textarea>' +
      '<div class="rev-note-add-foot"><span class="muted">Saved as a note on the whole ' + esc(UNIT) + '. <b>@revnotes</b> in any comment' + (on ? ', or <b>Fix in the next revision</b> on a rework,' : '') + ' lists it here too. <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to add.</span>' +
      '<button class="btn btn-primary btn-sm" data-act="revnote-add">Add</button></div></div>';
    var mine = whole ? '<div class="rev-note rev-note-whole"><div class="rev-note-label muted">Notes on the whole ' + esc(UNIT) + '</div>' + whole.comments.map(function (c) {
      return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span>' + relTime(c.at) + '</span>' +
        '<button class="icon-btn rev-note-del" data-act="del-comment" data-id="' + esc(c.id) + '" title="Delete this note" aria-label="Delete this note">' + ICON.close + '</button></div>' +
        '<div class="cmt-text">' + esc(M.stripRevNote(c.text) || c.text) + '</div></div></div>';
    }).join('') + '</div>' : '';
    return html + '<div class="card rev-notes-list">' + groups.map(function (g) {
      var w = g.item && reworkOf(p, g.item);
      if (w) return revNoteGroup('open-rework', g, '<span class="muted rev-note-cl">' + esc(w.ref || 'Rework') + '</span><span>' + esc(w.title || 'Rework') + '</span>' + rwChip(w.status));
      var q = g.item && reqOf(p, g.item);
      if (q) return revNoteGroup('open-req', g, '<span class="muted rev-note-cl">' + esc(q.ref || 'Requirement') + '</span><span>' + esc(q.text) + '</span>');
      var d = g.item ? itemDef(p, g.item) : null, it = (g.item && p.items[g.item]) || {};
      var st = M.oneOf(M.STATUSES, it.status, ''), res = M.oneOf(M.RESOLUTIONS, it.resolution, '');
      var chip = st === 'issue' ? '<span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open issue') + '</span>'
        : st === 'pass' ? '<span class="res fixed">Pass</span>' : st === 'na' ? '<span class="res waived">N/A</span>' : '';
      var title = d ? M.stripRevNote(d.def.text) || d.def.text : 'On the whole ' + UNIT;
      return revNoteGroup('goto-item', g, (d && d.template ? '<span class="muted rev-note-cl">' + esc(d.template.short || d.template.title || '') + '</span>' : '<span></span>') +
        '<span>' + esc(title) + '</span>' + chip);
    }).join('') + mine + (count ? '' : '<p class="muted rev-notes-none">Nothing noted yet.</p>') + add + '</div>';
  }
  // The update being typed on the Revisions tab: kept across redraws until it's added.
  var revDraft = '', revDraftId = '';
  function addRevNote() {
    var p = current(), text = p && revDraftId === p.id ? revDraft.trim() : '';
    if (!p || !text) return;
    var before = Object.keys(p.comments).length;
    addComment(null, M.isRevNote(text) ? text : '@revnotes ' + text);
    if (Object.keys((current() || p).comments).length > before) { revDraft = ''; renderPage(); }
    var ta = $('#revnote-input'); if (ta) ta.focus();
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
    var st = runsOf[p.id], path = zipPaths(checkerDir(p, C.runs.dir), r.zip), first = Array.isArray(path) ? path[0] : path;
    var entries = st && st.entries && st.entries.some(function (e) { return e.path === first; }) ? st.entries : undefined;
    toast('Downloading ' + r.zip.name + '…');
    workspace().store(homeOf(p)).readVerified(path, r.zip.sha256, entries).then(function (bytes) {
      download(r.zip.name, bytes, 'application/zip');
      toast('Saved ' + r.zip.name + ' (SHA-256 checked)');
    }, function (err) {
      toast(err.code === 'mismatch' ? 'Not saved: the stored zip doesn’t match its recorded SHA-256' : err.code === 'missing' ? 'Not saved: the zip isn’t in the repository' : 'Not saved: ' + (err.message || err));
    });
  }

  // Where a run's zip is under the run's folder: its path, or its parts' paths in order when
  // Fabcheck stored it in parts (readVerified joins them).
  function zipPaths(dir, zip) {
    return zip.parts ? zip.parts.map(function (x) { return dir + x.rel; }) : dir + zip.rel;
  }

  // ── Releases (config.releases, Signoff FW; fw_design_review/docs/releases.md) ──
  // Builds of the target's firmware: the file and release.json in the review's repo (releases/<id>/<release>/,
  // written once), the state in project.releases. FTEs publish; everyone on the review can download.
  var relOpen = {};        // release id -> details shown
  var relDemoFiles = {};   // the demo: release id -> the bytes uploaded in this tab (there's no repo)
  var REL_MAX = 64 * 1048576;
  function releaseOf(p, id) { return id ? M.liveReleases(p).filter(function (r) { return r.id === id; })[0] || null : null; }
  function relLoadText(load) {
    return (load.via === 'passthrough' ? 'Passthrough' : 'USB') + (load.board ? ', ' + load.board : '') + (load.base ? ' at ' + load.base : '');
  }
  function relChip(r) { return '<span class="chip rel-chip ' + r.state + '">' + esc(M.RELEASE_STATE_LABEL[r.state]) + '</span>'; }
  function relPaths(p, r) {
    var path = checkerDir(p, 'releases/') + r.id + '/' + r.file.name;
    return r.file.parts ? M.fileParts(path, r.file.parts) : path;
  }
  function flasherUrl(p, r) {
    return C.releases.flasher + '?' + (DEMO ? 'demo&' : '') + 'release=' + encodeURIComponent(p.id) + '/' + encodeURIComponent(r.id);
  }
  function setRelease(p, id, fields, msg) {
    if (HIST.compare.isCopy(p)) { touch(p); return; }
    p.releases[id] = M.stamp(Object.assign({}, p.releases[id], fields), me());
    touch(p); renderPage(); if (msg) toast(msg); syncSoon();
  }
  function releasesPage(p) {
    var all = M.liveReleases(p).slice().reverse(), latest = M.latestRelease(p), fte = isFte(), dl = M.cleanLoad(p.meta.load, '');
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Releases</h1>' +
      '<div class="page-sub"><span>' + plural(all.length, 'release') + '</span>' + (latest ? '<span class="sep">·</span><span>Latest released ' + esc(latest.version) + '</span>' : '') +
      '<span class="sep">·</span><span>Loads by ' + esc(relLoadText(dl)) + '</span>' + (fte ? ' <button class="btn btn-sm" data-act="edit-project">Change</button>' : '') + '</div></div>' +
      (fte ? '<button class="btn btn-primary" data-act="rel-new">New release</button>' : '') + '</div>';
    if (!all.length) return html + emptyCard('No releases yet', fte ? 'A release is one build of this ' + UNIT + '’s firmware: a .elf, .hex, or .bin file, its version, and how it loads. It’s kept with this ' + UNIT + ' in its private repository, and Flasher lists it for anyone who can open the ' + UNIT + '. Start as a draft to try it on the bench, then release it.'
      : 'When an FTE releases a build of this ' + UNIT + '’s firmware, it’s listed here, and you can download it or open it in Flasher.') + '</div>';
    if (DEMO) html += '<p class="note" style="margin:0 0 14px">In the demo, these releases are examples without files. A new release you add keeps its file in this tab only.</p>';
    html += all.filter(function (r) { return fte || r.state !== 'draft'; }).map(function (r) {
      var open = !!relOpen[r.id];
      return '<section class="card sec rev-group rel-row' + (open ? '' : ' collapsed') + '">' +
        '<div class="sec-head" data-act="rel-toggle" data-id="' + esc(r.id) + '">' + ICON.chev +
        '<div class="rev-line"><div class="rev-name rel-version ' + r.state + '">' + esc(r.version || 'Release') + '</div>' +
        '<div class="rev-meta muted">' + esc([r.file.name, fmtSize(r.file.size), relLoadText(r.load), fmtDate(r.createdAt), r.updatedBy].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div class="rev-tag">' + relChip(r) + '</div></div>' +
        (open ? '<div class="sec-body rev-body">' + releaseDetail(p, r, fte) + '</div>' : '') + '</section>';
    }).join('');
    return html + '</div>';
  }
  function releaseDetail(p, r, fte) {
    var h = '<div class="rev-acts">' +
      (C.releases.flasher ? '<a class="btn btn-primary" href="' + esc(flasherUrl(p, r)) + '">Open in Flasher</a>' : '') +
      '<button class="btn" data-act="rel-download" data-id="' + esc(r.id) + '" title="SHA-256 ' + esc(r.file.sha256) + '">Download ' + esc(fmtSize(r.file.size)) + '</button>' +
      (fte && r.state === 'draft' ? '<button class="btn" data-act="rel-release" data-id="' + esc(r.id) + '">Release</button>' : '') +
      (fte && r.state === 'withdrawn' ? '<button class="btn" data-act="rel-release" data-id="' + esc(r.id) + '">Release again</button>' : '') +
      (fte && r.state !== 'withdrawn' ? '<button class="btn" data-act="rel-withdraw" data-id="' + esc(r.id) + '">Withdraw</button>' : '') +
      (fte ? '<button class="btn" data-act="rel-notes" data-id="' + esc(r.id) + '">Edit notes</button>' : '') +
      (fte && r.state === 'draft' ? '<button class="btn btn-danger" data-act="rel-delete" data-id="' + esc(r.id) + '">Delete</button>' : '') + '</div>';
    var src = [r.source.repo, r.source.sha && r.source.sha.slice(0, 10), r.source.dirty && 'built with uncommitted changes'].filter(Boolean).join(' · ');
    h += '<div class="rev-info">' +
      (r.state === 'withdrawn' ? '<div><b>Withdrawn</b>' + (r.withdrawnWhy ? ': ' + esc(r.withdrawnWhy) : '') + '</div>' : '') +
      (r.state === 'draft' ? '<div>Draft: Flasher shows it to FTEs only, for the bench.</div>' : '') +
      (r.releasedAt ? '<div>Released ' + esc(r.releasedAt) + '</div>' : '') +
      (r.notes ? '<div class="rev-notes">' + esc(r.notes) + '</div>' : '') +
      (src ? '<div>Built from ' + esc(src) + '</div>' : '') + '</div>' +
      '<div class="rev-files"><div class="rev-folder"><b>' + esc(r.file.kind.toUpperCase()) + (r.file.parts ? ' · stored in ' + r.file.parts + ' parts' : '') + '</b>' +
      '<div class="rev-file"><span>' + esc(r.file.name) + '</span><span class="muted">' + esc(fmtSize(r.file.size)) + '</span></div>' +
      '<div class="rev-file"><span class="muted">SHA-256 ' + esc(r.file.sha256) + '</span></div></div></div>';
    return h;
  }

  // New release (FTEs): pick or drop the file, then its version and how it loads. The file and release.json
  // go up in one commit first; the record follows with the next sync.
  function releaseSheet(p) {
    if (HIST.compare.isCopy(p)) { touch(p); return; }
    if (!DEMO && !getToken()) { toast('Sign in to GitHub to add a release'); return; }
    var dl = M.cleanLoad(p.meta.load, ''), picked = null;
    var w = sheet('<div class="sheet-head"><h2>New release</h2><p>One build of ' + esc(p.meta.name) + '. The file is kept with this ' + UNIT + ' and never changed; its state and notes can be.</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field"><label for="rl-file">Firmware file (.elf, .hex, or .bin)</label><input class="input" type="file" id="rl-file" accept=".elf,.hex,.bin"><p class="note" id="rl-file-note"></p></div>' +
      '<div class="row2"><div class="field"><label for="rl-version">Version</label><input class="input" id="rl-version" maxlength="40" value="' + esc(M.nextReleaseVersion(p)) + '"></div>' +
      '<div class="field"><span class="field-label">Loads over</span><div class="seg" id="rl-via" role="group" aria-label="How it loads">' +
        [['usb', 'Its own USB'], ['passthrough', 'A passthrough']].map(function (k) { return '<button type="button" data-via="' + k[0] + '" aria-pressed="' + (dl.via === k[0]) + '"' + (dl.via === k[0] ? ' class="on"' : '') + '>' + k[1] + '</button>'; }).join('') + '</div></div></div>' +
      '<div class="row2"><div class="field"><label for="rl-board">Board</label><input class="input" id="rl-board" maxlength="48" value="' + esc(dl.board) + '" placeholder="Flasher’s board id, or the bootloader’s"></div>' +
      '<div class="field"><label for="rl-base">Flash address (.bin only)</label><input class="input" id="rl-base" maxlength="10" value="' + esc(dl.base || '') + '" placeholder="e.g. 0x08000000"></div></div>' +
      '<div class="row2"><div class="field"><label for="rl-repo">Built from (repo)</label><input class="input" id="rl-repo" maxlength="100" placeholder="Optional: owner/name"></div>' +
      '<div class="field"><label for="rl-sha">Commit</label><input class="input" id="rl-sha" maxlength="40" placeholder="Optional"></div></div>' +
      '<label class="rel-check"><input type="checkbox" id="rl-dirty"> Built with uncommitted changes</label>' +
      '<div class="field"><label for="rl-notes">Notes</label><textarea class="input" id="rl-notes" maxlength="4000" placeholder="What changed in this build"></textarea></div>' +
      '<label class="rel-check"><input type="checkbox" id="rl-now"> Release now (otherwise it starts as a draft, which Flasher shows to FTEs only)</label>' +
      '</div><div class="sheet-foot"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Add release</button></div>');
    var note = w.querySelector('#rl-file-note');
    w.querySelector('#rl-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      picked = null; note.textContent = '';
      if (!f) return;
      if (f.size > REL_MAX) { note.textContent = f.name + ' is over 64 MB.'; return; }
      f.arrayBuffer().then(function (buf) {
        var bytes = new Uint8Array(buf), s = M.sniffFirmware(f.name, bytes);
        if (s.error) { note.textContent = s.error; return; }
        if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(f.name)) { note.textContent = 'Rename the file to letters, digits, dots, dashes, and underscores only.'; return; }
        return S.github.sha256Hex(bytes).then(function (sha) {
          picked = { name: f.name, kind: s.kind, bytes: bytes, sha256: sha };
          note.textContent = s.kind.toUpperCase() + ', ' + fmtSize(bytes.length) + ', SHA-256 ' + sha.slice(0, 16) + '…';
        });
      }).catch(function (err) { note.textContent = 'Couldn’t read that file: ' + (err.message || err); });
    });
    w.addEventListener('click', function (e) {
      var vb = e.target.closest('#rl-via button');
      if (vb) { Array.prototype.forEach.call(w.querySelectorAll('#rl-via button'), function (x) { x.classList.toggle('on', x === vb); x.setAttribute('aria-pressed', String(x === vb)); }); return; }
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      if (!picked) { toast('Pick the firmware file first'); return; }
      var val = function (id) { return w.querySelector('#' + id).value.trim(); };
      var version = val('rl-version');
      if (!version) { w.querySelector('#rl-version').focus(); return; }
      if (M.liveReleases(p).some(function (r) { return r.version === version; })) { toast('There’s already a release ' + version); return; }
      var on = w.querySelector('#rl-via button.on'), load = M.cleanLoad({ via: on ? on.dataset.via : 'usb', board: val('rl-board'), base: val('rl-base') }, picked.kind);
      if (val('rl-board') && !load.board) { toast(load.via === 'passthrough' ? 'The bootloader’s board id is up to 16 lowercase letters, digits, and dashes' : 'A board id is lowercase letters, digits, dashes, and underscores'); return; }
      var problem = M.loadProblem(load, picked.kind);
      if (problem) { toast(problem); return; }
      var parts = DEMO ? null : S.GitHubStore.splitParts('x', picked.bytes);
      var rec = M.newRelease({ version: version, state: w.querySelector('#rl-now').checked ? 'released' : 'draft',
        file: { name: picked.name, size: picked.bytes.length, sha256: picked.sha256, parts: parts ? parts.length : 0 }, load: load,
        source: { repo: val('rl-repo'), sha: val('rl-sha'), dirty: w.querySelector('#rl-dirty').checked }, notes: val('rl-notes') }, me());
      closeSheet();
      storeRelease(p, rec, picked.bytes);
    });
  }
  function storeRelease(p, rec, bytes) {
    var pid = p.id;
    function add() {
      var cur = current();
      if (!cur || cur.id !== pid) { toast('Release stored, but the ' + UNIT + ' isn’t open any more. Open it and sync.'); return; }
      cur.releases = cur.releases || {};
      cur.releases[rec.id] = rec;
      relOpen[rec.id] = true;
      touch(cur); renderPage(); toast('Added ' + rec.version + (rec.state === 'draft' ? ' as a draft' : '')); syncSoon();
    }
    if (DEMO) { relDemoFiles[rec.id] = bytes; add(); return; }
    var base = checkerDir(p, 'releases/').slice(0, -('releases/' + pid + '/').length);
    var files = M.releaseFiles(base, pid, rec, bytes, settings.login, S.GitHubStore.splitParts);
    var busy = busyCard('Storing release ' + rec.version);
    busy.step('Uploading ' + rec.file.name + ' (' + fmtSize(bytes.length) + ')…', 0.05);
    workspace().store(homeOf(p)).putFiles(files, {
      message: 'Signoff: release ' + rec.version + ' for ' + pid,
      onProgress: function (done, total) { busy.step('Uploading ' + rec.file.name + '… ' + done + ' of ' + total, 0.05 + 0.85 * done / Math.max(1, total)); },
      onRetry: function (n) { busy.step('GitHub moved on; trying again (' + n + ')…'); }
    }).then(function () {
      busy.close(); add();
    }, function (err) {
      busy.stop('Nothing was added. ' + (err.message || err), [['Close', function () { busy.close(); }, true]], 'Couldn’t store the release');
    });
  }
  function downloadRelease(p, r) {
    if (!r) return;
    if (DEMO) {
      if (relDemoFiles[r.id]) download(r.file.name, relDemoFiles[r.id], 'application/octet-stream');
      else toast('The demo’s releases are examples without a file');
      return;
    }
    toast('Downloading ' + r.file.name + '…');
    workspace().store(homeOf(p)).readVerified(relPaths(p, r), r.file.sha256).then(function (bytes) {
      download(r.file.name, bytes, 'application/octet-stream');
      toast('Saved ' + r.file.name + ' (SHA-256 checked)');
    }, function (err) {
      toast(err.code === 'mismatch' ? 'Not saved: the stored file doesn’t match its recorded SHA-256' : err.code === 'missing' ? 'Not saved: the file isn’t in the repository' : 'Not saved: ' + (err.message || err));
    });
  }
  function releaseAct(act, id) {
    var p = current(), r = p && releaseOf(p, id);
    if (!r) return;
    if (act === 'rel-toggle') { relOpen[id] = !relOpen[id]; renderPage(); return; }
    if (act === 'rel-download') { downloadRelease(p, r); return; }
    if (!isFte()) return;
    if (act === 'rel-release') setRelease(p, id, { state: 'released', releasedAt: new Date().toISOString().slice(0, 10), withdrawnWhy: '' }, 'Released ' + r.version);
    else if (act === 'rel-withdraw') {
      var why = prompt('Withdraw ' + r.version + '? Flasher keeps listing it with a warning, and won’t pick it by default.\n\nWhy?', '');
      if (why === null) return;
      setRelease(p, id, { state: 'withdrawn', withdrawnWhy: why.trim().slice(0, 400) }, 'Withdrew ' + r.version);
    } else if (act === 'rel-delete') {
      if (r.state !== 'draft' || !confirm('Delete the draft ' + r.version + '? Its file stays in the ' + UNIT + '’s repository history.')) return;
      setRelease(p, id, { deleted: true }, 'Deleted ' + r.version);
    } else if (act === 'rel-notes') {
      var w = sheet('<div class="sheet-head"><h2>Release ' + esc(r.version) + '</h2><p>' + esc(r.file.name) + '</p></div><div class="sheet-body">' +
        '<div class="field"><label for="rl-enotes">Notes</label><textarea class="input" id="rl-enotes" maxlength="4000">' + esc(r.notes) + '</textarea></div></div>' +
        '<div class="sheet-foot"><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Save</button></div>');
      w.addEventListener('click', function (e) {
        var b = e.target.closest('[data-sheet]');
        if (!b) return;
        if (b.dataset.sheet === 'ok') { var t = w.querySelector('#rl-enotes').value.trim(); closeSheet(); setRelease(p, id, { notes: t }, 'Notes saved'); }
        else closeSheet();
      });
    }
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
        return store.readVerified(zipPaths(dir, r.zip), r.zip.sha256, entries).then(function (zip) {
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
    if (!a || !a.id || !(/^(INPUT|TEXTAREA)$/.test(a.tagName) || a.id === 'spec-editor')) return null;
    var f = { el: a, id: a.id, top: a.scrollTop };
    try { f.start = a.selectionStart; f.end = a.selectionEnd; f.dir = a.selectionDirection; } catch (e) { /* no selection on this input type */ }
    return f;
  }
  function restoreFocus(f) {
    if (!f || f.el.isConnected) return;   // not redrawn: nothing to do
    var a = document.getElementById(f.id);
    if (!a || a === document.activeElement || !(/^(INPUT|TEXTAREA)$/.test(a.tagName) || a.id === 'spec-editor')) return;
    a.focus({ preventScroll: true });
    try { if (f.start != null) a.setSelectionRange(f.start, f.end, f.dir); } catch (e) { /* no selection on this input type */ }
    a.scrollTop = f.top;
  }
  // ── Rework (Chris, 2026-11-16) ───────────────────────────
  // Bring-up reworks beside the Bring-up checklist (config.rework.template): its tab has a Checklist |
  // Rework switch (ui.reworkView). One record per rework (model.js, Rework), opened in the details pane
  // with its pictures and discussion. Pictures are scaled and re-encoded as Tickets does, then stored at
  // once in the review's repo (rework/<review id>/<rework id>/), and read back as blob: URLs.
  var RW_ICON = { planned: '<span class="rw-glyph" aria-hidden="true">\u25cb</span>', done: ICON.check, verified: '<span class="rw-glyph" aria-hidden="true">\u2713\u2713</span>', notneeded: ICON.dash };
  var RW_MAX_SIDE = 1920, RW_MAX_BYTES = 2500000, RW_MAX_PICS = 8;
  var rwPics = {};      // review id/rework id/picture id -> { state: 'loading' | 'ok' | 'missing' | 'signin', url }
  var rwDemoUrls = {};  // the demo's added pictures, for this page load only (the demo has no repo)
  var rwUploading = {}; // rework id -> how many pictures are going up
  function reworkTab(p) { return !!(C.rework && p && ui.view === C.rework.template && M.reworkOn(p)); }
  function reworkOf(p, id) { var r = p && p.rework && id && p.rework[id]; return r && typeof r === 'object' && !r.deleted ? M.cleanRework(r, id) : null; }
  function rwChip(status) { return '<span class="rw-st rw-' + status + '">' + RW_ICON[status] + M.REWORK_LABEL[status] + '</span>'; }
  function reworkSwitch(p) {
    if (!C.rework || !M.reworkOn(p)) return '';
    var st = M.reworkStats(p), on = ui.reworkView === 'rework';
    return '<div class="seg rw-switch" role="tablist" aria-label="Bring-up">' +
      '<button role="tab" class="' + (on ? '' : 'on') + '" data-act="rw-view" data-val="checklist">Checklist</button>' +
      '<button role="tab" class="' + (on ? 'on' : '') + '" data-act="rw-view" data-val="rework">Rework' + (st.total ? ' <span class="count" title="' + st.planned + ' planned">' + (st.planned ? st.planned + ' / ' : '') + st.total + '</span>' : '') + '</button></div>';
  }
  function rwMatches(p, r) {
    var f = ui.rwFilter || 'all';
    if (f === 'next' && !r.next) return false;
    if (f !== 'all' && f !== 'next' && r.status !== f) return false;
    if (ui.rwQuery) {
      var q = ui.rwQuery.toLowerCase();
      if ([r.ref, r.title, r.problem, r.fix, r.parts, r.nets, r.by].join(' ').toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  }
  function reworkPage(p) {
    var all = M.liveRework(p), st = M.reworkStats(p), list = all.filter(function (r) { return rwMatches(p, r); });
    var html = '<div class="page">' + reworkSwitch(p) + '<div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Rework</h1>' +
      '<div class="page-sub"><span>' + plural(st.total, 'rework') + '</span>' +
      M.REWORK_STATUS.filter(function (s) { return st[s]; }).map(function (s) { return '<span class="sep">\u00b7</span><span>' + st[s] + ' ' + M.REWORK_LABEL[s].toLowerCase() + '</span>'; }).join('') +
      (st.next ? '<span class="sep">\u00b7</span><span>' + st.next + ' for the next revision</span>' : '') + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + (all.length ? '<button class="btn" data-act="rw-print-list" title="Print the reworks shown, with their pictures, for the tech">Print</button>' : '') +
      '<button class="btn btn-primary" data-act="rw-add">Add rework</button></div></div>';
    if (!all.length) {
      return html + '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>No reworks yet</h2>' +
        '<p>Track each change made to the boards during bring-up: what was wrong, the rework, the parts and nets it touched, pictures, and whether it\u2019s been verified. Tick <b>Fix in the next revision</b> to list it with the next revision\u2019s updates.</p>' +
        '<button class="btn btn-primary" data-act="rw-add">Add rework</button></div></div>';
    }
    var filters = [['all', 'All', st.total]].concat(M.REWORK_STATUS.map(function (s) { return [s, M.REWORK_LABEL[s], st[s]]; }), [['next', 'Next revision', st.next]]);
    html += '<div class="filters"><div class="seg">' + filters.map(function (f) {
      return '<button class="' + ((ui.rwFilter || 'all') === f[0] ? 'on' : '') + '" data-act="rw-filter" data-filter="' + f[0] + '">' + f[1] + ' <span class="count">' + f[2] + '</span></button>';
    }).join('') + '</div><div class="search">' + ICON.search + '<input id="rw-search" type="search" placeholder="Filter reworks" value="' + esc(ui.rwQuery || '') + '" autocomplete="off"></div></div>';
    if (!list.length) return html + '<div class="empty"><h2>Nothing here</h2><p>No reworks match this filter.</p></div></div>';
    return html + '<div class="card rw-list">' + list.map(function (r) {
      var n = M.liveComments(p, r.id).length;
      var sub = [r.parts ? '<span class="rw-parts">' + esc(r.parts) + '</span>' : '', r.nets ? '<span class="muted">' + esc(r.nets) + '</span>' : '',
        r.pics.length ? '<span class="muted">' + plural(r.pics.length, 'picture') + '</span>' : '', n ? '<span class="cmt-count">' + ICON.bubble + n + '</span>' : '',
        r.next ? '<span class="chip accent">Next revision</span>' : ''].filter(Boolean).join('');
      var who = [r.by, r.doneAt ? fmtDate(r.doneAt + 'T12:00:00Z') : ''].filter(Boolean).join(', ');
      return '<button class="rw-row rw-is-' + r.status + (selected === r.id ? ' sel' : '') + '" data-act="rw-select" data-id="' + esc(r.id) + '">' +
        '<span class="rw-ref">' + esc(r.ref) + '</span>' +
        '<span class="rw-main"><span class="rw-title">' + (r.title ? esc(r.title) : '<span class="muted">No title yet</span>') + '</span>' + (sub ? '<span class="rw-sub">' + sub + '</span>' : '') + '</span>' +
        '<span class="rw-right">' + rwChip(r.status) + (who ? '<span class="muted rw-who">' + esc(who) + '</span>' : '') + '</span></button>';
    }).join('') + '</div></div>';
  }
  function openRework(id) {
    if (C.rework) { ui.view = C.rework.template; ui.reworkView = 'rework'; saveUi(); }
    selected = id;
    closeInspector(); renderPage();
    $('#inspector').classList.add('open'); renderInspector();
    var row = document.querySelector('.rw-row[data-id="' + CSS.escape(id) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function addRework() {
    var p = current(); if (!p) return;
    if (HIST.compare.isCopy(p)) { touch(p); return; }
    p.rework = p.rework || {};
    var r = M.newRework(p, {}, me());
    p.rework[r.id] = r;
    touch(p);
    ui.rwFilter = 'all'; ui.rwQuery = '';
    openRework(r.id);
    setTimeout(function () { var t = $('#rw-title'); if (t) t.focus(); }, 60);
  }
  // Writes fields onto the stored record (kept as stored, so fields this version doesn't know survive).
  function setRework(id, fields) {
    var p = current(); if (!p || !p.rework || !p.rework[id]) return;
    var prev = p.rework[id], next = Object.assign({}, prev, fields);
    // Done or verified fills in who and when, if they're blank.
    if ((fields.status === 'done' || fields.status === 'verified') && prev.status !== fields.status) {
      if (!next.by) next.by = me();
      if (!next.doneAt) next.doneAt = new Date().toISOString().slice(0, 10);
    }
    p.rework[id] = M.stamp(next, me());
    touch(p); renderPage(); renderInspector();
  }
  function rwPicKey(p, r, pic) { return p.id + '/' + r.id + '/' + pic.id; }
  function rwPicPath(p, r, pic) { return checkerDir(p, 'rework/') + r.id + '/' + pic.file; }
  function loadRwPic(p, r, pic) {
    var k = rwPicKey(p, r, pic);
    if (rwPics[k]) return rwPics[k];
    if (DEMO) return (rwPics[k] = { state: 'ok', url: rwDemoUrls[pic.id] || 'assets/demo-previews/' + pic.file });
    if (!getToken()) return { state: 'signin' };
    rwPics[k] = { state: 'loading' };
    var store = workspace().store(homeOf(p)), path = rwPicPath(p, r, pic);
    (pic.sha256 ? store.readVerified(path, pic.sha256) : store.readBytes(path)).then(function (b) {
      if (!b) throw new Error('missing');
      rwPics[k] = { state: 'ok', url: URL.createObjectURL(new Blob([b], { type: pic.type })) };
    }).catch(function () { rwPics[k] = { state: 'missing' }; }).then(function () { if (selected === r.id) renderInspector(); if (rwPrint && !$('#report').hidden) drawReworkPrint(); });
    return rwPics[k];
  }
  // Pictures on the rework (step '') or on one of its tech steps: thumbnails, then a box to paste,
  // drop, or pick more. Uploads in flight are counted per rework and step (rwUploading).
  function rwThumbsHtml(p, r, pics, step) {
    var up = rwUploading[r.id + '|' + (step || '')] || 0;
    return '<div class="rw-pics">' + pics.map(function (pic) {
      var s = loadRwPic(p, r, pic);
      var inner = s.state === 'ok' ? '<img src="' + esc(s.url) + '" alt="' + esc(pic.name || 'Rework picture') + '" loading="lazy">'
        : '<span class="muted">' + (s.state === 'loading' ? 'Loading\u2026' : s.state === 'signin' ? 'Sign in to see it' : 'Not found') + '</span>';
      return '<div class="rw-thumb"><button class="rw-thumb-img" data-act="rw-pic-open" data-id="' + esc(pic.id) + '" title="' + esc((pic.name ? pic.name + ' \u00b7 ' : '') + (pic.by ? 'added by ' + pic.by : '')) + '">' + inner + '</button>' +
        '<button class="rw-thumb-x" data-act="rw-pic-del" data-id="' + esc(pic.id) + '" data-step="' + esc(step || '') + '" title="Remove picture" aria-label="Remove picture">' + ICON.close + '</button></div>';
    }).join('') + (up ? '<div class="rw-thumb rw-thumb-up"><span class="muted">Adding ' + plural(up, 'picture') + '\u2026</span></div>' : '') + '</div>';
  }
  function rwDropHtml(step, label) {
    return '<label class="rw-drop' + (step ? ' rw-drop-sm' : '') + '" data-rw-drop="1" data-step="' + esc(step || '') + '"><input type="file" class="rw-pic-input" data-step="' + esc(step || '') + '" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>' +
      '<span>' + label + '</span></label>';
  }
  function rwPicsHtml(p, r) {
    return '<div class="field"><span class="field-label">Pictures</span>' + rwThumbsHtml(p, r, r.pics, '') + rwDropHtml('', 'Paste (Ctrl+V), drop, or <u>pick</u> pictures') + '</div>';
  }
  // Tech steps (Chris, 2026-11-16): step-by-step instructions for the technician under Rework details,
  // each with its own pictures. Pasting while a step's text is focused adds the picture to that step.
  function rwStepsHtml(p, r) {
    var n = r.steps.length;
    return '<div class="field rw-steps-field"><span class="field-label">Tech steps <span class="muted">step by step, for the technician\u2019s printout</span></span>' +
      (n ? '<ol class="rw-steps">' + r.steps.map(function (s, i) {
        return '<li class="rw-step" data-step="' + esc(s.id) + '"><div class="rw-step-row"><span class="rw-step-n">' + (i + 1) + '</span>' +
          '<textarea class="input rw-step-text" rows="2" maxlength="4000" data-rw-step="' + esc(s.id) + '" placeholder="e.g. Remove L1 with hot air at 350 \u00b0C">' + esc(s.text) + '</textarea>' +
          '<div class="rw-step-acts"><button class="icon-btn" data-act="rw-step-move" data-step="' + esc(s.id) + '" data-dir="-1" title="Move up" aria-label="Move step up"' + (i ? '' : ' disabled') + '>\u2191</button>' +
          '<button class="icon-btn" data-act="rw-step-move" data-step="' + esc(s.id) + '" data-dir="1" title="Move down" aria-label="Move step down"' + (i < n - 1 ? '' : ' disabled') + '>\u2193</button>' +
          '<button class="icon-btn" data-act="rw-step-del" data-step="' + esc(s.id) + '" title="Delete step" aria-label="Delete step">' + ICON.close + '</button></div></div>' +
          (s.pics.length || rwUploading[r.id + '|' + s.id] ? rwThumbsHtml(p, r, s.pics, s.id) : '') + rwDropHtml(s.id, 'Add a picture to step ' + (i + 1)) + '</li>';
      }).join('') + '</ol>' : '<p class="note" style="margin:0 0 8px">No steps yet. Without them, the technician\u2019s printout uses the Rework details.</p>') +
      '<button class="btn btn-sm" data-act="rw-step-add">+ Add step</button></div>';
  }
  // The rework's steps as stored (a copy to change), so fields this version doesn't know survive.
  function rwStepsRaw(rid) {
    var p = current(), raw = p && p.rework && p.rework[rid];
    return raw && Array.isArray(raw.steps) ? JSON.parse(JSON.stringify(raw.steps)) : [];
  }
  function rwStepEdit(fn) {
    var p = current(), r = reworkOf(p, selected); if (!r) return;
    var steps = rwStepsRaw(r.id), out = fn(steps);
    if (out === false) return;
    setRework(r.id, { steps: steps });
    return out;
  }

  // The rework pane widens by dragging its left edge (Chris, 2026-11-16: rework only). The width is kept
  // in this browser (rwInspW); a double-click on the edge puts it back to 400 px. Phones keep the sheet.
  var RW_INSP_MIN = 400;
  function rwInspMax() { return Math.max(RW_INSP_MIN, Math.round(window.innerWidth * 0.8)); }
  function rwInspWidth(w) {
    var el = $('#inspector'); if (!el) return;
    w = Math.max(RW_INSP_MIN, Math.min(rwInspMax(), Math.round(+w) || RW_INSP_MIN));
    el.style.setProperty('--rw-insp-w', w + 'px');
    return w;
  }
  document.addEventListener('pointerdown', function (e) {
    var g = e.target.closest && e.target.closest('.rw-grip');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    var el = $('#inspector'); el.classList.add('rw-resizing');
    try { g.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    var last = el.getBoundingClientRect().width;
    function move(ev) { last = rwInspWidth(window.innerWidth - ev.clientX - 12) || last; }
    function up() {
      g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
      el.classList.remove('rw-resizing'); save('rwInspW', last);
    }
    g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest('.rw-grip')) { rwInspWidth(RW_INSP_MIN); save('rwInspW', RW_INSP_MIN); }
  });
  window.addEventListener('resize', function () { var w = load('rwInspW', 0); if (w) rwInspWidth(w); });
  // Side by side shows the document alone on a narrow window: crossing that width draws the Scribe page again
  // (not while a section is open for editing, which a redraw would close).
  window.addEventListener('resize', function () {
    if (ui.view !== 'spec' || ui.specView !== 'side' || specEditing || specDrawnNarrow === null || specNarrow() === specDrawnNarrow) return;
    renderPage();
  });

  function renderReworkInspector(p, r) {
    var el = $('#inspector');
    el.classList.add('is-rework');
    rwInspWidth(load('rwInspW', RW_INSP_MIN));
    var keep = el.dataset.item === r.id ? { body: (el.querySelector('.insp-body') || {}).scrollTop || 0 } : null;
    var draft = el.querySelector('#comment-input'), draftText = draft ? draft.value : '';
    var comments = M.liveComments(p, r.id), revs = C.runs ? M.liveRevisions(p) : [];
    var seg = '<div class="seg full rw-seg">' + M.REWORK_STATUS.map(function (s) {
      return '<button class="rw-b-' + s + (r.status === s ? ' on' : '') + '" data-act="rw-status" data-val="' + s + '">' + RW_ICON[s] + M.REWORK_LABEL[s] + '</button>';
    }).join('') + '</div>';
    el.innerHTML = '<div class="rw-grip" title="Drag to widen (double-click: back to 400 px)" aria-hidden="true"></div>' +
      '<div class="insp-head"><div class="insp-crumb">Rework \u203a ' + esc(r.ref) + '</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="row2"><div class="field"><label for="rw-ref">ID</label><input class="input" id="rw-ref" value="' + esc(r.ref) + '" data-rw-input="ref" maxlength="20"></div>' +
      '<div class="field"><label for="rw-title">Title</label><input class="input" id="rw-title" value="' + esc(r.title) + '" data-rw-input="title" maxlength="300" placeholder="e.g. Relay coil drive"></div></div>' +
      '<div class="field"><span class="field-label">Status</span>' + seg + '</div>' +
      '<div class="field"><label for="rw-problem">What\u2019s wrong</label><textarea class="input" id="rw-problem" rows="3" data-rw-input="problem" maxlength="8000" placeholder="What was found, how, and what it measured">' + esc(r.problem) + '</textarea></div>' +
      '<div class="field"><label for="rw-fix">Rework details</label><textarea class="input" id="rw-fix" rows="3" data-rw-input="fix" maxlength="8000" placeholder="What was changed on the board, and what to do in the next revision">' + esc(r.fix) + '</textarea></div>' +
      rwStepsHtml(p, r) +
      '<div class="row2"><div class="field"><label for="rw-parts">Parts</label><input class="input" id="rw-parts" value="' + esc(r.parts) + '" data-rw-input="parts" maxlength="1000" placeholder="R12, C40, U3"></div>' +
      '<div class="field"><label for="rw-nets">Nets</label><input class="input" id="rw-nets" value="' + esc(r.nets) + '" data-rw-input="nets" maxlength="1000" placeholder="+3V3, VCAP"></div></div>' +
      '<div class="row2"><div class="field"><label for="rw-by">Done by</label><input class="input" id="rw-by" value="' + esc(r.by) + '" data-rw-input="by" maxlength="100" placeholder="Who did it"></div>' +
      '<div class="field"><label for="rw-date">Date</label><input class="input" type="date" id="rw-date" value="' + esc(r.doneAt) + '" data-rw-input="doneAt"></div></div>' +
      (revs.length ? '<div class="field"><label for="rw-rev">On revision</label><select class="input" id="rw-rev" data-rw-input="revision"><option value="">Not set</option>' + revs.map(function (v) {
        return '<option value="' + esc(v.id) + '"' + (v.id === r.revision ? ' selected' : '') + '>' + esc(v.label + (v.title ? ' \u00b7 ' + v.title : '')) + '</option>';
      }).join('') + '</select></div>' : '') +
      '<label class="rw-next"><input type="checkbox" data-act="rw-next"' + (r.next ? ' checked' : '') + '> Fix in the next revision <span class="muted">(listed under Revisions \u203a Next revision updates)</span></label>' +
      rwPicsHtml(p, r) +
      '<div class="meta-line">' + (r.createdAt ? 'Added ' + fmtDate(r.createdAt) : '') + (r.updatedBy ? ' \u00b7 last changed by ' + esc(r.updatedBy) + ', ' + relTime(r.updatedAt) : '') + '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn" data-act="rw-print">Print for the tech</button><button class="btn btn-danger" data-act="rw-delete">Delete rework</button></div>' +
      '<div class="thread"><div class="thread-title">Discussion <span class="note" style="margin:0">' + (comments.length || '') + '</span></div>' +
      (comments.length ? comments.map(function (c) {
        return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span title="' + esc(new Date(c.at).toLocaleString()) + '">' + relTime(c.at) + '</span>' +
          (c.author === me() ? '<button class="cmt-del" data-act="del-comment" data-id="' + esc(c.id) + '">Delete</button>' : '') + '</div><div class="cmt-text">' + esc(c.text) + '</div></div></div>';
      }).join('') : '<p class="note">No comments yet. Note measurements, scope captures, or what\u2019s left to check.</p>') + '</div></div>' +
      '<div class="composer"><textarea class="input" id="comment-input" placeholder="Add a comment\u2026" rows="2">' + esc(draftText) + '</textarea>' +
      composerFoot() + '</div>';
    el.dataset.item = r.id;
    if (keep) el.querySelector('.insp-body').scrollTop = keep.body;
  }
  // A printout for the tech at the bench (Chris, 2026-11-16): one rework from its pane, or the reworks
  // the list shows (its filter and search). Detailed has everything: what's wrong, Rework details, the
  // tech steps with their pictures, the rework's pictures, the discussion, and lines to sign. Technician
  // instructions is only the steps with their pictures (or, with no steps, the Rework details and the
  // rework's pictures), the parts and nets, and a Done line. The mode is kept in this browser
  // (rwPrintMode). It uses the review report's paper (#report); pictures still loading redraw it.
  // Not needed reworks are left out of Technician instructions (Chris, 2026-11-16; Detailed keeps them),
  // unless one is printed on its own from its pane (single), which is asked for by name.
  var rwPrint = null;   // { ids, single } while the printout is open
  function openReworkPrint(ids, single) {
    rwPrint = { ids: ids.slice(), single: !!single };
    drawReworkPrint();
    $('#report').scrollTop = 0;
  }
  function drawReworkPrint() {
    var p = current(), r = $('#report');
    if (!rwPrint || !p) return;
    var tech = load('rwPrintMode', 'detailed') === 'tech';
    var all = rwPrint.ids.map(function (id) { return reworkOf(p, id); }).filter(Boolean), m = p.meta;
    var list = rwPrint.single || !tech ? all : all.filter(function (w) { return w.status !== 'notneeded'; }), skipped = all.length - list.length;
    var revs = C.runs ? M.liveRevisions(p) : [], revOf = function (id) { return revs.filter(function (v) { return v.id === id; })[0]; };
    var waiting = 0;
    var line = function (label, text) { return text ? '<div class="rwp-field"><span>' + label + '</span><div class="rwp-text">' + esc(text) + '</div></div>' : ''; };
    function figs(w, pics) {
      return pics.map(function (pic) {
        var s = loadRwPic(p, w, pic);
        if (s.state === 'loading') waiting++;
        return '<figure class="rwp-pic">' + (s.state === 'ok' ? '<img src="' + esc(s.url) + '" alt="' + esc(pic.name || 'Rework picture') + '">' : '<div class="rwp-nopic">' + (s.state === 'loading' ? 'Loading picture\u2026' : 'Picture not available') + '</div>') +
          (pic.name ? '<figcaption>' + esc(pic.name) + '</figcaption>' : '') + '</figure>';
      }).join('');
    }
    function picsBlock(w, pics) { var f = figs(w, pics); return f ? '<div class="rwp-pics">' + f + '</div>' : ''; }
    function stepsBlock(w) {
      return '<ol class="rwp-steps">' + w.steps.map(function (s) {
        return '<li><div class="rwp-step-text">' + (tech ? '<span class="rwp-box" aria-hidden="true">\u2610</span>' : '') + '<div class="rwp-text">' + esc(s.text || '') + '</div></div>' + picsBlock(w, s.pics) + '</li>';
      }).join('') + '</ol>';
    }
    var seg = '<div class="seg rwp-mode" role="tablist" aria-label="Printout">' + [['detailed', 'Detailed'], ['tech', 'Technician instructions']].map(function (o) {
      return '<button role="tab" class="' + ((tech ? 'tech' : 'detailed') === o[0] ? 'on' : '') + '" data-act="rw-print-mode" data-val="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
    var html = '<div class="report-bar"><b>Rework printout</b>' + seg + '<div style="display:flex;gap:8px"><button class="btn" data-act="close-report">Close</button><button class="btn btn-primary" data-act="print">Print / Save PDF</button></div></div>' +
      '<div class="paper rwp-paper' + (tech ? ' rwp-tech' : '') + '">' +
      '<div class="r-head"><div><div class="r-brand">' + esc(C.product || 'Signoff') + ' \u00b7 ' + (tech ? 'TECHNICIAN INSTRUCTIONS' : 'BRING-UP REWORK') + '</div>' +
      '<h1 style="margin-top:14px">' + esc(m.name) + '</h1><div style="color:#515154">' + esc([m.client, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).join(' \u00b7 ')) + '</div></div>' +
      '<div style="text-align:right"><div style="font:600 30px var(--display);color:#004952">' + list.length + '</div><div style="color:#86868b;font-size:11px">' + (list.length === 1 ? 'rework' : 'reworks') + '</div></div></div>' +
      '<div class="r-meta"><div><span>Printed</span>' + fmtDate(M.now()) + '</div><div><span>By</span>' + esc(me() || '\u2014') + '</div><div><span>Board serial</span>&nbsp;</div><div><span>Tech</span>&nbsp;</div></div>' +
      (list.length > 1 ? '<table class="rwp-index"><thead><tr><th>ID</th><th>Rework</th><th>Parts</th>' + (tech ? '<th>Steps</th>' : '<th>Status</th>') + '</tr></thead><tbody>' + list.map(function (w) {
        return '<tr><td>' + esc(w.ref) + '</td><td>' + esc(w.title) + '</td><td>' + esc(w.parts) + '</td><td>' + (tech ? (w.steps.length || '\u2014') : esc(M.REWORK_LABEL[w.status])) + '</td></tr>';
      }).join('') + '</tbody></table>' : '') +
      list.map(function (w) {
        var head = '<div class="rwp-head"><span class="rwp-ref">' + esc(w.ref) + '</span><h2>' + esc(w.title || 'Rework') + '</h2>' + (tech ? '' : '<span class="rwp-st">' + esc(M.REWORK_LABEL[w.status]) + '</span>') + '</div>';
        if (tech) {
          return '<section class="rwp-item">' + head +
            '<div class="rwp-grid">' + line('Parts', w.parts) + line('Nets', w.nets) + '</div>' +
            (w.steps.length ? '<div class="rwp-field"><span>Steps</span>' + stepsBlock(w) + '</div>'
              : line('Instructions', w.fix || 'No instructions written yet.') + picsBlock(w, w.pics)) +
            '<div class="rwp-sign rwp-sign-tech"><div>\u2610 Done \u2003 By</div><div>Date</div></div>' +
            '<div class="rwp-notes">Notes</div></section>';
        }
        var rev = w.revision && revOf(w.revision), cm = M.liveComments(p, w.id);
        return '<section class="rwp-item">' + head +
          '<div class="rwp-grid">' + line('Parts', w.parts) + line('Nets', w.nets) + (rev ? line('On revision', rev.label + (rev.title ? ' \u00b7 ' + rev.title : '')) : '') +
          (w.by || w.doneAt ? line('Done', [w.by, w.doneAt].filter(Boolean).join(', ')) : '') + (w.next ? line('Next revision', 'Fix in the next revision') : '') + '</div>' +
          line('What\u2019s wrong', w.problem) + line('Rework details', w.fix) +
          (w.steps.length ? '<div class="rwp-field"><span>Tech steps</span>' + stepsBlock(w) + '</div>' : '') +
          picsBlock(w, w.pics) +
          (cm.length ? '<div class="rwp-field"><span>Discussion</span>' + cm.map(function (c) { return '<div class="r-cmt">' + esc(c.author) + ' (' + fmtDate(c.at) + '): ' + esc(c.text) + '</div>'; }).join('') + '</div>' : '') +
          '<div class="rwp-sign"><div>\u2610 Done \u2003 By</div><div>Date</div><div>\u2610 Verified \u2003 By</div><div>Date</div></div>' +
          '<div class="rwp-notes">Notes</div></section>';
      }).join('') +
      (list.length ? '' : '<p>No reworks to print.' + (skipped ? ' Not needed reworks are left out of Technician instructions; switch to Detailed, or print one from its pane.' : '') + '</p>') +
      (list.length && skipped ? '<p class="r-cmt">' + plural(skipped, 'rework') + ' marked Not needed ' + (skipped === 1 ? 'is' : 'are') + ' left out.</p>' : '') +
      '<div class="r-foot"><span>Generated by ' + esc(C.product) + ' ' + esc((window.SIGNOFF_VERSION || {}).hash || '') + '</span><span>' + esc(m.name) + '</span></div></div>';
    var keep = r.hidden ? 0 : r.scrollTop;
    r.innerHTML = html; r.hidden = false; r.scrollTop = keep;
    var pb = r.querySelector('[data-act="print"]');
    if (pb) { pb.disabled = waiting > 0; pb.title = waiting ? 'Waiting for ' + plural(waiting, 'picture') : ''; }
  }

  function rwRandomId() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); }
  function rwSha256(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (d) { return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); });
  }
  // One picture, scaled to 1920 px on its long side; a screenshot stays sharp as PNG, a photo goes as JPEG.
  function rwReadImage(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error('Only pictures can be added.')); return; }
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, RW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var use = c.toDataURL('image/png'), type = 'image/png';
        if (use.length * 0.75 > 900000) { use = c.toDataURL('image/jpeg', 0.86); type = 'image/jpeg'; }
        var bin = atob(use.slice(use.indexOf(',') + 1)), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        if (bytes.length > RW_MAX_BYTES) { reject(new Error('That picture is too large, even made smaller.')); return; }
        var id = rwRandomId();
        rwSha256(bytes).then(function (sha) {
          resolve({ rec: { id: id, file: id + '.' + M.REWORK_PIC_TYPES[type], type: type, w: w, h: h, sha256: sha, name: String(file.name || '').slice(0, 200), at: M.now(), by: me() }, bytes: bytes, url: use });
        }, reject);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That picture couldn\u2019t be read.')); };
      img.src = url;
    });
  }
  function addReworkPics(files, step) {
    var p = current(), r = reworkOf(p, selected);
    step = step || '';
    files = Array.prototype.filter.call(files || [], function (f) { return f && /^image\//.test(f.type); });
    if (!p || !r || !files.length) return;
    if (step && !r.steps.some(function (s) { return s.id === step; })) return;
    if (HIST.compare.isCopy(p)) { touch(p); return; }
    if (!DEMO && !getToken()) { toast('Sign in to GitHub to add pictures'); return; }
    if (files.length > RW_MAX_PICS) { toast('Up to ' + RW_MAX_PICS + ' pictures at a time'); files = files.slice(0, RW_MAX_PICS); }
    var pid = p.id, rid = r.id, uk = rid + '|' + step;
    rwUploading[uk] = (rwUploading[uk] || 0) + files.length; renderInspector();
    Promise.all(files.map(function (f) { return rwReadImage(f).catch(function (e) { toast(e.message); return null; }); })).then(function (list) {
      list = list.filter(Boolean);
      if (!list.length) return [];
      if (DEMO) { list.forEach(function (x) { rwDemoUrls[x.rec.id] = x.url; }); return list; }
      return workspace().store(homeOf(p)).putFiles(list.map(function (x) { return { path: rwPicPath(p, r, x.rec), bytes: x.bytes }; }),
        { message: 'Signoff: rework pictures for ' + pid }).then(function () { return list; });
    }).then(function (list) {
      if (!list.length) return;
      var cur = current();
      if (!cur || cur.id !== pid || !cur.rework || !cur.rework[rid]) { toast('Pictures stored, but the rework is gone'); return; }
      list.forEach(function (x) { rwPics[pid + '/' + rid + '/' + x.rec.id] = { state: 'ok', url: x.url }; });
      var recs = list.map(function (x) { return x.rec; }), keepSel = selected;
      selected = rid;
      if (step) {
        var steps = rwStepsRaw(rid), s = steps.filter(function (x) { return x && x.id === step; })[0];
        if (!s) { selected = keepSel; toast('Pictures stored, but the step is gone'); return; }
        s.pics = (Array.isArray(s.pics) ? s.pics : []).concat(recs);
        setRework(rid, { steps: steps });
      } else {
        var had = Array.isArray(cur.rework[rid].pics) ? cur.rework[rid].pics : [];
        setRework(rid, { pics: had.concat(recs) });
      }
      selected = keepSel;
      if (!DEMO) syncSoon();
      if (DEMO) toast('In the demo, added pictures last until the page reloads');
    }).catch(function (err) { toast('Couldn\u2019t store the pictures: ' + (err && err.message || err), null, 6000); })
      .then(function () { rwUploading[uk] = Math.max(0, (rwUploading[uk] || 0) - files.length); if (selected === rid) renderInspector(); });
  }
  function openReworkPic(id) {
    var p = current(), r = reworkOf(p, selected); if (!r) return;
    var where = '', pic = r.pics.filter(function (x) { return x.id === id; })[0];
    r.steps.forEach(function (s, i) { var hit = s.pics.filter(function (x) { return x.id === id; })[0]; if (hit && !pic) { pic = hit; where = 'Step ' + (i + 1); } });
    if (!pic) return;
    var s = loadRwPic(p, r, pic);
    sheet('<div class="sheet-head"><h2>' + esc(r.ref + (r.title ? ' \u00b7 ' + r.title : '')) + '</h2><button class="icon-btn" data-act="close-sheet" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="rw-big">' + (s.state === 'ok' ? '<img src="' + esc(s.url) + '" alt="' + esc(pic.name || 'Rework picture') + '">' : '<p class="note">The picture isn\u2019t loaded.</p>') + '</div>' +
      '<p class="note">' + esc([where, pic.name, pic.w && pic.h ? pic.w + ' \u00d7 ' + pic.h + ' px' : '', pic.by ? 'added by ' + pic.by : '', pic.at ? fmtDate(pic.at) : ''].filter(Boolean).join(' \u00b7 ')) + '</p>', { wide: true });
  }

  function renderInspector() { var f = focusNow(); drawInspector(); restoreFocus(f); }
  function drawInspector() {
    var el = $('#inspector'), p = current();
    if (!p || !selected || !el.classList.contains('open')) return;
    el.classList.remove('is-rework');
    var rq = reqOf(p, selected);
    if (rq) return renderReqInspector(p, rq);
    var rw = reworkOf(p, selected);
    if (rw) return renderReworkInspector(p, rw);
    if (specSel()) return renderSpecInspector(p);
    if (specBlockSel()) return renderSpecBlockInspector(p);
    if (specEdgeSel()) return renderSpecEdgeInspector(p);
    if (specPtSel()) return renderSpecPtInspector(p);
    if (selected === 'specdiagram') return renderSpecDiagramInspector(p);
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
  function linkItemText(it) { return it.name + (it.label ? ' · ' + it.label : '') + (it.dir === 'both' ? ' ↔' : it.dir === 'in' ? ' ←' : ''); }
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
    var toks = u.tokens.slice(), lead = '';
    if (u.note && toks[0] && toks[0].t === 'text') {
      var nm = /^(\s*)(check:)\s*/i.exec(toks[0].text);
      if (nm) { lead = esc(nm[1]) + '<span class="sl-note" title="A review note: resolve it in its panel">Check</span> '; toks[0] = { t: 'text', text: toks[0].text.slice(nm[0].length) }; }
    }
    var inner = lead + specRichHtml(toks, function (t) {
      return t.t === 'tag' ? '<span class="sl-tag" title="Flagged to become a requirement">@req</span>' : specSpanHtml(t);
    });
    if (u.row) inner = specRowCells(u).join(' <span class="muted">·</span> ');
    if (u.broken) { inner += '<span class="sl-broken" title="' + esc(BROKEN_TIP) + '">mark?</span>'; tip = (tip ? tip + '\n' : '') + BROKEN_TIP; }
    return '<span class="su su-' + u.state + (u.broken ? ' su-broken' : '') + (on ? ' sel' : '') + '" data-act="spec-unit" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '"' +
      (tip ? ' title="' + esc(tip) + '"' : ' title="' + STATE_LABEL[u.state] + '"') + '>' + inner + '</span>';
  }
  // A unit's tokens with bold, italic, and struck words (model.specRich) drawn, marks and flags included: each
  // token that isn't text stands in as one private-use character, so markers may wrap a link.
  function specRichHtml(toks, other) {
    var PH = '', text = '', rest = [];
    toks.forEach(function (t) { if (t.t === 'text') text += t.text.replace(//g, ''); else { text += PH; rest.push(t); } });
    var k = 0;
    return M.specRich(text).map(function (r) {
      var h = r.t.split(PH).map(esc).reduce(function (acc, part, i) { return i ? acc + other(rest[k++]) + part : part; }, '');
      if (r.s) h = '<s>' + h + '</s>';
      if (r.i) h = '<em>' + h + '</em>';
      if (r.b) h = '<strong>' + h + '</strong>';
      return h;
    }).join('');
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
    var html = '', list = false, nums = [], ni = 0;
    x.blocks.forEach(function (b, bi) {
      if (b.type !== 'li' && list) { html += '</ul>'; list = false; }
      if (b.type === 'p') html += '<p class="spec-p">' + b.units.map(function (u) { return specUnitHtml(p, a, x, u); }).join(' ') + '</p>';
      else if (b.type === 'li') {
        if (!list) {
          html += '<ul class="spec-ul">'; list = true; ni = 0;
          var run = []; for (var j = bi; j < x.blocks.length && x.blocks[j].type === 'li'; j++) run.push(x.blocks[j]);
          nums = M.specListNumbers(run);
        }
        var n = nums[ni++];
        html += '<li class="' + (n ? 'spec-li-n' : 'spec-li-b') + (b.lv ? ' lv-' + b.lv : '') + '">' + (n ? '<span class="spec-num">' + n + '</span>' : '') + '<span class="spec-li-text">' + b.units.map(function (u) { return specUnitHtml(p, a, x, u); }).join(' ') + '</span></li>';
      }
      else if (b.type === 'gist') html += '<p class="spec-gist">' + esc(b.text) + '</p>';
      else if (b.type === 'code') html += '<pre class="spec-code">' + esc(b.text) + '</pre>';
      else if (b.type === 'uses') {
        html += '<div class="spec-uses"><span>' + esc(b.word || 'Uses') + '</span>' + b.items.map(function (it) {
          var id = M.specUseId(a.ctx, it);
          return id ? '<button class="chip" data-act="spec-goto" data-id="' + esc(id) + '">' + esc(linkItemText(it)) + '</button>' : '<span class="chip spec-chip-missing" title="No section has this title">' + esc(linkItemText(it)) + '</span>';
        }).join('') + '</div>';
      } else if (b.type === 'power') {
        html += '<div class="spec-uses spec-parts"><span>Power</span>' + b.items.map(function (r) { return '<span class="chip spec-part" title="' + esc(r.role === 'source' ? 'It makes this rail' : 'It uses this rail') + '">' + (r.role === 'source' ? '○ ' : '⊤ ') + esc(r.rail) + ' <span class="muted">' + r.role + '</span></span>'; }).join('') + '</div>';
      } else if (b.type === 'parts') {
        html += '<div class="spec-uses spec-parts"><span>Parts</span>' + b.items.map(function (n) { return '<span class="chip spec-part">' + esc(n) + '</span>'; }).join('') + '</div>';
      } else if (b.type === 'part') {
        html += '<div class="spec-uses spec-parts"><span>Part</span><span class="chip spec-part">' + esc(b.mpn) + '</span></div>';
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
    var gaps = [], dead = x.dead && SPEC_FLOW ? x.dead : [];
    x.blocks.forEach(function (bk) { (bk.units || []).forEach(function (u) { if (u.state === 'untraced' || u.state === 'tag') gaps.push(u); }); });
    if (!gaps.length && !dead.length) return '';
    return '<div class="field"><span class="field-label">Gaps</span>' + gaps.map(function (u) {
      return '<div class="req-link"><button class="req-link-main" data-act="spec-open" data-sec="' + esc(x.sec.id) + '" data-u="' + u.start + '"><span><span class="req-link-text">' + esc(u.text) + '</span><span class="muted">' +
        (u.broken ? 'A mark in it didn’t parse: fix it in Edit its text' : u.state === 'tag' ? 'Flagged to become a requirement' : 'Unlinked: link a requirement, make one, or mark it standard') + '</span></span></button></div>';
    }).join('') + dead.map(function (d) {
      // A link the diagram can't draw (Chris, 2026-11-22): it names no block, a section, or the block itself.
      return '<div class="req-link"><button class="req-link-main" data-act="spec-goto" data-id="' + esc(x.sec.id) + '"><span><span class="req-link-text">' + esc(d.word + ': ' + d.name + (d.label ? ' (' + d.label + ')' : '')) + '</span><span class="muted">' +
        esc(d.why === 'section' ? d.name + ' is a section, not a block: connect to a block inside it' : d.why === 'self' ? 'It names this block itself: remove the entry' : 'No block is called ' + d.name + ': rename the entry, add the block, or remove it') + '</span></span></button></div>';
    }).join('') + '</div>';
  }
  function specGapTitle(x) {
    var dead = x.dead && SPEC_FLOW ? x.dead.length : 0;
    return [x.counts.untraced ? plural(x.counts.untraced, 'unlinked sentence') : '', x.counts.tag ? x.counts.tag + ' flagged for a requirement' : '', dead ? plural(dead, 'connection') + ' the diagram can’t draw' : ''].filter(Boolean).join(', ');
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
      return '<div class="spec-kindbar" role="toolbar" aria-label="Links of the heading at the cursor"><span class="spec-kindbar-label">Headings under a heading make a section</span><span class="spacer"></span>' + M.specOfferWords().map(function (w) {
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
    specFmtRefresh();
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
    var ln = ta.children[n - 1]; if (ln) ln.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // ── The Scribe editor (2026-11-19, Chris: a toolbar that writes the markup, and the markup shown as badges) ──
  // assets/specedit.js (SignoffSpecEdit) draws the text with its markup as badges and keeps the text exactly as
  // typed; the bar under it writes bold, italic, and strikethrough, bullets and numbered lists (1.1 by level),
  // headings, a gist, a review note, and the marks: Link requirement…, Flag @req, Standard, and Section link….
  var specEd = null;
  var FMT = {
    bold: ['Bold (Ctrl+B)', '<b>B</b>'], italic: ['Italic (Ctrl+I)', '<i>I</i>'], strike: ['Strikethrough (Ctrl+Shift+X)', '<s>S</s>'],
    bul: ['Bullets (Ctrl+Shift+8)', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/></svg>'],
    num: ['Numbered list, 1.1 by level (Ctrl+Shift+7)', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><text x="0.5" y="5.6" font-size="5" fill="currentColor" stroke="none" font-family="sans-serif">1</text><text x="0.5" y="9.6" font-size="5" fill="currentColor" stroke="none" font-family="sans-serif">2</text><text x="0.5" y="13.6" font-size="5" fill="currentColor" stroke="none" font-family="sans-serif">3</text></svg>'],
    out: ['Outdent (Shift+Tab)', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h7M7 8h7M7 12h7M4.5 5.5L2 8l2.5 2.5"/></svg>'],
    'in': ['Indent (Tab)', '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h7M7 8h7M7 12h7M2 5.5L4.5 8 2 10.5"/></svg>']
  };
  function specFmtBarHtml() {
    function b(f) { return '<button type="button" class="icon-btn spec-fmt" data-act="spec-fmt" data-f="' + f + '" title="' + esc(FMT[f][0]) + '" aria-label="' + esc(FMT[f][0].replace(/ \(.*$/, '')) + '">' + FMT[f][1] + '</button>'; }
    function t(f, label, title) { return '<button type="button" class="btn btn-sm spec-fmt-t" data-act="spec-fmt" data-f="' + f + '" title="' + esc(title) + '">' + label + '</button>'; }
    var sep = '<span class="spec-fmt-sep" aria-hidden="true"></span>';
    return '<div class="spec-fmtbar" role="toolbar" aria-label="Formatting and markup">' + b('bold') + b('italic') + b('strike') + sep + b('bul') + b('num') + b('out') + b('in') + sep +
      t('heading', 'Heading ▾', 'Make the line a heading (a new block or section), or a paragraph again') + t('gist', 'Gist', 'Make the line the section’s one-line gist (> …)') + t('check', 'Check', 'Make the line a review note (Check: …)') + sep +
      t('link', 'Link requirement…', 'Link the selected words to a requirement') + t('tag', 'Flag @req', 'Flag the sentence to become a requirement') + t('std', 'Standard', 'Mark the selected words as standard text that needs no requirement') +
      t('sec', 'Section link…', 'Point the selected words at another section') + (SPEC && SPEC.parts ? t('parts', 'Parts…', 'Add a Parts line under the cursor (U1, C1–C3)') : '') + '</div>';
  }
  function specMountEditor() {
    var ta = $('#spec-editor');
    if (!ta || ta._se || !window.SignoffSpecEdit) return;
    var p = current(), ctx = p ? M.specContext(p) : null;
    specEd = ta._se = window.SignoffSpecEdit.mount(ta, specDraft, {
      model: M, words: function () { return M.specLinkWords().concat(M.specPowerOn() ? ['Power'] : [], M.specPinsOn() ? ['Part'] : []); },
      markLabel: function (inner) { return specMarkLabel(ctx, inner); },
      onBadge: specBadge
    });
  }
  // What a mark's chip says: its requirement numbers, Standard, or the section it points at.
  function specMarkLabel(ctx, inner) {
    var miss = false, out = String(inner || '').split(',').map(function (t) {
      t = t.trim(); var low = t.toLowerCase();
      if (low === 'std') return 'Standard';
      if (low.charAt(0) === '#') { if (!ctx || !ctx.titles[low.slice(1).trim()]) miss = true; return '§ ' + t.slice(1).trim(); }
      if (/^q:/.test(t)) { var q = ctx && ctx.reqs[t.slice(2)]; if (!q) miss = true; return q ? q.ref || 'requirement' : t; }
      if (/^s:/.test(t)) { var sc = ctx && ctx.secs[t.slice(2)]; if (!sc) miss = true; return sc ? '§ ' + sc.title : t; }
      if (ctx && !ctx.refs[low] && !M.specRange(t, ctx)) miss = true;
      return t;
    }).filter(Boolean);
    var label = out.length > 2 ? out.slice(0, 2).join(' · ') + ' +' + (out.length - 2) : out.join(' · ');
    return { label: label || '?', missing: miss, title: (miss ? 'Not found: ' : '') + out.join(', ') };
  }
  // A click on a badge: what can be done to it.
  function specBadge(info, b) {
    var ed = specEd; if (!ed) return;
    var t = ed.value(), entries;
    if (info.kind === 'mark') entries = [['change', /std/i.test(info.inner) ? 'Link a requirement instead…' : 'Change what it links…'], ['unwrap', 'Remove the mark, keep the words'], ['drop', 'Delete the words too', true]];
    else if (info.kind === 'tag') entries = [['drop', 'Remove the @req flag', true]];
    else if (info.kind === 'li') entries = [['plain', 'Make it a paragraph']];
    else if (info.kind === 'h') entries = [['h1', 'Heading 1'], ['h2', 'Heading 2'], ['h3', 'Heading 3'], ['h4', 'Heading 4'], ['plain', 'Make it a paragraph']];
    else if (info.kind === 'kind') entries = [['drop', 'Remove the kind']];
    else entries = [['plain', 'Make it a paragraph']];
    menu(b, entries).then(function (c) {
      if (c === 'unwrap') ed.replace(info.a, info.b, info.txt);
      else if (c === 'drop') { var a = info.a; if (info.kind === 'tag' && a > 0 && t[a - 1] === ' ') a--; ed.replace(a, info.b, ''); }
      else if (c === 'plain') ed.replace(info.a, info.b, '');
      else if (/^h\d$/.test(c)) { ed.el.setSelectionRange(info.b, info.b); ed.setHeading(+c.slice(1)); }
      else if (c === 'change') { ed.replace(info.a, info.b, info.txt); ed.el.setSelectionRange(info.a, info.a + info.txt.length); specReqPicker(b); }
      ed.el.focus();
    });
  }
  // Link requirement…: a searchable list of the review's requirements; a pick wraps the selected words.
  function specReqPicker(anchor) {
    var ed = specEd, p = current(); if (!ed || !p) return;
    var s = ed.selection();
    if (s.a === s.b) { toast('Select the words to link first'); return; }
    var ctx = M.specContext(p);
    closeMenu();
    var m = document.createElement('div');
    m.className = 'menu spec-req-pick'; m.id = 'menu';
    m.innerHTML = '<input class="input" id="spec-req-pick" placeholder="Search requirements by number or words" autocomplete="off"><div class="spec-req-pick-list"></div>';
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left)) + 'px';
    m.style.top = Math.max(8, Math.min(innerHeight - 340, r.bottom + 6)) + 'px';
    var list = m.querySelector('.spec-req-pick-list'), inp = m.querySelector('input');
    function draw() {
      var q = inp.value.trim().toLowerCase();
      var hits = M.liveReqs(p).filter(function (x) { return x.status !== 'deprecated' && (!q || [x.ref, x.text, x.category].join(' ').toLowerCase().indexOf(q) >= 0); }).slice(0, 40);
      list.innerHTML = hits.map(function (x) { return '<button data-req="' + esc(x.id) + '"><span><b>' + esc(x.ref || '') + '</b> ' + esc(x.text || 'No text yet') + '</span></button>'; }).join('') || '<p class="note">' + (M.liveReqs(p).length ? 'No requirements match.' : 'No requirements yet: use Flag @req, then make it one.') + '</p>';
    }
    draw(); inp.focus();
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var f = list.querySelector('[data-req]'); if (f) { e.preventDefault(); f.click(); } } });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-req]'); if (!b) return;
      var q = ctx.reqs[b.dataset.req], ref = String(q.ref || ''), inner = ref && ctx.refs[ref.toLowerCase()] === q.id ? ref : 'q:' + q.id;
      closeMenu();
      ed.el.focus(); ed.el.setSelectionRange(s.a, s.b);
      if (!ed.wrapMark(inner)) toast('Select words on one line, outside other links');
    });
  }
  function specFmt(f, btn) {
    var ed = specEd; if (!ed || !$('#spec-editor')) return;
    ed.el.focus();
    var s = ed.selection();
    switch (f) {
      case 'bold': ed.toggleWrap('**'); break;
      case 'italic': ed.toggleWrap('*'); break;
      case 'strike': ed.toggleWrap('~~'); break;
      case 'bul': ed.setList('b'); break;
      case 'num': ed.setList('n'); break;
      case 'out': ed.shift(-1); break;
      case 'in': ed.shift(1); break;
      case 'gist': ed.setPrefix('> '); break;
      case 'check': ed.setPrefix('Check: '); break;
      case 'heading':
        menu(btn, [['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3'], ['4', 'Heading 4'], ['0', 'Paragraph']]).then(function (l) { ed.el.focus(); ed.el.setSelectionRange(s.a, s.b); ed.setHeading(+l); });
        break;
      case 'tag': ed.insert('@req', true); break;
      case 'std':
        if (s.a === s.b) { toast('Select the words to mark standard'); break; }
        if (!ed.wrapMark('std')) toast('Select words on one line, outside other links');
        break;
      case 'link': specReqPicker(btn); break;
      case 'sec': {
        var titles = {}, entries = [];
        M.specSplit(ed.value()).concat(current() && specEditing !== 'all' ? M.liveSpec(current()).map(function (x) { return { heading: x }; }) : []).forEach(function (c) {
          var tt = c.heading && c.heading.title; if (!tt || titles[tt.toLowerCase()]) return; titles[tt.toLowerCase()] = 1; entries.push([tt, tt]);
        });
        if (!entries.length) { toast('No sections to point at yet'); break; }
        menu(btn, entries).then(function (tt) { ed.el.focus(); ed.el.setSelectionRange(s.a, s.b); if (!ed.wrapMark('#' + tt, tt)) toast('Select words on one line, outside other links'); });
        break;
      }
      case 'parts': {
        var li = ed.lineAt(), end = ed.lineStart(li) + ed.line(li).length;
        ed.replace(end, end, (ed.line(li).trim() ? '\n' : '') + 'Parts: ');
        break;
      }
    }
    specFmtRefresh();
  }
  function specFmtRefresh() {
    var bar = document.querySelector('.spec-fmtbar'); if (!bar || !specEd || !$('#spec-editor')) return;
    var st = specEd.state(), on = { bold: st.bold, italic: st.italic, strike: st.strike, bul: st.list === 'b', num: st.list === 'n', gist: st.gist, check: st.check, heading: !!st.heading };
    bar.querySelectorAll('[data-f]').forEach(function (b) { var v = !!on[b.dataset.f]; b.classList.toggle('on', v); if (b.dataset.f in on) b.setAttribute('aria-pressed', v ? 'true' : 'false'); });
  }
  // While one section is edited: the other blocks' lines that name it (Connected from, Supplied by), which are
  // set in their text or in this block's panel, not here.
  function specFromNoteHtml(id) {
    var p = current(); if (!id || !p) return '';
    var a = M.specAnalysis(p), parts = M.specLinkWords().map(function (w) {
      var from = [];
      a.sections.forEach(function (y) { y.edges.forEach(function (e) { if (e.id === id && e.word.toLowerCase() === w.toLowerCase()) from.push(y.sec.title + (e.label ? ' (' + e.label + ')' : '')); }); });
      return from.length ? '<b>' + esc(linkFrom(w)) + '</b> ' + esc(from.join(', ')) : '';
    }).filter(Boolean);
    return parts.length ? '<p class="note spec-from-note">' + parts.join(' · ') + '. <span class="muted">Set in those blocks’ own text, or in this block’s panel on the diagram.</span></p>' : '';
  }
  function specEditorHtml(id, all) {
    var lines = specDraft.split('\n').length;
    return '<div class="spec-editor card' + (all ? ' spec-editor-all' : '') + '">' + specKindBarHtml() + specFromNoteHtml(id) +
      '<div class="input spec-ed" id="spec-editor" data-sec="' + esc(id || '') + '" style="min-height:' + Math.round((all ? Math.max(20, lines + 3) : Math.max(6, Math.min(30, lines + 2))) * 1.6) + 'em"></div>' +
      specFmtBarHtml() +
      '<div class="spec-help">The buttons write the markup, shown as badges; typing it works too. Headings: <code># Title</code>, <code>## Title * task</code> (kinds: ' + M.specKinds().join(', ') + ') · link: <code>[text]{REQ-001}</code> · standard: <code>[text]{std}</code> · flag: <code>@req</code> · ' + M.specOfferWords().map(function (w) { return '<code>' + esc(w) + ': Title' + (M.specLinkWords().length > 1 ? ' (signal)' : ', Title') + '</code>'; }).join(' ') + (M.specPowerOn() ? ' · <code>Power: 3V3 (sink), 5V (source)</code>' : '') + (SPEC && SPEC.parts ? ' · <code>Parts: U1, C1–C3</code>' : '') + ' · gist: <code>&gt; one line</code> · <code>[text]{#Title}</code> points at a section · review note: <code>Check: …</code></div>' +
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
        ['Connects: Wi-Fi module (UART), Display connector (I2C)', 'The blocks this one sends signals to, with the signal or bus in brackets. Write it in the direction signals go; it draws the diagram’s labeled arrows. Add a direction after the signal for one that comes in or goes both ways: (UART, in), (I2C, both ways). Two blocks that name each other draw one line, both ways.'],
        ['Power: 5V (sink), 3V3 (source)', 'The rails the block uses (sink) and makes (source). A rail it uses gets a bar over the block, one it makes a circle, each with its name. Set them in the block’s panel too.'],
        ['Connects: MCU (3V3), Wi-Fi module (3V3)', 'Power goes on Connects too, with the rail in brackets. A connection carrying a rail the other block uses (or this one makes) is a power link: a line within one section, and just the flags across sections. Old Supplies lines still read as before.'],
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
      ['Keep the ripple under 30 mV at the Wi-Fi module @req', 'Flags the sentence to become a requirement. It shows in the Requirements inbox, under Requirements to make.'],
      ['the [display link]{#Display connector}', 'Points at another block by its heading; the sentence’s panel has a button to go there.']
    ] : [
      ['[the relays go off]{REQ-003}', 'Links the words in brackets to a requirement. The rest of the sentence counts as linked too.'],
      ['[off on reset]{REQ-003, REQ-001}', 'Links to more than one requirement.'],
      ['[It runs on FreeRTOS.]{std}', 'Standard text: background or explanation that needs no requirement.'],
      ['Make the LED pulse instead of blink @req', 'Flags the sentence to become a requirement. It shows in the Requirements inbox, under Requirements to make.'],
      ['the [status frame]{#Status frame}', 'Points at another section by its heading. Pointing at an interface section counts as linked.']
    ];
    var example = board ?
      '## Power\n> From mains to the 5 V and 3.3 V rails.\nThe whole board draws no more than 1.5 W @req\n\n### 3V3 buck\n> Steps 5 V down to the 3.3 V rail.\n[U7 is a 2 A synchronous buck.]{std} [The rail stays within ±3% at 1.5 A]{REQ-006}.\nParts: U7, L1, C1–C3\nSupplies: MCU (3V3), Wi-Fi module (3V3)'
      : '## Relay driver * driver\n> Switches the heat and cool relays.\n[Both outputs are held off through a reset]{REQ-003}. The driver turns one on only when the control loop asks.\nAdd a 2 s minimum off time @req\nUses: Relays';
    var w = sheet('<div class="sheet-head"><h2>Writing guide</h2><p>' + esc(SPEC_LABEL) + ' is plain text with a few marks. The buttons under the text write them, and the editor shows them as badges; click a badge to change or remove it. Anything else shows exactly as you type it.</p></div>' +
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
        [board ? '- Line voltage\n- Neutral' : '- Heat call\n- Cool call', 'A list. Each item counts as one sentence for tracing. Two spaces before the dash put it a level in (Tab does it in the editor).'],
        ['1. Power up\n  1. Check the 5 V rail\n2. Program the MCU', 'A numbered list, numbered 1., 1.1, 2. by level, whatever numbers you type.'],
        ['**bold**, *italic*, ~~struck~~', 'Bold, italic, and struck-through words (Ctrl+B, Ctrl+I, Ctrl+Shift+X). A star with spaces round it, as in 5 * 3, stays a star.'],
        [board ? '| Rail | Max load |\n| --- | --- |\n| 3V3 | 1.5 A |' : '| Field | Units |\n| --- | --- |\n| temp | °C |', board ? 'A table: a header row, a row of dashes, then the rows. Good for a power budget or a pin list. Tables aren’t traced.' : 'A table: a header row, a row of dashes, then the rows. Good for interface fields. Tables aren’t traced.'],
        ['```\nstatus = 0x01\n```', 'Code, shown as typed. Put three backticks on their own line before and after.']
      ]) +
      '<h3>A short example</h3><pre class="spec-code">' + esc(example) + '</pre>' +
      '<p class="note">The buttons under the text write all of this for you, and the editor shows it as badges. Not supported: links to web pages show as typed.</p>' +
      (specGuideId() && window.SignoffSpecGuide ? '<p class="note">New to ' + esc(SPEC_LABEL) + '? <button class="btn btn-sm" data-act="spec-guide-start">Take the guide</button> walks through it on the demo.</p>' : '') +
      '</div><div class="sheet-foot"><span class="spacer"></span><button class="btn btn-primary" data-sheet="done">Back to writing</button></div>', { wide: true });
    w.querySelector('[data-sheet="done"]').addEventListener('click', function () { closeSheet(); var t = $('#spec-editor'); if (t) t.focus(); });
  }

  function specPage(p) {
    // Side by side (Chris, 2026-11-20): the document and the diagram together; on a narrow screen it shows
    // the document (its tab is hidden there), and a resize across the line draws the page again.
    var narrow = specNarrow(), view = ui.specView === 'map' ? 'map' : ui.specView === 'side' && !narrow ? 'side' : 'doc';
    var a = M.specAnalysis(p), t = a.totals, depth = ui.specDepth === 2 ? 2 : 3;
    specDrawnNarrow = narrow;
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
      (a.tags.length ? '<span class="sep">·</span><span>' + a.tags.length + ' flagged</span>' : '') +
      // Ticket 3 (2026-11-13): moving sections wasn't obvious. Pointers only: touch doesn't drag them.
      (t.sections > 1 && specEditing !== 'all' && ui.specView !== 'map' ? '<span class="spec-drag-hint"><span class="sep">·</span><span>Drag a heading to move its section</span></span>' : '') + '</div></div>' +
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
    html += '<div class="filters"><div class="seg"><button class="' + (view === 'doc' ? 'on' : '') + '" data-act="spec-view" data-view="doc">Document</button><button class="' + (view === 'map' ? 'on' : '') + '" data-act="spec-view" data-view="map">Diagram</button>' +
      '<button class="spec-side-tab' + (view === 'side' ? ' on' : '') + '" data-act="spec-view" data-view="side" title="The document and the diagram together">Side by side</button></div>' +
      (view !== 'map' ? '<div class="seg" title="How much to show">' + [[2, 'Gists'], [3, 'Full text']].map(function (d) {
        return '<button class="' + (depth === d[0] && !show ? 'on' : '') + '" data-act="spec-depth" data-depth="' + d[0] + '">' + d[1] + '</button>';
      }).join('') + '</div>' : '') +
      (view !== 'map' && (t.untraced + t.tag || t.note || show) ? '<div class="seg" title="Show only the sections with gaps or with review notes">' + [['', 'Everything', 0], ['gaps', 'Gaps', t.untraced + t.tag], ['notes', 'Notes', t.note]].map(function (f) {
        return '<button class="' + (show === f[0] ? 'on' : '') + '" data-act="spec-show" data-show="' + f[0] + '">' + f[1] + (f[0] ? ' <span class="count">' + f[2] + '</span>' : '') + '</button>';
      }).join('') + '</div>' : '') + '</div>';
    // The Requirements inbox stays out of the diagram (Chris, 2026-11-20); the document views keep it.
    html += specNeedsHtml(p, a, view === 'map');
    if (view === 'map') return html + specMapHtml(p, a) + '</div>';
    var outline = '<nav class="spec-outline" aria-label="Outline">' + specOlToggle() + a.sections.filter(shown).map(function (x) {
      return '<button class="lv-' + x.sec.level + '" data-act="spec-goto" data-id="' + esc(x.sec.id) + '"><span>' + esc(x.sec.title || 'Untitled') + '</span>' + gapMark(x.gaps, specGapTitle(x)) + noteMark(x) + '</button>';
    }).join('') + '</nav>';
    var doc = a.sections.map(function (x, i) {
      if (!shown(x) && specEditing !== x.sec.id) return '';
      var s = x.sec, next = a.sections[i + 1], group = next && next.sec.level > s.level;
      if (specEditing === s.id) return '<section class="spec-sec lv-' + s.level + '" id="spec-' + esc(s.id) + '">' + specEditorHtml(s.id) + '</section>';
      var hn = 'h' + Math.min(5, s.level + 1);
      return '<section class="spec-sec lv-' + s.level + '" id="spec-' + esc(s.id) + '"><div class="spec-h"><' + hn + ' title="Drag to move this section"><span class="spec-grip" aria-hidden="true">' + ICON_GRIP + '</span>' + esc(s.title || 'Untitled') + '</' + hn + '>' +
        (s.kind ? '<span class="chip spec-kind">' + esc(s.kind) + '</span>' : '') + gapMark(x.gaps, specGapTitle(x)) + noteMark(x) +
        '<button class="icon-btn spec-edit spec-add-after" data-act="spec-add-after" data-id="' + esc(s.id) + '" title="Add a section below this one" aria-label="Add a section below ' + esc(s.title) + '">' + ICON_PLUS + '</button>' +
        '<button class="icon-btn spec-edit" data-act="spec-edit" data-id="' + esc(s.id) + '" title="Edit this section" aria-label="Edit ' + esc(s.title) + '">' + ICON.pencil + '</button></div>' +
        (depth === 2 && x.gist ? '<p class="spec-gist">' + esc(x.gist) + '</p>' : '') +
        (depth === 3 ? (x.blocks.length ? specBlocksHtml(p, a, x) : group ? '' : '<p class="note">Nothing written yet.</p>') : '') + '</section>' +
        (specEditing === 'new' && specNewAfter === s.id ? '<section class="spec-sec">' + specEditorHtml(null) + '</section>' : '');
    }).join('') + (specEditing === 'new' && !specNewAt(p) ? '<section class="spec-sec">' + specEditorHtml(null) + '</section>' : '');
    if (show && !a.sections.some(shown)) doc = '<p class="note">' + (show === 'gaps' ? 'No gaps: every sentence is linked, standard, or a review note.' : 'No review notes.') + '</p>';
    // The outline folds (Chris, 2026-11-20): ui.specOutline (Document) or ui.specOutlineSide, 'open' or 'closed' once
    // toggled; until then it folds itself on a mid-width window, and always in Side by side (CSS, .ol-auto).
    var ol = (view === 'side' ? ui.specOutlineSide : ui.specOutline) || 'auto';
    var wrap = '<div class="spec-wrap depth-' + depth + ' ol-' + ol + (show ? ' spec-show-' + show : '') + '">' + outline + '<div class="spec-doc">' + doc + '</div></div>';
    if (view === 'side') return html.replace('<div class="page spec-page">', '<div class="page spec-page spec-side-page">') +
      // Expanded, the whole view fills the window, the text still beside the diagram (Chris, 2026-11-20).
      // The handle between the columns drags their split (Chris, 2026-11-20), kept in this browser.
      '<div class="spec-side' + (specExpanded ? ' expanded' : '') + '" style="--split:' + specSplit() + '"><div class="spec-side-doc">' + wrap + '</div>' +
      '<div class="spec-side-split" role="separator" aria-orientation="vertical" aria-label="Drag to change the columns’ widths" title="Drag to change the widths; double-click for half and half"></div><div class="spec-side-map">' + specMapHtml(p, a) + '</div></div></div>';
    return html + wrap + '</div>';
  }
  // The window is too narrow for Side by side (and for the outline beside the text).
  var specDrawnNarrow = null;
  function specNarrow() { return !!(window.matchMedia && window.matchMedia('(max-width: 860px)').matches); }
  function specOlToggle() {
    return '<button class="spec-ol-toggle" data-act="spec-outline-toggle" title="Show or hide the outline" aria-label="Show or hide the outline">' +
      '<span class="spec-ol-chev" aria-hidden="true">‹</span><span class="spec-ol-label">Outline</span></button>';
  }
  // Side by side's split: the text column's share of the width, in percent (25 to 75), kept in this browser.
  function specSplit() { var v = +load('specSideSplit', 50); return isFinite(v) ? Math.max(25, Math.min(75, Math.round(v * 10) / 10)) : 50; }
  document.addEventListener('pointerdown', function (e) {
    var h = e.button === 0 && e.target.closest && e.target.closest('.spec-side-split'); if (!h) return;
    var side = h.parentElement, box = side.getBoundingClientRect(), v = specSplit();
    e.preventDefault(); h.setPointerCapture && h.setPointerCapture(e.pointerId); side.classList.add('splitting');
    function move(ev) { v = Math.max(25, Math.min(75, (ev.clientX - box.left) / box.width * 100)); side.style.setProperty('--split', v.toFixed(1)); }
    function up() { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); side.classList.remove('splitting'); save('specSideSplit', Math.round(v * 10) / 10); }
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', function (e) {
    var h = e.target.closest && e.target.closest('.spec-side-split'); if (!h) return;
    save('specSideSplit', 50); h.parentElement.style.setProperty('--split', '50');
  });
  // The view to show text in: Side by side stays (it has the text), Diagram goes to Document.
  function specTextView() { return ui.specView === 'side' ? 'side' : 'doc'; }

  // Resolve a conflict copy in one step (Chris, 2026-11-13; ../signoff/docs/history.md, lab
  // ../signoff/lab/history.html). Lists what the copy has that the section lacks (M.specResolvePlan):
  // new sentences ticked, changed ones not. Add checked writes them into the section (M.specResolveApply);
  // Use the copy puts the copy's text in the section; Delete copy keeps nothing. Each is one step for back
  // and forward: the section's edit and the copy's tombstone are stamped together in one specPutAll.
  function specWordDiff(a, b) {
    var x = String(a || '').split(/(\s+)/), y = String(b || '').split(/(\s+)/), n = x.length, m = y.length, i, j;
    if (n * m > 250000) return '<del>' + esc(a) + '</del> <ins>' + esc(b) + '</ins>';
    var L = []; for (i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var out = [], put = function (t, s) { var l = out[out.length - 1]; if (l && l.t === t) l.s += s; else out.push({ t: t, s: s }); };
    i = 0; j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { put('=', x[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) put('-', x[i++]);
      else put('+', y[j++]);
    }
    while (i < n) put('-', x[i++]);
    while (j < m) put('+', y[j++]);
    return out.map(function (p) {
      if (p.t === '=') return esc(p.s);
      var lead = /^\s*/.exec(p.s)[0], core = p.s.slice(lead.length), tag = p.t === '+' ? 'ins' : 'del';
      return esc(lead) + (core ? '<' + tag + '>' + esc(core) + '</' + tag + '>' : '');
    }).join('');
  }
  function specResolveSheet(id) {
    var p = current(), cp = p && (p.spec || {})[id], sec = cp && (p.spec || {})[cp.conflictOf];
    if (!cp || cp.deleted || !sec || sec.deleted) { toast('That copy is already resolved'); return; }
    var plan = M.specResolvePlan(sec.body, cp.body), picks = plan.items.map(function (it) { return it.mode === 'add'; });
    var copyTitle = String(cp.title || '').replace(/ \(conflict copy\)$/, '');
    var also = [];
    if (copyTitle !== (sec.title || '')) also.push('its title is “' + copyTitle + '”');
    if ((cp.level || 1) !== (sec.level || 1)) also.push('it’s at heading level ' + (cp.level || 1));
    if ((cp.kind || '') !== (sec.kind || '')) also.push(cp.kind ? 'its kind is ' + cp.kind : 'it has no kind');
    var items = plan.items.map(function (it, k) {
      return '<li class="spec-res-item"><label><input type="checkbox" data-pick="' + k + '"' + (picks[k] ? ' checked' : '') + '> ' +
        '<span class="spec-res-mode">' + (it.mode === 'change' ? 'Changes a ' + (it.prose ? 'sentence' : 'line') : 'New ' + (it.prose ? 'sentence' : 'line')) + '</span></label>' +
        '<div class="spec-res-diff">' + (it.mode === 'change' ? specWordDiff(it.was, it.text) : specWordDiff('', it.text)) + '</div></li>';
    }).join('');
    var who = function (r) { return r.updatedBy || 'someone'; };
    var w = sheet('<div class="sheet-head"><h2>Resolve: ' + esc(sec.title || 'Untitled') + '</h2><p>' +
      esc(who(sec) + '’s edit (' + relTime(sec.updatedAt) + ') is the section. ' + who(cp) + '’s edit (' + relTime(cp.updatedAt) + ') is the copy. Pick what to keep from the copy.') + '</p></div>' +
      '<div class="sheet-body">' +
      (plan.items.length ? '<ul class="spec-res-list">' + items + '</ul>' : '<p class="note">Everything in the copy is already in the section.</p>') +
      (also.length ? '<p class="note">The copy differs in more than its text: ' + esc(also.join('; ')) + '. Resolve keeps the section’s; change it by hand if you want the copy’s.</p>' : '') +
      '<p class="note">Each choice deletes the copy. Back undoes it in one step, and the copy stays in the review’s history on GitHub.</p></div>' +
      '<div class="sheet-foot"><button class="btn btn-danger" data-sheet="drop">Delete copy</button><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button>' +
      (plan.items.length ? '<button class="btn" data-sheet="use">Use the copy instead</button><button class="btn btn-primary" data-sheet="add">Add checked to section</button>' : '') + '</div>', { wide: true });
    w.addEventListener('change', function (e) { var k = e.target.getAttribute('data-pick'); if (k != null) picks[+k] = e.target.checked; });
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      var act = b.getAttribute('data-sheet');
      if (act === 'cancel') { closeSheet(); return; }
      var body = null;
      if (act === 'add') {
        if (!picks.some(Boolean)) { toast('Tick at least one, or use Delete copy'); return; }
        body = M.specResolveApply(sec.body, plan, picks);
      } else if (act === 'use') body = String(cp.body || '');
      var recs = [], who = me();
      if (body != null && body !== sec.body) recs.push(M.specStamp(Object.assign({}, sec, { body: body }), who));
      recs.push(M.specStamp(Object.assign({}, cp, { deleted: true }), who));
      closeSheet();
      specPutAll(p, recs);
      toast(act === 'drop' ? 'Copy deleted' : 'Section updated and copy deleted');
    });
  }

  // ── History (Chris, 2026-11-13: a sheet from the ⋯ menu; ../signoff/docs/history.md, lab
  // ../signoff/lab/history.html) ──
  // One review's changes, newest first, built from the versions of its file in git (store.fileHistory,
  // M.historyRows) and never stored: each change is attributed by the record's own stamp. What this
  // browser hasn't synced yet comes first. Runs by one person fold into blocks (M.historyBlocks). A change
  // shows its diff; Revert writes the record as it was before as a new edit stamped now, refused when the
  // record changed since. The demo has no git, so it lists each record's latest change only.
  var HIST_KEY = { meta: 'meta', check: 'items', section: 'sections', comment: 'comments', custom: 'custom', req: 'reqs', revision: 'revisions', spec: 'spec', tag: 'tags', rework: 'rework', release: 'releases' };
  var HIST_NOUN = { meta: ['detail change', 'detail changes'], check: ['check', 'checks'], section: ['section set aside or back', 'sections set aside or back'], comment: ['comment', 'comments'],
    custom: ['added check', 'added checks'], req: ['requirement', 'requirements'], revision: ['revision tag', 'revision tags'], spec: [SPEC_LABEL + ' edit', SPEC_LABEL + ' edits'], tag: ['version tag', 'version tags'], rework: ['rework', 'reworks'], release: ['release', 'releases'] };
  var HIST_KIND = { meta: 'Details', check: 'Check', section: 'Section', comment: 'Comment', custom: 'Added check', req: 'Requirement', revision: 'Revision', spec: SPEC_LABEL, tag: 'Version tag', rework: 'Rework', release: 'Release' };
  var HIST_FILTERS = [['all', 'Everything'], ['spec', SPEC_LABEL], ['check', 'Checks'], ['comment', 'Comments'], ['req', 'Requirements']].concat(C.rework ? [['rework', 'Rework']] : [], C.releases ? [['release', 'Releases']] : []);
  var histCache = {};   // per repo: { commits, blobs } for fileHistory, for as long as the page is open
  function histRecKey(r) { return r && typeof r === 'object' ? String(r.updatedAt || '') + '|' + String(r.updatedBy || '') : ''; }
  function histText(kind, r) {
    if (!r) return '';
    if (kind === 'spec') return (r.title ? '# ' + r.title + '\n' : '') + String(r.body || '');
    if (kind === 'comment' || kind === 'custom') return String(r.text || '');
    if (kind === 'req') return [r.ref, r.text].filter(Boolean).join(' ') + '\nStatus: ' + (r.status || '') + ', verify: ' + (r.verify || 'open') + (r.evidence ? '\nEvidence: ' + r.evidence : '');
    if (kind === 'check') return 'Status: ' + (r.status || 'to review') + (r.severity ? ', ' + r.severity : '') + (r.resolution ? ', ' + r.resolution : '');
    if (kind === 'section') return r.na ? 'Set aside (N/A)' : 'In review';
    if (kind === 'tag') return 'Version ' + String(r.commit || '').slice(0, 7) + ': ' + String(r.note || '');
    if (kind === 'rework') { var w = M.cleanRework(r, ''); return [w.ref, w.title].filter(Boolean).join(' ') + '\nStatus: ' + M.REWORK_LABEL[w.status] + (w.next ? ', fix in the next revision' : '') +
      (w.parts ? '\nParts: ' + w.parts : '') + (w.nets ? '\nNets: ' + w.nets : '') + (w.problem ? '\nWhat’s wrong: ' + w.problem : '') + (w.fix ? '\nRework details: ' + w.fix : '') + w.steps.map(function (s, i) { return '\nStep ' + (i + 1) + ': ' + s.text + (s.pics.length ? ' (' + plural(s.pics.length, 'picture') + ')' : ''); }).join('') + (w.pics.length ? '\nPictures: ' + w.pics.length : ''); }
    if (kind === 'release') { var rl = M.cleanRelease(r, ''); return 'Release ' + rl.version + ' (' + M.RELEASE_STATE_LABEL[rl.state] + ')\n' + rl.file.name + ', loads over ' + relLoadText(rl.load) +
      (rl.withdrawnWhy ? '\nWithdrawn: ' + rl.withdrawnWhy : '') + (rl.notes ? '\nNotes: ' + rl.notes : ''); }
    if (kind === 'revision') return 'Revision ' + (r.label || '') + (r.status ? ' (' + r.status + ')' : '') + (r.title ? ': ' + r.title : '');
    if (kind === 'meta') return ['name', 'stage', 'revision'].map(function (k) { return r[k] ? cap(k) + ': ' + r[k] : ''; }).filter(Boolean).join('\n') +
      ((r.profile || []).length ? '\nProfile: ' + r.profile.join(', ') : '') + ((r.checklists || []).length ? '\nChecklists: ' + r.checklists.join(', ') : '');
    return '';
  }
  function historySheet(p) {
    if (!p) return;
    p = projects[ui.slug] && projects[ui.slug].id === p.id ? projects[ui.slug] : p;   // the live review, never a compared copy
    var full = homeOf(p), store = DEMO || !getToken() ? null : workspace().store(full);
    histCache[full] = histCache[full] || {};
    var live = function () { var k = Object.keys(projects).filter(function (s) { return projects[s].id === p.id; })[0]; return (k && projects[k]) || p; };
    var parse = function (text) { var d = JSON.parse(text); return d && d.meta && d.id === p.id ? d : null; };
    HIST.open({
      title: p.meta.name, word: UNIT, demo: DEMO, demoNote: 'In the demo, history shows each record’s latest change only.',
      mount: function () { return sheet('<div class="hist-wrap"></div>', { wide: true }).querySelector('.sheet'); }, unmount: closeSheet,
      store: store, repo: full, path: store ? store.projectsDir() + p.id + '.json' : '', cache: histCache[full],
      noStore: 'Sign in to GitHub to see this ' + UNIT + '’s history.', toast: function (t) { toast(t, null, 6000); },
      parse: parse, live: live,
      rows: function (versions, complete) { return M.historyRows(versions, TEMPLATES, { complete: complete }); },
      // This browser's edits not on GitHub yet: records newer here than in the newest version. (A record
      // newer on GitHub is someone else's change this browser hasn't pulled; it's in the rows already.)
      unsynced: function (d, newest) {
        return !newest ? M.recordDiff(null, d, TEMPLATES)
          : M.recordDiff(newest, d, TEMPLATES).filter(function (r) { return !r.before || String(r.after && r.after.updatedAt || '') > String(r.before.updatedAt || ''); });
      },
      demoRows: function (d) { return M.changesSince(d, '', TEMPLATES).map(function (r) { r.before = null; r.after = r.kind === 'meta' ? d.meta : (d[HIST_KEY[r.kind]] || {})[r.id]; return r; }); },
      intro: function (rows) {
        var people = {}; rows.forEach(function (r) { people[r.by || 'Someone'] = 1; });
        return rows.length ? rows.length + ' changes by ' + HIST.fmt.listText(Object.keys(people)) + '. Runs by one person fold into a block.' : 'Who changed what, from the ' + UNIT + '’s versions on GitHub.';
      },
      empty: function (f) { return 'No changes' + (f === 'all' ? '' : ' of this kind') + ' yet.'; },
      filters: HIST_FILTERS, filter: function (r, f) { return r.kind === f; },
      counts: function (rows) {
        var counts = {}; rows.forEach(function (r) { counts[r.kind] = (counts[r.kind] || 0) + 1; });
        return HIST.fmt.listText(Object.keys(counts).map(function (k) { return counts[k] + ' ' + HIST_NOUN[k][counts[k] === 1 ? 0 : 1]; }));
      },
      blockTags: function (rows) { return rows.some(function (r) { return r.kind === 'spec' && r.after && r.after.conflictOf; }) ? '<span class="hist-tag hist-conflict">Conflict copy</span>' : ''; },
      row: function (r) {
        return { kind: HIST_KIND[r.kind], label: r.label,
          sub: r.deleted ? '<span class="hist-tag hist-del">' + (r.kind === 'tag' ? 'Removed' : 'Deleted') + '</span>' : !r.before && r.commit !== undefined ? '<span class="muted">added</span>' : '' };
      },
      change: function (r, k) {
        var a = histText(r.kind, r.after), b = histText(r.kind, r.before);
        var diff = r.deleted ? '<del>' + esc(b || a) + '</del>' : specWordDiff(r.before ? b : '', a);
        // Removing what a change added is a tombstone, which only these kinds keep; the others revert
        // only to an earlier version.
        var canRevert = r.kind !== 'meta' && r.kind !== 'tag' && !DEMO && (r.before || (!r.deleted && /^(spec|comment|req|custom|rework)$/.test(r.kind)));
        return { title: HIST_KIND[r.kind] + ': ' + r.label, body: a || b ? '<div class="hist-diff">' + diff + '</div>' : '',
          acts: canRevert ? '<button class="btn btn-sm" data-h="revert" data-r="' + k + '">' + (r.before ? 'Revert…' : 'Remove…') + '</button>' : '' };
      },
      act: function (name, r, api) { if (name === 'revert') revert(r, api); },
      tags: true, user: me,
      writeTags: function (map) {
        var cur = live();
        if (HIST.compare.isCopy(cur)) return false;
        cur.tags = map;   // each tag is its own record, stamped (HIST.tags.set)
        touch(cur); renderPage(); renderToolbar(); syncSoon();
        return true;
      },
      compareKey: p.id, compareTitle: p.meta.name
    });
    function revert(r, api) {
      var cur0 = live(), map = HIST_KEY[r.kind], cur = (cur0[map] || {})[r.id];
      if (histRecKey(cur) !== histRecKey(r.after)) {
        toast((cur && cur.updatedBy ? cur.updatedBy : 'Someone') + ' changed it since' + (cur && cur.updatedAt ? ', ' + relTime(cur.updatedAt) : '') + '. Open its newest change to revert from there.', null, 6000);
        return;
      }
      var what = r.before ? 'Put “' + r.label + '” back as it was before this change?' : 'Remove “' + r.label + '”, which this change added?';
      if (!confirm(what + '\n\nIt’s saved as a new edit by you and syncs like any other. Nothing in GitHub’s history is rewritten.')) return;
      var rec = JSON.parse(JSON.stringify(r.before || Object.assign({}, r.after, { deleted: true })));
      if (!r.before) rec.deleted = true;
      rec = r.kind === 'spec' ? M.specStamp(rec, me()) : M.stamp(rec, me());
      cur0[map] = cur0[map] || {}; cur0[map][r.id] = rec;
      touch(cur0); renderPage(); renderInspector(); renderToolbar(); syncSoon();
      api.addRow({ kind: r.kind, id: r.id, item: r.item, label: r.label, detail: '', at: rec.updatedAt, by: rec.updatedBy, deleted: !!rec.deleted, before: cur, after: rec, commit: null });
      toast(r.before ? 'Reverted' : 'Removed');
    }
  }

  // The two lists that need someone: flagged sentences and requirements nothing describes.
  function specNeedsHtml(p, a, noInbox) {
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
        '<div class="spec-need-acts">' + (orig ? '<button class="btn btn-sm btn-primary" data-act="spec-copy-resolve" data-id="' + esc(x.sec.id) + '" title="Take what you need from the copy into the section, then delete the copy, in one step">Resolve…</button>' +
          '<button class="btn btn-sm" data-act="spec-goto" data-id="' + esc(orig.id) + '">Newer version</button>' : '') +
        '<button class="btn btn-sm" data-act="spec-edit" data-id="' + esc(x.sec.id) + '">Edit copy</button>' +
        '<button class="btn btn-sm" data-act="spec-copy-delete" data-id="' + esc(x.sec.id) + '" title="Delete the copy once its text is merged into the newer version">Delete copy</button></div></div>';
    }).join('');
    // The requirement lists fold into one Requirements inbox, folded by default (Chris, 2026-11-13: a
    // long list pushed the text off the page). ui.specInbox remembers it open.
    var nMiss = a.undescribed.length, open = !!ui.specInbox, inbox = '';
    if ((nTags || nMiss) && !noInbox) {
      var counts = (nTags ? '<span class="count" title="Tagged @req: requirements still to make from them">' + nTags + ' to make</span>' : '') +
        (nMiss ? '<span class="count" title="Requirements no sentence describes">' + nMiss + ' not described</span>' : '');
      inbox = '<div class="card spec-inbox' + (open ? ' open' : '') + '">' +
        '<button class="spec-inbox-head" data-act="spec-inbox" aria-expanded="' + open + '"><span class="spec-inbox-chev" aria-hidden="true">▸</span>Requirements inbox' + counts + '</button>' +
        (open ? '<div class="spec-inbox-body">' +
          (nTags ? '<div class="spec-needs-card"><div class="spec-needs-title">Requirements to make <span class="count">' + nTags + '</span></div><p class="note spec-needs-sub">Tagged @req. Make a requirement from each, or change one the section already links.</p>' + tags + '</div>' : '') +
          (nMiss ? '<div class="spec-needs-card"><div class="spec-needs-title">Not described <span class="count">' + nMiss + '</span></div>' + missing + '</div>' : '') + '</div>' : '') +
        '</div>';
    }
    return '<div class="spec-needs">' +
      (copies.length ? '<div class="card spec-needs-card"><div class="spec-needs-title">Edited in two places <span class="count">' + copies.length + '</span></div>' +
        '<p class="note" style="margin:0 0 6px">Two people edited the same section from the same version. The newer edit is the section; the older one is kept beside it as a copy, so nothing is lost. Resolve takes what you need from the copy into the section and deletes the copy.</p>' + conflicts + '</div>' : '') +
      inbox + '</div>';
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
    var svg = '<svg class="spec-map' + ((selBlock && pos[selBlock]) || specEdgeSel() ? ' focus' : '') + '" ' + specVBAttr('0 0 ' + MW + ' ' + H) + ' role="img" aria-label="Diagram of the ' + esc(W.thing) + ' from the outline" data-rows="' + rows.map(function (r) { return r.kind; }).join(',') + '" data-bands="' + rows.map(function (r) { return Math.round(r.y - (RH - BH) / 2) + ':' + Math.round(r.y + r.h - (RH - BH) / 2); }).join(',') + '" data-bh="' + BH + '">' +
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
    return specCard(svg) + '<p class="note">Drawn from the outline, and written back to it. + adds a block to a layer (a new section in the text). Drag from the dot under a block to another block to say it uses that one; click a line for its panel, where Delete removes it (Undo in the message brings it back). Drag a block itself to another layer to change its kind, or beside other blocks to move it there in the outline. Click a block to rename it, change its kind or gist, or choose what it uses. Lines come from each section’s <code>Uses:</code> line, or join it to the section above it; dashed lines join each interface to the blocks that use it. Lines from one block to several share a trunk, and pointing at a block brings its own lines forward. Dotted blocks have unlinked or flagged sentences.</p>';
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
  // Whole steps of the routing grid (SPEC_GRID, 10), so blocks, their ports, and the lines between them all sit
  // on it (Chris, 2026-11-19: everything snaps on a grid).
  var SPEC_BW = 160, SPEC_BH = 60, SPEC_PAD = 20, SPEC_HEAD = 20, SPEC_GAP = 40, SPEC_ROWGAP = 60;
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
  // ── The expanded diagram (Chris, 2026-11-13) ──
  // The expand button at the card's top right opens the diagram over the whole window (Chris: always
  // full screen), with the block and line panel over it as usual. There the wheel (or a trackpad pinch) zooms about the pointer, a middle or right drag pans (a
  // plain drag still draws a section), and on a touch screen a pinch zooms and one finger on empty space
  // pans. Everything else works as in the page. Closed, the card shows the whole diagram as before.
  // specZoom is the expanded view's viewBox, kept across re-renders and forgotten on close.
  var specExpanded = false, specZoom = null, specZp = null;
  var ICON_EXPAND = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5l-5 5M3.5 16.5l5-5"/></svg>';
  var ICON_SHRINK = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 8H12V3.5M3.5 12H8v4.5M12 8l4.5-4.5M8 12l-4.5 4.5"/></svg>';
  // specExpanded names the expanded card (Chris, 2026-11-19: the power tree is a second diagram on the page):
  // 'map' for the block diagram or FW's map, 'ptree' for the power tree, or false.
  function specVBAttr(fit, card) { return 'viewBox="' + (specExpanded === (card || 'map') && specZoom ? specZoom.join(' ') : fit) + '" data-fit="' + fit + '"'; }
  // tools: buttons shown at the top left only while the diagram is expanded (Chris, 2026-11-19: Add block and
  // Auto layout full screen too).
  function specCard(svg, tools, card) {
    card = card || 'map';
    var ex = specExpanded === card;
    return '<div class="card spec-map-card' + (ex ? ' expanded' : '') + '" data-card="' + card + '">' +
      (ex && tools ? '<div class="spec-view-tools">' + tools + '</div>' : '') +
      // Full screen, the page's Sync and Discard come along (Chris, 2026-11-20), left of Fit; none in the demo.
      '<div class="spec-view-acts">' + (ex ? '<span class="spec-view-sync">' + syncButtons() + '</span><button class="chip" data-act="spec-fit" title="Show the whole diagram">Fit</button>' : '') +
      '<button class="icon-btn spec-expand" data-act="spec-export" title="Save the diagram as a picture or a PDF" aria-label="Export the diagram" aria-haspopup="menu">' + ICON_SAVE + '</button>' +
      '<button class="icon-btn spec-expand" data-act="spec-expand" data-card="' + card + '" title="' + (ex ? 'Back to the page (Esc)' : 'Expand the diagram: zoom and pan') + '" aria-label="' + (ex ? 'Collapse the diagram' : 'Expand the diagram') + '">' + (ex ? ICON_SHRINK : ICON_EXPAND) + '</button></div>' +
      (ex ? '<div class="spec-zoom-hint"><span class="hint-mouse">Scroll to zoom · middle or right drag to pan · Esc to close</span><span class="hint-touch">Pinch to zoom · drag empty space to pan</span></div>' : '') +
      svg + '</div>';
  }
  var ICON_SAVE = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5v9M6 9l4 4 4-4M4 15.5h12"/></svg>';
  // ── Exporting the diagram (Chris, 2026-11-13): PNG, SVG, or a landscape PDF with a title block ──
  // Always the whole diagram in light colors, whatever the zoom or theme, without the editing handles,
  // hit areas, current beads, or selection. Styles are copied inline so the file stands alone.
  var SPEC_EXPORT_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
    'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing'];
  function specExportSvg(live) {
    live = live || document.querySelector('svg.spec-map'); if (!live) return null;
    var fit = String(live.dataset.fit || '').split(' ').map(Number);
    if (fit.length !== 4 || fit.some(function (n) { return !isFinite(n); })) { var b = live.viewBox.baseVal; fit = [b.x, b.y, b.width, b.height]; }
    var c = live.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.spec-handle, .spec-edge-hit, .spec-lead-hit, .spec-pulse, .spec-grips, .spec-port, title'), function (el) { el.remove(); });
    c.classList.remove('focus', 'moving', 'moving-label');
    Array.prototype.forEach.call(c.querySelectorAll('.sel, .on'), function (el) { el.classList.remove('sel', 'on'); });
    c.setAttribute('viewBox', fit.join(' '));
    c.setAttribute('width', Math.round(fit[2])); c.setAttribute('height', Math.round(fit[3]));
    c.setAttribute('style', 'position:absolute;left:-100000px;top:0;width:' + fit[2] + 'px;height:' + fit[3] + 'px');
    var root = document.documentElement, theme = root.getAttribute('data-theme');
    root.classList.add('spec-exporting'); root.setAttribute('data-theme', 'light');
    document.body.appendChild(c);
    var els = [c].concat(Array.prototype.slice.call(c.querySelectorAll('*')));
    var styles = els.map(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none') return null;
      return { st: SPEC_EXPORT_PROPS.map(function (k) { return k + ':' + cs.getPropertyValue(k); }).join(';'), upper: cs.textTransform === 'uppercase' };
    });
    var bg = getComputedStyle(document.body).getPropertyValue('--bg-elev') || '#fff';
    c.remove();
    if (theme) root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
    root.classList.remove('spec-exporting');
    els.forEach(function (el, i) {
      var st = styles[i];
      if (!st) { el.remove(); return; }
      el.setAttribute('style', st.st);
      el.removeAttribute('class');
      Array.prototype.slice.call(el.attributes).forEach(function (a) { if (/^(data-|aria-|role$|tabindex$)/.test(a.name)) el.removeAttribute(a.name); });
      if (st.upper && el.tagName.toLowerCase() === 'text') el.textContent = el.textContent.toUpperCase();
    });
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.setAttribute('style', 'background:#fff');
    var bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    ['x', 'y', 'width', 'height'].forEach(function (k, i) { bgRect.setAttribute(k, fit[i]); });
    bgRect.setAttribute('fill', '#ffffff');
    c.insertBefore(bgRect, c.firstChild);
    return { svg: new XMLSerializer().serializeToString(c), w: fit[2], h: fit[3], bg: bg };
  }
  function specExportName(p, ext, what) {
    return (String(p.meta.name || p.slug || 'diagram').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'diagram') + ' ' + (what || 'block diagram') + '.' + ext;
  }
  function specSaveBlob(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function specExport(anchor) {
    var p = current(); if (!p) return;
    var card = anchor && anchor.closest && anchor.closest('.spec-map-card'), live = card && card.querySelector('svg.spec-map');
    var what = card && card.dataset.card === 'ptree' ? 'power tree' : 'block diagram';
    // The block diagram's SVG also carries it as a draw.io diagram (Chris, 2026-11-20): a .drawio.svg.
    var dio = what === 'block diagram' && specDrawioOn() && !!live && live.classList.contains('spec-flow');
    menu(anchor, [['png', 'PNG picture'], ['svg', dio ? 'SVG drawing, editable in draw.io' : 'SVG drawing'], ['pdf', 'PDF, landscape, with a title block']]).then(function (ch) {
      var x = specExportSvg(live); if (!x) { toast('Nothing to export yet'); return; }
      x.what = what;
      var head = '<?xml version="1.0" encoding="UTF-8"?>\n';
      if (ch === 'svg' && dio) {
        Promise.resolve().then(function () { return DRAWIO.svgWithFile(x.svg, [DRAWIO.scribePage(specDrawioSnap(p))]); }).then(function (s) {
          specSaveBlob(specExportName(p, 'drawio.svg', what), new Blob([head + s], { type: 'image/svg+xml' }));
          toast('Saved. It’s a picture anywhere, and an editable diagram in draw.io; Import from draw.io in the ☰ menu reads it back.', null, 6000);
        }).catch(function () {
          specSaveBlob(specExportName(p, 'svg', what), new Blob([head + x.svg], { type: 'image/svg+xml' }));
          toast('Saved as a plain SVG: the draw.io diagram couldn’t be added');
        });
        return;
      }
      if (ch === 'svg') { specSaveBlob(specExportName(p, 'svg', what), new Blob([head + x.svg], { type: 'image/svg+xml' })); return; }
      if (ch === 'png') {
        var img = new Image(), url = URL.createObjectURL(new Blob([x.svg], { type: 'image/svg+xml' }));
        img.onload = function () {
          var k = 2, cv = document.createElement('canvas');
          cv.width = Math.round(x.w * k); cv.height = Math.round(x.h * k);
          var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0, cv.width, cv.height);
          URL.revokeObjectURL(url);
          cv.toBlob(function (b) { if (b) specSaveBlob(specExportName(p, 'png', what), b); else toast('Couldn’t make the picture'); }, 'image/png');
        };
        img.onerror = function () { URL.revokeObjectURL(url); toast('Couldn’t make the picture'); };
        img.src = url;
        return;
      }
      if (ch === 'pdf') specDiagramSheet(p, x);
    });
  }
  // ── draw.io (Chris, 2026-11-20) ──
  // The block diagram's SVG export carries it as a draw.io diagram too, and Import from draw.io (the ☰ menu) reads
  // one back as Scribe edits, listed before they're made. The mapping is assets/drawio.js (window.SignoffDrawio);
  // here the snapshot is taken from the drawn diagram and the plan is applied. docs/scribe-ee.md, *draw.io*.
  var DRAWIO = window.SignoffDrawio || null;
  function specDrawioOn() { return SPEC_FLOW && !!DRAWIO && typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'; }
  // The drawn diagram as a snapshot. It's drawn with its section boxes for this, even when Sections is off.
  function specDrawioSnap(p) {
    var svg = document.querySelector('svg.spec-flow');
    if (svg && ui.specBoxes !== false) return specDrawioRead(svg, p);
    var keep = { view: ui.view, specView: ui.specView, boxes: ui.specBoxes };
    ui.view = 'spec'; if (!svg) ui.specView = 'map'; ui.specBoxes = true;
    try { renderPage(); svg = document.querySelector('svg.spec-flow'); if (!svg) throw new Error('No diagram to read'); return specDrawioRead(svg, p); }
    finally { ui.view = keep.view; ui.specView = keep.specView; ui.specBoxes = keep.boxes; renderPage(); }
  }
  function specDrawioRead(svg, p) {
    var a = M.specAnalysis(p), byId = {}, n = function (el, k) { return +el.getAttribute(k); };
    a.sections.forEach(function (x) { byId[x.sec.id] = x; });
    var snap = { review: { id: p.id, name: p.meta.name || '', tool: C.toolName || '' }, sections: [], blocks: [], lines: [], legend: null };
    Array.prototype.forEach.call(svg.querySelectorAll('g.spec-group-g'), function (g) {
      var x = byId[g.dataset.id]; if (!x) return;
      var b = g.dataset.box.split(' ').map(Number);
      snap.sections.push({ id: x.sec.id, title: x.sec.title || '', gist: x.gist || '', parent: g.dataset.parent || '', x: b[0], y: b[1], w: b[2], h: b[3], grow: x.sec.grow || { l: 0, t: 0, r: 0, b: 0 } });
    });
    Array.prototype.forEach.call(svg.querySelectorAll('g.spec-node'), function (g) {
      var x = byId[g.dataset.id], r = g.querySelector('rect'); if (!x || !r) return;
      // Its rails' pictures, where they're drawn (a power flag's stem starts at the block's top edge).
      var flags = Array.prototype.filter.call(svg.querySelectorAll('g.spec-flag[data-for="' + CSS.escape(x.sec.id) + '"]'), function (f) {
        var t = f.querySelector('title'); return t && /^(Makes|Uses) /.test(t.textContent);
      });
      var power = (x.power || []).map(function (q, i) {
        // The marker drawn for this rail and role (sources are drawn right of sinks, so not in line order).
        var f = flags.filter(function (g2) { return (g2.getAttribute('data-rail') || '').toLowerCase() === q.rail.toLowerCase() && g2.getAttribute('data-role') === q.role; })[0] || flags[i], d = f && f.querySelector('path'), m = d && /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(d.getAttribute('d'));
        var fx = m ? +m[1] - 8 : n(r, 'x') + n(r, 'width') - 46 * (i + 1), fy = m ? +m[2] - 15 : n(r, 'y') - 15;
        return { rail: q.rail, role: q.role, tree: q.tree !== false, x: fx, y: fy, w: Math.min(110, 22 + q.rail.length * 6.2) };
      });
      snap.blocks.push({ id: x.sec.id, title: x.sec.title || '', gist: x.gist || '', parent: g.dataset.parent || '', kept: !!x.sec.pos,
        x: n(r, 'x'), y: n(r, 'y'), w: n(r, 'width'), h: n(r, 'height'), parts: x.parts || [], power: power,
        reqs: (x.links || []).map(function (id) { return a.ctx.reqs[id] ? a.ctx.reqs[id].ref : ''; }).filter(Boolean) });
    });
    var lines = {}; ((specFlowLast && specFlowLast.model.lines) || []).forEach(function (L) { lines[L.key] = L; });
    Array.prototype.forEach.call(svg.querySelectorAll('path.spec-edge[data-line]'), function (el) {
      var key = el.dataset.line, L = lines[key], nums = (el.getAttribute('d').match(/-?\d+(\.\d+)?/g) || []).map(Number), pts = [];
      for (var i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      if (pts.length < 2) return;
      var lab = svg.querySelector('g.spec-edge-label[data-line="' + CSS.escape(key) + '"]'), txt = lab && lab.querySelector('.spec-pill');
      var ms = !!el.getAttribute('marker-start'), me2 = !!el.getAttribute('marker-end');
      snap.lines.push({ key: key, a: el.dataset.a, b: el.dataset.b, word: L ? L.word : key.split('|').pop(), dir: ms && me2 ? 'both' : ms ? 'in' : 'out',
        signal: txt ? (txt.dataset.text != null ? txt.dataset.text : (txt.querySelector('text') || txt).textContent) : '', t: lab ? +lab.dataset.t || 0.5 : 0.5, pa: pts[0], pb: pts[pts.length - 1], corners: specDrawioCorners(pts),
        shaped: !!(L && L.shape), srcA: L ? L.srcA : el.dataset.a, rkey: L ? L.rkey : '' });
    });
    var lg = svg.querySelector('g.spec-legend path'), lm = lg && /M\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/.exec(lg.getAttribute('d'));
    if (lm) snap.legend = { x: +lm[1] - 8, y: +lm[2] - 15 };
    return snap;
  }
  // A drawn line's path rounds its corners into short runs: keep the corners of its straight runs.
  function specDrawioCorners(pts) {
    var segs = [], out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var A = pts[i], B = pts[i + 1], dx = Math.abs(B.x - A.x), dy = Math.abs(B.y - A.y);
      if (Math.max(dx, dy) > 3 && (dx < 0.01 || dy < 0.01)) segs.push({ h: dy < 0.01, x: A.x, y: A.y });
    }
    for (var j = 0; j < segs.length - 1; j++) { var s = segs[j], t = segs[j + 1]; if (s.h !== t.h) out.push(s.h ? { x: t.x, y: s.y } : { x: s.x, y: t.y }); }
    return out;
  }
  function specDrawioImport() {
    var p = current(); if (!p) return;
    if (HIST.compare.isCopy(p)) { HIST.compare.refuse(); return; }
    if (specEditing) { toast('Save or cancel the edit first'); return; }
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.svg,.drawio,.xml,image/svg+xml';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]; if (!f) return;
      if (f.size > 20 * 1024 * 1024) { toast('That file is too big for a block diagram'); return; }
      f.text().then(DRAWIO.read).then(function (doc) {
        var page = doc.pages.filter(function (pg) { return pg.root && pg.root.scribeFormat; })[0] || doc.pages[0];
        var q = current(); if (!q || q.id !== p.id) return;
        var snap = specDrawioSnap(q), plan = DRAWIO.scribePlan(page, snap);
        if (doc.pages.length > 1) plan.unshift({ op: 'skip', text: 'The file has ' + doc.pages.length + ' pages; only “' + (page.name || 'the first') + '” was read' });
        specDrawioSheet(q, plan, snap, f.name);
      }).catch(function (err) { toast((err && err.message) || 'Couldn’t read that file'); });
    });
    inp.click();
  }
  function specDrawioSheet(p, plan, snap, fname) {
    var edits = plan.filter(function (c) { return c.op !== 'skip' && c.op !== 'review'; });
    var notes = plan.filter(function (c) { return c.op === 'skip' || c.op === 'review'; });
    if (!edits.length) { toast(notes.length ? 'Nothing to change. ' + notes[0].text : 'Nothing to change: the file matches the diagram', null, 6000); return; }
    var w = sheet('<div class="sheet-head"><h2>Import from draw.io</h2><p>' + esc(fname) + ' asks for these changes to ' + esc(SPEC_LABEL) + '. Untick any you don’t want. Removals start unticked. It’s one step you can undo, and it waits for Sync like any edit.</p></div>' +
      '<div class="sheet-body">' + (notes.length ? '<div class="spec-dio-notes">' + notes.map(function (c) { return '<p class="note">' + esc(c.text) + '</p>'; }).join('') + '</div>' : '') +
      '<div class="spec-dio-list">' + edits.map(function (c, i) {
        return '<label class="spec-dio-row' + (c.ask ? ' ask' : '') + '"><input type="checkbox" data-i="' + i + '"' + (c.ask ? '' : ' checked') + '> <span>' + esc(c.text) + '</span></label>';
      }).join('') + '</div>' +
      '<p class="note">Kept from draw.io: names, sections, places, connections and their signals and arrows, where lines meet blocks, Parts, and rails. Not kept: line shapes (they route again), colors, fonts, and other shapes.</p></div>' +
      '<div class="sheet-foot"><span class="spacer"></span><button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">Make the changes</button></div>');
    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sheet]'); if (!b) return;
      if (b.dataset.sheet === 'cancel') { closeSheet(); return; }
      var pick = Array.prototype.filter.call(w.querySelectorAll('.spec-dio-list input'), function (x) { return x.checked; }).map(function (x) { return edits[+x.dataset.i]; });
      closeSheet();
      if (!pick.length) return;
      var q = current(); if (!q || q.id !== p.id) return;
      var res = specDrawioApply(q, pick, snap);
      if (!res.recs.length) { toast(res.notes[0] || 'Nothing changed'); return; }
      specPutAll(q, res.recs);
      var hu = specHistOf(q).undo, last = hu[hu.length - 1];
      if (last && res.recs.every(function (r) { return r.id in last.cur; })) { last.label = 'importing from draw.io'; renderPage(); }
      toast('Imported from draw.io: ' + plural(pick.length, 'change') + (res.notes.length ? '. ' + res.notes.join(' ') : ''), { label: 'Undo', run: function () { specHistStep(true); } }, 8000);
    });
  }
  // The plan's changes as Scribe records, made on a working copy in a fixed order: new blocks and sections,
  // renames, sections, connections, signals and arrows, Parts and rails, places, ports, routes, and removals.
  function specDrawioApply(p, plan, snap) {
    var view = Object.assign({}, p, { spec: Object.assign({}, p.spec) }), newId = {}, notes = [], who = me();
    var put = function (recs) { recs.forEach(function (r) { view.spec[r.id] = r; }); };
    var rec = function (id) { return view.spec[id]; };
    var idOf = function (k) { return k && k.indexOf('new:') === 0 ? newId[k] || '' : k; };
    var titleOf = function (id) { var r = rec(id); return r ? r.title : ''; };
    var taken = function (t, id) { return M.liveSpec(view).some(function (s) { return s.id !== id && s.title.toLowerCase() === t.toLowerCase(); }); };
    var uniq = function (t) { var x = t, i = 2; while (taken(x)) x = t + ' ' + i++; return x; };
    var edit = function (id, f) { var r = rec(id); if (r) put([M.specStamp(Object.assign({}, r, f), who)]); };
    var setBody = function (id, fn) { var r = rec(id); if (!r) return; var b = fn(String(r.body || '')); if (b !== r.body) edit(id, { body: b }); };
    var of = function (op) { return plan.filter(function (c) { return c.op === op; }); };
    var lineOf = {}; snap.lines.forEach(function (L) { lineOf[L.key] = L; });
    var word0 = M.specOfferWords()[0];
    of('add-block').forEach(function (c) { var r = M.specAddBlock(view, { title: uniq(c.title) }, who); if (r.length) { put(r); newId[c.key] = r[0].id; } });
    // New sections, inner ones first: each groups the blocks (and sections) inside it.
    var secs = of('add-section'), guard = 0;
    while (secs.length && guard++ < 50) secs = secs.filter(function (c) {
      var ids = c.members.map(idOf);
      if (ids.some(function (x) { return !x; })) return true;
      var t = uniq(c.title), r = ids.length ? M.specGroup(view, ids, t, who) : M.specAddBlock(view, { title: t }, who);
      put(r);
      var made = r.filter(function (x) { return x.title === t && !p.spec[x.id]; })[0];
      if (made) newId[c.key] = made.id;
      return false;
    });
    // Grouping makes the heading where its first block was: put it where it was drawn (a section, or the board).
    of('add-section').forEach(function (c) {
      var id = idOf(c.key); if (!id || (c.parent && c.parent.indexOf('new:') === 0)) return;
      put(M.specNest(view, [id], c.parent || null, who));
    });
    of('rename').forEach(function (c) {
      if (!rec(c.id)) return;
      if (taken(c.to, c.id)) { notes.push('Not renamed to ' + c.to + ': another section has that name.'); return; }
      put(M.specRename(view, c.id, c.to, who));
    });
    // Which section each block is in: a move into a new section was made by grouping it.
    of('nest').concat(of('add-block')).forEach(function (c) {
      var id = c.op === 'nest' ? c.id : idOf(c.key), to = c.op === 'nest' ? c.to : c.parent;
      if (!id || (to && to.indexOf('new:') === 0)) return;
      if (c.op === 'add-block' && !to) return;
      put(M.specNest(view, [id], to || null, who));
    });
    var setItems = function (id, word, fn) {
      setBody(id, function (body) { return M.specSetLine(body, word, M.specLinkText(fn(M.specUsesItems(body, word)))); });
    };
    of('add-link').forEach(function (c) {
      var a = idOf(c.from), b = idOf(c.to); if (!a || !b || !rec(a) || !rec(b)) return;
      var tb = titleOf(b);
      setItems(a, word0, function (items) {
        if (items.some(function (it) { return M.specUseIs(it, tb); })) return items;
        return items.concat([{ name: tb, label: String(c.signal || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim(), dir: c.dir === 'out' ? '' : c.dir }]);
      });
    });
    var wordOf = function (c) { return M.specLinkWord(c.word) || word0; };
    of('signal').forEach(function (c) {
      var parts = String(c.to || '').split(' / '), two = parts.length === 2;
      var clean = function (s) { return String(s || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim(); };
      var ta = titleOf(c.a), tb = titleOf(c.b), wd = wordOf(c);
      setItems(c.a, wd, function (items) { return items.map(function (it) { return M.specUseIs(it, tb) ? Object.assign({}, it, { label: clean(two ? parts[0] : c.to) }) : it; }); });
      setItems(c.b, wd, function (items) { return items.map(function (it) { return M.specUseIs(it, ta) ? Object.assign({}, it, { label: clean(two ? parts[1] : c.to) }) : it; }); });
    });
    of('dir').forEach(function (c) {
      var ta = titleOf(c.a), tb = titleOf(c.b), wd = wordOf(c), back = c.to === 'both' ? 'both' : c.to === 'in' ? 'out' : 'in';
      setItems(c.a, wd, function (items) { return items.map(function (it) { return M.specUseIs(it, tb) ? Object.assign({}, it, { dir: c.to === 'out' ? '' : c.to }) : it; }); });
      setItems(c.b, wd, function (items) { return items.map(function (it) { return M.specUseIs(it, ta) ? Object.assign({}, it, { dir: back === 'out' ? '' : back }) : it; }); });
    });
    of('parts').forEach(function (c) { setBody(c.id, function (body) { return M.specSetLine(body, 'parts', c.to); }); });
    of('power').forEach(function (c) {
      var id = idOf(c.id); if (!id) return;
      setBody(id, function (body) { return M.specSetLine(body, 'power', M.specPowerText(c.items)); });
    });
    // Places: a move or a resize keeps every block's place from then on, as a drag does.
    var moves = of('move'), grows = of('grow'), frozen = snap.blocks.some(function (b) { return b.kept; });
    if (moves.length || grows.length) {
      var to = {}; moves.forEach(function (c) { to[c.id] = c; });
      snap.blocks.forEach(function (b) {
        if (!rec(b.id) || rec(b.id).deleted) return;
        var c = to[b.id];
        if (c) edit(b.id, { pos: { x: c.x, y: c.y } });
        else if (!b.kept) edit(b.id, { pos: { x: specSnap(b.x), y: specSnap(b.y) } });
      });
      frozen = true;
    }
    if (frozen) of('add-block').forEach(function (c) { var id = idOf(c.key); if (id && rec(id)) edit(id, { pos: { x: c.x, y: c.y } }); });
    grows.forEach(function (c) {
      var r = rec(c.id); if (!r) return;
      var nr = Object.assign({}, r), g = c.grow;
      if (g.l || g.t || g.r || g.b) nr.grow = g; else delete nr.grow;
      put([M.specStamp(nr, who)]);
    });
    of('port').forEach(function (c) {
      var r = rec(c.block); if (!r) return;
      var ports = Object.assign({}, r.ports || {});
      ports[c.other + '|' + String(c.word).toLowerCase()] = specPortAt(c.box, c.at);
      edit(c.block, { ports: ports });
    });
    of('route').forEach(function (c) {
      var L = lineOf[c.line], r = L && rec(L.srcA); if (!r || !r.routes || !r.routes[L.rkey]) return;
      var rt = Object.assign({}, r.routes); delete rt[L.rkey];
      var nr = Object.assign({}, r); if (Object.keys(rt).length) nr.routes = rt; else delete nr.routes;
      put([M.specStamp(nr, who)]);
    });
    of('delete-link').forEach(function (c) {
      var ta = titleOf(c.a), tb = titleOf(c.b), wd = wordOf(c);
      setItems(c.a, wd, function (items) { return items.filter(function (it) { return !M.specUseIs(it, tb); }); });
      setItems(c.b, wd, function (items) { return items.filter(function (it) { return !M.specUseIs(it, ta); }); });
    });
    of('delete-block').forEach(function (c) {
      if (!rec(c.id)) return;
      // A section's blocks move up a level first, so deleting the heading takes only its own text.
      if (snap.sections.some(function (s) { return s.id === c.id; })) put(M.specUngroup(view, c.id, who));
      if (rec(c.id) && !rec(c.id).deleted) edit(c.id, { deleted: true });
    });
    var recs = Object.keys(view.spec).filter(function (id) { return view.spec[id] !== (p.spec || {})[id]; }).map(function (id) { return view.spec[id]; });
    return { recs: recs, notes: notes };
  }

  // The landscape sheet: the diagram over the page, and a title block at the bottom right with the
  // review's details. Print or save as PDF from the print view (the browser's own PDF printer).
  // The title block follows Dovetail's Altium schematic sheets (Chris, 2026-11-13): the review's title
  // across the top (Chris swapped it with Page the same day; the tb- areas name places, not contents);
  // part number and project beside the Dovetail mark; page and rev; date and, where the schematic has
  // its variant, the stage; engineer, client (in the schematic's size), and sheet 1 of 1.
  var DG_MARK = '<svg viewBox="0 0 59.21 98.68" aria-hidden="true"><path d="M0 0h18.19v41.88H0zM0 56.79h18.19v41.88H0zM18.2 41.89h1.59v14.91H18.2zM19.79 0v41.89l24.96-6.63v28.16L19.79 56.79v41.89l39.42-10.47V10.47z" fill="#000"/></svg>';
  function specDiagramSheet(p, x) {
    var m = p.meta, d = new Date(), date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    var tool = (C.toolName || document.title.split('·')[0] || 'Signoff').trim();
    function cell(area, label, value, big) {
      return '<div class="tb-' + area + (big ? ' tb-big' : '') + '"><span class="tb-l">' + esc(label) + '</span>' + (big ? '' : ' ') + '<span class="tb-v">' + esc(value || '') + '</span></div>';
    }
    var block = '<div class="dg-title">' +
      cell('page', 'Title', m.name || 'Untitled', true) +
      cell('pn', 'Part number', m.board, true) +
      cell('proj', 'Project', m.project, true) +
      '<div class="tb-logo">' + DG_MARK + '<span>DOVETAIL</span></div>' +
      cell('title', 'Page:', tool + ' ' + (x.what || 'block diagram')) +
      '<div class="tb-rev"><span class="tb-l">Rev</span> <b>' + esc(m.revision || '') + '</b></div>' +
      cell('date', 'Date:', date) +
      cell('var', 'Stage:', m.stage) +
      cell('eng', 'Engineer:', settings.user || me()) +
      cell('client', 'Client:', m.client) +
      '<div class="tb-sheet"><span class="tb-l">Sheet</span> <b>1</b> <span class="tb-l">of</span> <b>1</b></div>' +
      '</div>';
    var r = $('#report');
    r.innerHTML = '<div class="report-bar"><b>' + (x.what === 'power tree' ? 'Power tree' : 'Block diagram') + '</b><div style="display:flex;gap:8px"><button class="btn" data-act="close-report">Close</button><button class="btn btn-primary" data-act="print">Print or save as PDF</button></div></div>' +
      '<div class="paper dg-paper"><div class="dg-art">' + x.svg + '</div><div class="dg-foot">' + block + '</div></div>';
    r.hidden = false;
  }
  function specSetExpanded(on) { specExpanded = on ? (typeof on === 'string' ? on : 'map') : false; specZoom = null; specZp = null; renderPage(); }
  function specVB(svg) { var b = svg.viewBox.baseVal; return [b.x, b.y, b.width, b.height]; }
  function specSetVB(svg, v) { specZoom = v.map(function (n) { return Math.round(n * 100) / 100; }); svg.setAttribute('viewBox', specZoom.join(' ')); }
  // Zoom by f (above 1 zooms in) about a point on screen, between a twelfth and four times the fitted width.
  function specZoomAt(svg, cx, cy, f) {
    var v = specVB(svg), fit = Number(String(svg.dataset.fit || '').split(' ')[2]) || v[2];
    var nw = Math.max(fit / 12, Math.min(fit * 4, v[2] / f)), k = nw / v[2];
    var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
    var q = pt.matrixTransform(svg.getScreenCTM().inverse());
    specSetVB(svg, [q.x - (q.x - v[0]) * k, q.y - (q.y - v[1]) * k, v[2] * k, v[3] * k]);
  }
  function specPanBy(svg, dx, dy) {
    var v = specVB(svg), sc = svg.getScreenCTM().a || 1;
    specSetVB(svg, [v[0] - dx / sc, v[1] - dy / sc, v[2], v[3]]);
  }
  function specZpDown(e, svg) {
    e.preventDefault();
    if (!specZp || specZp.svg !== svg) specZp = { svg: svg, pts: {}, moved: false };
    specZp.pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  }
  function specZpMove(e) {
    var z = specZp, q = z && z.pts[e.pointerId]; if (!q) return false;
    e.preventDefault();
    var ids = Object.keys(z.pts);
    if (ids.length === 1) specPanBy(z.svg, e.clientX - q.x, e.clientY - q.y);
    else {
      var o = z.pts[ids[0] === String(e.pointerId) ? ids[1] : ids[0]];
      var d0 = Math.hypot(q.x - o.x, q.y - o.y) || 1, d1 = Math.hypot(e.clientX - o.x, e.clientY - o.y) || 1;
      var m0 = { x: (q.x + o.x) / 2, y: (q.y + o.y) / 2 }, m1 = { x: (e.clientX + o.x) / 2, y: (e.clientY + o.y) / 2 };
      specZoomAt(z.svg, m1.x, m1.y, d1 / d0); specPanBy(z.svg, m1.x - m0.x, m1.y - m0.y);
    }
    if (e.clientX !== q.x || e.clientY !== q.y) z.moved = true;
    q.x = e.clientX; q.y = e.clientY;
    return true;
  }
  function specZpUp(e) {
    var z = specZp; if (!z || !z.pts[e.pointerId]) return;
    delete z.pts[e.pointerId];
    if (Object.keys(z.pts).length) return;
    if (z.moved) { specDragJustEnded = true; setTimeout(function () { specDragJustEnded = false; }, 0); }
    specZp = null;
  }
  document.addEventListener('wheel', function (e) {
    var svg = specExpanded && e.target.closest && e.target.closest('.spec-map-card.expanded svg.spec-map'); if (!svg) return;
    e.preventDefault();
    specZoomAt(svg, e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015) * (e.ctrlKey ? 4 : 1)));
  }, { passive: false });
  document.addEventListener('contextmenu', function (e) { if (specExpanded && e.target.closest && e.target.closest('.spec-map-card.expanded')) e.preventDefault(); });
  document.addEventListener('mousedown', function (e) { if (e.button === 1 && specExpanded && e.target.closest && e.target.closest('.spec-map-card.expanded')) e.preventDefault(); });
  function bez(p0, p1, p2, p3, t) { var u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; }
  // A line from one block to another, out of the side facing it, with a point for its label.
  // It leaves and enters square to the block's side on a short straight stub (Chris, 2026-11-13: lines
  // fanning out of one connector came in at odd angles), so an arrowhead always sits on a straight run;
  // the curve between the stubs (cd) is what labels ride on.
  var SPEC_STUB = 12;
  function specRoute(A, B) {
    var x1, y1, x2, y2, sx = 0, sy = 0, ex = 0, ey = 0, S = SPEC_STUB;
    if (B.x >= A.x + A.w + 12) { x1 = A.x + A.w; y1 = A.y + A.h / 2; x2 = B.x - 1; y2 = B.y + B.h / 2; sx = ex = 1; }
    else if (A.x >= B.x + B.w + 12) { x1 = A.x; y1 = A.y + A.h / 2; x2 = B.x + B.w + 1; y2 = B.y + B.h / 2; sx = ex = -1; }
    else if (B.y > A.y + A.h) { x1 = A.x + A.w / 2; y1 = A.y + A.h; x2 = B.x + B.w / 2; y2 = B.y - 1; sy = ey = 1; }
    else if (B.y + B.h < A.y) { x1 = A.x + A.w / 2; y1 = A.y; x2 = B.x + B.w / 2; y2 = B.y + B.h + 1; sy = ey = -1; }
    else { x1 = A.x + A.w / 2; y1 = A.y + A.h; x2 = B.x + B.w / 2; y2 = B.y + B.h + 1; sy = 1; ey = -1; }
    var p1x = x1 + sx * S, p1y = y1 + sy * S, p2x = x2 - ex * S, p2y = y2 - ey * S, c1x, c1y, c2x, c2y;
    if (sx) { c1x = c2x = (p1x + p2x) / 2; c1y = p1y; c2y = p2y; }
    else if (sy === ey) { c1y = c2y = (p1y + p2y) / 2; c1x = p1x; c2x = p2x; }
    else { c1y = c2y = Math.max(p1y, p2y) + 28; c1x = p1x; c2x = p2x; }
    var cd = 'M' + p1x + ' ' + p1y + ' C' + c1x + ' ' + c1y + ' ' + c2x + ' ' + c2y + ' ' + p2x + ' ' + p2y;
    return { d: 'M' + x1 + ' ' + y1 + ' L' + cd.slice(1) + ' L' + x2 + ' ' + y2, cd: cd,
      mx: bez(p1x, c1x, c2x, p2x, 0.7), my: bez(p1y, c1y, c2y, p2y, 0.7),
      at: function (t) { return { x: bez(p1x, c1x, c2x, p2x, t), y: bez(p1y, c1y, c2y, p2y, t) }; } };
  }
  // ── Routed lines in the block diagram (Chris, 2026-11-18) ──
  // Lines route at right angles with rounded corners round the blocks, with Loom's engine (Loom owns it;
  // assets/vendor/route.js and connect.js, copied by tools/sync_routing.py). Each end of a line has its
  // own port on its block's edge: placed on the side facing the other block and spread along it, or
  // where it was dragged (the block's ports['<other id>|<word>'] = { side, t }). A line's straight runs
  // drag as Loom's wires do, and its shape is kept on its from-block (routes['<to id>|<word>'], Loom's
  // record { v, a, b, mode }). Nothing derived is written: auto ports and routes stay in memory.
  var SPEC_GRID = 10, SPEC_LSTUB = 20, SPEC_RAD = 10, specFlowLast = null, specPtLast = null;
  // The power tree's multiple selection (Chris, 2026-11-22): block ids picked by a box drawn on empty space or by
  // Shift- or Ctrl-click; dragging any one of them moves them all. Kept only in this page, never stored.
  var specPtPick = {};
  function specPtPickIds() { return Object.keys(specPtPick); }
  // Marks the picked blocks in a drawn power tree without redrawing it.
  function specPtPickShow(svg) {
    svg = svg || document.querySelector('svg.spec-ptree'); if (!svg) return;
    Array.prototype.forEach.call(svg.querySelectorAll('.spec-node'), function (g) { g.classList.toggle('msel', !!specPtPick[g.dataset.id]); });
  }
  // Two diagrams share the drag code (Chris, 2026-11-19): the block diagram ('flow'), whose arrangement sits on
  // each section record (pos, ports, routes, labels), and the power tree ('ptree'), whose sits under its ptree.
  function svgView(svg) { return svg && svg.getAttribute && svg.getAttribute('data-view') === 'ptree' ? 'ptree' : 'flow'; }
  function specLastOf(view) { return view === 'ptree' ? specPtLast : specFlowLast; }
  function specLay(rec, view) { return !rec ? {} : view === 'ptree' ? (rec.ptree || {}) : rec; }
  // rec with patch applied to its arrangement for view; an undefined value or an empty map takes the key off.
  function specWithLay(rec, view, patch) {
    function tidy(o) { Object.keys(patch).forEach(function (k) { var v = o[k]; if (v === undefined || (v && typeof v === 'object' && k !== 'pos' && !Object.keys(v).length)) delete o[k]; }); return o; }
    if (view !== 'ptree') return tidy(Object.assign({}, rec, patch));
    var pt = tidy(Object.assign({}, rec.ptree || {}, patch)), out = Object.assign({}, rec);
    if (pt.pos == null) delete pt.pos;
    if (Object.keys(pt).length) out.ptree = pt; else delete out.ptree;
    return out;
  }
  function specRouter() { return window.LM && LM.connect && LM.route ? LM.connect : null; }
  // The side of block A facing block B (as specRoute picks).
  function specPortSide(A, B) {
    if (B.x >= A.x + A.w + 12) return 'r';
    if (A.x >= B.x + B.w + 12) return 'l';
    if (B.y > A.y + A.h) return 'b';
    if (B.y + B.h < A.y) return 't';
    return 'b';
  }
  // Ports sit on the grid (Chris, 2026-11-19: snap ports to a grid): a side has a grid point every SPEC_GRID
  // in from its corners, its slots 1 to specSlots, and a port takes the slot nearest its t. Blocks sit on
  // the grid and are whole steps in size, so every port is on a grid line.
  function specSideLen(r, side) { return side === 't' || side === 'b' ? r.w : r.h; }
  function specSlots(r, side) { return Math.max(1, Math.floor(specSideLen(r, side) / SPEC_GRID) - 1); }
  function specSlot(r, p) {
    var L = specSideLen(r, p.side);
    return Math.max(1, Math.min(specSlots(r, p.side), Math.round(L * (p.t == null ? 0.5 : p.t) / SPEC_GRID)));
  }
  function specPortPt(r, p) {
    var L = specSideLen(r, p.side), a = L < 2 * SPEC_GRID ? L / 2 : specSlot(r, p) * SPEC_GRID;
    if (p.side === 'l') return { x: r.x, y: r.y + a, dx: -1, dy: 0 };
    if (p.side === 'r') return { x: r.x + r.w, y: r.y + a, dx: 1, dy: 0 };
    if (p.side === 't') return { x: r.x + a, y: r.y, dx: 0, dy: -1 };
    return { x: r.x + a, y: r.y + r.h, dx: 0, dy: 1 };
  }
  // The port nearest a point on block r's edge, its place on the grid.
  function specPortAt(r, q) {
    var d = [['l', Math.abs(q.x - r.x)], ['r', Math.abs(q.x - r.x - r.w)], ['t', Math.abs(q.y - r.y)], ['b', Math.abs(q.y - r.y - r.h)]].sort(function (u, v) { return u[1] - v[1]; })[0][0];
    var horiz = d === 't' || d === 'b', len = horiz ? r.w : r.h, along = horiz ? q.x - r.x : q.y - r.y;
    along = Math.max(SPEC_GRID, Math.min(len - SPEC_GRID, Math.round(along / SPEC_GRID) * SPEC_GRID));
    return { side: d, t: Math.round(Math.max(0.01, Math.min(0.99, along / len)) * 1000) / 1000 };
  }
  // A block grows so each line on a side gets its own grid point (Chris, 2026-11-19: expand parts to
  // accommodate). lines: [{ a, b, pa, pb }] (pa, pb: a kept port, else null; an auto port takes the side
  // facing the other block). R's block rects are widened or deepened in place, keeping their top-left corner.
  function specGrow(R, lines) {
    // A kept port counts once per grid point it holds (a power tree rail's pin is shared by all its loads).
    var n = {}, kept = {};
    function add(id, p, side) {
      var k = id + '\n' + side;
      if (p) { var sl = specSlot(R[id], p); kept[k] = kept[k] || {}; if (kept[k][sl]) return; kept[k][sl] = 1; }
      n[k] = (n[k] || 0) + 1;
    }
    lines.forEach(function (L) {
      var A = R[L.a], B = R[L.b]; if (!A || !B || L.a === L.b) return;
      add(L.a, L.pa && L.pa.side ? L.pa : null, (L.pa && L.pa.side) || specPortSide(A, B));
      add(L.b, L.pb && L.pb.side ? L.pb : null, (L.pb && L.pb.side) || specPortSide(B, A));
    });
    Object.keys(R).forEach(function (id) {
      var r = R[id], c = function (s) { return n[id + '\n' + s] || 0; };
      r.w = Math.max(r.w, (Math.max(c('t'), c('b')) + 1) * SPEC_GRID);
      r.h = Math.max(r.h, (Math.max(c('l'), c('r')) + 1) * SPEC_GRID);
    });
  }
  // The x of a terminal's lead-in when it runs straight out of a port on a top or bottom edge (the lead-in's
  // edge point straight above or below it), else null.
  function specLeadX(T, lead) { return lead && Math.abs(lead.x - T.x) < 0.5 && Math.abs(lead.y - T.y) > 0.5 ? T.x : null; }
  // Whether shape v fits ends A and B: route.js fits, or the same but for an end's vertical run in line with
  // its lead-in, heading on away from its block (Chris, 2026-11-19: a line couldn't be dragged under its port).
  // There the lead-in and the run are one, and the line drops straight out of the port (route.js shape drops
  // the run of no length between them).
  function specFits(A, B, v) {
    if (LM.route.fits(A, B, v, 8)) return true;
    if (!Array.isArray(v) || !v.length || v.length % 2 === 0 || v.some(function (x) { return !isFinite(+x); })) return false;
    v = v.map(Number);
    var n = v.length, ax = specLeadX(A, A.from), bx = specLeadX(B, B.to), sa = A.stub != null ? A.stub : 8, sb = B.stub != null ? B.stub : 8;
    var a1 = n > 1 ? v[1] : B.y, b1 = n > 1 ? v[n - 2] : A.y;
    var okA = (ax != null && Math.abs(v[0] - ax) < 0.5 && (a1 - A.y) * (A.y - A.from.y) > 0.5) || (v[0] - A.x) * A.out >= sa - 0.5;
    var okB = (bx != null && Math.abs(v[n - 1] - bx) < 0.5 && (b1 - B.y) * (B.y - B.to.y) > 0.5) || (B.x - v[n - 1]) * B.in >= sb - 0.5;
    return okA && okB;
  }
  // An engine route out of a top or bottom port leaves level from its lead point, so it always steps aside
  // before heading on, a jog right at the port. Its first (or last) vertical run moved under the port drops it
  // straight out instead, when that fits, clears every block, and lies along no other line. Returns the new v,
  // or null. rects: { id, x0, y0, x1, y1 }; routes: the other routes in the same space (a Map).
  function specDrop(R0, rects, routes) {
    var RTm = LM.route, v = R0.v.map(Number), n = v.length, done = false;
    if (!n || R0.kept || R0.behind) return null;
    function blocked(w) {
      return RTm.runs(R0.A, R0.B, w).some(function (r) {
        if (Math.abs(r.a.x - r.b.x) + Math.abs(r.a.y - r.b.y) < 0.5) return false;
        return rects.some(function (rc) {
          if (r.k < 0 && (rc.id === R0.A.node || rc.id === R0.B.node)) return false;
          var m = 4, x0 = rc.x0 - m, y0 = rc.y0 - m, x1 = rc.x1 + m, y1 = rc.y1 + m;
          return Math.abs(r.a.y - r.b.y) < 0.01 ? r.a.y > y0 && r.a.y < y1 && Math.max(r.a.x, r.b.x) > x0 && Math.min(r.a.x, r.b.x) < x1
            : r.a.x > x0 && r.a.x < x1 && Math.max(r.a.y, r.b.y) > y0 && Math.min(r.a.y, r.b.y) < y1;
        });
      });
    }
    function along(w) {
      var mine = RTm.runs(R0.A, R0.B, w);
      return Array.from(routes.values()).some(function (o) {
        if (o.key === R0.key) return false;
        return RTm.runs(o.A, o.B, o.v).some(function (s) {
          return mine.some(function (r) {
            if (r.axis !== s.axis) return false;
            var lv = r.axis === 'h', gap = Math.abs(lv ? r.a.y - s.a.y : r.a.x - s.a.x);
            var lo = lv ? Math.max(Math.min(r.a.x, r.b.x), Math.min(s.a.x, s.b.x)) : Math.max(Math.min(r.a.y, r.b.y), Math.min(s.a.y, s.b.y));
            var hi = lv ? Math.min(Math.max(r.a.x, r.b.x), Math.max(s.a.x, s.b.x)) : Math.min(Math.max(r.a.y, r.b.y), Math.max(s.a.y, s.b.y));
            return gap < 6 && hi - lo > 1;
          });
        });
      });
    }
    // At each end: move its vertical run under the port, or, when that would turn back toward the block, drop the
    // runs up to a later vertical run instead (Chris, 2026-11-20: a line looped under a port, the engine stepping
    // aside, back up between the block and its lead point, and over again before heading down). The fewest runs
    // dropped that fit, clear the blocks, and lie along no other line.
    [['A', R0.A.from], ['B', R0.B.to]].forEach(function (e) {
      var T = e[0] === 'A' ? R0.A : R0.B, lx = specLeadX(T, e[1]), m = v.length;
      if (lx == null || !m) return;
      for (var k = 0; k < m; k += 2) {
        var w = e[0] === 'A' ? [lx].concat(v.slice(k + 1)) : v.slice(0, m - 1 - k).concat([lx]);
        if (w.join(',') === v.join(',')) return;
        if (!specFits(R0.A, R0.B, w) || blocked(w) || along(w)) continue;
        v = w; done = true; return;
      }
    });
    return done ? v : null;
  }
  // A stub that reaches a line of the search grid, where the engine turns first (as Loom's onGrid: one
  // short of it makes the route give up and run straight).
  function specOnGrid(x, out, need) { var g = SPEC_GRID; return Math.abs((out > 0 ? Math.ceil((x + need) / g) : Math.floor((x - need) / g)) * g - x); }
  // A port's terminals for the engine, whose terminals are level: a port on a left or right edge leaves
  // level; one on the top or bottom runs out to a lead point past the edge and turns level there, either
  // way, the cheaper winning (Loom's termsRect).
  function specTerms(r, id, q, end, toward) {
    if (q.dx) {
      var T = { x: q.x, y: q.y, pins: true, node: id, side: q.dx > 0 ? 'r' : 'l', conn: false, stub: specOnGrid(q.x, q.dx, SPEC_LSTUB) };
      T[end === 'A' ? 'out' : 'in'] = end === 'A' ? q.dx : -q.dx;
      return [T];
    }
    var ly = q.dy < 0 ? r.y - SPEC_LSTUB : r.y + r.h + SPEC_LSTUB, from = { x: q.x, y: q.y }, first = toward >= q.x ? 1 : -1;
    return [first, -first].map(function (o) {
      var T = { x: q.x, y: ly, pins: true, node: id, side: o > 0 ? 'r' : 'l', conn: true, stub: specOnGrid(q.x, o, SPEC_RAD) };
      if (end === 'A') { T.out = o; T.from = from; } else { T.in = -o; T.to = from; }
      return T;
    });
  }
  // Every line's route. m: { doc, R (block rects by id), lines: [{ key, a, b, shape, pa, pb }] } (pa, pb: a
  // dragged port, else null). Returns { <key>: { R0, pts, d, lane, qa, qb, pa, pb } }.
  function specRouteSet(m, opts) {
    var C = specRouter(), R = m.R, want = {}, sides = {};
    m.lines.forEach(function (L) {
      var A = R[L.a], B = R[L.b];
      var pa = L.pa ? Object.assign({}, L.pa) : { side: specPortSide(A, B), auto: true }, pb = L.pb ? Object.assign({}, L.pb) : { side: specPortSide(B, A), auto: true };
      want[L.key] = { a: pa, b: pb };
      if (pa.auto) (sides[L.a + '\n' + pa.side] = sides[L.a + '\n' + pa.side] || []).push({ p: pa, o: B });
      if (pb.auto) (sides[L.b + '\n' + pb.side] = sides[L.b + '\n' + pb.side] || []).push({ p: pb, o: A });
    });
    // Auto ports on one side spread along it, in the order of the blocks they go to, each on a free grid point
    // (a kept port holds its own).
    var taken = {};
    m.lines.forEach(function (L) {
      var w = want[L.key];
      [[L.a, w.a], [L.b, w.b]].forEach(function (e) { if (e[1].auto) return; var k = e[0] + '\n' + e[1].side; (taken[k] = taken[k] || {})[specSlot(R[e[0]], e[1])] = 1; });
    });
    Object.keys(sides).forEach(function (k) {
      var id = k.split('\n')[0], side = k.split('\n')[1], list = sides[k], horiz = side === 't' || side === 'b';
      var S = specSlots(R[id], side), L0 = specSideLen(R[id], side), used = Object.assign({}, taken[k] || {}), prev = 0;
      list.sort(function (u, v) { return horiz ? (u.o.x + u.o.w / 2) - (v.o.x + v.o.w / 2) : (u.o.y + u.o.h / 2) - (v.o.y + v.o.h / 2); });
      list.forEach(function (u, i) {
        var ideal = Math.round((i + 1) * (S + 1) / (list.length + 1)), best = null;
        for (var s = prev + 1; s <= S; s++) if (!used[s] && (best == null || Math.abs(s - ideal) < Math.abs(best - ideal))) best = s;
        if (best == null) best = Math.max(1, Math.min(S, ideal));
        used[best] = 1; prev = best;
        u.p.t = best * SPEC_GRID / L0;
      });
    });
    // Two blocks side by side (or one over the other): an auto port alone on its side lines up with the
    // other end, so the line runs straight instead of a small jog (as the old lines between neighbors did).
    var facing = { r: 'l', l: 'r', b: 't', t: 'b' };
    m.lines.forEach(function (L) {
      var w = want[L.key], pa = w.a, pb = w.b, A = R[L.a], B = R[L.b];
      if (!pa.auto || !pb.auto || facing[pa.side] !== pb.side) return;
      var lr = pa.side === 'l' || pa.side === 'r', o = lr ? 'y' : 'x', s = lr ? 'h' : 'w';
      var va = specPortPt(A, pa)[o], vb = specPortPt(B, pb)[o], na = sides[L.a + '\n' + pa.side].length, nb = sides[L.b + '\n' + pb.side].length;
      if (na === 1 && vb >= A[o] + SPEC_GRID && vb <= A[o] + A[s] - SPEC_GRID) pa.t = (vb - A[o]) / A[s];
      else if (nb === 1 && va >= B[o] + SPEC_GRID && va <= B[o] + B[s] - SPEC_GRID) pb.t = (va - B[o]) / B[s];
    });
    // The engine's terminals leave level, so a line whose ends are both on top or bottom edges would step
    // out sideways and back (Chris, 2026-11-19: jogs on lines that were straight). Those route with x and y
    // swapped, where their ends are level, and their drawing is swapped back; their kept shapes say so (tr).
    var TR = { t: 'l', b: 'r', l: 't', r: 'b' }, swap = function (q) { return { x: q.y, y: q.x }; };
    var groups = { h: [], v: [] };
    m.lines.forEach(function (L) { var w = want[L.key]; groups[/[tb]/.test(w.a.side) && /[tb]/.test(w.b.side) ? 'v' : 'h'].push(L); });
    var out = {};
    ['h', 'v'].forEach(function (gk) {
      var tr = gk === 'v', lines = groups[gk]; if (!lines.length) return;
      var RR = {};
      Object.keys(R).forEach(function (id) { var r = R[id]; RR[id] = tr ? { x: r.y, y: r.x, w: r.h, h: r.w } : r; });
      var rects = Object.keys(RR).map(function (id) { var r = RR[id]; return { id: id, x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }; });
      var list = lines.map(function (L) {
        var w = want[L.key], A = RR[L.a], B = RR[L.b], combos = [];
        var qa = specPortPt(A, tr ? { side: TR[w.a.side], t: w.a.t } : w.a), qb = specPortPt(B, tr ? { side: TR[w.b.side], t: w.b.t } : w.b);
        var ta = specTerms(A, L.a, qa, 'A', qb.x), tb = specTerms(B, L.b, qb, 'B', qa.x);
        ta.forEach(function (x) { tb.forEach(function (y) { combos.push({ A: x, B: y }); }); });
        // A kept shape for the other orientation, or one its ends have moved away from (a block dragged past
        // its first bend), would hook back into the block: it routes afresh instead. A shape being dragged
        // (live) is drawn as it is.
        var shape = L.shape || null;
        if (shape && Array.isArray(shape.v) && (!!shape.tr !== tr || (!L.live && !combos.some(function (c) { return specFits(c.A, c.B, shape.v.map(Number)); })))) shape = shape.mode ? { mode: shape.mode } : null;
        return { key: L.key, weight: 1, combos: combos, half: 1, stub: 8, r: SPEC_RAD, shape: shape,
          qa: tr ? Object.assign(swap(qa), { dx: qa.dy, dy: qa.dx }) : qa, qb: tr ? Object.assign(swap(qb), { dx: qb.dy, dy: qb.dx }) : qb };
      });
      var res = C.routeAll(m.doc + '|' + gk, rects, list, { grid: SPEC_GRID, fast: !!(opts && opts.fast), margin: 200 });
      // Lines out of top or bottom ports (only level ends route upright, so here) drop straight out of them
      // where they can (Chris, 2026-11-19: lines met their ports off to one side).
      if (!tr) list.forEach(function (o) {
        var R0 = res.routes.get(o.key), dv = R0 && specDrop(R0, rects, res.routes);
        if (dv) res.routes.set(o.key, Object.assign({}, R0, { v: dv }));
      });
      list.forEach(function (o) {
        var R0 = res.routes.get(o.key); if (!R0) return;
        var dr = C.draw(R0), pts = dr && dr.pts ? dr.pts : dr;
        if (tr) pts = pts.map(swap);
        out[o.key] = { R0: R0, tr: tr, pts: pts, d: C.pathD(pts), lane: C.lane(pts), qa: o.qa, qb: o.qb, pa: want[o.key].a, pb: want[o.key].b, combos: o.combos };
      });
    });
    return out;
  }
  // A point in a line's routing space (x and y swapped for a line routed upright, rr.tr).
  function specRouteSpace(rr, q) { return rr && rr.tr ? { x: q.y, y: q.x } : q; }
  // A route as a label rides it: { d, cd (its points, for the label's data-route), at(t) along it }.
  function specRt(rr) {
    var C = specRouter();
    return { d: rr.d, cd: rr.pts.map(function (q) { return Math.round(q.x * 10) / 10 + ' ' + Math.round(q.y * 10) / 10; }).join(' '),
      at: function (t) { return C.laneAt(rr.lane, t); } };
  }
  // A kept shape moved with both its blocks (v alternates x, y, x, …).
  function specShiftShape(rec, dx, dy) {
    if (!rec || !Array.isArray(rec.v)) return rec;
    if (rec.tr) { var t0 = dx; dx = dy; dy = t0; }   // an upright line's shape is in swapped axes
    return Object.assign({}, rec, { v: rec.v.map(function (x, i) { return Math.round((+x + (i % 2 ? dy : dx)) * 10) / 10; }) });
  }
  // Current along a line: beads that run its length while its block is selected or pointed at, after
  // Loom's pulse on a selected wire. Drawn right after its .spec-edge, which CSS keys on.
  function specPulse(d, key) { return '<path class="spec-pulse"' + (key ? ' data-line="' + esc(key) + '"' : '') + ' d="' + d + '" pathLength="1"/>'; }
  // Grips on a section box's edges and corners that resize it (Chris, 2026-11-18). The box never gets
  // smaller than the fit around its blocks; how far each edge reaches past that is the section's grow.
  function specGrips(b) {
    var t = 10, c = 14, out = '';
    function r(edge, x, y, w, h) { out += '<rect class="spec-grip g-' + edge + '" data-edge="' + edge + '" x="' + x + '" y="' + y + '" width="' + Math.max(0, w) + '" height="' + Math.max(0, h) + '"/>'; }
    r('n', b.x + c / 2, b.y - t / 2, b.w - c, t); r('s', b.x + c / 2, b.y + b.h - t / 2, b.w - c, t);
    r('w', b.x - t / 2, b.y + c / 2, t, b.h - c); r('e', b.x + b.w - t / 2, b.y + c / 2, t, b.h - c);
    r('nw', b.x - c / 2, b.y - c / 2, c, c); r('ne', b.x + b.w - c / 2, b.y - c / 2, c, c);
    r('sw', b.x - c / 2, b.y + b.h - c / 2, c, c); r('se', b.x + b.w - c / 2, b.y + b.h - c / 2, c, c);
    return '<g class="spec-grips"><title>Drag to resize the section</title>' + out + '</g>';
  }
  // drag: { from, key, d, anchor, t } makes the label draggable (Chris, 2026-11-13): along its line, or off
  // it, where a leader ends in a dot at its place on the line (anchor, at t along d, the line's curve). The
  // dot drags along the line too, and the leader follows both live (labelLead).
  function pill(x, y, text, drag, tag) {
    var plain = text;                            // the label alone: the draw.io export reads it, never the marks
    if (tag && tag.text) text = text + ' ' + tag.text;
    var w = Math.min(tag ? 230 : 150, 14 + text.length * 6.6), an = drag && drag.anchor, off = an && Math.hypot(an.x - x, an.y - y) > 12;
    var lead = drag ? '<path class="spec-lead" d="M' + x + ' ' + y + ' L' + (an ? an.x + ' ' + an.y : x + ' ' + y) + '"' + (off ? '' : ' style="display:none"') + '/>' +
      '<g class="spec-lead-dot"' + (off ? '' : ' style="display:none"') + '><title>Drag along the line to move where the label points</title>' +
      '<circle class="spec-lead-hit" cx="' + (an ? an.x : x) + '" cy="' + (an ? an.y : y) + '" r="8"/><circle class="spec-lead-pt" cx="' + (an ? an.x : x) + '" cy="' + (an ? an.y : y) + '" r="3"/></g>' : '';
    return '<g class="spec-edge-label' + (drag ? ' drag' : '') + '"' + (drag ? ' data-from="' + esc(drag.from) + '" data-key="' + esc(drag.key) + '" data-route="' + drag.d + '" data-cx="' + x + '" data-cy="' + y + '"' +
      (drag.t != null ? ' data-t="' + drag.t + '"' : '') + (drag.line ? ' data-line="' + esc(drag.line) + '"' : '') + (an ? ' data-ax="' + an.x + '" data-ay="' + an.y + '"' : '') : '') + '>' + lead +
      '<g class="spec-pill' + (tag ? ' pin-' + tag.sev : '') + '" data-text="' + esc(plain) + '">' + (drag || tag ? '<title>' + esc([tag && tag.title, drag ? 'Drag along its line, or off it' : ''].filter(Boolean).join('\n')) + '</title>' : '') +
      '<rect x="' + (x - w / 2) + '" y="' + (y - 10) + '" width="' + w + '" height="20" rx="10"/><text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle">' + esc(cutText(text, Math.floor((w - 12) / 6.6))) + '</text></g></g>';
  }
  // Whether a power connection e ({ a, b, word, label }) is drawn as a line (Chris, 2026-11-22): { on, can, set }.
  // can: it may be hidden, because both ends show the rail's marker (a circle on the block making it, a bar on
  // the one using it, or an old Supplies flag); a regular connection, or one with an unmarked end, is always
  // drawn. set: the block's own choice, shown[<to>|<word>], else drawn within one section and not across.
  // ── Buses (Chris, 2026-11-22): lines with the same label (two I2C1 lines, two 3V3 lines) can run together ──
  // A line's runs in page space, level ('h') or upright ('v'), each with its fixed coordinate and its span.
  function specRealRuns(rr) {
    var sw = function (q) { return rr.tr ? { x: q.y, y: q.x } : q; };
    return LM.route.runs(rr.R0.A, rr.R0.B, rr.R0.v).map(function (r) {
      var a = sw(r.a), b = sw(r.b), h = Math.abs(a.y - b.y) < 0.5;
      return { h: h, at: h ? a.y : a.x, lo: Math.min(h ? a.x : a.y, h ? b.x : b.y), hi: Math.max(h ? a.x : a.y, h ? b.x : b.y), k: r.k };
    }).filter(function (r) { return r.hi - r.lo > 0.5; });
  }
  // Where a run being dragged can join its bus: the fixed coordinate of each parallel run of another line with
  // the same label that overlaps it, as [{ val, key }]. In routing space the dragged value is that coordinate.
  function specBusTargets(last, L0, rr, g) {
    if (!last || !L0 || !L0.bus || !g || g.k == null) return [];
    var mine = LM.route.runs(rr.R0.A, rr.R0.B, g.v0).filter(function (r) { return r.k === g.k; })[0];
    if (!mine) return [];
    var sw = function (q) { return rr.tr ? { x: q.y, y: q.x } : q; }, a = sw(mine.a), b = sw(mine.b), h = Math.abs(a.y - b.y) < 0.5;
    var lo = Math.min(h ? a.x : a.y, h ? b.x : b.y), hi = Math.max(h ? a.x : a.y, h ? b.x : b.y), out = [];
    last.model.lines.forEach(function (L) {
      var ro = last.routed[L.key]; if (L.key === L0.key || L.bus !== L0.bus || !ro) return;
      specRealRuns(ro).forEach(function (r) { if (r.h === h && r.lo < hi && r.hi > lo) out.push({ val: r.at, key: L.key }); });
    });
    return out;
  }
  // The stretches where lines of one bus run together, drawn as one thicker trunk: { segs: [{ x1, y1, x2, y2 }],
  // joined: { key: 1 } } (joined: a line that shares a stretch with one drawn before it, whose label is left off).
  function specBusTrunks(lines, routed) {
    var segs = [], joined = {}, runs = {};
    if (!window.LM || !LM.route) return { segs: segs, joined: joined };
    lines.forEach(function (L) { if (L.bus && routed[L.key]) runs[L.key] = specRealRuns(routed[L.key]); });
    lines.forEach(function (A, i) {
      if (!runs[A.key]) return;
      lines.slice(i + 1).forEach(function (B) {
        if (!runs[B.key] || B.bus !== A.bus) return;
        runs[A.key].forEach(function (ra) {
          runs[B.key].forEach(function (rb) {
            if (ra.h !== rb.h || Math.abs(ra.at - rb.at) > 0.5) return;
            var lo = Math.max(ra.lo, rb.lo), hi = Math.min(ra.hi, rb.hi); if (hi - lo < 1) return;
            segs.push(ra.h ? { x1: lo, y1: ra.at, x2: hi, y2: ra.at } : { x1: ra.at, y1: lo, x2: ra.at, y2: hi });
            joined[B.key] = 1;
          });
        });
      });
    });
    return { segs: segs, joined: joined };
  }
  function specBusSvg(t) {
    return t.segs.map(function (s) { return '<path class="spec-bus" d="M' + s.x1 + ' ' + s.y1 + ' L' + s.x2 + ' ' + s.y2 + '"/>'; }).join('');
  }
  var specPowerInfo = {};   // '<from>|<to>|<word>' → specLineShown, from the last drawing (the line panel reads it)
  function specLineShown(T, e) {
    var sw = (M.specLinkWord('supplies') || '').toLowerCase(), w = String(e.word || '').toLowerCase(), rail = String(e.label || '').toLowerCase();
    function has(id, role) { var y = T.byId[id]; return !!rail && !!y && (y.power || []).some(function (r) { return r.role === role && r.rail.toLowerCase() === rail; }); }
    var can = !!rail && has(e.a, 'source') && (w === sw || has(e.b, 'sink'));
    var A = T.byId[e.a], v = A && A.sec.shown ? A.sec.shown[e.b + '|' + w] : undefined;
    var set = typeof v === 'boolean' ? v : null;
    return { can: can, set: set, on: !can || (set != null ? set : T.dparent(A) === T.dparent(T.byId[e.b])) };
  }
  function specFlowHtml(p, a) {
    var T = specFlowTree(a), sel = specBlockSel(), show = ui.specBoxes !== false, head = show ? SPEC_HEAD : 0, pad = show ? SPEC_PAD : 0;
    var supWord = (M.specLinkWord('supplies') || '').toLowerCase();
    var blocks = T.items.filter(function (x) { return !T.isSec(x); }), isBlock = {};
    blocks.forEach(function (x) { isBlock[x.sec.id] = 1; });
    var frozen = blocks.some(function (x) { return x.sec.pos; });
    var flowTools = '<button class="chip" data-act="spec-add-block" data-kind="">+ Add block</button>' +
      (frozen || T.items.some(function (x) { return x.sec.labels || x.sec.grow || x.sec.ports || x.sec.routes; }) ? '<button class="chip" data-act="spec-auto-layout" title="Forget the arrangement and lay the diagram out again">Auto layout</button>' : '');
    var bar = '<div class="spec-flow-add">' + flowTools +
      '<span class="spec-flow-hint">Drag on empty space to draw a section around blocks</span>' +
      '<label class="spec-boxes" title="Show section boxes"><input type="checkbox" data-act="spec-boxes"' + (show ? ' checked' : '') + '> Sections</label></div>';
    if (!blocks.length) {
      return bar + '<div class="card empty"><h2>Nothing to draw yet</h2><p>Every heading is a block, and a heading with headings under it is a section around them. Add a block above, or write headings in the Document view.</p></div>';
    }
    var conn = [], sup = [], pw = [];
    // A connection is a power link when it carries a rail the far block sinks or this block sources (its
    // Power line): drawn like a supply, a line within one section and only the flags across sections.
    function railOf(id, rail, role) { var y = T.byId[id]; return !!rail && !!y && (y.power || []).some(function (r) { return r.role === role && r.rail.toLowerCase() === rail.toLowerCase(); }); }
    blocks.forEach(function (x) {
      x.edges.forEach(function (e) {
        if (!isBlock[e.id]) return;
        var o = { a: x.sec.id, b: e.id, label: e.label, word: e.word, dir: e.dir || '' };
        if (supWord && e.word.toLowerCase() === supWord) sup.push(o);
        else if (railOf(e.id, e.label, 'sink') || railOf(x.sec.id, e.label, 'source')) pw.push(o);
        else conn.push(o);
      });
    });
    // A block is as wide as its rail markers need, on the grid (Chris, 2026-11-22: rails ran off a block's left
    // edge). The markers sit 6 apart from 6 in from its right edge, each as wide as its name (to 110).
    var bw = {};
    blocks.forEach(function (x) {
      var names = sup.filter(function (e) { return e.b === x.sec.id; }).map(function (e) { return e.label || T.byId[e.a].sec.title; })
        .concat((x.power || []).map(function (r) { return r.rail; }));
      var need = 6 + names.reduce(function (n, t) { return n + Math.min(110, 22 + t.length * 6.2) + 6; }, 0);
      bw[x.sec.id] = Math.max(SPEC_BW, Math.ceil(need / SPEC_GRID) * SPEC_GRID);
    });
    function under(x) { return T.isSec(x) ? T.ch[x.sec.id].reduce(function (acc, c) { return acc.concat(under(c)); }, []) : [x.sec.id]; }
    // Siblings in signal order: one goes right of another when a link runs from it into it.
    function orderRow(list) {
      var u = list.map(under), rank = list.map(function () { return 0; }), edges = conn.concat(sup, pw);
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
      if (!T.isSec(x)) return (size[x.sec.id] = { w: bw[x.sec.id], h: SPEC_BH });
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
    // A kept place is drawn on the grid (places kept before 2026-11-19 may sit off it); a drag then keeps it there.
    blocks.forEach(function (x) { if (x.sec.pos) R[x.sec.id] = { x: specSnap(x.sec.pos.x), y: specSnap(x.sec.pos.y), w: bw[x.sec.id], h: SPEC_BH }; });
    // Once the diagram is arranged, a block added later has no place of its own, and the automatic one
    // can sit on a block that was moved (ticket 5, 2026-11-13). It goes right of the last block in its
    // section instead, then further right or down until it covers nothing.
    function free(q, w) {
      return !Object.keys(R).some(function (k) { var r = R[k]; return q.x < r.x + r.w + SPEC_GAP && q.x + w + SPEC_GAP > r.x && q.y < r.y + r.h + SPEC_GAP && q.y + SPEC_BH + SPEC_GAP > r.y; });
    }
    blocks.forEach(function (x) {
      if (x.sec.pos) return;
      var q = auto[x.sec.id] || { x: 20, y: Y };
      if (frozen) {
        var sib = blocks.filter(function (y) { return y !== x && R[y.sec.id] && T.dparent(y) === T.dparent(x); }).map(function (y) { return R[y.sec.id]; });
        var start = sib.length ? sib.reduce(function (m, r) { return r.x > m.x ? r : m; }) : null;
        start = start ? { x: start.x + start.w + SPEC_GAP, y: start.y } : q;
        var found = null;
        for (var row = 0; row < 8 && !found; row++) for (var col = 0; col < 8 && !found; col++) {
          var c = { x: start.x + col * (bw[x.sec.id] + SPEC_GAP), y: start.y + row * (SPEC_BH + SPEC_GAP) };
          if (free(c, bw[x.sec.id])) found = c;
        }
        if (!found) {
          var maxY0 = Math.max.apply(null, Object.keys(R).map(function (k) { return R[k].y + R[k].h; }).concat([0]));
          found = { x: start.x, y: maxY0 + SPEC_ROWGAP };
        }
        q = found;
      }
      R[x.sec.id] = { x: q.x, y: q.y, w: bw[x.sec.id], h: SPEC_BH };
    });
    // Supplies within one section draw as routed arrows; every supply also gets a power flag.
    // Chris, 2026-11-19: a supply between two blocks in one section is a routed line wherever they sit (it
    // used to be a line only while they stood side by side, so dragging one turned it into a flag), and every
    // supply also keeps its rail flag on the block it feeds.
    // Then (Chris, 2026-11-22) a power connection's Show line decides (specLineShown), and one whose ends don't
    // both show the rail's marker is always a line, so nothing on a block goes unindicated.
    var flagged = sup.slice(), arrows = sup.concat(pw).filter(function (e) { return e.a !== e.b && specLineShown(T, e).on; });
    specPowerInfo = {};
    sup.concat(pw).forEach(function (e) { specPowerInfo[e.a + '|' + e.b + '|' + e.word.toLowerCase()] = specLineShown(T, e); });
    // One line per pair of blocks (ticket 6, 2026-11-13): a connection both blocks name draws once.
    // Its arrows show which way the signal goes (ticket 8): out from the block whose line names the
    // other (the default), in to it, or both ways; both blocks naming each other is both ways too.
    var lines = [], pairs = {};
    conn.forEach(function (e) {
      var k = [e.a, e.b].sort().join('|') + '|' + e.word.toLowerCase(), L = pairs[k];
      if (!L) lines.push(L = pairs[k] = { a: e.a, b: e.b, word: e.word, labels: [], ab: false, ba: false, src: e });
      var fwd = L.a === e.a, out = e.dir !== 'in', inn = e.dir === 'in' || e.dir === 'both';
      if (e.dir === 'both') { L.ab = L.ba = true; }
      else if (fwd ? out : inn) L.ab = true; else L.ba = true;
      if (e.label && L.labels.map(function (t) { return t.toLowerCase(); }).indexOf(e.label.toLowerCase()) < 0) L.labels.push(e.label);
    });
    // Every drawn line, routed together: supply arrows, then connections.
    var rlines = arrows.map(function (e) { return { key: e.a + '>' + e.b + '|' + e.word.toLowerCase(), a: e.a, b: e.b, word: e.word, src: e, sup: e }; })
      .concat(lines.filter(function (L) { return L.a !== L.b; }).map(function (L) { return { key: L.a + '>' + L.b + '|' + L.word.toLowerCase(), a: L.a, b: L.b, word: L.word, src: L.src, L: L }; }));
    var blockR = {}; blocks.forEach(function (x) { blockR[x.sec.id] = R[x.sec.id]; });
    var model = { doc: 'scribe|' + p.id, R: blockR, lines: rlines.map(function (l) {
      var w = l.word.toLowerCase(), A = T.byId[l.a].sec, B = T.byId[l.b].sec, S = T.byId[l.src.a].sec;
      return { key: l.key, a: l.a, b: l.b, word: l.word, srcA: l.src.a, rkey: l.src.b + '|' + w, bus: (l.L ? l.L.labels.join(' / ') : l.sup.label || '').trim().toLowerCase(),
        shape: (S.routes || {})[l.src.b + '|' + w] || null, pa: (A.ports || {})[l.b + '|' + w] || null, pb: (B.ports || {})[l.a + '|' + w] || null };
    }) };
    // Each block grows so every line on a side gets its own grid point, before the sections fit round them.
    specGrow(R, model.lines);
    function boxOf(x) {
      if (!T.isSec(x)) return R[x.sec.id];
      var bs = T.ch[x.sec.id].map(boxOf).filter(Boolean);
      if (!bs.length) return null;
      var x0 = Math.min.apply(null, bs.map(function (b) { return b.x; })), y0 = Math.min.apply(null, bs.map(function (b) { return b.y; }));
      var x1 = Math.max.apply(null, bs.map(function (b) { return b.x + b.w; })), y1 = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
      var bp = Math.max(pad, 20), bh = Math.max(head, 20), g = x.sec.grow || { l: 0, t: 0, r: 0, b: 0 };
      return (R[x.sec.id] = { x: x0 - bp - g.l, y: y0 - bp - bh - g.t, w: x1 - x0 + 2 * bp + g.l + g.r, h: y1 - y0 + 2 * bp + bh + g.t + g.b });
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
    var svg = '<svg class="spec-map spec-flow' + (isBlock[sel] || specEdgeSel() ? ' focus' : '') + '" ' + specVBAttr(minX + ' ' + minY + ' ' + VW + ' ' + VH) + ' role="img" aria-label="Block diagram of the ' + esc(W.thing) + ' from the outline">' +
      '<defs><pattern id="spec-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.1" class="spec-dot"/></pattern>' +
      // A slim notched head of a fixed size (user units), so a thicker selected line doesn't grow it.
      '<marker id="spec-arrow" viewBox="0 0 10 8" refX="10" refY="4" markerWidth="9" markerHeight="7.2" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0.6L10 4L0 7.4L2.6 4z" class="spec-arrow"/></marker></defs>' +
      '<rect class="spec-flow-bg" x="' + minX + '" y="' + minY + '" width="' + VW + '" height="' + VH + '"/>';
    // Section boxes, outer ones first.
    if (show) {
      T.items.filter(function (x) { return T.isSec(x) && R[x.sec.id]; }).sort(function (x, y) { return T.anc(x).length - T.anc(y).length; }).forEach(function (x) {
        var b = R[x.sec.id];
        var gw = x.sec.grow || {};
        svg += '<g class="spec-group-g' + (sel === x.sec.id ? ' sel' : '') + (x.gaps ? ' gap' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" data-box="' + [b.x, b.y, b.w, b.h].join(' ') + '" data-grow="' + [gw.l || 0, gw.t || 0, gw.r || 0, gw.b || 0].join(' ') + '" data-anc="' + esc(T.anc(x).join(' ')) + '" data-parent="' + esc(T.dparent(x)) + '">' +
          '<title>' + esc(x.sec.title + (x.gist ? '\n' + x.gist : '') + (x.links.length ? '\n' + plural(x.links.length, 'requirement') + ' tied to the section itself' : '')) + '</title>' +
          '<rect class="spec-group" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="12"/>' +
          '<text class="spec-group-label" x="' + (b.x + 12) + '" y="' + (b.y + 16) + '">' + esc(cutText(x.sec.title || 'Untitled', Math.floor((b.w - 24) / 7) - (x.links.length || x.gaps ? 8 : 0))) + '</text>' +
          (x.links.length || x.gaps ? '<text class="spec-group-meta" x="' + (b.x + b.w - 12) + '" y="' + (b.y + 16) + '" text-anchor="end">' + esc([x.links.length ? plural(x.links.length, 'req') : '', x.gaps ? '△ ' + x.gaps : ''].filter(Boolean).join(' · ')) + '</text>' : '') +
          specGrips(b) + '</g>';
      });
    }
    // Where a dragged label was left, from its block's record: { q, anchor } or null.
    function keptLabel(from, key, rt) {
      var labs = T.byId[from] && T.byId[from].sec.labels, k = labs && labs[key];
      if (!k) return null;
      var an = rt.at(k.t);
      return { q: { x: an.x + k.x, y: an.y + k.y }, anchor: an, t: k.t };
    }
    function hit(e, d, L, key) {
      var a = T.byId[e.a].sec.title, b = T.byId[e.b].sec.title, label = L ? L.labels.join(' / ') : e.label;
      var says = L && L.ab && L.ba ? a + ' and ' + b + ' connect both ways' : L && L.ba && !L.ab ? (L.a === e.a ? b + ' ' + linkVerb(e.word) + ' ' + a : a + ' ' + linkVerb(e.word) + ' ' + b) : a + ' ' + linkVerb(e.word) + ' ' + b;
      return '<path class="spec-edge-hit" data-act="spec-edge"' + (key ? ' data-line="' + esc(key) + '"' : '') + ' data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" data-word="' + esc(e.word) + '" d="' + d + '"><title>' + esc(says + (label ? ' (' + label + ')' : '') + ', click for its panel') + '</title></path>';
    }
    // A label goes at the middle of its line, or the nearest place along it that covers no block (ticket 7).
    // A line too short for its label (two blocks side by side) puts it just above or below them.
    // Each block's rect reaches up over its power flags.
    var blockRects = blocks.map(function (x) { var r = R[x.sec.id]; return { x: r.x, y: r.y - 18, w: r.w, h: r.h + 18 }; }), placed = [];
    function labelAt(rt, text) {
      var w = Math.min(150, 14 + text.length * 6.6), tries = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74], mid = rt.at(0.5), off = SPEC_BH / 2 + 14;
      var cands = tries.map(function (t) { return rt.at(t); }).concat([{ x: mid.x, y: mid.y + off }, { x: mid.x, y: mid.y - off - 18 }]);
      function clear(q) {
        return !blockRects.concat(placed).some(function (r) { return q.x + w / 2 > r.x - 2 && q.x - w / 2 < r.x + r.w + 2 && q.y + 10 > r.y - 2 && q.y - 10 < r.y + r.h + 2; });
      }
      var q = cands.filter(clear)[0] || mid, i = cands.indexOf(q);
      placed.push({ x: q.x - w / 2, y: q.y - 10, w: w, h: 20 });
      // Off the line (above or below), it points back to the line's middle.
      var onLine = q === mid || i < tries.length;
      return { q: q, anchor: onLine ? null : mid, t: onLine ? (i >= 0 ? tries[i] : 0.5) : 0.5 };
    }
    var routed = specRouter() ? specRouteSet(model) : {};
    specFlowLast = { model: model, routed: routed };
    var pinTags = specPinTags(a);
    // The frame takes in lines routed past the blocks (round the top block, say).
    var rx0 = minX, ry0 = minY, rx1 = minX + VW, ry1 = minY + VH;
    Object.keys(routed).forEach(function (k) { routed[k].pts.forEach(function (q) { rx0 = Math.min(rx0, q.x - 24); ry0 = Math.min(ry0, q.y - 30); rx1 = Math.max(rx1, q.x + 24); ry1 = Math.max(ry1, q.y + 30); }); });
    if (rx0 < minX || ry0 < minY || rx1 > minX + VW || ry1 > minY + VH) {
      var vbOld = specVBAttr(minX + ' ' + minY + ' ' + VW + ' ' + VH), bgOld = 'x="' + minX + '" y="' + minY + '" width="' + VW + '" height="' + VH + '"/>';
      svg = svg.replace(vbOld, specVBAttr(rx0 + ' ' + ry0 + ' ' + (rx1 - rx0) + ' ' + (ry1 - ry0))).replace(bgOld, 'x="' + rx0 + '" y="' + ry0 + '" width="' + (rx1 - rx0) + '" height="' + (ry1 - ry0) + '"/>');
    }
    // Lines of one bus that run together: the shared stretches as one thicker trunk under them, named once.
    var trunks = specBusTrunks(model.lines, routed);
    svg += specBusSvg(trunks);
    rlines.forEach(function (l) {
      var rr = routed[l.key], rt = rr ? specRt(rr) : specRoute(R[l.a], R[l.b]), dl = ' data-line="' + esc(l.key) + '"';
      if (l.sup) {
        var e = l.sup;
        svg += '<path class="spec-edge supply' + on(e) + '"' + dl + ' data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '" d="' + rt.d + '" marker-end="url(#spec-arrow)"/>' + specPulse(rt.d, l.key) + hit(e, rt.d, null, l.key);
        if (e.label && !(trunks.joined[l.key] && !keptLabel(e.a, e.b + '|' + e.word.toLowerCase(), rt))) {
          var skey = e.b + '|' + e.word.toLowerCase(), sk = keptLabel(e.a, skey, rt) || labelAt(rt, e.label);
          svg += pill(sk.q.x, sk.q.y, e.label, { from: e.a, key: skey, d: rt.cd, anchor: sk.anchor, t: sk.t, line: l.key });
        }
        return;
      }
      var L = l.L;
      var cls = specEdgeIs(L.a, L.b, L.word) || specEdgeIs(L.b, L.a, L.word) ? ' on sel' : isBlock[sel] && (L.a === sel || L.b === sel) ? ' on' : '';
      svg += '<path class="spec-edge uses' + cls + (L.ab && L.ba ? ' both' : '') + '"' + dl + ' data-a="' + esc(L.a) + '" data-b="' + esc(L.b) + '" d="' + rt.d + '"' +
        (L.ab ? ' marker-end="url(#spec-arrow)"' : '') + (L.ba ? ' marker-start="url(#spec-arrow)"' : '') + '/>' + specPulse(rt.d, l.key) + hit(L.src, rt.d, L, l.key);
      // A joined line's label is left off unless it was dragged, or carries a pin warning (never hidden).
      var pinned = L.labels.some(function (t) { return !!pinTags[L.a + '|' + L.b + '|' + t.toLowerCase()]; });
      if (L.labels.length && !(trunks.joined[l.key] && !pinned && !keptLabel(L.src.a, L.src.b + '|' + L.word.toLowerCase(), rt))) {
        var lt = L.labels.join(' / '), key = L.src.b + '|' + L.word.toLowerCase();
        var tags = L.labels.map(function (t) { return pinTags[L.a + '|' + L.b + '|' + t.toLowerCase()]; }), tag = null;
        if (tags.some(Boolean)) {
          var worst = tags.filter(Boolean).map(function (t) { return t.sev; }).sort(function (s1, s2) { return ['issue', 'warn', 'ok'].indexOf(s1) - ['issue', 'warn', 'ok'].indexOf(s2); })[0];
          tag = { sev: worst, text: tags.map(function (t) { return t ? t.text : ''; }).filter(Boolean).join(' / '), title: tags.map(function (t) { return t ? t.title : ''; }).filter(Boolean).join(' ') };
        }
        var kept = keptLabel(L.src.a, key, rt) || labelAt(rt, lt + (tag ? ' ' + tag.text : ''));
        svg += pill(kept.q.x, kept.q.y, lt, { from: L.src.a, key: key, d: rt.cd, anchor: kept.anchor, t: kept.t, line: l.key }, tag);
      }
    });
    blocks.forEach(function (x) {
      var b = R[x.sec.id], chars = Math.floor((b.w - 16) / 7.2);
      var sub = x.gaps ? '△ ' + plural(x.gaps, 'gap') : x.parts.length ? x.parts.slice(0, 4).join(' · ') + (x.parts.length > 4 ? ' …' : '') : '';
      svg += '<g class="spec-node' + (x.gaps ? ' gap' : '') + (sel === x.sec.id ? ' sel' : '') + '" data-act="spec-block" data-id="' + esc(x.sec.id) + '" data-x="' + b.x + '" data-y="' + b.y + '" data-anc="' + esc(T.anc(x).join(' ')) + '" data-parent="' + esc(T.dparent(x)) + '">' +
        '<title>' + esc(x.sec.title + (x.gist ? '\n' + x.gist : '') + (x.gaps ? '\n' + specGapTitle(x) : '')) + '</title>' +
        '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="8"/>' +
        (x.gaps ? '<rect class="spec-node-dots" x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="8"/>' : '') +
        '<text class="spec-node-title" x="' + (b.x + b.w / 2) + '" y="' + (b.y + (sub ? 23 : 31)) + '" text-anchor="middle">' + esc(cutText(x.sec.title || 'Untitled', chars)) + '</text>' +
        (sub ? '<text class="spec-node-sub" x="' + (b.x + b.w / 2) + '" y="' + (b.y + 40) + '" text-anchor="middle">' + esc(cutText(sub, chars + 4)) + '</text>' : '') +
                // At the top-right corner, clear of the ports (Chris, 2026-11-18).
        '<circle class="spec-handle" data-src="' + esc(x.sec.id) + '" cx="' + (b.x + b.w) + '" cy="' + b.y + '" r="7"><title>Drag to a block this one connects to</title></circle></g>';
      // Rail markers over the block, every source right of every sink (Chris, 2026-11-22). Left to right: old
      // Supplies flags, the rails it uses (a bar), then the rails it makes (a circle); placed from the right edge.
      // A sink fed by a power connection opens that line's panel (where Show line is), else its block's.
      var marks = flagged.filter(function (e) { return e.b === x.sec.id; }).map(function (e) { return { sup: e }; })
        .concat((x.power || []).filter(function (r) { return r.role !== 'source'; }).map(function (r) { return { r: r }; }))
        .concat((x.power || []).filter(function (r) { return r.role === 'source'; }).map(function (r) { return { r: r }; }));
      var right = b.x + b.w - 6;
      marks.reverse().forEach(function (m) {
        var e = m.sup, r = m.r, src = !!r && r.role === 'source', name = e ? e.label || T.byId[e.a].sec.title : r.rail;
        var fw = Math.min(110, 22 + name.length * 6.2), fx = right - fw, fy = b.y - 15;
        right = fx - 6;
        var from = e || (src ? null : pw.filter(function (f) { return f.b === x.sec.id && (f.label || '').toLowerCase() === name.toLowerCase(); })[0]);
        var act = from ? 'data-act="spec-edge" data-a="' + esc(from.a) + '" data-b="' + esc(from.b) + '" data-word="' + esc(from.word) + '"' : 'data-act="spec-block" data-id="' + esc(x.sec.id) + '"';
        var tip = e ? 'Supplied by ' + T.byId[e.a].sec.title + (e.label ? ' (' + e.label + ')' : '') : (src ? 'Makes ' : 'Uses ') + name + (from ? ', from ' + T.byId[from.a].sec.title : '');
        svg += '<g class="spec-flag' + (src ? ' source' : '') + '" ' + act + ' data-for="' + esc(x.sec.id) + '"' + (r ? ' data-rail="' + esc(r.rail) + '" data-role="' + r.role + '"' : '') + '><title>' + esc(tip) + '</title>' +
          // A rail symbol: a stem up from the block to a bar (Chris, 2026-11-13: a bar, not an arrow), or to a circle.
          (src ? '<path d="M' + (fx + 8) + ' ' + (fy + 15) + ' L' + (fx + 8) + ' ' + (fy + 8) + '"/><circle class="spec-flag-ring" cx="' + (fx + 8) + '" cy="' + (fy + 4.5) + '" r="3.5"/>'
            : '<path d="M' + (fx + 8) + ' ' + (fy + 15) + ' L' + (fx + 8) + ' ' + (fy + 4) + '"/><path class="spec-flag-bar" d="M' + (fx + 3) + ' ' + (fy + 4) + ' L' + (fx + 13) + ' ' + (fy + 4) + '"/>') +
          '<text x="' + (fx + 17) + '" y="' + (fy + 9) + '">' + esc(cutText(name, Math.floor((fw - 20) / 6.2))) + '</text></g>';
      });
    });
    // Each line's ports, over the blocks: drag one round its block's edge.
    rlines.forEach(function (l) {
      var rr = routed[l.key]; if (!rr) return;
      [['a', rr.qa, rr.pa], ['b', rr.qb, rr.pb]].forEach(function (o) {
        svg += '<g class="spec-port' + (o[2] && !o[2].auto ? ' pinned' : '') + '" data-line="' + esc(l.key) + '" data-end="' + o[0] + '"><title>Drag round the block to move where the line meets it</title>' +
          '<circle class="spec-port-hit" cx="' + o[1].x + '" cy="' + o[1].y + '" r="8"/><circle class="spec-port-dot" cx="' + o[1].x + '" cy="' + o[1].y + '" r="3.5"/></g>';
      });
    });
    // A legend for the power symbols at the bottom right (Chris, 2026-11-19), when any block has a Power line.
    // It sits in the frame's bottom margin, below every block (rx1, ry1: the frame's corner).
    if (blocks.some(function (x) { return (x.power || []).length; })) {
      var lx = rx1 - 150, ly = ry1 - 22;
      svg += '<g class="spec-legend" aria-label="Legend: a circle is a rail the block makes (source); a bar, a rail it uses (sink)">' +
        '<path d="M' + lx + ' ' + (ly + 11) + ' L' + lx + ' ' + (ly + 4) + '"/><circle class="spec-flag-ring" cx="' + lx + '" cy="' + (ly + 0.5) + '" r="3.5"/>' +
        '<text x="' + (lx + 9) + '" y="' + (ly + 9) + '">Source</text>' +
        '<path d="M' + (lx + 76) + ' ' + (ly + 11) + ' L' + (lx + 76) + ' ' + ly + '"/><path class="spec-flag-bar" d="M' + (lx + 71) + ' ' + ly + ' L' + (lx + 81) + ' ' + ly + '"/>' +
        '<text x="' + (lx + 85) + '" y="' + (ly + 9) + '">Sink</text></g>';
    }
    svg += '</svg>';
    return bar + specCard(svg, flowTools) + '<p class="note">Drag blocks and sections to arrange the diagram, and a section’s edge to size it; drag on empty space to draw a new section around blocks. Drag a line’s straight runs to shape it (Shift breaks a run where it’s grabbed; a double-click adds a bend), and the dot at either end to move where it meets its block. Which section a block is in is set in the hierarchy below. Signals flow from each block’s <code>Connects:</code> line, and a <code>Supplies:</code> line puts a power flag with the rail’s name on each block it feeds, and a line to each one in the same section. Drag from the dot on a block’s top-right corner to connect it; click a line for its panel, where Delete removes it (Undo in the message brings it back).</p>' +
      specTreeHtml(p, a, T) + (M.specPowerOn() ? specPtreeHtml(p, T) : '');
  }

  // ── The power tree, under the hierarchy (Chris, 2026-11-19) ──
  // Drawn from the Power lines: a block is in it for each rail row ticked Power tree. A block that makes a
  // tree rail feeds every tree block that uses it, one line per rail, labeled with it. Laid out left to
  // right from sources to loads; the blocks' input rails sit on their left edge and outputs on their right.
  // Dragging arranges it as the block diagram does, kept apart under each section's ptree (specLay).
  var SPEC_PT_COL = 130, SPEC_PT_PIN = 20;
  function specPtModel(T) {
    var blocks = T.items.filter(function (x) { return !T.isSec(x) && (x.power || []).some(function (r) { return r.tree !== false; }); });
    var pins = {};
    blocks.forEach(function (x) {
      var ins = [], outs = [];
      x.power.forEach(function (r) {
        if (r.tree === false) return;
        var list = r.role === 'source' ? outs : ins;
        if (!list.some(function (y) { return y.toLowerCase() === r.rail.toLowerCase(); })) list.push(r.rail);
      });
      pins[x.sec.id] = { ins: ins, outs: outs };
    });
    var lines = [];
    blocks.forEach(function (A) {
      pins[A.sec.id].outs.forEach(function (rail) {
        var rl = rail.toLowerCase();
        blocks.forEach(function (B) {
          if (B === A || !pins[B.sec.id].ins.some(function (y) { return y.toLowerCase() === rl; })) return;
          lines.push({ key: A.sec.id + '>' + B.sec.id + '|' + rl, a: A.sec.id, b: B.sec.id, rail: rail, word: rl, srcA: A.sec.id, rkey: B.sec.id + '|' + rl, bus: rl });
        });
      });
    });
    return { blocks: blocks, pins: pins, lines: lines };
  }
  // The block's height, and where a rail's pin sits down its edge: on the grid, a step apart, under the title.
  function specPtHeight(pn) { return Math.max(SPEC_BH, 40 + SPEC_PT_PIN * Math.max(pn.ins.length, pn.outs.length, 1)); }
  function specPtPinY(i) { return 40 + SPEC_PT_PIN * i; }
  function specPtreeHtml(p, T) {
    var M0 = specPtModel(T), blocks = M0.blocks, pins = M0.pins, sel = specBlockSel(), ps = specPtSel();
    var arranged = blocks.some(function (x) { return x.sec.ptree; });
    var tools = arranged ? '<button class="chip" data-act="spec-auto-layout" data-view="ptree" title="Forget the power tree’s arrangement and lay it out again">Auto layout</button>' : '';
    var head = '<div class="spec-pt-head"><b>Power tree</b><span>From each block’s Power rows ticked Power tree: a block that makes a rail feeds every block that uses it.</span><span class="spacer"></span>' + tools + '</div>';
    if (!blocks.length) {
      specPtLast = null;
      return '<div class="spec-pt">' + head + '<div class="card empty"><h2>No power tree yet</h2><p>Open a block, and under Power tick <b>Power tree</b> on the rails it makes or uses. Ticked blocks appear here, joined by their rails.</p></div></div>';
    }
    var isPt = {}; blocks.forEach(function (x) { isPt[x.sec.id] = 1; });
    // Ranks: sources left, each load one column right of what feeds it (bounded, so a loop can't run away).
    var rank = {}; blocks.forEach(function (x) { rank[x.sec.id] = 0; });
    for (var it = 0; it < blocks.length; it++) {
      var mv = false;
      M0.lines.forEach(function (L) { if (rank[L.b] < rank[L.a] + 1 && rank[L.a] + 1 < blocks.length) { rank[L.b] = rank[L.a] + 1; mv = true; } });
      if (!mv) break;
    }
    var cols = {}, order = {};
    blocks.forEach(function (x, i) { order[x.sec.id] = i; });
    blocks.forEach(function (x) { (cols[rank[x.sec.id]] = cols[rank[x.sec.id]] || []).push(x.sec.id); });
    var R = {}, rowOf = {};
    Object.keys(cols).map(Number).sort(function (u, v) { return u - v; }).forEach(function (c) {
      // Within a column, under what feeds them, then in document order.
      var ids = cols[c].sort(function (u, v) {
        function feed(id) { var f = M0.lines.filter(function (L) { return L.b === id && rowOf[L.a] != null; }).map(function (L) { return rowOf[L.a]; }); return f.length ? Math.min.apply(null, f) : 1e9; }
        return feed(u) - feed(v) || order[u] - order[v];
      });
      var y = 40;
      ids.forEach(function (id, i) {
        var h = specPtHeight(pins[id]);
        R[id] = { x: 20 + c * (SPEC_BW + SPEC_PT_COL), y: y, w: SPEC_BW, h: h };
        rowOf[id] = i; y += h + 40;
      });
    });
    // Kept places win; once any block is placed, a newcomer goes below everything in its column.
    blocks.forEach(function (x) { var q = x.sec.ptree && x.sec.ptree.pos; if (q) R[x.sec.id] = { x: specSnap(q.x), y: specSnap(q.y), w: SPEC_BW, h: R[x.sec.id].h }; });
    if (blocks.some(function (x) { return x.sec.ptree && x.sec.ptree.pos; })) {
      var bottom = Math.max.apply(null, blocks.filter(function (x) { return x.sec.ptree && x.sec.ptree.pos; }).map(function (x) { var r = R[x.sec.id]; return r.y + r.h; }).concat([0]));
      blocks.forEach(function (x) { if (x.sec.ptree && x.sec.ptree.pos) return; R[x.sec.id].y = bottom + 40; bottom += R[x.sec.id].h + 40; });
    }
    function pinT(id, rail, side) {
      var list = side === 'r' ? pins[id].outs : pins[id].ins, i = list.map(function (y) { return y.toLowerCase(); }).indexOf(rail.toLowerCase());
      return Math.max(0.05, Math.min(0.95, specPtPinY(Math.max(0, i)) / R[id].h));
    }
    var model = { doc: 'ptree|' + p.id, R: R, lines: M0.lines.map(function (L) {
      var A = T.byId[L.a].sec, B = T.byId[L.b].sec, la = specLay(A, 'ptree'), lb = specLay(B, 'ptree');
      var ka = (la.ports || {})[L.b + '|' + L.word], kb = (lb.ports || {})[L.a + '|' + L.word];
      // Unmoved, a line leaves its rail's pin on the right edge and lands on its pin on the left edge.
      return Object.assign({}, L, { shape: (la.routes || {})[L.rkey] || null,
        pa: ka || { side: 'r', t: pinT(L.a, L.rail, 'r'), pin: true }, pb: kb || { side: 'l', t: pinT(L.b, L.rail, 'l'), pin: true } });
    }) };
    specGrow(R, model.lines);
    var routed = specRouter() ? specRouteSet(model) : {};
    specPtLast = { model: model, routed: routed };
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    function grow(q, mx, my) { x0 = Math.min(x0, q.x - mx); y0 = Math.min(y0, q.y - my); x1 = Math.max(x1, q.x + mx); y1 = Math.max(y1, q.y + my); }
    Object.keys(R).forEach(function (id) { var r = R[id]; grow({ x: r.x, y: r.y }, 24, 30); grow({ x: r.x + r.w, y: r.y + r.h }, 24, 30); });
    Object.keys(routed).forEach(function (k) { routed[k].pts.forEach(function (q) { grow(q, 24, 30); }); });
    var VW = Math.max(980, x1 - x0); if (x1 - x0 < VW) x0 -= (VW - (x1 - x0)) / 2;
    var fit = x0 + ' ' + y0 + ' ' + VW + ' ' + (y1 - y0);
    var focus = isPt[sel] || ps;
    var svg = '<svg class="spec-map spec-flow spec-ptree' + (focus ? ' focus' : '') + '" data-view="ptree" ' + specVBAttr(fit, 'ptree') + ' role="img" aria-label="Power tree of the ' + esc(W.thing) + '">' +
      '<defs><marker id="spec-pt-arrow" viewBox="0 0 10 8" refX="10" refY="4" markerWidth="9" markerHeight="7.2" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0.6L10 4L0 7.4L2.6 4z" class="spec-arrow"/></marker></defs>' +
      '<rect class="spec-flow-bg" x="' + x0 + '" y="' + y0 + '" width="' + VW + '" height="' + (y1 - y0) + '"/>';
    var named = {}, trunks = specBusTrunks(model.lines, routed);
    svg += specBusSvg(trunks);
    model.lines.forEach(function (L) {
      var rr = routed[L.key], rt = rr ? specRt(rr) : specRoute(R[L.a], R[L.b]), dl = ' data-line="' + esc(L.key) + '"';
      var on = ps && ps.a === L.a && ps.b === L.b && ps.rail.toLowerCase() === L.word ? ' on sel' : isPt[sel] && (L.a === sel || L.b === sel) ? ' on' : '';
      var a = T.byId[L.a].sec.title, b = T.byId[L.b].sec.title;
      svg += '<path class="spec-edge supply' + on + '"' + dl + ' data-a="' + esc(L.a) + '" data-b="' + esc(L.b) + '" d="' + rt.d + '" marker-end="url(#spec-pt-arrow)"/>' + specPulse(rt.d, L.key) +
        '<path class="spec-edge-hit" data-act="spec-pt-edge"' + dl + ' data-a="' + esc(L.a) + '" data-b="' + esc(L.b) + '" data-rail="' + esc(L.rail) + '" d="' + rt.d + '"><title>' + esc(a + ' makes ' + L.rail + ' for ' + b + ', click for its panel') + '</title></path>';
      // A rail fanning out to several loads is named once, on its first line, unless a label was dragged.
      var k = (specLay(T.byId[L.a].sec, 'ptree').labels || {})[L.rkey], fan = L.a + '|' + L.word;
      if (!k && (named[fan] || trunks.joined[L.key])) return;
      named[fan] = 1;
      var an = rt.at(k ? k.t : 0.5), q = k ? { x: an.x + k.x, y: an.y + k.y } : an;
      svg += pill(q.x, q.y, L.rail, { from: L.a, key: L.rkey, d: rt.cd, anchor: k ? an : null, t: k ? k.t : 0.5, line: L.key });
    });
    blocks.forEach(function (x) {
      var id = x.sec.id, b = R[id], pn = pins[id], both = pn.ins.length && pn.outs.length, pc = both ? 9 : 18;
      svg += '<g class="spec-node spec-pt-node' + (sel === id ? ' sel' : '') + (specPtPick[id] ? ' msel' : '') + '" data-act="spec-block" data-id="' + esc(id) + '" data-x="' + b.x + '" data-y="' + b.y + '" data-anc="" data-parent="">' +
        '<title>' + esc(x.sec.title + (pn.ins.length ? '\nUses ' + pn.ins.join(', ') : '') + (pn.outs.length ? '\nMakes ' + pn.outs.join(', ') : '')) + '</title>' +
        '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '" rx="8"/>' +
        '<text class="spec-node-title" x="' + (b.x + b.w / 2) + '" y="' + (b.y + 20) + '" text-anchor="middle">' + esc(cutText(x.sec.title || 'Untitled', Math.floor((b.w - 16) / 7.2))) + '</text>' +
        pn.ins.map(function (r, i) { var y = b.y + specPtPinY(i); return '<text class="spec-pt-rail" x="' + (b.x + 8) + '" y="' + (y + 4) + '">' + esc(cutText(r, pc)) + '</text>'; }).join('') +
        pn.outs.map(function (r, i) { var y = b.y + specPtPinY(i); return '<circle class="spec-pt-pin source" cx="' + (b.x + b.w) + '" cy="' + y + '" r="2.5"/><text class="spec-pt-rail" x="' + (b.x + b.w - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(cutText(r, pc)) + '</text>'; }).join('') +
        '</g>';
    });
    model.lines.forEach(function (L) {
      var rr = routed[L.key]; if (!rr) return;
      [['a', rr.qa, rr.pa], ['b', rr.qb, rr.pb]].forEach(function (o) {
        svg += '<g class="spec-port' + (o[2] && !o[2].auto && !o[2].pin ? ' pinned' : '') + '" data-line="' + esc(L.key) + '" data-end="' + o[0] + '"><title>Drag round the block to move where the line meets it</title>' +
          '<circle class="spec-port-hit" cx="' + o[1].x + '" cy="' + o[1].y + '" r="8"/><circle class="spec-port-dot" cx="' + o[1].x + '" cy="' + o[1].y + '" r="3.5"/></g>';
      });
    });
    svg += '</svg>';
    return '<div class="spec-pt">' + head + specCard(svg, tools, 'ptree') +
      '<p class="note">Drag blocks to arrange the power tree (draw a box on empty space, or Shift-click, to pick several and drag them together), a line’s straight runs to shape it (a double-click adds a bend), and the dot at either end to move where it meets its block. Its arrangement is its own: the block diagram above keeps its own. Click a line for its panel.</p></div>';
  }
  // ── The diagram's own panel (Chris, 2026-11-22): a click on empty diagram space shows it ──
  // For now it lists the rails: every rail on a Power line, who makes and uses it, and its connections. A row
  // picked shows ✕, which deletes the rail everywhere (specRailDelete), one step that Back undoes.
  var specRailSel = '';
  function specOpenDiagram() {
    selected = 'specdiagram'; specRailSel = '';
    $('#inspector').classList.add('open');
    renderPage(); renderInspector();
  }
  function renderSpecDiagramInspector(p) {
    var el = $('#inspector'), rails = M.specRails(p);
    function who(list) { return list.length ? list.join(', ') : 'none'; }
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body"><h2 class="spec-edge-title">' + esc(p.meta.name || 'Block diagram') + '</h2>' +
      '<div class="field"><span class="field-label">Power rails</span>' +
      (rails.length ? '<div class="spec-rails">' + rails.map(function (r) {
        var on = specRailSel.toLowerCase() === r.rail.toLowerCase();
        return '<div class="spec-rail' + (on ? ' sel' : '') + '"><button class="spec-rail-pick" data-act="spec-rail-pick" data-rail="' + esc(r.rail) + '" aria-pressed="' + on + '">' +
          '<b>' + esc(r.rail) + '</b><span>' + esc('Made by ' + who(r.sources) + ' · used by ' + who(r.sinks) + (r.links ? ' · ' + plural(r.links, 'connection') : '')) + '</span></button>' +
          (on ? '<button class="icon-btn spec-rail-del" data-act="spec-rail-delete" data-rail="' + esc(r.rail) + '" title="Delete ' + esc(r.rail) + ': its markers on every block, and the connections that carry it" aria-label="Delete ' + esc(r.rail) + '">' + ICON.close + '</button>' : '') + '</div>';
      }).join('') + '</div><p class="note" style="margin:6px 0 0">Pick a rail to delete it from every block, with the connections that carry it.</p>'
        : '<p class="note" style="margin:0">No power rails yet. A block’s Power rows add them.</p>') + '</div></div>';
    el.dataset.item = selected;
  }
  function specRailDeleteAct(rail) {
    var p = current(); if (!p || !rail) return;
    var recs = M.specRailDelete(p, rail);
    if (!recs.length) return;
    specRailSel = '';
    specPutAll(p, recs.map(function (r) { return M.specStamp(r, me()); }));
    toast('Deleted the rail ' + rail + ' from ' + plural(recs.length, 'block'), { label: 'Undo', run: function () { specHistStep(true); } });
  }
  // A power tree line's panel: read-only, since the line comes from the two blocks' Power rows.
  // selected is 'specpt|' + JSON [from, to, rail].
  function specPtSel() {
    var m = /^specpt\|(.+)$/.exec(selected || ''); if (!m) return null;
    try { var v = JSON.parse(m[1]); return { a: v[0], b: v[1], rail: String(v[2] || '') }; } catch (err) { return null; }
  }
  function specOpenPt(a, b, rail) {
    selected = 'specpt|' + JSON.stringify([a, b, rail]);
    $('#inspector').classList.add('open');
    renderPage(); renderInspector();
  }
  function specPtShaped(p, s) {
    var w = s.rail.toLowerCase(), A = specLay(p.spec[s.a], 'ptree'), B = specLay(p.spec[s.b], 'ptree');
    return !!((A.routes && A.routes[s.b + '|' + w]) || (A.ports && A.ports[s.b + '|' + w]) || (B.ports && B.ports[s.a + '|' + w]));
  }
  function renderSpecPtInspector(p) {
    var el = $('#inspector'), s = specPtSel(), A = s && p.spec[s.a], B = s && p.spec[s.b];
    if (!A || !B || A.deleted || B.deleted) { selected = null; closeInspector(); renderPage(); return; }
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Power tree › Line</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<h2 class="spec-edge-title">' + esc(A.title || 'Untitled') + ' <span>powers</span> ' + esc(B.title || 'Untitled') + '</h2>' +
      '<div class="field"><span class="field-label">Rail</span><div>' + esc(s.rail) + '</div></div>' +
      '<div class="field"><span class="field-label">From</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(s.a) + '">' + esc(A.title || 'Untitled') + '</button></div></div>' +
      '<div class="field"><span class="field-label">To</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(s.b) + '">' + esc(B.title || 'Untitled') + '</button></div></div>' +
      '<p class="note">Drawn from the two blocks’ Power rows: ' + esc(A.title || 'one') + ' makes ' + esc(s.rail) + ' and ' + esc(B.title || 'the other') + ' uses it, both ticked Power tree. Untick either to take the line away.</p>' +
      (specPtShaped(p, s) ? '<div class="spec-acts"><button class="btn" data-act="spec-pt-reset" title="Forget its shape and where its ends meet the blocks">Reset route</button></div>' : '') +
      '</div>';
    el.dataset.item = selected;
  }
  function specPtReset() {
    var p = current(), s = specPtSel(); if (!p || !s) return;
    var w = s.rail.toLowerCase(), out = [];
    [[s.a, s.b], [s.b, s.a]].forEach(function (o, i) {
      var r = p.spec[o[0]], k = o[1] + '|' + w, lay = specLay(r, 'ptree'), patch = {}; if (!r) return;
      if (lay.ports && lay.ports[k]) { patch.ports = Object.assign({}, lay.ports); delete patch.ports[k]; }
      if (!i && lay.routes && lay.routes[k]) { patch.routes = Object.assign({}, lay.routes); delete patch.routes[k]; }
      if (Object.keys(patch).length) out.push(M.specStamp(specWithLay(r, 'ptree', patch), me()));
    });
    if (out.length) specPutAll(p, out);
  }

  // ── The hierarchy under the block diagram, after Signoff PL's Map ──
  // The board is the trunk, sections branch off it (nested sections branch again), and each
  // section's blocks are tiles on its branch. Drag a tile or a section onto a branch to move it into
  // that section, or onto a tile to put it just before; + on a branch adds a block inside. It is the
  // outline: every move is a heading moved in the text (model.specNest).
  var ICON_GRIP = '<svg viewBox="0 0 10 16" fill="currentColor"><circle cx="3" cy="3" r="1.3"/><circle cx="7" cy="3" r="1.3"/><circle cx="3" cy="8" r="1.3"/><circle cx="7" cy="8" r="1.3"/><circle cx="3" cy="13" r="1.3"/><circle cx="7" cy="13" r="1.3"/></svg>';
  var ICON_SECTION = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="2.5" y="4" width="15" height="12" rx="2.5"/><path d="M2.5 7.5h15"/></svg>';
  var SPEC_TREE_BOARD = '@board';
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
    // Folding (Chris, 2026-11-20): the board folds the whole hierarchy to one block, and Collapse all / Expand all
    // folds every section at once. Kept in ui.specClosed (the board under SPEC_TREE_BOARD), for the session.
    var shut = ui.specClosed || {}, boardShut = !!shut[SPEC_TREE_BOARD];
    var secIds = T.items.filter(function (y) { return T.isSec(y); }).map(function (y) { return y.sec.id; });
    var nBlocks = T.items.filter(function (y) { return !T.isSec(y); }).length;
    var allOpen = !boardShut && secIds.some(function (sid) { return !shut[sid]; });
    var foldAll = secIds.length || boardShut ? '<button class="btn btn-sm" data-act="spec-tree-all" data-mode="' + (allOpen ? 'close' : 'open') + '">' + (allOpen ? 'Collapse all' : 'Expand all') + '</button>' : '';
    return '<div class="card spec-tree" aria-label="Hierarchy"><div class="st-title"><b>Hierarchy</b><span>Drag a block or section onto a section to move it in, onto a block to put it just before, or onto the board to take it out of its section. The text follows.</span>' +
      '<span class="spacer"></span>' + foldAll + '<button class="btn btn-sm" data-act="spec-new-section">+ Section</button><button class="btn btn-sm btn-primary" data-act="spec-add-block" data-kind="">+ Block</button></div>' +
      '<div class="st"><div class="st-trunk" data-sdrop=""><div class="st-head st-top-head"><span class="st-top"><span class="st-eyebrow">Board</span><span class="st-top-name">' + esc(root ? root.sec.title : p.meta.name) + '</span>' +
      (root && root.links.length ? '<span class="st-sub">' + esc(plural(root.links.length, 'requirement') + ' on the board itself') + '</span>' : '') +
      (boardShut ? '<span class="st-sub">' + esc([plural(secIds.length, 'section'), plural(nBlocks, 'block')].join(' · ')) + '</span>' : '') + '</span>' +
      (top.length ? '<button class="icon-btn st-fold' + (boardShut ? ' closed' : '') + '" data-act="spec-tree-fold" data-id="' + SPEC_TREE_BOARD + '" title="' + (boardShut ? 'Expand' : 'Collapse to the board') + '" aria-expanded="' + !boardShut + '">' + ICON.chev + '</button>' : '') + '</div>' +
      (boardShut ? '' : top.length ? kids(top) : '<div class="st-kids"><div class="st-item st-leaves"><div class="map-empty">Nothing yet: add a block.</div></div></div>') + '</div></div></div>';
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
  // Pictures for the rework open in the details pane: pasted anywhere on the page, or dropped on its picture box.
  function rwOpen() { return $('#inspector').classList.contains('open') && !!reworkOf(current(), selected) && !$('#sheet'); }
  document.addEventListener('paste', function (e) {
    if (!rwOpen()) return;
    var items = (e.clipboardData && e.clipboardData.items) || [], files = [];
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) files.push(items[i].getAsFile());
    if (files.length) { e.preventDefault(); var ps = document.activeElement && document.activeElement.closest && document.activeElement.closest('.rw-step'); addReworkPics(files, ps ? ps.dataset.step : ''); }
  });
  document.addEventListener('dragover', function (e) {
    var z = e.target.closest && e.target.closest('[data-rw-drop]');
    if (z && e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); z.classList.add('on'); }
  });
  document.addEventListener('dragleave', function (e) {
    var z = e.target.closest && e.target.closest('[data-rw-drop]');
    if (z && !z.contains(e.relatedTarget)) z.classList.remove('on');
  });
  document.addEventListener('drop', function (e) {
    var z = e.target.closest && e.target.closest('[data-rw-drop]');
    if (!z || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); z.classList.remove('on'); addReworkPics(e.dataTransfer.files, z.dataset.step || '');
  });
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
    if (!svg || e.button !== 0 || e.target.closest('.spec-handle, .spec-flag')) return;
    var node = e.target.closest('.spec-node'), box = e.target.closest('.spec-group-g');
    var m = svg.getScreenCTM().inverse(), pt = svg.createSVGPoint();
    function local(ev) { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(m); }
    var view = svgView(svg), last = specLastOf(view), C = specRouter();
    // A line's port: it slides round its block's edge.
    var port = e.target.closest('.spec-port');
    if (port && last && C) {
      var PL = specLine(port.dataset.line, view); if (!PL) return;
      e.preventDefault(); e.stopPropagation();
      flowDrag = { svg: svg, view: view, local: local, start: local(e), cx: e.clientX, cy: e.clientY, on: false, type: 'port', line: PL, end: port.dataset.end };
      return;
    }
    // A line's straight run: it drags sideways, as Loom's wires (Shift breaks it at the grab). A click
    // without moving still opens the line's panel.
    var lineHit = e.target.closest('.spec-edge-hit');
    if (lineHit) {
      var L0 = last && C && specLine(lineHit.dataset.line, view), rr = L0 && last.routed[L0.key];
      if (!rr) return;
      var q0 = specRouteSpace(rr, local(e)), run = C.runAt(rr.R0, q0);
      if (!run) return;
      var g = {}, rec0 = C.dragStart(g, run, L0.shape && !!L0.shape.tr === rr.tr ? L0.shape : {}, e.ctrlKey ? null : specSnap, e.shiftKey, q0);
      if (!rec0) return;
      // A line with the same label (a bus) is a target too (Chris, 2026-11-22): a run dragged onto a parallel run
      // of one sticks to it, as to a straight line, and on the drop they run together there.
      g.bus = specBusTargets(last, L0, rr, g);
      g.lines = (g.lines || []).concat(g.bus.map(function (t) { return t.val; }));
      flowDrag = { svg: svg, view: view, local: local, start: q0, cx: e.clientX, cy: e.clientY, on: false, type: 'run', line: L0, g: g, rec: rec0, ctrl: e.ctrlKey, tr: rr.tr, rr: rr };
      return;
    }
    var lab = e.target.closest('.spec-edge-label.drag');
    if (lab) {
      e.preventDefault();
      // The label itself, or the dot at the end of its leader ('dot'), which moves only along the line.
      flowDrag = { svg: svg, view: view, local: local, start: local(e), cx: e.clientX, cy: e.clientY, on: false, type: e.target.closest('.spec-lead-dot') ? 'dot' : 'label', el: lab,
        from: lab.dataset.from, key: lab.dataset.key, route: labelRoute(lab.dataset.route), c0: { x: +lab.dataset.cx, y: +lab.dataset.cy },
        t0: lab.dataset.t != null && lab.dataset.t !== '' ? +lab.dataset.t : null };
      return;
    }
    var grip = !node && box && e.target.closest('.spec-grip');
    if (grip) {
      e.preventDefault();
      flowDrag = { svg: svg, local: local, start: local(e), cx: e.clientX, cy: e.clientY, on: false, type: 'resize', id: box.dataset.id,
        edge: grip.dataset.edge, el: box, box0: box.dataset.box.split(' ').map(Number) };
      return;
    }
    // The power tree has no sections: its blocks drag, and a box drawn on empty space picks the blocks in it.
    // Shift- or Ctrl-click adds a block to the pick or takes it out; dragging a picked block moves them all.
    var ids = null;
    if (view === 'ptree' && node) {
      var nid = node.dataset.id;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (specPtPick[nid]) delete specPtPick[nid]; else specPtPick[nid] = 1;
        specPtPickShow(svg);
        specDragJustEnded = true; setTimeout(function () { specDragJustEnded = false; }, 400);
        return;
      }
      if (specPtPick[nid] && specPtPickIds().length > 1) ids = specPtPickIds();
      else specPtPick = {};
    }
    flowDrag = { svg: svg, view: view, local: local, start: local(e), cx: e.clientX, cy: e.clientY, on: false,
      type: node ? 'block' : box ? 'section' : view === 'ptree' ? 'pick' : 'draw', id: node ? node.dataset.id : box ? box.dataset.id : '', ids: ids,
      add: e.shiftKey || e.ctrlKey || e.metaKey };
    if (flowDrag.type === 'draw' || flowDrag.type === 'pick') e.preventDefault();
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
  // A label's line as a lane (its routed points, "x y x y …", with the distance along it; 2026-11-18,
  // routed lines: a kept t is now a share of the line's length, where it was the curve's parameter), and
  // the nearest point on it.
  function labelRoute(d) {
    var C = specRouter(), n = String(d || '').match(/-?[\d.]+(?:e-?\d+)?/g); n = n ? n.map(Number) : [];
    if (!C || n.length < 4) return null;
    var pts = []; for (var i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
    return C.lane(pts);
  }
  function labelSnap(r, q) {
    var C = specRouter(), t = C.laneT(r, q), p = C.laneAt(r, t);
    return { t: t, x: p.x, y: p.y, dd: Math.hypot(q.x - p.x, q.y - p.y) };
  }
  function labelPt(r, t) { var p = specRouter().laneAt(r, t); return { t: t, x: p.x, y: p.y }; }
  // Where a label being dragged goes: on its line when within 16 units of it, else where it's dropped, with
  // its dot kept where the label last sat on the line (t0), or the nearest point when it never had a place.
  // c is the label's middle, a its dot (null on the line).
  function labelDrop(d, ev) {
    var q = d.local(ev), c = { x: d.c0.x + q.x - d.start.x, y: d.c0.y + q.y - d.start.y }, s = d.route && labelSnap(d.route, c);
    if (!s) return null;
    if (s.dd <= 16) return { t: s.t, x: 0, y: 0, c: { x: s.x, y: s.y }, a: null, on: true };
    var a = d.t0 != null ? labelPt(d.route, d.t0) : s;
    return { t: a.t, x: Math.round(c.x - a.x), y: Math.round(c.y - a.y), c: c, a: a };
  }
  // Where a dragged dot goes: the nearest point on the line; the label stays put.
  function dotDrop(d, ev) {
    var s = d.route && labelSnap(d.route, d.local(ev));
    return s && { t: s.t, x: Math.round(d.c0.x - s.x), y: Math.round(d.c0.y - s.y), c: d.c0, a: s };
  }
  // The leader drawn live from the label's middle c to its dot a while either drags.
  function labelLead(el, c, a) {
    var lead = el.querySelector('.spec-lead'), dot = el.querySelector('.spec-lead-dot'); if (!lead || !dot) return;
    var show = a && Math.hypot(a.x - c.x, a.y - c.y) > 12;
    lead.style.display = dot.style.display = show ? '' : 'none';
    if (!show) return;
    lead.setAttribute('d', 'M' + c.x + ' ' + c.y + ' L' + a.x + ' ' + a.y);
    Array.prototype.forEach.call(dot.querySelectorAll('circle'), function (ci) { ci.setAttribute('cx', a.x); ci.setAttribute('cy', a.y); });
  }
  function flowMove(e) {
    var d = flowDrag; if (!d) return;
    if (d.type === 'label' || d.type === 'dot') {
      if (!d.on && Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) < 4) return;
      d.on = true; d.svg.classList.add('moving-label'); e.preventDefault();
      var nd = d.type === 'dot' ? dotDrop(d, e) : labelDrop(d, e); if (!nd) return;
      if (nd.on) d.t0 = nd.t;   // dragged along the line, then off it: the dot stays where it left
      var pl = d.el.querySelector('.spec-pill'); if (pl) pl.setAttribute('transform', 'translate(' + (nd.c.x - d.c0.x) + ' ' + (nd.c.y - d.c0.y) + ')');
      labelLead(d.el, nd.c, nd.a);
      return;
    }
    if (d.type === 'run' || d.type === 'port') {
      if (!d.on && Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) < 4) return;
      d.on = true; d.svg.classList.add('moving'); e.preventDefault();
      var pq = d.local(e), o = { shapes: {}, ports: {} };
      if (d.type === 'run') {
        // Near straight it snaps straight, within one grid step (Chris, 2026-11-19: Loom's 5 steps, 50 units here,
        // left nowhere to put a run between two straight lines under 100 apart; Loom's STICK is 5, so step / 5).
        var nrec = specRouter().dragTo(d.g, specRouteSpace(d.rr, pq), d.ctrl ? null : specSnap, d.ctrl ? 0 : SPEC_GRID / 5);
        // A run stops where the line still clears its blocks by a stub: past that it would hook back
        // into the block, and the kept shape would be dropped when drawn. Any of the line's end pairs will
        // do (a run next to a top or bottom port crosses under it to the other side), and so will a run in
        // line with such a port, where the line drops straight out of it (specFits).
        if (!(d.rr.combos || [{ A: d.rr.R0.A, B: d.rr.R0.B }]).some(function (c) { return specFits(c.A, c.B, nrec.v); })) return;
        d.rec = nrec;
        if (d.tr) d.rec.tr = true; else delete d.rec.tr;
        o.shapes[d.line.key] = d.rec;
      } else {
        var bid = d.end === 'a' ? d.line.a : d.line.b;
        d.port = specPortAt(specLastOf(d.view).model.R[bid], pq);
        o.ports[d.line.key] = {}; o.ports[d.line.key][d.end] = d.port;
        o.shapes[d.line.key] = null;   // a moved port routes its line afresh
      }
      flowLiveSoon(d, o);
      return;
    }
    if (d.type === 'resize') {
      if (!d.on && Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) < 4) return;
      d.on = true; d.svg.classList.add('moving'); e.preventDefault();
      var rq = d.local(e), rs = flowResize(d, rq.x - d.start.x, rq.y - d.start.y), rb = rs.box, el = d.el;
      var rr = el.querySelector('.spec-group'); rr.setAttribute('x', rb.x); rr.setAttribute('y', rb.y); rr.setAttribute('width', rb.w); rr.setAttribute('height', rb.h);
      var tl = el.querySelector('.spec-group-label'); if (tl) { tl.setAttribute('x', rb.x + 12); tl.setAttribute('y', rb.y + 16); }
      var tm = el.querySelector('.spec-group-meta'); if (tm) { tm.setAttribute('x', rb.x + rb.w - 12); tm.setAttribute('y', rb.y + 16); }
      var gg = el.querySelector('.spec-grips'); if (gg) gg.style.display = 'none';
      return;
    }
    if (!d.on) {
      if (Math.abs(e.clientX - d.cx) + Math.abs(e.clientY - d.cy) < 6) return;
      d.on = true; d.svg.classList.add('moving');
      if (d.type === 'draw' || d.type === 'pick') { d.rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); d.rect.setAttribute('class', 'spec-draw' + (d.type === 'pick' ? ' pick' : '')); d.svg.appendChild(d.rect); }
      else d.els = d.type === 'block' ? (d.ids || [d.id]).reduce(function (a, id) { return a.concat([d.svg.querySelector('.spec-node[data-id="' + CSS.escape(id) + '"]')], Array.prototype.slice.call(d.svg.querySelectorAll('.spec-flag[data-for="' + CSS.escape(id) + '"]'))); }, [])
        : [d.svg.querySelector('.spec-group-g[data-id="' + CSS.escape(d.id) + '"]')].concat(Array.prototype.slice.call(d.svg.querySelectorAll('[data-anc~="' + CSS.escape(d.id) + '"]')));
      if (d.type !== 'draw' && d.type !== 'pick') d.moving = flowMoving(d);
      // A section's blocks take their power flags along too.
      if (d.type === 'section') Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node[data-anc~="' + CSS.escape(d.id) + '"]'), function (g) {
        d.els = d.els.concat(Array.prototype.slice.call(d.svg.querySelectorAll('.spec-flag[data-for="' + CSS.escape(g.dataset.id) + '"]')));
      });
    }
    e.preventDefault();
    var q = d.local(e), dx = q.x - d.start.x, dy = q.y - d.start.y;
    if (d.type === 'draw' || d.type === 'pick') {
      d.rect.setAttribute('x', Math.min(q.x, d.start.x)); d.rect.setAttribute('y', Math.min(q.y, d.start.y));
      d.rect.setAttribute('width', Math.abs(dx)); d.rect.setAttribute('height', Math.abs(dy));
      return;
    }
    d.els.forEach(function (el) { if (el) el.setAttribute('transform', 'translate(' + dx + ' ' + dy + ')'); });
    flowLiveSoon(d, { moving: d.moving, dx: dx, dy: dy });
  }
  // Live re-routing at most once a frame (a big diagram's route set can take longer than a pointer event);
  // flowUp settles a pending one first.
  function flowLiveSoon(d, o) {
    d.liveO = o;
    if (!d.raf) d.raf = requestAnimationFrame(function () { d.raf = 0; d.live = flowLive(d.svg, d.liveO); });
  }
  // A section box resized by its edge grip by (dx, dy): the new grow (never under 0) and box.
  function flowResize(d, dx, dy) {
    var b = d.box0, g0 = d.el.dataset.grow.split(' ').map(Number), e = d.edge;
    var fit = { x: b[0] + g0[0], y: b[1] + g0[1], w: b[2] - g0[0] - g0[2], h: b[3] - g0[1] - g0[3] };
    var g = { l: g0[0], t: g0[1], r: g0[2], b: g0[3] };
    if (e.indexOf('w') >= 0) g.l = Math.max(0, g0[0] - dx);
    if (e.indexOf('e') >= 0) g.r = Math.max(0, g0[2] + dx);
    if (e.indexOf('n') >= 0) g.t = Math.max(0, g0[1] - dy);
    if (e.indexOf('s') >= 0) g.b = Math.max(0, g0[3] + dy);
    return { grow: g, box: { x: fit.x - g.l, y: fit.y - g.t, w: fit.w + g.l + g.r, h: fit.h + g.t + g.b } };
  }
  // The blocks a block or section drag moves.
  function flowMoving(d) {
    var moving = {};
    if (d.type === 'block') (d.ids || [d.id]).forEach(function (id) { moving[id] = 1; });
    else Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node[data-anc~="' + CSS.escape(d.id) + '"]'), function (g) { moving[g.dataset.id] = 1; });
    return moving;
  }
  function specSnap(v) { return Math.round(v / SPEC_GRID) * SPEC_GRID; }
  function specLine(key, view) { var last = specLastOf(view), m = last && last.model; return m ? m.lines.filter(function (L) { return L.key === key; })[0] || null : null; }
  // The lines routed again as they stand mid-drag, and drawn so (Chris, 2026-11-18: lines follow a dragged
  // block). o: { moving (block ids), dx, dy, shapes: { key: record or null }, ports: { key: { a, b } } }. A
  // line with both blocks moving carries its kept shape along. Labels ride along at their place on the line.
  function flowLive(svg, o) {
    var last = specLastOf(svgView(svg)), C = specRouter(); if (!last || !C) return null;
    var m = last.model, mv = o.moving || {}, dx = o.dx || 0, dy = o.dy || 0, R = {};
    Object.keys(m.R).forEach(function (id) { var r = m.R[id]; R[id] = mv[id] ? { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h } : r; });
    var lines = m.lines.map(function (L) {
      var x = Object.assign({}, L);
      if (mv[L.a] && mv[L.b]) x.shape = specShiftShape(L.shape, dx, dy);
      if (o.shapes && L.key in o.shapes) { x.shape = o.shapes[L.key]; x.live = true; }
      var pp = o.ports && o.ports[L.key];
      if (pp && pp.a) x.pa = pp.a;
      if (pp && pp.b) x.pb = pp.b;
      return x;
    });
    var res = specRouteSet({ doc: m.doc, R: R, lines: lines }, { fast: true });
    Object.keys(res).forEach(function (key) {
      var rr = res[key], sel = '[data-line="' + CSS.escape(key) + '"]';
      Array.prototype.forEach.call(svg.querySelectorAll('path' + sel), function (el) { el.setAttribute('d', rr.d); });
      Array.prototype.forEach.call(svg.querySelectorAll('.spec-port' + sel), function (g) {
        var q = g.dataset.end === 'a' ? rr.qa : rr.qb;
        Array.prototype.forEach.call(g.querySelectorAll('circle'), function (c) { c.setAttribute('cx', q.x); c.setAttribute('cy', q.y); });
      });
      Array.prototype.forEach.call(svg.querySelectorAll('.spec-edge-label' + sel), function (l) {
        var old = labelRoute(l.dataset.route); if (!old) return;
        var t = l.dataset.t != null && l.dataset.t !== '' ? +l.dataset.t : 0.5, a = labelPt(old, t), b = C.laneAt(rr.lane, t);
        l.setAttribute('transform', 'translate(' + (b.x - a.x) + ' ' + (b.y - a.y) + ')');
      });
    });
    return { res: res, lines: lines };
  }
  function flowUp(e) {
    var d = flowDrag; flowDrag = null;
    if (!d || !d.on) return;
    if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; d.live = flowLive(d.svg, d.liveO); }
    d.svg.classList.remove('moving', 'moving-label');
    specDragJustEnded = true; setTimeout(function () { specDragJustEnded = false; }, 0);
    var p = current(); if (!p) return;
    var q = d.local(e);
    if (d.type === 'label' || d.type === 'dot') {
      var nd = d.type === 'dot' ? dotDrop(d, e) : labelDrop(d, e), rec = p.spec[d.from];
      if (!nd || !rec) { renderPage(); return; }
      var labs = Object.assign({}, specLay(rec, d.view).labels || {});
      labs[d.key] = { t: Math.round(nd.t * 1000) / 1000, x: nd.x, y: nd.y };
      specPutAll(p, [M.specStamp(specWithLay(rec, d.view, { labels: labs }), me())]);
      return;
    }
    if (d.type === 'run') {
      var rl = d.line, rres = d.live && d.live.res[rl.key], srec0 = p.spec[rl.srcA];
      if (!rres || !srec0 || !d.rec) { renderPage(); return; }
      var kept = specRouter().release(rres.R0, d.rec.v, d.rec), rts = Object.assign({}, specLay(srec0, d.view).routes || {});
      rts[rl.rkey] = { v: kept.v, a: kept.a, b: kept.b }; if (kept.mode) rts[rl.rkey].mode = kept.mode; if (rres.tr) rts[rl.rkey].tr = true;
      var outR = {}; outR[rl.srcA] = specWithLay(srec0, d.view, { routes: rts });
      // Dropped on a line of its bus: that line keeps the shape it's drawn with now, so the two stay together.
      var val = d.rec.v[d.g.k], lastV0 = specLastOf(d.view);
      (d.g.bus || []).filter(function (t) { return Math.abs(t.val - val) < 0.5; }).forEach(function (t) {
        var Lp = specLine(t.key, d.view), rp = lastV0 && lastV0.routed[t.key]; if (!Lp || !rp || Lp.shape) return;
        var r0 = outR[Lp.srcA] || p.spec[Lp.srcA]; if (!r0) return;
        var rt2 = Object.assign({}, specLay(r0, d.view).routes || {});
        rt2[Lp.rkey] = { v: rp.R0.v.slice(), a: rp.R0.A.side === 'l' ? 'l' : 'r', b: rp.R0.B.side === 'r' ? 'r' : 'l' }; if (rp.tr) rt2[Lp.rkey].tr = true;
        outR[Lp.srcA] = specWithLay(r0, d.view, { routes: rt2 });
      });
      specPutAll(p, Object.keys(outR).map(function (k) { return M.specStamp(outR[k], me()); }));
      return;
    }
    if (d.type === 'port') {
      var pl = d.line, w = pl.word.toLowerCase(), bid = d.end === 'a' ? pl.a : pl.b, other = d.end === 'a' ? pl.b : pl.a, brec = p.spec[bid];
      if (!brec || !d.port) { renderPage(); return; }
      var prts = Object.assign({}, specLay(brec, d.view).ports || {}), out = {};
      prts[other + '|' + w] = { side: d.port.side, t: d.port.t };
      out[bid] = specWithLay(brec, d.view, { ports: prts });
      // A moved port routes its line afresh: its kept shape goes.
      var sr = out[pl.srcA] || p.spec[pl.srcA], srt = specLay(sr, d.view).routes;
      if (sr && srt && srt[pl.rkey]) {
        var r2 = Object.assign({}, srt); delete r2[pl.rkey];
        out[pl.srcA] = specWithLay(sr, d.view, { routes: r2 });
      }
      specPutAll(p, Object.keys(out).map(function (k) { return M.specStamp(out[k], me()); }));
      return;
    }
    if (d.type === 'resize') {
      var sn = function (v) { return Math.round(v / 10) * 10; }, rs = flowResize(d, sn(q.x - d.start.x), sn(q.y - d.start.y)), srec = p.spec[d.id];
      var old = (srec && srec.grow) || {}, ng = rs.grow;
      if (!srec || ['l', 't', 'r', 'b'].every(function (k) { return (old[k] || 0) === ng[k]; })) { renderPage(); return; }
      var nrec = Object.assign({}, srec);
      if (ng.l || ng.t || ng.r || ng.b) nrec.grow = ng; else delete nrec.grow;
      // Resizing arranges too: blocks without a kept place keep the one they're drawn at.
      var rrecs = [M.specStamp(nrec, me())];
      Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node'), function (g) {
        var r0 = p.spec[g.dataset.id]; if (!r0 || r0.pos || g.dataset.id === d.id) return;
        rrecs.push(M.specStamp(Object.assign({}, r0, { pos: { x: +g.dataset.x, y: +g.dataset.y } }), me()));
      });
      specPutAll(p, rrecs);
      return;
    }
    if (d.type === 'pick') {
      var px0 = Math.min(q.x, d.start.x), py0 = Math.min(q.y, d.start.y), px1 = Math.max(q.x, d.start.x), py1 = Math.max(q.y, d.start.y);
      d.rect.remove();
      if (!d.add) specPtPick = {};
      // A block is picked when the box touches it.
      Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node'), function (g) {
        var gr = g.querySelector('rect'), bx = +g.dataset.x, by = +g.dataset.y, bw = gr ? +gr.getAttribute('width') : SPEC_BW, bh = gr ? +gr.getAttribute('height') : SPEC_BH;
        if (bx < px1 && bx + bw > px0 && by < py1 && by + bh > py0) specPtPick[g.dataset.id] = 1;
      });
      specPtPickShow(d.svg);
      var pn = specPtPickIds().length;
      if (pn) toast(plural(pn, 'block') + ' picked. Drag one to move them all; Esc lets go.');
      return;
    }
    if (d.type === 'draw') {
      var x0 = Math.min(q.x, d.start.x), y0 = Math.min(q.y, d.start.y), x1 = Math.max(q.x, d.start.x), y1 = Math.max(q.y, d.start.y);
      d.rect.remove();
      var ids = Array.prototype.filter.call(d.svg.querySelectorAll('.spec-node'), function (g) {
        var gr = g.querySelector('rect'), cx = +g.dataset.x + (gr ? +gr.getAttribute('width') : SPEC_BW) / 2, cy = +g.dataset.y + SPEC_BH / 2;
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
    var stored = {}; M.liveSpec(p).forEach(function (s) { stored[s.id] = specLay(s, d.view).pos; });
    var moving = flowMoving(d);
    var view = Object.assign({}, p, { spec: Object.assign({}, p.spec) }), upd = {};
    Array.prototype.forEach.call(d.svg.querySelectorAll('.spec-node'), function (g) {
      var id = g.dataset.id, x = +g.dataset.x + (moving[id] ? dx : 0), y = +g.dataset.y + (moving[id] ? dy : 0), was = stored[id];
      // A place kept off the grid (before 2026-11-19) draws snapped; unmoved, it isn't rewritten (or stamped).
      if (was && specSnap(was.x) === x && specSnap(was.y) === y) return;
      upd[id] = specWithLay(p.spec[id], d.view, { pos: { x: x, y: y } }); view.spec[id] = upd[id];
    });
    // A shaped line between two moved blocks moves with them (its shape is absolute).
    var lastV = specLastOf(d.view);
    if (dx || dy) ((lastV && lastV.model.lines) || []).forEach(function (L) {
      if (!L.shape || !moving[L.a] || !moving[L.b]) return;
      var r0 = upd[L.srcA] || p.spec[L.srcA]; if (!r0) return;
      var rts = Object.assign({}, specLay(r0, d.view).routes || {}); rts[L.rkey] = specShiftShape(L.shape, dx, dy);
      upd[L.srcA] = specWithLay(r0, d.view, { routes: rts });
    });
    Object.keys(upd).forEach(function (id) { upd[id] = M.specStamp(upd[id], me()); });
    var recs = Object.keys(upd).map(function (k) { return upd[k]; });
    if (!recs.length) { renderPage(); return; }
    specPutAll(p, recs);
  }
  function T_title(p, id) { var s = M.liveSpec(p).filter(function (x) { return x.id === id; })[0]; return s ? s.title : 'It'; }
  function specAutoLayout(view) {
    var p = current(); if (!p) return;
    if (view === 'ptree') {
      var precs = M.liveSpec(p).filter(function (s) { return s.ptree; }).map(function (s) { var r = Object.assign({}, p.spec[s.id]); delete r.ptree; return M.specStamp(r, me()); });
      if (precs.length) { specPutAll(p, precs); toast('Power tree laid out again'); }
      return;
    }
    var recs = M.liveSpec(p).filter(function (s) { return s.pos || s.labels || s.grow || s.ports || s.routes; }).map(function (s) { var r = Object.assign({}, p.spec[s.id], { pos: null }); delete r.labels; delete r.grow; delete r.ports; delete r.routes; return M.specStamp(r, me()); });
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
    touch(p); renderPage(); renderInspector(); renderToolbar();
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
  // and waits for a sync like any other. A step is refused when its sections changed since (a sync brought
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
    // A move rewrites the neighbors it renumbers too: name the one that went furthest (a change of level first).
    var far = function (id) { var r = e.cur[id], o = e.old[id]; return (o.level !== r.level ? 1e9 : 0) + Math.abs((r.order || 0) - (o.order || 0)); };
    if (ids.every(moved)) return 'moving ' + title(ids.slice().sort(function (u, v) { return far(v) - far(u); })[0]);
    if (ids.length === 1) {
      var r = e.cur[ids[0]], o = e.old[ids[0]];
      if (!o) return 'adding ' + title(ids[0]);
      if (r.deleted && !o.deleted) return 'deleting ' + title(ids[0]);
      if (o.title !== r.title && o.body === r.body) return 'renaming ' + (o.title || 'Untitled') + ' to ' + title(ids[0]);
      if (o.title === r.title && o.body === r.body && JSON.stringify(o.pins || null) !== JSON.stringify(r.pins || null)) return 'the pin change on ' + title(ids[0]);
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
    if (HIST.compare.isCopy(p)) { HIST.compare.refuse(); return; }   // the tagged version: its back and forward are the live review's
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
    specPinsRefresh();
    toast((back ? 'Undone: ' : 'Redone: ') + e.label, { label: back ? 'Redo' : 'Undo', run: function () { specHistStep(!back); } });
    // Show where it happened.
    var live = recs.filter(function (r) { return !r.deleted; })[0];
    if (live && ui.specView !== 'map' && !pinFull) {
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
    var offer = M.specOfferWords().map(function (w) { return w.toLowerCase(); });
    var linkFields = words.map(function (w) {
      var items = M.specUsesItems(s.body, w), have = items.map(function (n) { return (M.specUseId(a.ctx, n) && a.ctx.secs[M.specUseId(a.ctx, n)].title || n.name).toLowerCase(); });
      var offered = offer.indexOf(w.toLowerCase()) >= 0;
      if (!offered && !items.length) return '';
      var opts = offered ? a.sections.filter(function (y) { return y.sec.id !== id && y.sec.title && have.indexOf(y.sec.title.toLowerCase()) < 0; }) : [];
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
    // Connected from and Supplied by are the other blocks' lines naming this one (Chris, 2026-11-19: set them
    // here too): × takes this block off that block's line, and the list adds it to another block's line.
    var fromFields = words.map(function (w) {
      var from = a.sections.filter(function (y) { return y.edges.some(function (e) { return e.id === id && e.word.toLowerCase() === w.toLowerCase(); }); });
      var offeredF = offer.indexOf(w.toLowerCase()) >= 0;
      if (!offeredF && !from.length) return '';
      var fopts = offeredF ? a.sections.filter(function (y) { return y.sec.id !== id && y.sec.title && from.indexOf(y) < 0; }) : [];
      return '<div class="field"><span class="field-label">' + esc(linkFrom(w)) + '</span><div class="chips">' + (from.length ? from.map(function (y) {
        var e = y.edges.filter(function (e2) { return e2.id === id && e2.word.toLowerCase() === w.toLowerCase(); })[0];
        var it = M.specUsesItems(y.sec.body, w).filter(function (n) { return M.specUseId(a.ctx, n) === id; })[0];
        return '<span class="chip spec-use-chip"><button data-act="spec-block" data-id="' + esc(y.sec.id) + '">' + esc(y.sec.title + (e && e.label ? ' · ' + e.label : '')) + '</button>' +
          (it ? '<button class="spec-use-x" data-act="spec-block-unfrom" data-from="' + esc(y.sec.id) + '" data-word="' + esc(w) + '" data-name="' + esc(it.name) + '" aria-label="Remove ' + esc(y.sec.title) + '">×</button>' : '') + '</span>';
      }).join('') : '<span class="note" style="margin:0">Nothing yet</span>') + '</div>' +
      (fopts.length ? '<select class="input spec-block-from" data-word="' + esc(w) + '" style="margin-top:8px"><option value="">Add a block that ' + esc(linkVerb(w)) + ' it…</option>' + fopts.map(function (y) {
        return '<option value="' + esc(y.sec.id) + '">' + esc(y.sec.title) + '</option>';
      }).join('') + '</select>' : '') + '</div>';
    }).join('');
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram › ' + esc(s.title || 'Untitled') + '</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="field"><label for="spec-block-title">Name</label><input class="input" id="spec-block-title" value="' + esc(s.title) + '"></div>' +
      (kinds.length > 1 ? '<div class="field"><span class="field-label">Kind</span><div class="seg full spec-kind-seg">' + kinds.map(function (k) {
        return '<button class="' + (s.kind === k ? 'on' : '') + '" data-act="spec-block-kind" data-kind="' + k + '">' + (k ? kindLabel(k) : 'None') + '</button>';
      }).join('') + '</div></div>' : '') +
      '<div class="field"><label for="spec-block-gist">Gist</label><input class="input" id="spec-block-gist" value="' + esc(x.blocks.filter(function (b) { return b.type === 'gist'; }).map(function (b) { return b.text; })[0] || '') + '" placeholder="' + esc(x.gist || 'One line: what it does') + '"></div>' +
      linkFields + fromFields + (FT ? specWithinField(FT, x) : '') + specPowerField(a, x) +
      (SPEC && SPEC.parts ? '<div class="field"><label for="spec-block-parts">Parts</label><input class="input" id="spec-block-parts" value="' + esc(x.parts.join(', ')) + '" placeholder="U7, L1, C1–C3"></div>' : '') +
      (pinsOn() ? specPinsField(a, x) : '') +
      '<div class="field"><span class="field-label">Text</span><p class="note" style="margin:0">' + esc([plural(x.counts.linked + x.counts.std + x.counts.tag + x.counts.untraced + x.counts.note, 'sentence'), x.links.length ? plural(x.links.length, 'requirement') + ' linked' : '', x.gaps ? specGapTitle(x) : '', x.notes.length ? plural(x.notes.length, 'review note') : ''].filter(Boolean).join(' · ')) + '</p></div>' +
      specGapList(x) + specNoteList(x) +
      '<div class="spec-acts"><button class="btn btn-primary" data-act="spec-edit" data-id="' + esc(id) + '">Edit its text</button><button class="btn" data-act="spec-goto" data-id="' + esc(id) + '">Show in document</button>' +
      (lower ? '<button class="btn" data-act="spec-add-block" data-kind="' + lower + '" data-parent="' + esc(id) + '">Add a ' + lower + ' it uses</button>' : '') +
      '<button class="btn btn-danger" data-act="spec-block-delete" data-id="' + esc(id) + '">Delete</button></div>' +
      '<p class="note">Last changed ' + (s.updatedBy ? 'by ' + esc(s.updatedBy) + ', ' : '') + relTime(s.updatedAt) + '.</p></div>';
    el.dataset.item = selected;
  }
  // ── Pins (Chris, 2026-11-20): an MCU block's pin plan. The planner is assets/pinmap.js; the part comes from
  // Pincheck's library in this browser (../pincheck/assets/library.js, IndexedDB `pincheck`) and is copied onto the
  // section (pins.part) when a plan starts, so everyone the review is shared with plans from the same pins. Picks
  // are pins.map. See ../pincheck/docs/pin-planner.md. EE only (config.spec.pins). ──
  var PIN = window.SignoffPinmap;
  function pinsOn() { return !!(SPEC && SPEC.pins && PIN); }
  var pinLib = { list: null, loading: false };
  function pinLibLoad() {
    if (pinLib.list || pinLib.loading || !window.PK || !window.PK.library) return;
    pinLib.loading = true;
    window.PK.DEMO = !!DEMO;                    // before the library first opens its database: ?demo reads pincheck-demo
    window.PK.tokenSource = getToken;            // the library syncs with pincheck_data on EE's sign-in
    window.PK.toast = function (t) { toast(t); };
    window.PK.library.all().then(function (l) {
      pinLib.list = (l || []).filter(function (f) { return f && Array.isArray(f.pins) && f.pins.length && !(f.local && f.local.conflictOf); });
    }, function () { pinLib.list = []; }).then(function () { pinLib.loading = false; if (selected && specBlockSel()) renderInspector(); });
  }
  function pinLibFind(mpn) { return mpn && pinLib.list ? window.PK.library.find(pinLib.list, mpn) : null; }
  function pinIsMcu(f) {
    return !!f && (f.kind === 'mcu' || (f.pins || []).some(function (q) { return (q.functions || []).some(function (fn) { return /^[A-Z][A-Z0-9]*_\S+\s+AF\d+$/.test(fn); }); }));
  }
  var pinCache = {}, pinOpen = {};   // pinOpen: the side panel's open folds, { '<section id>': { '<conn id>': true } }
  function pinRes(id) { return pinCache[id] ? pinCache[id].res : null; }
  // The plan for a block, worked out again only when its part, connections, or picks change.
  function pinPlan(a, x) {
    var copy = x.sec.pins && x.sec.pins.part;
    if (!copy) return null;
    var conns = M.specMcuConns(a, x.sec.id), map = (x.sec.pins && x.sec.pins.map) || {}, types = (x.sec.pins && x.sec.pins.types) || {};
    var key = x.sec.id + '|' + JSON.stringify([copy.mpn, copy.from || null, copy.pins.length]) + '|' + JSON.stringify(conns.map(function (c) { return [c.id, c.label, c.dir, c.block]; })) + '|' + JSON.stringify(map) + '|' + JSON.stringify(types);
    var c = pinCache[x.sec.id];
    if (!c || c.key !== key) {
      var part = PIN.part(copy), res = PIN.plan(part, conns, map, types, { auto: false });   // stored assignments only (2026-11-21)
      res.part = part; res.conns = conns;
      c = pinCache[x.sec.id] = { key: key, res: res };
    }
    return c.res;
  }
  var PIN_MARK = { issue: '✕', warn: '▲', todo: '○', ok: '✓' };
  function pinWhat(r) { return r.type === 'PINS' ? 'Pins' : PIN.TYPES[r.type].single ? r.type : (r.inst || r.want || r.item.inst || r.type) + (r.item.count > 1 ? ' × ' + r.item.count : ''); }
  function specPinsField(a, x) {
    var s = x.sec, copy = s.pins && s.pins.part, fte = isFte() || !!DEMO;
    if (fte) pinLibLoad();
    var lib = fte ? pinLibFind(x.part) : null;
    var mcus = fte && pinLib.list ? pinLib.list.filter(pinIsMcu) : [];
    var html = '<div class="field"><label for="spec-block-part">Part</label><input class="input" id="spec-block-part" value="' + esc(x.part) + '" placeholder="Part number, such as STM32G0B1CBT6"' + (mcus.length ? ' list="spec-part-list"' : '') + '>' +
      (mcus.length ? '<datalist id="spec-part-list">' + mcus.map(function (f) { return '<option value="' + esc(f.mpn) + '">' + esc((f.manufacturer || '') + (f.package ? ', ' + f.package : '')) + '</option>'; }).join('') + '</datalist>' : '') + '</div>';
    if (!x.part && !copy) return html;
    html += '<div class="field spec-pins"><span class="field-label">Pins</span>';
    if (!copy) {
      if (lib && pinIsMcu(lib)) html += '<p class="note" style="margin:0 0 8px">' + esc(lib.mpn) + ' is in the part library. A pin plan checks this block’s connections against its pins and alternate functions, and places them.</p><div class="spec-acts"><button class="btn btn-sm" data-act="spec-pins-start">Start a pin plan</button>' + (pinEditorOn() ? '<button class="btn btn-sm btn-plain" data-act="spec-part-edit">Edit part…</button>' : '') + '</div>';
      else if (lib) html += '<p class="note" style="margin:0 0 8px">' + esc(lib.mpn) + ' is in the part library, but not as an MCU: its pins list no alternate functions.' + (pinEditorOn() ? ' Add them in the part window (Import from CubeMX… for an STM32).' : '') + '</p>' + (pinEditorOn() ? '<div class="spec-acts"><button class="btn btn-sm" data-act="spec-part-edit">Edit part…</button></div>' : '');
      else if (fte && pinLib.loading) html += '<p class="note" style="margin:0">Looking in the part library…</p>';
      else if (fte) html += '<p class="note" style="margin:0 0 8px">' + esc(x.part) + ' isn’t in the part library in this browser.' + (pinEditorOn() ? ' Make it here: the part window is Pincheck’s, and for an STM32 its Import from CubeMX… reads the pins and alternate functions from STM32CubeMX on this computer.' : ' Make it in <a href="../pincheck/' + (DEMO ? '?demo' : '') + '">Pincheck</a>, then come back.') + '</p>' +
        '<div class="spec-acts">' + (pinEditorOn() ? '<button class="btn btn-sm" data-act="spec-part-new">New part…</button>' : '') + (DEMO ? '' : '<button class="btn btn-sm btn-plain" data-act="spec-part-sync">' + (pinLib.syncing ? 'Syncing…' : 'Sync the part library') + '</button>') + '</div>';
      else html += '<p class="note" style="margin:0">No pin plan yet.</p>';
      return html + '</div>';
    }
    var res = pinPlan(a, x), c = res.counts;
    var notes = [];
    if (x.part && copy.mpn && window.PK && window.PK.library ? window.PK.library.norm(copy.mpn) !== window.PK.library.norm(x.part) : x.part && copy.mpn && copy.mpn.toUpperCase() !== x.part.toUpperCase())
      notes.push('The plan is for ' + esc(copy.mpn) + '; the Part line says ' + esc(x.part) + '.' + (lib && pinIsMcu(lib) ? ' <button class="btn btn-plain btn-sm spec-pins-act" data-act="spec-pins-start">Plan from ' + esc(lib.mpn) + '</button>' : ''));
    else if (lib && lib.local && lib.local.sha && copy.from && copy.from.sha && lib.local.sha !== copy.from.sha)
      notes.push('The part library has a newer ' + esc(copy.mpn) + '. <button class="btn btn-plain btn-sm spec-pins-act" data-act="spec-pins-start">Update the plan’s copy</button>');
    html += '<div class="spec-pins-sum"><span><b>' + c.used + '</b> of ' + c.io + ' I/O pins assigned</span>' +
      (c.problems ? '<span class="spec-pins-tag issue">✕ ' + plural(c.problems, 'problem') + '</span>' : '') +
      (c.warnings ? '<span class="spec-pins-tag warn">▲ ' + c.warnings + ' to check</span>' : '') +
      (c.unassigned ? '<span class="spec-pins-tag todo">○ ' + c.unassigned + ' not assigned</span>' : '') +
      (!c.problems && !c.warnings && !c.unassigned ? '<span class="spec-pins-tag ok">✓ All placed</span>' : '') + '</div>' +
      notes.map(function (n) { return '<p class="note spec-pins-note">' + n + '</p>'; }).join('');
    // One row per connection, as the pin map lists them (Chris, 2026-11-21): a connection with several signals folds
    // open to a row per signal (pinOpen remembers which, per block).
    var pinsOf = function (r) {
      return r.slots.slice().sort(function (p1, p2) { return PIN.nat(p1.sig, p2.sig); }).map(function (sl) {
        return '<span class="spec-pin' + (sl.lock ? ' lock' : '') + '">' + esc(sl.gpio) + (sl.sig && sl.sig !== sl.gpio && sl.sig !== 'GPIO' ? ' <i>' + esc(sl.sig) + '</i>' : '') + '</span>';
      }).join('');
    };
    var sigRow = function (r, u, kid, cn, noChips) {
      var sev = PIN.sevOf(r), pins = noChips ? '' : pinsOf(r), what = pinWhat(r), name = String(u.item.text || '');
      var lines = r.problems.map(function (q) { return '<li class="issue">' + esc(q.text) + '</li>'; }).concat(r.notes.filter(function (n) { return n.sev === 'warn' || n.sev === 'shared'; }).map(function (n) { return '<li class="warn">' + esc(n.text) + '</li>'; })).join('');
      return '<div class="spec-pins-row ' + sev + (kid ? ' kid' : '') + '"><div class="spec-pins-top"><span class="spec-pins-mark ' + sev + '" aria-label="' + sev + '">' + PIN_MARK[sev] + '</span><b>' + esc(kid ? what : cn.block) + '</b><span class="spec-pins-blocks">' + esc(kid ? (name.toLowerCase() === what.toLowerCase() ? '' : name) : what) + '</span></div>' +
        (pins ? '<div class="spec-pins-pins">' + pins + '</div>' : '') + (lines ? '<ul class="spec-pins-why">' + lines + '</ul>' : '') +
        (r.fix ? '<button class="btn btn-plain btn-sm spec-pins-act" data-act="spec-pins-fix" data-req="' + esc(r.id) + '">Write it as ' + esc(r.fix.to) + '</button>' : '') + '</div>';
    };
    // One line per pin inside a fold: its signal, its pin, and the function when it says more.
    var pinLines = function (r, u) {
      var T = PIN.TYPES[r.type], net = String(u.item.text || '').replace(/^\d+\s*[x×]?\s+/, '');
      var ss = r.slots.slice().sort(function (a1, a2) { return T.bus ? T.sigs.indexOf(a1.sig) - T.sigs.indexOf(a2.sig) : PIN.nat(a1.gpio, a2.gpio); });
      return ss.length ? '<div class="spec-pins-pinrows">' + ss.map(function (sl, i) {
        var name = r.type === 'PINS' ? sl.gpio : T.bus ? sl.sig : (net || r.type) + (ss.length > 1 ? ' ' + (i + 1) : '');
        return '<div class="spec-pins-pinrow"><span class="spec-pins-pn">' + esc(name) + '</span><span class="spec-pin' + (sl.lock ? ' lock' : '') + '">' + esc(sl.gpio) + '</span>' + (sl.fn && !T.bus ? '<span class="spec-pins-fn">' + esc(sl.fn.full) + '</span>' : '') + '</div>';
      }).join('') + '</div>' : '';
    };
    var corder = {}; (res.conns || []).forEach(function (cn, i) { corder[cn.id] = i; });
    var conns = [], cById = {};
    res.reqs.forEach(function (r) {
      r.users.forEach(function (u) {
        var cn = cById[u.conn.id];
        if (!cn) { cn = cById[u.conn.id] = { id: u.conn.id, block: u.block, label: u.conn.label || '', items: [] }; conns.push(cn); }
        cn.items.push({ r: r, u: u, ii: +String(u.key || '').split('#').pop() || 0 });
      });
    });
    conns.sort(function (c1, c2) { return (corder[c1.id] != null ? corder[c1.id] : 1e6) - (corder[c2.id] != null ? corder[c2.id] : 1e6); });
    var openSet = pinOpen[s.id] || {};
    html += '<div class="spec-pins-list">' + conns.map(function (cn) {
      cn.items.sort(function (i1, i2) { return i1.ii - i2.ii; });
      var multi = cn.items.length > 1, nPins = cn.items.reduce(function (n, it) { return n + it.r.slots.length; }, 0);
      if (!multi && nPins < 2) return sigRow(cn.items[0].r, cn.items[0].u, false, cn);
      var sev = cn.items.map(function (it) { return PIN.sevOf(it.r); }).sort(function (s1, s2) { return ['issue', 'warn', 'todo', 'ok'].indexOf(s1) - ['issue', 'warn', 'todo', 'ok'].indexOf(s2); })[0];
      var open = !!openSet[cn.id];
      return '<div class="spec-pins-grp' + (open ? ' open' : '') + '"><button class="spec-pins-row spec-pins-head ' + sev + '" data-act="spec-pins-fold" data-id="' + esc(cn.id) + '" aria-expanded="' + open + '">' +
        '<div class="spec-pins-top"><span class="spec-pins-caret' + (open ? ' open' : '') + '"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="spec-pins-mark ' + sev + '" aria-label="' + sev + '">' + PIN_MARK[sev] + '</span><b>' + esc(cn.block) + '</b><span class="spec-pins-blocks">' + (multi ? cn.items.length + ' signals' : esc(pinWhat(cn.items[0].r))) + '</span></div>' +
        '<div class="spec-pins-label">“' + esc(cn.label) + '”</div>' +
        (open ? '' : '<div class="spec-pins-pins">' + cn.items.map(function (it) { return pinsOf(it.r); }).join('') + '</div>') + '</button>' +
        (open ? '<div class="spec-pins-kids">' + cn.items.map(function (it) { return (multi ? sigRow(it.r, it.u, true, cn, true) : '') + pinLines(it.r, it.u); }).join('') + '</div>' : '') + '</div>';
    }).join('') + res.stray.map(function (st) {
      return '<div class="spec-pins-row warn"><div class="spec-pins-top"><span class="spec-pins-mark warn">▲</span><b>' + esc(st.fn) + '</b><span class="spec-pins-blocks">' + esc((res.part.byNum[st.pad] || { names: [st.pad] }).names[0]) + '</span></div><ul class="spec-pins-why"><li class="warn">You picked this function on the pin, but no connection to the MCU asks for it.</li></ul></div>';
    }).join('') + (res.reqs.length || res.stray.length ? '' : '<p class="note" style="margin:0">No connections yet. Connect blocks to this one, naming the interface: IMU (I2C1), Wi-Fi module (UART), Probe (2 ADC).</p>') + '</div>';
    return html + (window.SignoffPinView ? '<div class="spec-acts" style="margin-top:10px"><button class="btn" data-act="spec-pins-map">Open pin map</button>' + (lib && pinEditorOn() ? '<button class="btn btn-plain" data-act="spec-part-edit">Edit part…</button>' : '') + '</div>' : '') +
      '<p class="note">From ' + esc([copy.mpn, copy.package].filter(Boolean).join(', ')) + ', the part library’s copy kept with this review.</p></div>';
  }
  // Marks on the diagram's lines (Chris, 2026-11-20): a connection an MCU block's plan covers shows its peripheral and
  // pins after its label ("I2C · I2C1 PB6/PB7"), with ✕ or ▲ when the part can't do it or it needs a look.
  // { '<a>|<b>|<label, lower case>': { sev, text } }, a and b in either order.
  function specPinTags(a) {
    var out = {};
    if (!pinsOn()) return out;
    a.sections.forEach(function (x) {
      var res = x.sec.pins && x.sec.pins.part ? pinPlan(a, x) : null;
      if (!res) return;
      res.reqs.forEach(function (r) {
        var sev = PIN.sevOf(r);
        if (sev !== 'issue' && sev !== 'warn') return;   // Chris, 2026-11-21: the label shows the net name only, no peripheral or pins
        var why = r.problems.map(function (q) { return q.text; }).concat(r.notes.filter(function (n) { return n.sev === 'warn'; }).map(function (n) { return n.text; })).join(' ');
        r.users.forEach(function (u) {
          var lab = String(u.conn.label || '').toLowerCase();
          // An entry with several signals ("I2C2 + ALERT") has a requirement each: the line keeps the worst.
          [u.conn.from + '|' + u.conn.to, u.conn.to + '|' + u.conn.from].forEach(function (k) {
            var key = k + '|' + lab, was = out[key];
            if (was && (was.sev === 'issue' || sev === 'warn')) { was.title += ' ' + why; return; }
            out[key] = { sev: sev, text: sev === 'issue' ? '✕' : '▲', title: (was ? was.title + ' ' : '') + why };
          });
        });
      });
    });
    return out;
  }

  // The full-window pin map (assets/pinview.js): the plan's five views. A pick on a pin is written to the section's
  // pins.map (one Scribe edit, with Back), and the map draws again from the new plan.
  var pinFull = null;
  function specPinsOpen() {
    var p = current(), id = specBlockSel(), a = p && M.specAnalysis(p), x = a && a.sections.filter(function (y) { return y.sec.id === id; })[0];
    var res = x && pinPlan(a, x);
    if (!res || !window.SignoffPinView) return;
    specPinsClose();
    var wrap = document.createElement('div');
    wrap.className = 'pv-full';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = '<div class="pv-full-head"><div><div class="eyebrow">Pin map</div><h2 class="pv-full-title"></h2></div><span class="pv-full-tools"><span class="pv-full-hist"></span><button class="icon-btn" data-pv-close aria-label="Close">' + ICON.close + '</button></span></div><div class="pv-full-body"></div>';
    document.body.appendChild(wrap);
    document.body.classList.add('pv-open');
    var view = window.SignoffPinView.mount(wrap.querySelector('.pv-full-body'), {
      part: res.part, result: res, map: (x.sec.pins && x.sec.pins.map) || {}, view: ui.pinView || 'package',
      canEdit: !HIST.compare.isCopy(p),
      onView: function (v) { ui.pinView = v; saveUi(); },
      onPick: function (pad, fn, req, gpio) { var r0 = pinRes(id); if (r0) specPinsMap(function (m) { return PIN.pick(m, r0, r0.part, pad, fn, req, gpio); }, 'Picked ' + (fn || 'GPIO') + ' on ' + pinName(r0, pad, gpio)); },
      onUnpick: function (pad) { var r0 = pinRes(id); specPinsMap(function (m) { return PIN.unpick(m, pad); }, 'Removed your pick on ' + pinName(r0, pad)); },
      // A connection's picks all at once: the planner places it again.
      // A connection's Type, over its label: the old requirement's picks go (they were for the other type).
      onType: function (reqId, keys, val) {
        specPinsEdit(function (pins) {
          var t = Object.assign({}, pins.types || {}), m = {};
          keys.forEach(function (k) { if (val) t[k] = val; else delete t[k]; });
          Object.keys(pins.map || {}).forEach(function (k) { if (pins.map[k].req !== reqId) m[k] = pins.map[k]; });
          return Object.assign({}, pins, { types: t, map: m });
        }, val ? 'Set the type to ' + val : 'The type comes from the label again');
      },
      // Auto-assign (a full plan around what's stored, the new pins stored unlocked), Unassign (all but locked), and a
      // row's lock (Chris, 2026-11-21).
      onAuto: function () {
        var r0 = pinRes(id); if (!r0) return;
        specPinsEdit(function (pins) {
          var full = PIN.plan(r0.part, r0.conns, pins.map || {}, pins.types || {}, { auto: true });
          return Object.assign({}, pins, { map: PIN.assignAll(pins.map || {}, full, r0.part) });
        }, 'Auto-assigned the open connections');
      },
      onUnassign: function () { specPinsMap(function (m) { return PIN.unassign(m); }, 'Unassigned every pin but the locked ones'); },
      onLock: function (ids, on) { specPinsMap(function (m) { return PIN.lock(m, ids, on); }, on ? 'Locked' : 'Unlocked'); },
      onLockPads: function (pads, on) { specPinsMap(function (m) { return PIN.lockPads(m, pads, on); }, on ? 'Locked the pin' : 'Unlocked the pin'); },
      onClear: function (reqId) { specPinsMap(function (m) { var o = {}; Object.keys(m).forEach(function (k) { if (m[k].req !== reqId) o[k] = m[k]; }); return o; }, 'Cleared your picks'); },
      onFix: function (reqId) { specPinsFix(reqId); }
    });
    wrap.addEventListener('click', function (e) {
      if (e.target.closest('[data-pv-close]')) { specPinsClose(); return; }
      var hb = e.target.closest('.pv-full-hist [data-act]');
      if (hb && !hb.disabled) { e.stopPropagation(); specHistStep(hb.dataset.act === 'spec-undo'); }
    });
    pinFull = { id: id, wrap: wrap, view: view };
    specPinsRefresh();
  }
  function pinName(res, pad, gpio) { var q = res && res.part.byNum[pad]; return (gpio || (q ? q.names[0] : '')) + ' (pin ' + pad + ')'; }
  function specPinsClose() {
    if (!pinFull) return;
    pinFull.view.destroy();
    pinFull.wrap.remove();
    pinFull = null;
    document.body.classList.remove('pv-open');
  }
  // Draw the open pin map again from the current review (after a pick, a sync, an edit, or Back).
  function specPinsRefresh() {
    if (!pinFull) return;
    var p = current(), a = p && specOn(p) ? M.specAnalysis(p) : null, x = a && a.sections.filter(function (y) { return y.sec.id === pinFull.id; })[0];
    var res = x && pinPlan(a, x);
    if (!res) { specPinsClose(); return; }
    pinFull.wrap.querySelector('.pv-full-title').textContent = x.sec.title + ' · ' + [res.part.meta.mpn, res.part.meta.package].filter(Boolean).join(', ');
    pinFull.view.update({ part: res.part, result: res, map: (x.sec.pins && x.sec.pins.map) || {} });
    pinFull.wrap.querySelector('.pv-full-hist').innerHTML = HIST.compare.isCopy(p) ? '' : specHistHtml(p);   // Back and Forward, as on Scribe's toolbar
  }
  function specPinsMap(fn, what) {
    specPinsEdit(function (pins) { return Object.assign({}, pins, { map: fn(pins.map || {}) }); }, what);
  }
  // Any change to the block's pins record (picks, types), as one Scribe edit with Undo.
  function specPinsEdit(fn, what) {
    var p = current(), cur = p && pinFull && (p.spec || {})[pinFull.id];
    if (!cur || !pinRes(pinFull.id)) return;
    var pins = fn(Object.assign({}, cur.pins || {}));
    ['map', 'types'].forEach(function (k) { if (!pins[k] || !Object.keys(pins[k]).length) delete pins[k]; });
    specPutAll(p, [M.specStamp(Object.assign({}, cur, { pins: pins }), me())]);
    specPinsRefresh();
    if (what) toast(what, { label: 'Undo', run: function () { specHistStep(true); } });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !pinFull) return;
    e.stopPropagation(); e.preventDefault();
    var pop = pinFull.wrap.querySelector('.pv-pop');
    if (pop && !pop.hidden) pinFull.view.closePop(); else specPinsClose();
  }, true);
  // Pincheck's part window (../pincheck/assets/editor.js, PK.editor; Chris, 2026-11-20: one part maker for both
  // tools): New part… for a part number the library lacks, Edit part… for one it has. A save goes into the shared
  // library in this browser (IndexedDB `pincheck`, Pincheck's own) and syncs to pincheck_data on EE's sign-in, so the
  // part is in Pincheck at once and everywhere after the sync. FTEs only.
  function pinEditorOn() { return !!(window.PK && window.PK.editor && window.PK.library) && (isFte() || !!DEMO); }
  function specPartOpen(isNew) {
    var p = current(), id = specBlockSel(), a = p && M.specAnalysis(p), x = a && a.sections.filter(function (y) { return y.sec.id === id; })[0];
    if (!x || !x.part || !pinEditorOn()) return;
    var L = window.PK.library, now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    var file = isNew ? { schema: L.SCHEMA, id: L.slug(x.part), mpn: x.part, match: [], manufacturer: '', kind: 'mcu', description: '', package: '',
      datasheet: { title: '', rev: '', url: '', sha256: '' }, pins: [], domains: ['VDD'], values: [], status: 'imported',
      made: { by: settings.login ? '@' + settings.login : me(), at: now, how: 'by hand (Signoff EE)' }, updated: now } : pinLibFind(x.part);
    if (!file) return;
    window.PK.editor.open({
      file: file, isNew: isNew, tab: 'pins', who: settings.login ? '@' + settings.login : me(),
      onSave: function (f) {
        var was = (pinLib.list || []).filter(function (g) { return g.id === f.id; })[0];
        if (isNew && was && !confirm('A part file named ' + f.id + ' is in the library. Replace it?')) return;
        f.local = was ? was.local : f.local;
        L.save(f).then(function () { toast('Saved ' + f.mpn + ' to the part library'); pinLibReload(); pinLibSync(); }, function (e) { toast('Couldn’t save: ' + e.message); });
      },
      onDelete: function (f) { L.remove(f).then(function () { toast('Deleted ' + f.mpn); pinLibReload(); }, function (e) { toast(e.message); }); }
    });
  }
  function pinLibReload() { pinLib.list = null; pinLib.loading = false; pinLibLoad(); }
  // Pull parts made elsewhere and push this browser's edits (Pincheck's own sync, on EE's sign-in).
  function pinLibSync() {
    var L = window.PK && window.PK.library;
    if (!L || DEMO || pinLib.syncing || !getToken()) return;
    pinLib.syncing = true; if (selected && specBlockSel()) renderInspector();
    L.sync().then(function (r) {
      if (r && (r.pulled || r.pushed || r.conflicts)) toast('Part library: ' + [r.pulled ? r.pulled + ' read' : '', r.pushed ? r.pushed + ' saved to pincheck_data' : '', r.conflicts ? r.conflicts + ' in conflict (open Pincheck to resolve)' : ''].filter(Boolean).join(', '));
    }, function (e) { toast('Part library didn’t sync: ' + e.message); }).then(function () { pinLib.syncing = false; pinLibReload(); });
  }

  // Start a plan, or refresh its copy: the library's file, stripped to what the planner reads, onto the section.
  function specPinsStart() {
    var p = current(), id = specBlockSel(), cur = p && (p.spec || {})[id];
    if (!cur) return;
    var a = M.specAnalysis(p), x = a.sections.filter(function (y) { return y.sec.id === id; })[0], lib = x && pinLibFind(x.part);
    var copy = lib && M.specPinPart(lib);
    if (!copy) { toast('That part isn’t in the part library in this browser'); return; }
    var had = cur.pins && cur.pins.part;
    specPutAll(p, [M.specStamp(Object.assign({}, cur, { pins: Object.assign({}, cur.pins || {}, { part: copy }) }), me())]);
    toast((had ? 'Updated the plan’s copy of ' : 'Planning pins from ') + copy.mpn + '.', { label: 'Undo', run: function () { specHistStep(true); } });
  }
  // A label the part can't do, rewritten as the planner suggests ("DAC2" as "DAC1 OUT2"), in whichever block's
  // Connects line holds it.
  function specPinsFix(reqId) {
    var p = current(), r = null;
    Object.keys(pinCache).forEach(function (k) { (pinCache[k].res.reqs || []).forEach(function (q) { if (!r && q.id === reqId) r = q; }); });
    if (!p || !r || !r.fix) return;
    var c = r.users[0].conn, from = (p.spec || {})[c.from];
    if (!from) return;
    var ctx = M.specAnalysis(p).ctx, items = M.specUsesItems(from.body, c.word), it = items.filter(function (n) { return M.specUseId(ctx, n) === c.to && (n.label || '') === c.label; })[0];
    if (!it) { toast('That connection changed; try again'); renderInspector(); return; }
    it.label = c.label.replace(r.fix.from, r.fix.to);
    specPutAll(p, [M.specStamp(Object.assign({}, from, { body: M.specSetLine(from.body, c.word, M.specLinkText(items)) }), me())]);
    specPinsRefresh();
    toast('Wrote ' + r.fix.to + ' on ' + from.title + '’s line.', { label: 'Undo', run: function () { specHistStep(true); specPinsRefresh(); } });
  }

  // The block panel's Within (Chris, 2026-11-20): the section the block is in, and a list to move it to another one
  // or out under the board, as the hierarchy's drag does (M.specNest; the text follows).
  function specWithinField(T, x) {
    var cur = T.dparent(x), secs = T.items.filter(function (y) { return T.isSec(y); });
    return '<div class="field"><label for="spec-block-within">Within</label><select class="input" id="spec-block-within">' +
      '<option value=""' + (cur ? '' : ' selected') + '>The board (no section)</option>' +
      secs.map(function (y) {
        var depth = T.anc(y).length;
        return '<option value="' + esc(y.sec.id) + '"' + (cur === y.sec.id ? ' selected' : '') + '>' + '   '.repeat(depth) + esc(y.sec.title || 'Untitled') + '</option>';
      }).join('') + '</select></div>';
  }
  // The block panel's Power (EE, config.spec.power; Chris, 2026-11-19): the rails the block uses or makes.
  function specPowerField(a, x) {
    if (!M.specPowerOn()) return '';
    var rails = [];
    a.sections.forEach(function (y) { (y.power || []).forEach(function (r) { if (rails.map(function (t) { return t.toLowerCase(); }).indexOf(r.rail.toLowerCase()) < 0) rails.push(r.rail); }); });
    return '<div class="field"><span class="field-label">Power</span>' + ((x.power || []).length ? '<div class="spec-power-rows">' + x.power.map(function (r, i) {
      return '<div class="spec-power-row"><span class="spec-power-rail">' + esc(r.rail) + '</span><div class="seg spec-power-seg">' + [['source', 'Source'], ['sink', 'Sink'], ['', 'N/A']].map(function (o) {
        return '<button class="' + (r.role === o[0] ? 'on' : '') + '" data-act="spec-power-role" data-i="' + i + '" data-role="' + o[0] + '" title="' + esc(o[0] === 'source' ? 'It makes ' + r.rail : o[0] === 'sink' ? 'It uses ' + r.rail : 'Take ' + r.rail + ' off') + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
        '<label class="spec-power-tree" title="Show ' + esc(x.sec.title) + ' in the power tree for ' + esc(r.rail) + '"><input type="checkbox" data-act="spec-power-tree" data-i="' + i + '"' + (r.tree !== false ? ' checked' : '') + '> Power tree</label></div>';
    }).join('') + '</div>' : '<p class="note" style="margin:0 0 6px">No power rails. A rail it uses gets a bar over the block; one it makes, a circle.</p>') +
      '<input class="input" id="spec-power-add" list="spec-power-rails" placeholder="Add a rail it uses, e.g. 3V3 (Enter)" autocomplete="off" style="margin-top:6px">' +
      '<datalist id="spec-power-rails">' + rails.map(function (r) { return '<option value="' + esc(r) + '">'; }).join('') + '</datalist></div>';
  }
  function specPowerSet(fn) {
    var p = current(), id = specBlockSel(), cur = p && (p.spec || {})[id]; if (!cur) return;
    var items = fn(M.specPowerOf(cur.body).slice());
    specPutAll(p, [M.specStamp(Object.assign({}, cur, { body: M.specSetLine(cur.body, 'power', M.specPowerText(items)) }), me())]);
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
    if (key === 'part') f.body = M.specSetLine(cur.body, 'part', value);
    specPutAll(p, [M.specStamp(Object.assign({}, cur, f), me())]);
  }
  // Drag-to-connect: `from` gains a link to `to`, with the link its kind makes (Uses in FW; Connects in
  // EE, Supplies from a power block).
  function specConnect(from, to) {
    var p = current(), a = p && (p.spec || {})[from], b = p && (p.spec || {})[to];
    if (!a || !b || from === to) return;
    var word = M.specKindLink(M.oneOf(M.specKinds(), a.kind, ''));
    if (!M.specKinds().length && M.specLinkWord('supplies') && M.specOfferWords().indexOf(M.specLinkWord('supplies')) >= 0 && M.specUsesItems(a.body, 'supplies').length) word = M.specLinkWord('supplies');
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
    // The same connection named from the other block too (one line on the diagram, ticket 6).
    var back = M.specUsesItems(b.body, word).filter(function (n) { return M.specUseIs(n, a.title); })[0] || null;
    return it ? { s: s, from: a, to: b, word: word, items: items, it: it, back: back } : null;
  }
  function renderSpecEdgeInspector(p) {
    var el = $('#inspector'), L = specEdgeItem(p);
    if (!L) { selected = null; closeInspector(); renderPage(); return; }
    var words = M.specLinkWords(), isSupply = !!M.specLinkWord('supplies') && L.word.toLowerCase() === M.specLinkWord('supplies').toLowerCase();
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">Diagram › Line</div><button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<h2 class="spec-edge-title">' + esc(L.from.title || 'Untitled') + ' <span>' + esc(linkVerb(L.word)) + '</span> ' + esc(L.to.title || 'Untitled') + '</h2>' +
      '<div class="field"><span class="field-label">From</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(L.s.a) + '">' + esc(L.from.title || 'Untitled') + '</button></div></div>' +
      '<div class="field"><span class="field-label">To</span><div class="chips"><button class="chip" style="border:none" data-act="spec-block" data-id="' + esc(L.s.b) + '">' + esc(L.to.title || 'Untitled') + '</button></div></div>' +
      (isSupply ? '' : specSignalsHtml(L)) +
      (words.length > 1 && isSupply ? '<div class="field"><label for="spec-edge-label">Signal, bus, or rail</label><input class="input" id="spec-edge-label" value="' + esc(L.it.label || '') + '" placeholder="' + (M.specLinkWord('supplies') && L.word.toLowerCase() === M.specLinkWord('supplies').toLowerCase() ? '3V3' : 'I2C') + '"></div>' : '') +
      specEdgeShowField(L) +
      '<p class="note">It’s the <code>' + esc(L.word) + ':</code> line in ' + esc(L.from.title || 'its block') + '’s text' +
        (L.back ? ', and ' + esc(L.to.title || 'the other block') + '’s names it too, so the diagram draws one line both ways. Delete removes both.' : '.') + '</p>' +
      '<div class="spec-acts"><button class="btn" data-act="spec-goto" data-id="' + esc(L.s.a) + '">Show in document</button>' +
      (specEdgeShaped(p, L.s) ? '<button class="btn" data-act="spec-edge-reset" title="Forget its shape and where its ends meet the blocks">Reset route</button>' : '') +
      '<button class="btn btn-danger" data-act="spec-edge-delete">Delete line</button></div></div>';
    el.dataset.item = selected;
  }
  // A power connection's Show line (Chris, 2026-11-22). It can be turned off only while both blocks show the rail's
  // marker; otherwise the line is the only sign of the connection, so it stays on.
  function specEdgeShowField(L) {
    var info = specPowerInfo[L.s.a + '|' + L.s.b + '|' + L.word.toLowerCase()];
    if (!info) return '';
    var note = info.can ? (info.on ? 'Turn it off to let the rail’s markers on both blocks stand for it.' : 'Hidden: the rail’s markers on both blocks stand for it.')
      : 'Always drawn: ' + (L.to.title || 'the other block') + ' or ' + (L.from.title || 'this block') + ' doesn’t show the rail’s marker, so the line is what shows this connection.';
    return '<div class="field"><label class="spec-power-tree"><input type="checkbox" data-act="spec-edge-show"' + (info.on ? ' checked' : '') + (info.can ? '' : ' disabled') + '> Show line</label>' +
      '<p class="note" style="margin:4px 0 0">' + esc(note) + '</p></div>';
  }
  function specEdgeShow(on) {
    var p = current(), s = specEdgeSel(), rec = p && s && p.spec[s.a]; if (!rec) return;
    var sh = Object.assign({}, rec.shown || {}); sh[s.b + '|' + String(s.word || '').toLowerCase()] = !!on;
    specPutAll(p, [M.specStamp(Object.assign({}, rec, { shown: sh }), me())]);
  }
  // Whether a line was shaped or had a port moved, and Reset route, which forgets both.
  function specEdgeShaped(p, s) {
    var w = String(s.word || '').toLowerCase(), A = p.spec[s.a], B = p.spec[s.b];
    return !!((A && A.routes && A.routes[s.b + '|' + w]) || (A && A.ports && A.ports[s.b + '|' + w]) || (B && B.ports && B.ports[s.a + '|' + w]));
  }
  function specEdgeReset() {
    var p = current(), s = specEdgeSel(); if (!p || !s) return;
    var w = String(s.word || '').toLowerCase(), out = [];
    [[s.a, s.b], [s.b, s.a]].forEach(function (o, i) {
      var r = p.spec[o[0]], k = o[1] + '|' + w; if (!r) return;
      var n = Object.assign({}, r), ch = false;
      if (r.ports && r.ports[k]) { n.ports = Object.assign({}, r.ports); delete n.ports[k]; ch = true; }
      if (!i && r.routes && r.routes[k]) { n.routes = Object.assign({}, r.routes); delete n.routes[k]; ch = true; }
      if (n.ports && !Object.keys(n.ports).length) delete n.ports;
      if (n.routes && !Object.keys(n.routes).length) delete n.routes;
      if (ch) out.push(M.specStamp(n, me()));
    });
    if (out.length) specPutAll(p, out);
  }
  // A line's signals (Chris, 2026-11-21: "I2C/alert" on a line whose panel said only I2C): every interface on the
  // line, from both blocks' entries, since the diagram joins both into one line. An entry holds several, written
  // "I2C2 + ALERT" (the pin planner reads each on its own), and one direction for them all.
  function specSigSplit(label) { return String(label || '').split(/\s*\+\s*/).map(function (t) { return t.trim(); }).filter(Boolean); }
  function specSignalsHtml(L) {
    var entry = function (side, it, from, to) {
      var sigs = specSigSplit(it.label), d = it.dir === 'out' ? '' : it.dir || '';
      var dirs = [['', 'Out: ' + (from.title || 'this block') + ' → ' + (to.title || 'the other')], ['in', 'In: ' + (to.title || 'the other') + ' → ' + (from.title || 'this block')], ['both', 'Both ways ↔']];
      return '<div class="spec-sig-entry"><div class="spec-sig-head">In ' + esc(from.title || 'Untitled') + '’s text</div>' +
        sigs.map(function (t, i) {
          return '<div class="spec-sig-row"><input class="input spec-sig-name" data-side="' + side + '" data-i="' + i + '" value="' + esc(t) + '" aria-label="Signal">' +
            '<button class="icon-btn" data-act="spec-sig-del" data-side="' + side + '" data-i="' + i + '" title="Remove ' + esc(t) + '" aria-label="Remove">' + ICON.close + '</button></div>';
        }).join('') +
        (sigs.length ? '' : '<p class="note" style="margin:2px 0 6px">No signal named.</p>') +
        '<input class="input spec-sig-add" data-side="' + side + '" placeholder="Add a signal, e.g. ' + (sigs.length ? 'ALERT' : 'I2C') + ' (Enter)">' +
        '<select class="input spec-sig-dir" data-side="' + side + '" aria-label="Direction">' + dirs.map(function (o) { return '<option value="' + o[0] + '"' + (d === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>';
    };
    return '<div class="field"><span class="field-label">Signals</span>' + entry('a', L.it, L.from, L.to) + (L.back ? entry('b', L.back, L.to, L.from) : '') +
      '<p class="note" style="margin-top:4px">' + (L.back ? 'Both blocks name this connection, so the line carries both entries. ' : '') + 'Signals in one entry share its direction.</p></div>';
  }
  // Change one block's entry for this line ('a', the From block's; 'b', the To block's), written back into its text.
  function specSigEdit(side, fn) {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    var sec = side === 'b' ? L.to : L.from, other = side === 'b' ? L.from : L.to;
    var items = M.specUsesItems(sec.body, L.word), it = items.filter(function (n) { return M.specUseIs(n, other.title); })[0];
    if (!it) return;
    var sigs = specSigSplit(it.label), next = fn(sigs.slice(), it);
    if (next) it.label = next.map(function (t) { return String(t).replace(/[(),+]/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean).join(' + ');
    specPutAll(p, [M.specStamp(Object.assign({}, sec, { body: M.specSetLine(sec.body, L.word, M.specLinkText(items)) }), me())]);
  }
  function specEdgeLabel(value) {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    var v = String(value || '').replace(/[(),]/g, ' ').replace(/\s+/g, ' ').trim();
    if (v === (L.it.label || '')) return;
    L.it.label = v;
    specPutAll(p, [M.specStamp(Object.assign({}, L.from, { body: M.specSetLine(L.from.body, L.word, M.specLinkText(L.items)) }), me())]);
  }
  // A line's direction (ticket 8): written into its item's brackets, "(UART, in)".
  function specEdgeDir(value) {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    var v = value === 'in' || value === 'both' ? value : '';
    if (v === (L.it.dir === 'out' ? '' : L.it.dir || '')) return;
    L.it.dir = v;
    specPutAll(p, [M.specStamp(Object.assign({}, L.from, { body: M.specSetLine(L.from.body, L.word, M.specLinkText(L.items)) }), me())]);
  }
  function specEdgeDelete() {
    var p = current(), L = specEdgeItem(p); if (!L) return;
    selected = null; closeInspector();
    if (!L.back) { specUnlinkName(L.s.a, L.word, L.it.name); return; }
    // Named from both blocks: both entries go, with one Undo.
    var recs = [[L.from, L.to.title], [L.to, L.from.title]].map(function (o) {
      var sec = o[0], t = String(o[1] || '').toLowerCase();
      return { before: sec.body, rec: M.specStamp(Object.assign({}, sec, { body: M.specSetLine(sec.body, L.word, M.specLinkText(M.specUsesItems(sec.body, L.word).filter(function (n) { return !M.specUseIs(n, t); }))) }), me()) };
    });
    specPutAll(p, recs.map(function (r) { return r.rec; }));
    toast('Removed: ' + (L.from.title || 'It') + ' ' + linkVerb(L.word) + ' ' + (L.to.title || 'it') + ', both ways', { label: 'Undo', run: function () {
      var q = current(), back = [];
      for (var i = 0; i < recs.length; i++) {
        var cur = q && (q.spec || {})[recs[i].rec.id];
        if (!cur || cur.updatedAt !== recs[i].rec.updatedAt) { toast('It has changed since; add the link again'); return; }
        back.push(M.specStamp(Object.assign({}, cur, { body: recs[i].before }), me()));
      }
      specPutAll(q, back);
    } });
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
      '<div class="field"><label for="spec-new-parent">' + esc(M.specOfferWords().length > 1 ? 'Connected from, or supplied by' : linkFrom(M.specOfferWords()[0])) + '</label><select class="input" id="spec-new-parent"><option value="">Nothing yet</option>' + secs.map(function (s) {
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
      '<input class="input" id="spec-link-search" placeholder="Search existing requirements to link additional" value="' + esc(query) + '" autocomplete="off">' +
      '<div id="spec-link-results">' + specLinkResults(p, u, query) + '</div></div>' +
      (secLinks.length ? '<div class="field"><span class="field-label">Points at</span><div class="chips">' + secLinks.map(function (id) { return '<button class="chip" data-act="spec-goto" data-id="' + esc(id) + '">' + esc(a.ctx.secs[id].title) + '</button>'; }).join('') + '</div></div>' : '') +
      (u.state === 'note' ? '<p class="note">A review note: a question for the review, counted on its own and not a gap. Answer it in the text, then resolve it.</p>' : '') +
      '<div class="spec-acts">' +
      // A linked sentence offers Edit for its requirements, not Make requirement (Chris, 2026-11-13: after
      // New requirement the panel's Make requirement looked like the next step and made a duplicate).
      // Linking a second requirement goes through the search above.
      (u.note ? '<button class="btn btn-primary" data-act="spec-resolve" data-sec="' + esc(f.x.sec.id) + '" data-u="' + u.start + '" title="Take the note out of the text">Resolve</button>' :
      u.reqs.length ? u.reqs.slice(-3).reverse().map(function (id, i) {
        return '<button class="btn' + (i ? '' : ' btn-primary') + '" data-act="open-req" data-id="' + esc(id) + '" title="Open it in the Requirements tab">Edit ' + esc(a.ctx.reqs[id].ref || 'requirement') + '</button>';
      }).join('') :
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
    ui.view = 'spec'; ui.specView = specTextView(); if ((ui.specDepth || 3) < 3) ui.specDepth = 3; saveUi();
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
    if (view === 'doc' || view === 'map' || view === 'side') ui.specView = view;
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
      // Unfold (or fold) the Requirements inbox, for the steps about its lists.
      inbox: function (open) { ui.specInbox = open !== false; saveUi(); renderPage(); },
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

  // From the Requirements to make list: show the sentence in the document, highlighted, without
  // opening its panel (Chris: the text is where to write it up).
  function specJumpUnit(sec, start) {
    ui.view = 'spec'; ui.specView = specTextView(); if ((ui.specDepth || 3) < 3) ui.specDepth = 3; saveUi();
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
    if (ui.view !== 'spec' || ui.specView === 'map') { ui.view = 'spec'; ui.specView = specTextView(); saveUi(); renderPage(); }
    var el = document.getElementById('spec-' + id);
    if (!el && specUnfilter()) el = document.getElementById('spec-' + id);
    if (el) { specScrollTo(el, 'start'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  function specStartEdit(id) {
    var p = current(); if (!p) return;
    var a = M.specAnalysis(p), x = a.sections.filter(function (y) { return y.sec.id === id; })[0];
    if (!x) return;
    ui.view = 'spec'; ui.specView = specTextView(); saveUi();
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
    renderPage(); renderToolbar();
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
    renderPage();
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
      ui.view = 'spec'; saveUi(); renderPage();
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
      ui.view = 'spec'; saveUi(); renderPage();
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
    renderPage(); renderInspector(); renderToolbar();
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
    touch(p); renderPage(); renderToolbar();
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
    touch(p); renderPage(); renderToolbar();
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
      // How its firmware loads, where the tool keeps releases (config.releases, Signoff FW): meta.load, copied into
      // each new release.
      (C.releases ? (function () {
        var l = M.cleanLoad(m.load, '');
        return '<div class="row2"><div class="field"><span class="field-label">Its firmware loads over</span><div class="seg" id="f-via" role="group" aria-label="How it loads">' +
          [['usb', 'Its own USB'], ['passthrough', 'A passthrough']].map(function (k) { return '<button type="button" data-via="' + k[0] + '" aria-pressed="' + (l.via === k[0]) + '"' + (l.via === k[0] ? ' class="on"' : '') + '>' + k[1] + '</button>'; }).join('') + '</div></div>' +
          '<div class="field"><label for="f-lboard">Board</label><input class="input" id="f-lboard" maxlength="48" value="' + esc(l.board) + '" placeholder="Flasher’s board id, or the bootloader’s"></div></div>';
      })() : '') +
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
      var vb = e.target.closest('#f-via button');
      if (vb) { Array.prototype.forEach.call(w.querySelectorAll('#f-via button'), function (x) { x.classList.toggle('on', x === vb); x.setAttribute('aria-pressed', String(x === vb)); }); return; }
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
      if (C.releases) {
        var von = w.querySelector('#f-via button.on'), lb = w.querySelector('#f-lboard').value.trim();
        fields.load = M.cleanLoad({ via: von ? von.dataset.via : 'usb', board: lb, base: m.load && m.load.base }, '');
        if (lb && !fields.load.board) { toast(fields.load.via === 'passthrough' ? 'The bootloader’s board id is up to 16 lowercase letters, digits, and dashes' : 'A board id is lowercase letters, digits, dashes, and underscores'); return; }
      }
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
      if (fields.load) doc.meta.load = fields.load;
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
  // signoff-local-<ns>: the reviews' local store (assets/localstore.js); keep this list in step with the hub's
  // sidefoot.js and Signoff PL's.
  var SUITE_DBS = ['fabcheck', 'dovetail-handoff', 'dovetail-handoff-demo', 'signoff-pl-pictures', 'signoff-pl-uploads', 'pincheck-runs', 'signoff-local-signoff.v1.', 'signoff-local-signoff-me.v1.', 'signoff-local-signoff-fw.v1.', 'jig-local', 'jig-local-demo'];
  function signOut() {
    var unsynced = 0;
    SUITE_NS.forEach(function (ns) {
      try { unsynced += Object.keys(JSON.parse(localStorage.getItem(ns + 'dirty') || '{}') || {}).length; } catch (e) { /* unreadable: nothing counted */ }
    });
    try { unsynced += Object.keys((JSON.parse(localStorage.getItem('signoff.v1.held') || '{}') || {}).projects || {}).length; } catch (e) { /* ignore */ }
    // This tool's own change markers are in its local store now (assets/localstore.js), held here in memory.
    if (LOCAL && LOCAL.backend === 'idb') unsynced += Object.keys(dirty).length;
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
      ready = false;   // nothing is saved again before the reload
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
  // Scribe edits never call it (Chris, 2026-11-13): they wait for Sync, counted on its badge and the pill.
  function syncSoon() {
    if (DEMO || !getToken() || !settings.owner || !settings.dataRepo || !settings.user) return;
    if (!ready) return;
    if (syncing) { syncAgain = true; return; }
    sync();
  }
  function sync() {
    if (DEMO) { toast('Demo mode keeps everything in this browser'); return; }
    if (!ready) return;
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
    var bases0 = Object.assign({}, bases);
    workspace().sync(st0, { message: message, onRetry: function () { toast('Someone else just synced — merging their changes'); },
      keepLocal: function (id) { return !!dirty[id]; }, mergeOpts: function (id) { return mergeOpts(id, bases0); }, edited: syncEdited, plCache: load('plCache', null) })
      .then(function (res) {
        var st = res.state;
        if (res.userName && !settings.user) settings.user = res.userName;
        settings.login = st.login; save('settings', settings);
        // Edits made while the sync ran are merged on top, and stay unsynced.
        var nowById = stateNow().projects, merged = {};
        // Only sections stamped since the sync started are edits here; the rest went into the sync.
        Object.keys(st.projects).forEach(function (id) { merged[id] = nowById[id] ? M.mergeProjects(nowById[id], st.projects[id], { since: startedAt }) : st.projects[id]; });
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
        // What each project synced as is the base of its next merge (from its repo only if that one synced).
        var nextBases = Object.assign({}, bases);
        Object.keys(st.projects).forEach(function (id) { if (failedRepos.indexOf(st.homes[id] || (settings.owner + '/' + settings.dataRepo)) < 0) nextBases[id] = M.specBase(st.projects[id]); });
        Object.keys(nextBases).forEach(function (id) { if (!st.projects[id]) delete nextBases[id]; });
        bases = nextBases;
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
        // The reviews, their change markers, and the record of what this browser synced (cache2, bases) are
        // saved in one transaction (2026-11-19: a full browser storage kept the old reviews while the record
        // said the new ones were here, so a later sync wrote an old copy over a newer file).
        save('roster', roster);
        storeSave({ projects: projects, dirty: dirty, homes: homes, cache2: cache, bases: bases });
        save('lastSync', lastSync); save('dataAccess', dataAccess); save('invitations', invitations);
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
    rwPrint = null;
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

  // Another tab of this tool, or Fabcheck's or Pincheck's "Send to Signoff", wrote our projects, dirty list
  // or ui. Merge it in rather than let our next persist() overwrite it. We write back only when the merge
  // changed something, so two open tabs settle instead of echoing. With IndexedDB (assets/localstore.js),
  // other tabs say what they saved over a BroadcastChannel (onLocalChange), and a projects or dirty key in
  // localStorage is an older writer's (a tab or tool not updated yet): absorbLegacy takes it in.
  function mergeIn(theirs) {
    var fresh = dropStaleDemo(theirs);
    // Every edit here is saved as it's made, so the other tab wrote on top of ours: our copy counts
    // as synced unless we edited it in the last few seconds (it may have read before that save).
    var res = M.mergeLocalCopies(projects, fresh, { since: function (id) { return Date.now() - (touchedAt[id] || 0) < 10000 ? '' : '￿'; } });
    // The other tab wrote stale demo copies over ours: write ours back.
    if (!res.changed && Object.keys(fresh).length !== Object.keys(theirs).length) { storeSave({ projects: projects }); return false; }
    if (!res.changed) return false;
    projects = res.projects;
    return true;
  }
  function mergeDirty(theirs) {
    var added = Object.keys(theirs || {}).filter(function (k) { return !dirty[k] || theirs[k] > dirty[k]; });
    added.forEach(function (k) { dirty[k] = theirs[k]; });
    return added.length > 0;
  }
  function onLocalChange(m) {
    if (!ready) return;
    if (m.slugs && m.slugs.length) LOCAL.read(m.slugs).then(function (fresh) { if (mergeIn(fresh)) { storeSave({ projects: projects }); render(); } });
    (m.keys || []).forEach(function (k) {
      LOCAL.get(k).then(function (v) {
        if (k === 'dirty') { if (mergeDirty(v)) { renderSidebar(); renderSyncState(); renderToolbar(); } }
        else if (k === 'homes') Object.keys(v).forEach(function (id) { homes[id] = v[id]; });
        else if (k === 'bases') bases = v;   // another tab synced: its record is the newer one
      });
    });
  }
  // What an older writer left in localStorage, merged in and saved here; the keys go once it's read back.
  function absorbLegacy() {
    var leg = LOCAL && LOCAL.legacy(); if (!leg) return Promise.resolve(false);
    if (leg.projects) mergeIn(leg.projects);
    if (leg.dirty) mergeDirty(leg.dirty);
    if (leg.homes) Object.keys(leg.homes).forEach(function (id) { if (!homes[id]) homes[id] = leg.homes[id]; });
    // The sync record comes over only with the reviews it describes, the first time (nothing here yet).
    var first = !Object.keys(cache).length;
    if (first && leg.cache2) cache = leg.cache2;
    if (first && leg.bases) bases = leg.bases;
    return storeSave({ projects: projects, dirty: dirty, homes: homes, cache2: cache, bases: bases }).then(function (ok) {
      return ok ? LOCAL.clearLegacy(leg, projects) : false;
    });
  }
  function onExternalWrite(e) {
    if (!e.key || e.key.indexOf(NS) !== 0) return;
    var key = e.key.slice(NS.length), theirs;
    if (LOCAL && LOCAL.backend === 'idb' && (key === 'projects' || key === 'dirty')) { if (ready && e.newValue) absorbLegacy().then(function () { render(); }); return; }
    try { theirs = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) { return; }
    if (!theirs || typeof theirs !== 'object') return;
    if (key === 'projects') {
      if (!ready) return;
      if (mergeIn(theirs)) { storeSave({ projects: projects }); render(); }
    } else if (key === 'roster') {
      // Another tab, or this tool's People tab framed in the hub or PL, edited People.
      var merged = M.mergeRosters(roster, theirs);
      if (JSON.stringify(merged) === JSON.stringify(roster)) return;
      roster = merged;
      if (JSON.stringify(merged) !== JSON.stringify(theirs)) save('roster', roster);
      renderSidebar(); if (peopleShown()) renderPage();
    } else if (key === 'dirty') {
      if (!ready || !mergeDirty(theirs)) return;
      storeSave({ dirty: dirty });
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
    if (!el) {
      // Empty space in a Scribe EE diagram lets go of what was picked and shows the diagram's own panel.
      if (M.specPowerOn() && e.target.closest && e.target.closest('svg.spec-flow') && !e.target.closest('.spec-handle') && !specDragJustEnded) { specPtPick = {}; specPtPickShow(); specOpenDiagram(); return; }
      if (blankClick(e) || specBlankClick(e)) closePanel();
      return;
    }
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
      case 'revnote-add': addRevNote(); break;
      case 'req-add': addReq(); break;
      case 'spec-view':
        // A block's panel belongs to the diagram and a sentence's to the document: switching closes them
        // (on a narrow screen the panel is a sheet over the depth buttons, which took the first click).
        if (ui.specView !== el.dataset.view && /^spec(block|edge)?\|/.test(selected || '')) { selected = null; closeInspector(); }
        ui.specView = el.dataset.view; specEditing = null; saveUi(); renderPage(); break;
      case 'open-diagram': {
        ui.view = 'spec'; ui.specView = 'map'; specEditing = null; selected = null; closeInspector(); saveUi(); renderPage();
        var mc = document.querySelector('.spec-map-card');
        if (mc) { var mn = $('#main'); mn.scrollTop = Math.max(0, mn.scrollTop + mc.getBoundingClientRect().top - mn.getBoundingClientRect().top - 72); }
        break;
      }
      case 'spec-depth': ui.specDepth = parseInt(el.dataset.depth, 10) === 2 ? 2 : 3; ui.specShow = ''; saveUi(); renderPage(); break;
      case 'spec-show': ui.specShow = el.dataset.show || ''; saveUi(); renderPage(); break;
      case 'spec-inbox': ui.specInbox = !ui.specInbox; saveUi(); renderPage(); break;
      case 'spec-outline-toggle': {
        // Whatever the outline shows now (folded by hand, or by the window's width), the other is kept.
        var olw = el.closest('.spec-wrap'), olItem = olw && olw.querySelector('.spec-outline [data-act="spec-goto"]');
        var olShut = olItem ? getComputedStyle(olItem).display === 'none' : !!(olw && olw.classList.contains('ol-closed')), olNext = olShut ? 'open' : 'closed';
        if (el.closest('.spec-side')) ui.specOutlineSide = olNext; else ui.specOutline = olNext;
        saveUi();
        if (olw) { olw.classList.remove('ol-auto', 'ol-open', 'ol-closed'); olw.classList.add('ol-' + olNext); }
        break;
      }
      case 'spec-resolve': specResolve(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-goto': specGoto(id); break;
      case 'spec-jump': specJumpUnit(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-unit': case 'spec-open':
        if (window.getSelection && String(window.getSelection()) && act === 'spec-unit') break;   // selecting text to copy
        specOpenUnit(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-edit': specStartEdit(id); break;
      case 'spec-edit-all': {
        var ea = current(); if (!ea) break;
        ui.view = 'spec'; ui.specView = specTextView(); saveUi();
        specEditing = 'all'; specDraft = M.specToText(ea); closeInspector(); selected = null; renderPage(); specFocusEditor(); break;
      }
      case 'spec-add':
        ui.view = 'spec'; ui.specView = specTextView(); saveUi(); specNewAfter = '';
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
          .concat(specDrawioOn() ? [['drawio', 'Import from draw.io…']] : [])
          .concat(has ? ['-', ['md', 'Export as Markdown (.md)'], ['print', 'Print or save as PDF']] : [])).then(function (ch) {
          if (ch === 'guide') { closeSheet(); window.SignoffSpecGuide.start(); }
          else if (ch === 'writing') specGuideSheet();
          else if (ch === 'paste') specPasteSheet();
          else if (ch === 'drawio') specDrawioImport();
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
      case 'spec-fmt': specFmt(el.dataset.f, el); break;
      case 'spec-block': if (!specDragJustEnded) specOpenBlock(id); break;
      case 'spec-edge': if (!specDragJustEnded) specOpenEdge(el.dataset.a, el.dataset.b, el.dataset.word); break;
      case 'spec-edge-show': specEdgeShow(el.checked); break;
      case 'spec-rail-pick': specRailSel = specRailSel === el.dataset.rail ? '' : el.dataset.rail; renderInspector(); break;
      case 'spec-rail-delete': specRailDeleteAct(el.dataset.rail); break;
      case 'spec-pt-edge': if (!specDragJustEnded) specOpenPt(el.dataset.a, el.dataset.b, el.dataset.rail); break;
      case 'spec-pt-reset': specPtReset(); break;
      case 'spec-edge-delete': specEdgeDelete(); break;
      case 'spec-sig-del': { var sdi = +el.dataset.i; specSigEdit(el.dataset.side, function (sg) { sg.splice(sdi, 1); return sg; }); break; }
      case 'spec-edge-reset': specEdgeReset(); break;
      case 'spec-boxes': ui.specBoxes = !!el.checked; saveUi(); renderPage(); break;
      case 'spec-power-tree': { var ti = +el.dataset.i, ton = !!el.checked; specPowerSet(function (it) { if (it[ti]) it[ti] = Object.assign({}, it[ti], { tree: ton }); return it; }); break; }
      case 'spec-auto-layout': specAutoLayout(el.dataset.view); break;
      case 'spec-expand': specSetExpanded(specExpanded ? false : (el.dataset.card || 'map')); break;
      case 'spec-fit': specZoom = null; renderPage(); break;
      case 'spec-export': specExport(el); break;
      case 'spec-new-section': specNewSectionSheet(); break;
      case 'spec-tree-all': {
        var tp = current(); if (!tp) break;
        var tT = specFlowTree(M.specAnalysis(tp)), tc = {};
        if (el.dataset.mode === 'close') tT.items.forEach(function (y) { if (tT.isSec(y)) tc[y.sec.id] = true; });
        ui.specClosed = tc; saveUi(); renderPage(); break;
      }
      case 'spec-tree-fold': { var fc = Object.assign({}, ui.specClosed || {}); if (fc[id]) delete fc[id]; else fc[id] = true; ui.specClosed = fc; saveUi(); renderPage(); break; }
      case 'spec-ungroup': {
        var gp = current(); if (!gp) break;
        if (confirm('Ungroup ' + T_title(gp, id) + '? Its blocks stay, one level up in the outline.')) { selected = null; closeInspector(); specPutAll(gp, M.specUngroup(gp, id, me())); }
        break;
      }
      case 'spec-block-label': specLinkLabel(el.dataset.word, el.dataset.name); break;
      case 'spec-pins-start': specPinsStart(); break;
      case 'spec-pins-fix': specPinsFix(el.dataset.req); break;
      case 'spec-pins-map': specPinsOpen(); break;
      case 'spec-pins-fold': { var fsec = specBlockSel(), fo = pinOpen[fsec] = pinOpen[fsec] || {}; if (fo[id]) delete fo[id]; else fo[id] = true; renderInspector(); break; }
      case 'spec-part-new': specPartOpen(true); break;
      case 'spec-part-edit': specPartOpen(false); break;
      case 'spec-part-sync': pinLibSync(); break;
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
      case 'spec-copy-resolve': specResolveSheet(id); break;
      case 'spec-copy-delete': {
        var cp = current(), cc = cp && (cp.spec || {})[id];
        if (cc && confirm('Delete this conflict copy? Its text is gone once you do.')) specPutAll(cp, [M.specStamp(Object.assign({}, cc, { deleted: true }), me())]);
        break;
      }
      case 'spec-add-block': specAddBlockSheet(el.dataset.kind, el.dataset.parent || (SPEC_FLOW ? '' : specBlockSel()), el.dataset.section || ''); break;
      case 'spec-block-kind': specBlockField('kind', el.dataset.kind); break;
      case 'spec-block-unuse': specUnlinkName(specBlockSel(), el.dataset.word, el.dataset.name); break;
      case 'spec-block-unfrom': specUnlinkName(el.dataset.from, el.dataset.word, el.dataset.name); break;
      case 'spec-power-role': { var pi = +el.dataset.i, prole = el.dataset.role; specPowerSet(function (it) { if (!it[pi]) return it; if (prole) it[pi].role = prole; else it.splice(pi, 1); return it; }); break; }
      case 'spec-editor-line': specEditorLine(parseInt(el.dataset.line, 10) || 1); break;
      case 'spec-block-delete': {
        var dp = current(), dc = dp && (dp.spec || {})[id];
        if (dc && confirm('Delete ' + (dc.title || 'this block') + ' and its text?')) { selected = null; closeInspector(); specPutAll(dp, [M.specStamp(Object.assign({}, dc, { deleted: true }), me())]); }
        break;
      }
      case 'spec-cancel': specEditing = null; specDraft = ''; renderPage(); break;
      case 'spec-delete':
        if (confirm('Delete this section?')) { var sp = current(); specPut(sp, id, { deleted: true }); specEditing = null; specDraft = ''; renderPage(); }
        break;
      case 'spec-paste': specPasteSheet(); break;
      case 'spec-template': specTemplateSheet(); break;
      case 'spec-make': specMakeReq(el.dataset.sec, parseInt(el.dataset.u, 10)); break;
      case 'spec-change': specChangeReq(el.dataset.sec, parseInt(el.dataset.u, 10), id); break;
      case 'spec-untag': { var up = current(); if (specUnitEdit(up, el.dataset.sec, parseInt(el.dataset.u, 10), 'tag', false)) { renderPage(); renderInspector(); renderToolbar(); } break; }
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
        if (specUnitEdit(sp2, ss.sec, ss.start, op, arg)) { renderPage(); renderInspector(); renderToolbar(); }
        break;
      }
      case 'req-import': importReqsSheet(); break;
      case 'req-export': { var rp = current(); download(rp.slug + '-requirements.csv', M.reqsCsv(rp, checkIdx(rp)), 'text/csv'); break; }
      case 'req-filter': ui.reqFilter = el.dataset.filter; saveUi(); renderPage(); break;
      case 'select-req': openReq(id); break;
      case 'rw-view': ui.reworkView = el.dataset.val === 'rework' ? 'rework' : 'checklist'; selected = null; closeInspector(); saveUi(); renderPage(); $('#main').scrollTop = 0; break;
      case 'rw-add': addRework(); break;
      case 'rw-print': if (reworkOf(current(), selected)) openReworkPrint([selected], true); break;
      case 'rw-print-list': { var wl = current(); if (wl) openReworkPrint(M.liveRework(wl).filter(function (w) { return rwMatches(wl, w); }).map(function (w) { return w.id; })); break; }
      case 'rw-select': case 'open-rework': openRework(id); break;
      case 'rw-filter': ui.rwFilter = el.dataset.filter; saveUi(); renderPage(); break;
      case 'rw-status': setRework(selected, { status: M.oneOf(M.REWORK_STATUS, el.dataset.val, 'planned') }); break;
      case 'rw-next': setRework(selected, { next: !!el.checked }); break;
      case 'rw-pic-open': openReworkPic(id); break;
      case 'rw-pic-del': {
        var wp = current(), wr = wp && wp.rework && wp.rework[selected], wstep = el.dataset.step || '';
        if (!wr || !confirm('Remove this picture from the ' + (wstep ? 'step' : 'rework') + '? It stays in the ' + UNIT + '\u2019s repository history.')) break;
        if (wstep) rwStepEdit(function (steps) { var s = steps.filter(function (x) { return x && x.id === wstep; })[0]; if (!s || !Array.isArray(s.pics)) return false; s.pics = s.pics.filter(function (x) { return !x || x.id !== id; }); });
        else if (Array.isArray(wr.pics)) setRework(selected, { pics: wr.pics.filter(function (x) { return !x || x.id !== id; }) });
        break;
      }
      case 'rw-step-add': {
        var nid = rwRandomId();
        rwStepEdit(function (steps) { steps.push({ id: nid, text: '', pics: [] }); });
        setTimeout(function () { var t = document.querySelector('[data-rw-step="' + nid + '"]'); if (t) { t.focus(); t.scrollIntoView({ block: 'nearest' }); } }, 40);
        break;
      }
      case 'rw-step-move': {
        var mv = el.dataset.step, dir = +el.dataset.dir;
        rwStepEdit(function (steps) { var i = steps.map(function (x) { return x && x.id; }).indexOf(mv), j = i + dir; if (i < 0 || j < 0 || j >= steps.length) return false; var t = steps[i]; steps[i] = steps[j]; steps[j] = t; });
        break;
      }
      case 'rw-step-del': {
        var ds = el.dataset.step, dr = reworkOf(current(), selected), dstep = dr && dr.steps.filter(function (x) { return x.id === ds; })[0];
        if (!dstep || ((dstep.text || dstep.pics.length) && !confirm('Delete this step' + (dstep.pics.length ? ' and its ' + plural(dstep.pics.length, 'picture') : '') + '?'))) break;
        rwStepEdit(function (steps) { for (var k = steps.length - 1; k >= 0; k--) if (steps[k] && steps[k].id === ds) steps.splice(k, 1); });
        break;
      }
      case 'rw-print-mode': save('rwPrintMode', el.dataset.val === 'tech' ? 'tech' : 'detailed'); drawReworkPrint(); break;
      case 'rw-delete': {
        var wd = reworkOf(current(), selected);
        if (wd && confirm('Delete ' + (wd.ref || 'this rework') + '? Its discussion is kept in the ' + UNIT + ' history.')) { setRework(selected, { deleted: true }); selected = null; closeInspector(); renderPage(); syncSoon(); }
        break;
      }
      case 'close-sheet': closeSheet(); break;
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
      case 'model-attach': { var mp = current(); if (mp && MODELS && S.model3d) modelSheet(mp); break; }
      case 'model-remove': { var mr = current(); if (mr && MODELS) removeModel(mr); break; }
      case 'model-step': { var ms = current(); if (ms && MODELS) downloadModelStep(ms); break; }
      case 'open-fabcheck': openFabcheck(el); break;
      case 'open-pincheck': openPincheck(el); break;
      case 'runs-reload': { var rp = current(); if (rp) { loadRuns(rp, true); renderPage(); } break; }
      case 'rel-new': { var np = current(); if (np && isFte()) releaseSheet(np); break; }
      case 'rel-toggle': case 'rel-download': case 'rel-release': case 'rel-withdraw': case 'rel-delete': case 'rel-notes': releaseAct(act, el.dataset.id); break;
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
      case 'close-report': $('#report').hidden = true; rwPrint = null; break;
      case 'print': window.print(); break;
      case 'export-csv': exportCsv(); break;
      case 'nav': toggleSidebar(); break;
      case 'project-menu':
        menu(el, !current() ? ticketEntries() : (isFte() ? [['edit', cap(UNIT) + ' details\u2026']] : []).concat([['history', 'History…'], '-', ['report', 'Review report'], ['csv', 'Export findings (CSV)'], ['json', 'Export ' + UNIT + ' (JSON)']],
          isFte() ? ['-', ['import', (C.legacyTabs || []).length ? 'Import ' + UNIT + ' or old checklist\u2026' : 'Import ' + UNIT + '\u2026'], '-', ['archive', current().meta.archived ? 'Unarchive ' + UNIT : 'Archive ' + UNIT, true]] : [],
          ticketsOn() ? ['-'].concat(ticketEntries()) : []))
          .then(function (choice) {
            if (choice === 'ticket') { window.SignoffTickets.newTicket(); return; }
            if (choice === 'tickets') { window.SignoffTickets.open(); return; }
            if (choice === 'history') historySheet(current());
            else if (choice === 'edit') projectSheet(current());
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement.id === 'revnote-input') { e.preventDefault(); addRevNote(); return; }
    if (document.activeElement.id === 'spec-editor') {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); specSaveEdit(); return; }
      if (e.key === 'Escape' && !$('#sheet')) { e.preventDefault(); specEditing = null; specDraft = ''; renderPage(); return; }
    }
    if (e.key === 'Escape') {
      if ($('#menu')) { closeMenu(); return; }
      if ($('#sheet')) { closeSheet(); applyTheme(settings.theme); return; }
      if (!$('#report').hidden) { $('#report').hidden = true; rwPrint = null; return; }
      if (inField) { document.activeElement.blur(); return; }
      if (specPtPickIds().length) { specPtPick = {}; specPtPickShow(); return; }
      if ($('#inspector').classList.contains('open')) { closePanel(); return; }
      if (specExpanded) { specSetExpanded(false); return; }
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
    if (e.target.id === 'revnote-input') { revDraft = e.target.value; revDraftId = (current() || {}).id || ''; }
    if (e.target.id === 'item-search') {
      ui.query = e.target.value;
      var pos = e.target.selectionStart;
      renderPage();
      var s = $('#item-search'); s.focus(); s.setSelectionRange(pos, pos);
    }
    if (e.target.id === 'rw-search') {
      ui.rwQuery = e.target.value;
      var wpos = e.target.selectionStart;
      renderPage();
      var ws2 = $('#rw-search'); ws2.focus(); ws2.setSelectionRange(wpos, wpos);
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
    var wk = e.target.dataset && e.target.dataset.rwInput;
    if (wk && selected) {
      var wcur = reworkOf(current(), selected), wv = e.target.value.trim();
      if (wcur && wcur[wk] !== wv) { var wf = {}; wf[wk] = wv; setRework(selected, wf); }
    }
    if (e.target.classList && e.target.classList.contains('rw-pic-input') && e.target.files.length) { addReworkPics(e.target.files, e.target.dataset.step || ''); e.target.value = ''; }
    var wsid = e.target.dataset && e.target.dataset.rwStep;
    // A step's text is saved without redrawing the pane, so a click that ended the edit (+ Add step, a picture) still lands.
    if (wsid && selected) {
      var wsp = current(), wraw = wsp && wsp.rework && wsp.rework[selected], wsteps = rwStepsRaw(selected), wss = wsteps.filter(function (x) { return x && x.id === wsid; })[0], wsv = e.target.value.trim();
      if (wraw && wss && wss.text !== wsv && !HIST.compare.isCopy(wsp)) { wss.text = wsv; wsp.rework[selected] = M.stamp(Object.assign({}, wraw, { steps: wsteps }), me()); touch(wsp); renderPage(); }
      else if (HIST.compare.isCopy(wsp)) touch(wsp);
    }
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
    if (e.target.classList && e.target.classList.contains('spec-block-from') && e.target.value) {
      var fp = current(), fsrc = fp && (fp.spec || {})[e.target.value], fme = fp && (fp.spec || {})[specBlockSel()], fw = e.target.dataset.word;
      if (fsrc && fme) {
        specPutAll(fp, [M.specStamp(Object.assign({}, fsrc, { body: M.specSetLine(fsrc.body, fw, M.specLinkText(M.specUsesItems(fsrc.body, fw).concat([{ name: fme.title, label: '' }]))) }), me())]);
        toast('Added ' + fme.title + ' to ' + fsrc.title + '’s ' + fw + ' line. Name the ' + (/suppl/i.test(fw) ? 'rail' : 'signal') + ' in ' + fsrc.title + '’s panel.');
      }
    }
    if (e.target.id === 'spec-block-within') {
      var wp = current(), wid = specBlockSel(), wT = wp && specFlowTree(M.specAnalysis(wp)), wx = wT && wT.byId[wid], wto = e.target.value || null;
      if (wx && (wT.dparent(wx) || null) !== wto) {
        var wrecs = M.specNest(wp, [wid], wto, me());
        if (wrecs.length) { specPutAll(wp, wrecs); toast(wx.sec.title + (wto ? ' is in ' + wT.byId[wto].sec.title : ' is under the board') + '. The text follows.', { label: 'Undo', run: function () { specHistStep(true); } }); }
      }
    }
    if (e.target.id === 'spec-block-parts') specBlockField('parts', e.target.value);
    if (e.target.id === 'spec-block-part') specBlockField('part', e.target.value);
    if (e.target.id === 'spec-power-add' && e.target.value.trim()) { var prail = e.target.value.trim(); specPowerSet(function (it) { return it.concat([{ rail: prail, role: 'sink' }]); }); }
    if (e.target.id === 'spec-edge-label') specEdgeLabel(e.target.value);
    if (e.target.id === 'spec-edge-dir') specEdgeDir(e.target.value);
    if (e.target.classList && e.target.classList.contains('spec-sig-name')) { var sni = +e.target.dataset.i, snv = e.target.value; specSigEdit(e.target.dataset.side, function (sg) { sg[sni] = snv; return sg; }); }
    if (e.target.classList && e.target.classList.contains('spec-sig-add') && e.target.value.trim()) { var sav = e.target.value.trim(); specSigEdit(e.target.dataset.side, function (sg) { return sg.concat([sav]); }); }
    if (e.target.classList && e.target.classList.contains('spec-sig-dir')) { var sdv = e.target.value; specSigEdit(e.target.dataset.side, function (sg, it) { it.dir = sdv === 'in' || sdv === 'both' ? sdv : ''; return null; }); }
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
    var zsvg = specExpanded && e.target.closest && e.target.closest('.spec-map-card.expanded svg.spec-map');
    if (zsvg && (e.button === 1 || e.button === 2 || (e.pointerType === 'touch' && (specZp || !e.target.closest('.spec-node, .spec-group-g, .spec-edge-hit, .spec-edge-label.drag, .spec-flag, [data-act]'))))) { specZpDown(e, zsvg); return; }
    if (e.target.closest && e.target.closest('svg.spec-flow')) { if (e.pointerType !== 'touch' || !e.target.closest('svg.spec-flow') || e.target.closest('.spec-node, .spec-group-g')) flowDown(e); return; }
    var n = e.target.closest && e.target.closest('.spec-map .spec-node');
    if (n && e.pointerType !== 'touch') specMoveDown(e, n);
  });
  document.addEventListener('pointermove', function (e) { if (specZp && specZpMove(e)) return; if (specDrag) specDragMove(e); else if (specMove) specMoveMove(e); else if (flowDrag) flowMove(e); });
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
  document.addEventListener('pointerup', function (e) { if (specZp && specZp.pts[e.pointerId]) { specZpUp(e); return; } if (specDrag) specDragEnd(); else if (specMove) specMoveUp(); else if (flowDrag) flowUp(e); });
  // A double-click on a diagram line adds a bend where it was clicked (Loom's bend), kept as its shape.
  document.addEventListener('dblclick', function (e) {
    var hitEl = e.target.closest && e.target.closest('svg.spec-flow .spec-edge-hit'), C = specRouter();
    var dv = hitEl && svgView(hitEl.ownerSVGElement), L = hitEl && C && specLine(hitEl.dataset.line, dv), rr = L && specLastOf(dv).routed[L.key], p = current();
    if (!rr || !p || !p.spec[L.srcA]) return;
    var svg = hitEl.ownerSVGElement, pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    var run = C.runAt(rr.R0, specRouteSpace(rr, pt.matrixTransform(svg.getScreenCTM().inverse()))), rec = run && C.bend(run, specSnap, L.shape && !!L.shape.tr === rr.tr ? L.shape : {});
    if (!rec) return;
    e.preventDefault();
    var src = p.spec[L.srcA], rts = Object.assign({}, specLay(src, dv).routes || {});
    rts[L.rkey] = { v: rec.v, a: rec.a, b: rec.b }; if (rec.mode) rts[L.rkey].mode = rec.mode; if (rr.tr) rts[L.rkey].tr = true;
    specPutAll(p, [M.specStamp(specWithLay(src, dv, { routes: rts }), me())]);
  });
  document.addEventListener('pointercancel', function (e) { if (specZp) specZpUp(e); if (specDrag) specDragEnd(); specMove = null; });
  document.addEventListener('mousedown', function (e) { if (e.target.closest && e.target.closest('.spec-kindbar, .spec-fmtbar') && document.activeElement && document.activeElement.id === 'spec-editor') e.preventDefault(); });
  // The page's own height, for the sticky outline and Side by side's diagram, which 100vh overshoots by the demo
  // banner or the compare bar above the page.
  (function () {
    var mn = $('#main'), set = function () { mn.style.setProperty('--main-h', mn.clientHeight + 'px'); };
    set(); if (window.ResizeObserver) new ResizeObserver(set).observe(mn); else window.addEventListener('resize', set);
  })();
  $('#main').addEventListener('scroll', function () { $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 60); }, { passive: true });

  // ── Boot ─────────────────────────────────────────────────
  function render() { var f = focusNow(); renderSidebar(); renderSyncState(); drawPage(); drawInspector(); restoreFocus(f); if (pinFull) specPinsRefresh(); }

  // Version comparison (assets/history.js): Restore this version puts back everything but the comments
  // (Chris, 2026-11-14), as new edits (model.restorePlan), and Undo in its toast puts it all back.
  function slugOfId(id) { return Object.keys(projects).filter(function (k) { return projects[k].id === id; })[0] || ''; }
  function fillProject(d) { ['items', 'sections', 'comments', 'custom', 'reqs'].forEach(function (k) { if (!d[k] || typeof d[k] !== 'object') d[k] = {}; }); return d; }
  function restoreTo(id, older, said) {
    var k = slugOfId(id), cur = projects[k];
    if (!cur) return false;
    var before = JSON.parse(JSON.stringify(cur)), plan = M.restorePlan(cur, fillProject(older), me());
    if (!plan.count) { toast('Nothing to put back: it’s already as it was.'); return true; }
    M.restoreApply(cur, plan);
    touch(cur); render(); renderToolbar(); syncSoon();
    toast(said + ' (' + plural(plan.count, 'record') + ')', said === 'Put back' ? null : { label: 'Undo', run: function () { restoreTo(id, before, 'Put back'); } });
    return true;
  }
  HIST.compare.setup({
    render: function () { render(); renderToolbar(); },
    toast: function (t) { toast(t, null, 6000); },
    fresh: function (key, d) { return fillProject(d); },
    restore: function (key, older) { return restoreTo(key, older, 'Restored'); },
    word: function () { return UNIT; },
    restoreNote: function () { return 'Checks, requirements' + (C.spec ? ', ' + SPEC_LABEL : '') + ', and the details go back to how they were, and anything added since is removed. Comments and revision tags stay as they are.'; }
  });

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
      // The demo's reviews live in IndexedDB since 2026-11-19 (localstore.js), so clearing localStorage alone kept every
      // edit (found 2026-11-21): empty its store too, in one transaction, then reload. (Deleting the database waited on
      // this page's own connection and was dropped by the reload.)
      var done = false, go = function () { if (!done) { done = true; location.reload(); } };
      try {
        if (!LOCAL || !LOCAL.open) { go(); return; }
        LOCAL.open().then(function (db) {
          if (!db) { go(); return; }
          var tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').clear();
          tx.oncomplete = tx.onerror = tx.onabort = go;
        }, go);
        setTimeout(go, 3000);
      } catch (e) { go(); }
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
    if (C.releases && releaseOf(current(), id)) { ui.view = 'releases'; relOpen[id] = true; saveUi(); renderPage(); return; }
    if (!itemDef(current(), id).retired || reworkOf(current(), id)) gotoItem(id);
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
    return !syncing && !typing && !specEditing && !(draft && draft.value.trim()) && !revDraft.trim() && !$('#sheet') && !$('#busy-wrap') && !$('#menu')
      && !document.querySelector('.tk-wrap, .tk-new, #people-pop') && !HIST.compare.active() && !(HOME && HOME.busy()) && !document.hidden;   // a Version comparison lives on the page too
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

  // ── Boot ─────────────────────────────────────────────────
  // The reviews load from the local store first (IndexedDB, or localStorage without it); what older code
  // left in localStorage is taken in; then the page draws and syncs as it always has.
  function start() {
    if (!DEMO) noticeToken();
    setupHome();
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
  }
  function boot(d) {
    projects = d.projects || {}; dirty = d.dirty || {}; homes = d.homes || {}; cache = d.cache2 || {}; bases = d.bases || {};
    ready = true;
    var changed = tidyDirty();
    if (seedDemo()) changed = true;
    if (fixDemo()) changed = true;
    var legacy = LOCAL && LOCAL.backend === 'idb' ? absorbLegacy() : Promise.resolve(false);
    if (changed) storeSave({ projects: projects, dirty: dirty });
    if (LOCAL) LOCAL.onChange(onLocalChange);
    if (LOCAL && LOCAL.backend === 'ls' && !DEMO) setTimeout(function () { toast('This browser won’t give Signoff its larger storage (IndexedDB), so reviews are kept the old way, with less room.'); }, 600);
    return legacy;
  }
  (LOCAL ? LOCAL.load() : Promise.resolve({ projects: load('projects', {}), dirty: load('dirty', {}), homes: load('homes', {}), cache2: load('cache2', {}), bases: load('bases', {}) }))
    .then(boot, function () { return boot({}); })
    .then(start, start);
  setInterval(function () { renderSyncState(syncing ? 'busy' : undefined); }, 60000);

  S.app = { sync: sync, render: render, spec: specHook() };
})(window.Signoff = window.Signoff || {});
