/* Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
   vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff app: state, storage, rendering and interaction. */
(function (S) {
  'use strict';
  var M = S.model;
  var C = S.config, W = C.words || {};

  // ── Storage ──────────────────────────────────────────────
  // Each tool keeps its data under its own namespace (assets/config.js). The token and the
  // light/dark theme are shared by the whole suite, so they live under fixed keys.
  var DEMO = /[?&]demo\b/.test(location.search) || location.hash === '#demo';
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
  var settings = Object.assign({}, DEFAULT_SETTINGS, load('settings', {}), { suiteRepos: (C.repos.suite || []).slice() });
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
  var ui = Object.assign({ slug: '', view: 'overview', filter: 'all', query: '', showArchived: false }, load('ui', {}));

  var TEMPLATES, INDEX;
  function refreshTemplates() {
    TEMPLATES = M.resolveTemplates(window.SIGNOFF_TEMPLATES || [], pulledTemplates);
    INDEX = M.indexTemplates(TEMPLATES);
  }
  refreshTemplates();

  if (DEMO && !Object.keys(projects).length && S.demo) {
    S.demo.projects(TEMPLATES).forEach(function (p) { projects[p.slug] = p; });
    settings.user = settings.user || 'Demo Reviewer';
    save('projects', projects); save('settings', settings);
  }

  function persist() { save('projects', projects); save('dirty', dirty); save('roster', roster); save('homes', homes); }

  // ── People and access ────────────────────────────────────
  // GitHub decides what each person can open. An FTE's token reaches the data repo; a
  // contractor's reaches only the review-* repos of their projects, so their copy of
  // Signoff never sees anything else. Before a first sync everything local is shown.
  function myRole() { return DEMO || dataAccess !== 'none' ? 'fte' : 'contractor'; }
  function isFte() { return myRole() === 'fte'; }
  function isOwner() { return !!settings.login && settings.login === String(settings.owner).toLowerCase(); }
  function visible() { return true; }
  function visibleProjects() { return Object.keys(projects).map(function (k) { return projects[k]; }); }
  function workspace() { return new S.Workspace(settings, getToken()); }
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
    return M.liveUsers(roster).filter(function (u) { return u.role === 'contractor' && (u.projects || []).indexOf(projectId) >= 0; });
  }
  function saveUi() { save('ui', { slug: ui.slug, view: ui.view, filter: ui.filter, showArchived: ui.showArchived, sideCollapsed: !!ui.sideCollapsed, reqFilter: ui.reqFilter || 'all' }); }
  // The sidebar slides over the page on narrow windows; on wide ones it collapses away and
  // stays that way until opened again.
  var narrow = window.matchMedia ? window.matchMedia('(max-width: 860px)') : { matches: false };
  function toggleSidebar() {
    if (narrow.matches) { $('#app').classList.toggle('nav-open'); return; }
    ui.sideCollapsed = !ui.sideCollapsed;
    $('#app').classList.toggle('side-collapsed', ui.sideCollapsed);
    saveUi();
  }

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
  function me() { return settings.user || 'Anonymous'; }

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
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3h6v1.5M8.5 11l2 2 4-4.5M8.5 17h7"/></svg>'
  };

  function ring(pct, size, stroke, label, sub) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r;
    return '<div class="ring" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg width="' + size + '" height="' + size + '"><circle class="ring-track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
      '<circle class="ring-val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '"/></svg>' +
      (label != null ? '<div class="ring-label"><div><b>' + label + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div></div>' : '') + '</div>';
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
  }
  function addCustom(checklist, section, text) {
    var p = current(); if (!p || !text.trim()) return;
    var id = M.uid(C.ids.custom || 'x');
    p.custom[id] = M.stamp({ id: id, checklist: checklist, section: section, text: text.trim(), hint: '', severity: 'major', createdAt: M.now() }, me());
    touch(p); renderPage();
    return id;
  }
  function updateMeta(fields) {
    var p = current(); if (!p) return;
    p.meta = M.stamp(Object.assign({}, p.meta, fields), me());
    touch(p); render();
  }

  // ── Sidebar ──────────────────────────────────────────────
  function renderSidebar() {
    var q = ($('#project-search').value || '').toLowerCase();
    var list = visibleProjects()
      .filter(function (p) { return !q || [p.meta.name, p.meta.client, p.meta.board].join(' ').toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (b.meta.updatedAt || '').localeCompare(a.meta.updatedAt || ''); });
    var active = list.filter(function (p) { return !p.meta.archived; });
    var archived = list.filter(function (p) { return p.meta.archived; });
    function row(p) {
      var st = M.projectStats(p, TEMPLATES);
      var tip = [p.meta.name, [p.meta.client, p.meta.board, p.meta.revision && 'Rev ' + p.meta.revision].filter(Boolean).join(' · '), p.meta.stage].filter(Boolean).join('\n');
      return '<button class="proj' + (p.slug === ui.slug ? ' active' : '') + '" data-act="open-project" data-slug="' + esc(p.slug) + '" title="' + esc(tip) + '">' +
        ring(st.pct, 26, 3.5) +
        '<span class="proj-body"><span class="proj-name">' + esc(p.meta.name) + '</span>' +
        '<span class="proj-sub">' + esc([p.meta.board, p.meta.revision && 'Rev ' + p.meta.revision].filter(Boolean).join(' · ') || p.meta.stage) + '</span></span>' +
        (dirty[p.id] ? '<span class="proj-dirty" title="Not synced yet"></span>' : '') + '</button>';
    }
    var html = active.map(row).join('') || '<div class="side-empty">' + (q ? 'No matching projects.' : myRole() === 'fte' ? 'No projects yet.' : 'No projects shared with you yet.') + '</div>';
    if (archived.length) {
      html += '<div class="side-archived"><div class="side-head"><span class="side-label">Archived</span><button class="btn-plain btn" style="padding:2px 6px;font-size:12px" data-act="toggle-archived">' + (ui.showArchived ? 'Hide' : 'Show ' + archived.length) + '</button></div>' +
        (ui.showArchived ? archived.map(row).join('') : '') + '</div>';
    }
    if (invitations.length && !DEMO) {
      html = '<div class="invite-card"><b>' + plural(invitations.length, 'invitation') + ' from ' + esc(settings.owner) + '</b><span>' +
        invitations.map(function (i) { return esc(String(i.repo).split('/')[1]); }).join(', ') + '</span><button class="btn btn-primary" data-act="accept-invites">Accept</button></div>' + html;
    }
    $('#project-list').innerHTML = html;
    $('[data-act="new-project"]').hidden = !isFte();
    var people = $('#people-link');
    people.hidden = DEMO || !isFte();
    // Links to the rest of the suite (hub, the other Signoff tool, Fabcheck) show for everyone:
    // FTEs, contractors and the demo. In the demo they point at the other tools' demos. A link
    // marked data-internal is for FTEs only (none today).
    var tools = $('#side-tools');
    if (tools) {
      tools.hidden = false;
      tools.querySelectorAll('[data-internal]').forEach(function (a) { a.hidden = DEMO || !isFte(); });
      if (DEMO) {
        tools.querySelectorAll('a.side-link').forEach(function (a) {
          var href = a.getAttribute('href');
          if (!/[?&]demo\b/.test(href)) a.setAttribute('href', href + (href.indexOf('?') >= 0 ? '&' : '?') + 'demo');
        });
      }
    }
    people.classList.toggle('active', ui.page === 'people');
  }

  function renderSyncState(state) {
    var dot = $('#sync-dot'), title = $('#sync-title'), sub = $('#sync-sub');
    var n = Object.keys(dirty).length;
    if (DEMO) { dot.dataset.tone = 'idle'; title.textContent = 'Demo mode'; sub.textContent = 'Changes stay in this browser'; return; }
    if (state === 'busy') { dot.dataset.tone = 'busy'; title.textContent = 'Syncing\u2026'; sub.textContent = settings.owner; return; }
    if (state === 'error') { dot.dataset.tone = 'error'; title.textContent = 'Sync failed'; sub.textContent = 'Click for details'; return; }
    if (!getToken()) { dot.dataset.tone = n ? 'warn' : 'idle'; title.textContent = n ? plural(n, 'unsynced change') : 'Local only'; sub.textContent = 'Set up Git sync'; return; }
    if (n) { dot.dataset.tone = 'warn'; title.textContent = plural(n, 'unsynced change'); sub.textContent = 'Click to sync'; return; }
    var outdated = lastSync && lastSync.version && window.SIGNOFF_VERSION && lastSync.version.hash !== window.SIGNOFF_VERSION.hash;
    dot.dataset.tone = outdated ? 'warn' : 'ok';
    title.textContent = outdated ? 'Newer tool available' : 'Synced';
    var errs = lastSync && lastSync.errors && lastSync.errors.length;
    if (errs) { dot.dataset.tone = 'warn'; title.textContent = 'Synced with problems'; sub.textContent = lastSync.errors[0].message; return; }
    sub.textContent = outdated ? 'Get the latest from ' + settings.toolRepo : (lastSync ? relTime(lastSync.at) : 'Ready') +
      (settings.login ? ' \u00b7 ' + settings.login + (myRole() === 'contractor' ? ' (contractor)' : '') : '');
  }

  // ── Toolbar ──────────────────────────────────────────────
  // Sync, plus Discard while there are unsynced changes.
  function syncButtons() {
    if (DEMO) return '';
    var n = Object.keys(dirty).length;
    return '<button class="btn" data-act="sync" title="Sync with GitHub (Ctrl+S)">' + ICON.sync + '<span class="btn-label">Sync</span>' + (n ? '<span class="badge">' + n + '</span>' : '') + '</button>' +
      (n ? '<button class="btn" data-act="discard" title="Throw away unsynced changes and go back to what’s on GitHub">' + ICON.undo + '<span class="btn-label">Discard</span></button>' : '');
  }
  function renderToolbar() {
    var p = current();
    $('#toolbar-title').textContent = p ? p.meta.name : '';
    var seg = $('#view-seg'), acts = $('#toolbar-actions');
    if (!p || ui.page === 'people') {
      seg.innerHTML = '';
      acts.innerHTML = syncButtons();
      return;
    }
    var st = M.projectStats(p, TEMPLATES);
    var reqIdx = checkIdx(p), reqFail = M.liveReqs(p).some(function (q) { return reqFailing(q, reqIdx); });
    var views = [{ id: 'overview', label: 'Overview' }].concat(reqsOn(p) ? [{ id: 'reqs', label: 'Requirements', extra: reqFail ? '<span class="dot"></span>' : '' }] : [], projectTemplates(p).map(function (t) {
      var c = st.per[t.id];
      return { id: t.id, label: t.short, extra: c && c.issuesOpen ? '<span class="dot"></span>' : '' };
    }));
    views.push({ id: 'findings', label: 'Findings', extra: st.issue ? '<span class="count">' + st.issue + '</span>' : '' });
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
      '<button class="icon-btn" data-act="project-menu" title="More" aria-label="More">' + ICON.more + '</button>';
  }

  // ── Pages ────────────────────────────────────────────────
  function renderPage() {
    var p = current();
    var page = $('#page');
    var scroll = $('#main').scrollTop;
    if (ui.page === 'people' && isFte() && !DEMO) { page.innerHTML = peoplePage(); renderToolbar(); return; }
    ui.page = '';
    if (!p) { page.innerHTML = emptyPage(); renderToolbar(); return; }
    renderToolbar();
    if (ui.view === 'overview') page.innerHTML = overviewPage(p);
    else if (ui.view === 'findings') page.innerHTML = findingsPage(p);
    else if (ui.view === 'reqs') page.innerHTML = reqsPage(p);
    else page.innerHTML = checklistPage(p, templateById(ui.view));
    $('#main').scrollTop = scroll;
  }

  function emptyPage() {
    if (!isFte()) {
      return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
        '<h2>' + (!visibleProjects().length ? 'No projects shared with you yet' : 'Pick a project') + '</h2>' +
        '<p>' + (!visibleProjects().length ? 'Signed in as <b>' + esc(settings.login) + '</b>. ' + (invitations.length ? 'Accept your invitation in the sidebar.' : 'Ask your Dovetail contact to add you to a project, then sync.') : 'Choose a project from the sidebar.') + '</p>' +
        '<button class="btn btn-primary" data-act="sync">Sync now</button></div></div>';
    }
    var none = !visibleProjects().length;
    return '<div class="page"><div class="empty"><div class="empty-art">' + ICON.clipboard + '</div>' +
      '<h2>' + (none ? 'Start a design review' : 'Pick a project') + '</h2>' +
      '<p>' + (none ? 'Create a project, choose the checklists and what kind of ' + W.thing + ' it is, and Signoff builds a review tailored to it.' : 'Choose a project from the sidebar, or start a new one.') + '</p>' +
      '<button class="btn btn-primary" data-act="new-project">New project</button>' +
      (none && !DEMO ? ' <button class="btn" data-act="sync">Pull from GitHub</button>' : '') +
      (none ? '<p class="note" style="margin-top:18px">' + TEMPLATES.length + ' checklists · ' + Object.keys(INDEX.items).length + ' checks available</p>' : '') +
      '</div></div>';
  }

  function headBlock(p, eyebrow) {
    var m = p.meta;
    var sub = [m.client, m.board, m.revision && 'Rev ' + m.revision].filter(Boolean).map(esc).join('<span class="sep">·</span>');
    return '<div class="eyebrow">' + esc(eyebrow) + '</div><h1 class="page-title">' + esc(m.name) + '</h1>' +
      '<div class="page-sub">' + (sub ? '<span>' + sub + '</span>' : '') + '<span class="chip accent">' + esc(m.stage) + '</span></div>';
  }

  function overviewPage(p) {
    var st = M.projectStats(p, TEMPLATES);
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
      ring(st.pct, 132, 11, st.pct + '%', 'reviewed') + '</div>' +
      '<div class="grid grid-4">' +
      stat(st.pass, 'Passed', 'pass') + stat(st.issue, plural(st.issue, 'Issue').replace(/^\d+ /, '') + (st.issuesOpen ? ' · ' + st.issuesOpen + ' open' : ''), 'issue') +
      stat(st.open, 'To review', '') + stat(st.na, 'Not applicable', '') + '</div>' +
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
  function stat(n, label, cls) { return '<div class="card stat ' + cls + '"><div class="stat-num">' + n + '</div><div class="stat-label">' + esc(label) + '</div></div>'; }
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
    if (ui.filter === 'open') return r.status === 'open';
    if (ui.filter === 'issue') return r.status === 'issue';
    if (ui.filter === 'comments') return !!counts[r.id];
    return true;
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
        '<button class="sec-na' + (g.state.na ? ' on' : '') + '" data-act="sec-na" data-sec="' + esc(g.section.id) + '" title="Mark the whole section not applicable">N/A</button></div></div>' +
        '<div class="sec-body">' + visible.map(function (r) { return itemRow(r, counts); }).join('') +
        (hiddenCount ? '<div class="hidden-rows"><span>' + plural(hiddenCount, 'check') + ' not applicable to this ' + W.thing + '’s profile</span><button data-act="show-hidden" data-sec="' + esc(g.section.id) + '">Show</button></div>' :
          (showHidden[g.section.id] && g.rows.some(function (r) { return r.hidden; }) ? '<div class="hidden-rows"><span>Showing checks outside the profile</span><button data-act="show-hidden" data-sec="' + esc(g.section.id) + '">Hide</button></div>' : '')) +
        (ui.filter === 'all' && !ui.query ? '<div class="add-row"><input data-add="' + esc(t.id) + '|' + esc(g.section.id) + '" placeholder="+ Add a check for this project" maxlength="400"></div>' : '') +
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

  function itemRow(r, counts) {
    var n = counts[r.id] || 0;
    var sub = '';
    if (r.severity !== 'minor' || r.status === 'issue') sub += '<span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span>';
    if (r.status === 'issue') {
      var res = r.state.resolution;
      sub += '<span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</span>';
      if (r.state.assignee) sub += '<span>→ ' + esc(r.state.assignee) + '</span>';
    }
    if (r.auto === 'profile') sub += '<span class="tag">Outside profile</span>';
    if (r.custom) sub += '<span class="tag">' + (isFabcheck(r.def) ? 'Fabcheck' : 'Project check') + '</span>';
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

  function allFindings(p) {
    var out = [];
    projectTemplates(p).forEach(function (t) {
      M.checklistRows(p, t).forEach(function (g) {
        g.rows.forEach(function (r) { if (r.status === 'issue') out.push({ row: r, template: t, section: g.section }); });
      });
    });
    var rank = { critical: 0, major: 1, minor: 2 };
    var resRank = { '': 0, fixed: 1, waived: 2 };
    return out.sort(function (a, b) {
      return (resRank[a.row.state.resolution || ''] - resRank[b.row.state.resolution || '']) || (rank[a.row.severity] - rank[b.row.severity]);
    });
  }

  function findingsPage(p) {
    var f = allFindings(p);
    var counts = commentCounts(p);
    var open = f.filter(function (x) { return !x.row.state.resolution; }).length;
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Findings</h1>' +
      '<div class="page-sub"><span>' + plural(f.length, 'issue') + '</span><span class="sep">·</span><span>' + open + ' open</span></div></div>' +
      '<button class="btn" data-act="export-csv">Export CSV</button></div>';
    if (!f.length) return html + '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>No issues raised</h2><p>Mark a check as an Issue to add it here, with its severity, owner and resolution.</p></div></div>';
    html += '<div class="card" style="overflow:hidden"><table class="table"><thead><tr><th>Severity</th><th>Check</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>' +
      f.map(function (x) {
        var r = x.row, res = r.state.resolution;
        var last = M.liveComments(p, r.id).slice(-1)[0];
        return '<tr data-act="goto-item" data-id="' + esc(r.id) + '"><td><span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span></td>' +
          '<td>' + esc(r.def.text) + '<div class="muted">' + esc(x.template.short + ' › ' + x.section.title) + '</div>' + (last ? '<div class="muted" style="margin-top:4px">“' + esc(last.text.slice(0, 140)) + (last.text.length > 140 ? '…' : '') + '” — ' + esc(last.author) + '</div>' : '') + '</td>' +
          '<td class="muted">' + esc(r.state.assignee || '—') + '</td>' +
          '<td><span class="res ' + (res || 'open') + '">' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</span></td>' +
          '<td class="muted">' + (counts[r.id] ? '<span class="cmt-count">' + ICON.bubble + counts[r.id] + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
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

  // ── Fabcheck runs (docs/fabcheck-link.md) ────────────────
  function isFabcheck(def) { return !!(def && def.source && def.source.tool === 'fabcheck'); }

  // Link that opens the run in Fabcheck, zoomed to a location when one is given. The repo is
  // where the project lives now; a run stored before the project was shared moved with it.
  function fabcheckUrl(p, src, loc) {
    var run = src.run || {};
    var q = ['run=' + encodeURIComponent(run.id || ''), 'project=' + encodeURIComponent(p.id), 'repo=' + encodeURIComponent(homeOf(p)), 'check=' + encodeURIComponent(src.check || '')];
    if (loc) {
      q.push('x=' + encodeURIComponent(loc.x), 'y=' + encodeURIComponent(loc.y));
      if (loc.layer) q.push('layer=' + encodeURIComponent(loc.layer));
    }
    return '../pcb_dfm/index.html' + (DEMO ? '?demo' : '') + '#/board?' + q.join('&');
  }

  function fabcheckBlock(p, def) {
    if (!isFabcheck(def)) return '';
    var src = def.source, run = src.run || null, locs = src.locations || [];
    var canOpen = !DEMO && isFte() && run && run.id;
    var stored = run && run.stored && run.stored.repo;
    var h = '<div class="fab-card"><div class="fab-head"><b>From Fabcheck</b>' +
      (canOpen ? '<button class="btn btn-primary" data-act="open-fabcheck" data-href="' + esc(fabcheckUrl(p, src, locs[0])) + '">Open in Fabcheck</button>' : '') + '</div>';
    if (run) {
      h += '<div class="fab-meta">' + esc(run.package && run.package.name || 'Package') +
        (run.package && run.package.key ? ' <span class="muted">· ' + esc(run.package.key.slice(0, 8)) + '</span>' : '') + '<br>' +
        esc([fmtDate(run.at), run.by, run.settings && run.settings.profile && run.settings.profile + ' profile'].filter(Boolean).join(' · ')) + '<br>' +
        (stored ? 'Package and results saved with the project' : 'Run kept on ' + esc(run.by || 'the sender') + '’s computer only; others can drop the same package into Fabcheck to see it') + '</div>';
    } else {
      h += '<div class="fab-meta">Sent before Fabcheck kept runs. Run Fabcheck on the package again and send it to link this check to the board.</div>';
    }
    if (src.gone) h += '<div class="note" style="margin:6px 0 0">Not found in the latest Fabcheck run.</div>';
    if (locs.length) {
      h += '<div class="fab-locs">' + locs.map(function (l, i) {
        var label = (l.label ? l.label + ' — ' : '') + Number(l.x).toFixed(2) + ', ' + Number(l.y).toFixed(2) + ' mm' + (l.layer ? ' · ' + l.layer : '');
        return canOpen ? '<button class="fab-loc" data-act="open-fabcheck" data-href="' + esc(fabcheckUrl(p, src, l)) + '">' + esc(label) + '</button>'
          : '<span class="fab-loc">' + esc(label) + '</span>';
      }).join('') + '</div>';
    }
    if (def.hint) h += '<details class="fab-detail"><summary>Details</summary><div>' + esc(def.hint) + '</div></details>';
    return h + '</div>';
  }

  function renderInspector() {
    var el = $('#inspector'), p = current();
    if (!p || !selected || !el.classList.contains('open')) return;
    var rq = reqOf(p, selected);
    if (rq) return renderReqInspector(p, rq);
    var d = itemDef(p, selected);
    var st = p.items[selected] || {};
    var row = null;
    if (d.template) {
      M.checklistRows(p, d.template).forEach(function (g) { g.rows.forEach(function (r) { if (r.id === selected) row = r; }); });
    }
    var status = row ? row.status : (st.status || 'open');
    var sev = st.severity || d.def.severity || 'minor';
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
    el.innerHTML = '<div class="insp-head"><div class="insp-crumb">' + esc(d.template ? d.template.short + ' › ' + (d.section ? d.section.title : '') : 'Retired check') + '</div>' +
      '<button class="icon-btn" data-act="close-insp" aria-label="Close">' + ICON.close + '</button></div>' +
      '<div class="insp-body">' +
      '<div class="insp-title"' + (d.custom ? ' contenteditable="true" data-edit-custom="' + esc(selected) + '"' : '') + '>' + esc(d.def.text) + '</div>' +
      fabcheckBlock(p, d.def) +
      (d.def.hint && !isFabcheck(d.def) ? '<div class="hint"><b>Guidance</b>' + esc(d.def.hint) + '</div>' : '') +
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
      (d.custom ? '<button class="btn btn-danger" data-act="delete-custom" data-id="' + esc(selected) + '" style="margin-bottom:10px">Delete project check</button>' : '') +
      '<div class="thread"><div class="thread-title">Discussion <span class="note" style="margin:0">' + (comments.length || '') + '</span></div>' +
      (comments.length ? comments.map(function (c) {
        return '<div class="cmt">' + avatar(c.author) + '<div><div class="cmt-head"><b>' + esc(c.author) + '</b><span title="' + esc(new Date(c.at).toLocaleString()) + '">' + relTime(c.at) + '</span>' +
          (c.author === me() ? '<button class="cmt-del" data-act="del-comment" data-id="' + esc(c.id) + '">Delete</button>' : '') + '</div><div class="cmt-text">' + esc(c.text) + '</div></div></div>';
      }).join('') : '<p class="note">No comments yet. Note what you checked, what you found, or ask the designer a question.</p>') +
      '</div></div>' +
      '<div class="composer"><textarea class="input" id="comment-input" placeholder="Add a comment…" rows="2">' + esc(draftText) + '</textarea>' +
      '<div class="composer-foot"><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to post</span><button class="btn btn-primary" data-act="post-comment">Comment</button></div></div>';
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
    draft: 'Draft', approved: 'Approved', changed: 'Changed', open: 'Not verified', pass: 'Pass', fail: 'Fail',
    shall: 'Shall', should: 'Should' };
  function reqOf(p, id) { var q = p && p.reqs && p.reqs[id]; return q && !q.deleted ? q : null; }
  // Requirements is picked in the project sheet like a checklist ('reqs' in meta.checklists).
  // Projects from before that choice existed show it if they already have requirements.
  // Turning it off hides it but keeps the requirements, as a checklist's state is kept.
  function reqsOn(p) {
    if (!p) return false;
    if ((p.meta.checklists || []).indexOf('reqs') >= 0) return true;
    return !p.meta.reqsDecided && M.liveReqs(p).length > 0;
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
    var tip = t.pass + ' pass · ' + t.issue + ' issue · ' + t.open + ' to review' + (t.na ? ' · ' + t.na + ' N/A' : '') + (t.missing ? ' · ' + t.missing + ' no longer in the project' : '');
    return '<span class="res ' + cls + '" title="' + tip + '">' + label + '</span>';
  }
  function verifyChip(v) { return '<span class="res ' + (v === 'pass' ? 'fixed' : v === 'fail' ? 'open' : 'waived') + '">' + REQ_LABEL[v] + '</span>'; }

  function reqFailing(q, idx) { return q.verify === 'fail' || M.reqTrace(q, idx).state === 'issue'; }
  function reqMatches(q, idx) {
    var f = ui.reqFilter || 'all';
    if (ui.reqQuery) {
      var s = ui.reqQuery.toLowerCase();
      if ([q.ref, q.text, q.category, q.source].join(' ').toLowerCase().indexOf(s) < 0) return false;
    }
    if (f === 'draft') return q.status !== 'approved';
    if (f === 'open') return q.verify === 'open';
    if (f === 'fail') return reqFailing(q, idx);
    if (f === 'unlinked') return !(q.links || []).length;
    return true;
  }

  function reqsPage(p) {
    var idx = checkIdx(p), all = M.liveReqs(p), st = M.reqStats(p);
    var list = all.filter(function (q) { return reqMatches(q, idx); });
    var failing = all.filter(function (q) { return reqFailing(q, idx); }).length;
    var filters = [['all', 'All', st.total], ['draft', 'Not approved', st.total - st.approved], ['open', 'Not verified', st.open],
      ['fail', 'Failing', failing], ['unlinked', 'Not traced', st.unlinked]];
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(p.meta.name) + '</div><h1 class="page-title">Requirements</h1>' +
      '<div class="page-sub"><span>' + plural(st.total, 'requirement') + '</span><span class="sep">·</span><span>' + st.approved + ' approved</span>' +
      '<span class="sep">·</span><span>' + st.pass + ' verified</span>' +
      (failing ? '<span class="sep">·</span><span style="color:var(--issue)">' + failing + ' failing</span>' : '') + '</div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="req-import">Import</button>' +
      (st.total ? '<button class="btn" data-act="req-export">Export CSV</button>' : '') +
      '<button class="btn btn-primary" data-act="req-add">Add requirement</button></div></div>';
    if (st.duplicates.length) {
      html += '<div class="card" style="padding:12px 16px;margin-bottom:14px;font-size:13px">More than one requirement uses ' +
        st.duplicates.map(esc).join(', ') + '. Renumber one so the trace stays unambiguous.</div>';
    }
    if (!st.total) {
      return html + '<div class="card empty"><div class="empty-art">' + ICON.clipboard + '</div><h2>No requirements yet</h2>' +
        '<p>List what this ' + W.thing + ' must do, how each requirement will be verified, and which checks show it’s met. Add them one at a time, or import a spreadsheet with a Requirement column.</p>' +
        '<button class="btn btn-primary" data-act="req-add">Add requirement</button> <button class="btn" data-act="req-import">Import</button></div></div>';
    }
    html += '<div class="filters"><div class="seg">' + filters.map(function (f) {
      return '<button class="' + ((ui.reqFilter || 'all') === f[0] ? 'on' : '') + '" data-act="req-filter" data-filter="' + f[0] + '">' + f[1] + ' <span class="count">' + f[2] + '</span></button>';
    }).join('') + '</div><div class="search">' + ICON.search + '<input id="req-search" type="search" placeholder="Filter requirements" value="' + esc(ui.reqQuery || '') + '" autocomplete="off"></div></div>';
    if (!list.length) return html + '<div class="empty"><h2>Nothing here</h2><p>No requirements match this filter.</p></div></div>';
    html += '<div class="card" style="overflow:hidden"><table class="table reqs"><thead><tr><th>ID</th><th>Requirement</th><th>Verify by</th><th>Status</th><th>Verified</th><th>Trace</th></tr></thead><tbody>' +
      list.map(function (q) {
        var n = M.liveComments(p, q.id).length;
        return '<tr data-act="select-req" data-id="' + esc(q.id) + '"' + (selected === q.id ? ' class="sel"' : '') + '>' +
          '<td class="req-ref">' + esc(q.ref) + '</td>' +
          '<td>' + (q.text ? esc(q.text) : '<span class="muted">No text yet</span>') +
          '<div class="muted">' + esc([REQ_LABEL[q.kind], q.category, q.source].filter(Boolean).join(' · ')) +
          (n ? ' <span class="cmt-count">' + ICON.bubble + n + '</span>' : '') + '</div></td>' +
          '<td class="muted">' + REQ_LABEL[q.method] + '</td>' +
          '<td><span class="chip' + (q.status === 'approved' ? ' accent' : '') + '">' + REQ_LABEL[q.status] + '</span></td>' +
          '<td>' + verifyChip(q.verify) + '</td>' +
          '<td>' + traceChip(M.reqTrace(q, idx)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    return html;
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
        return '<button class="' + (q[key] === v ? 'on' : '') + tone + '" data-act="req-field" data-key="' + key + '" data-val="' + v + '">' + REQ_LABEL[v] + '</button>';
      }).join('') + '</div>';
    }
    var links = (q.links || []).map(function (id) {
      var c = idx[id];
      if (!c) {
        return '<div class="req-link missing"><span class="req-link-main"><span class="status-dot"></span><span><span class="req-link-text">' + esc(id) + '</span><span class="muted">No longer in this project</span></span></span>' +
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
      '<div class="field"><label for="req-text">Requirement</label><textarea class="input" id="req-text" rows="3" data-req-input="text" placeholder="e.g. The ' + esc(W.thing) + ' shall run from 24 V DC ±10%.">' + esc(q.text) + '</textarea></div>' +
      '<div class="row2"><div class="field"><label for="req-cat">Category</label><input class="input" id="req-cat" value="' + esc(q.category) + '" placeholder="Power, interfaces…" data-req-input="category"></div>' +
      '<div class="field"><label for="req-src">Source</label><input class="input" id="req-src" value="' + esc(q.source) + '" placeholder="Spec and section" data-req-input="source"></div></div>' +
      '<div class="field"><span class="field-label">Verify by</span>' + seg('method', M.REQ_METHODS) + '</div>' +
      '<div class="field"><span class="field-label">Status</span>' + seg('status', M.REQ_STATUS) + '</div>' +
      '<div class="field"><span class="field-label">Verified</span>' + seg('verify', M.REQ_VERIFY) + '</div>' +
      '<div class="field"><label for="req-ev">Evidence</label><textarea class="input" id="req-ev" rows="2" data-req-input="evidence" placeholder="Test report, measurement, analysis…">' + esc(q.evidence) + '</textarea></div>' +
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
      '<div class="composer-foot"><span><kbd>Ctrl</kbd> + <kbd>Enter</kbd> to post</span><button class="btn btn-primary" data-act="post-comment">Comment</button></div></div>';
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
    var hits = M.liveReqs(p).filter(function (q) { return (q.links || []).indexOf(id) >= 0; });
    if (!hits.length) return '';
    return '<div class="field"><span class="field-label">Traces to</span><div class="chips">' + hits.map(function (q) {
      return '<button class="chip accent" style="border:none" data-act="open-req" data-id="' + esc(q.id) + '" title="' + esc(q.text) + '">' + esc(q.ref) + '</button>';
    }).join('') + '</div></div>';
  }

  function importReqsSheet() {
    var p = current(); if (!p) return;
    var w = sheet('<div class="sheet-head"><h2>Import requirements</h2><p>Paste rows from Excel or a CSV file, or choose a file. The first row names the columns: ' +
      '<b>Requirement</b> (needed), and optionally <b>ID</b>, <b>Type</b> (shall / should), <b>Category</b>, <b>Source</b> and <b>Verification</b> ' +
      '(inspection, analysis, demonstration, test). A row whose ID already exists updates that requirement.</p></div>' +
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
      toast('Imported — ' + r.added + ' added, ' + r.updated + ' updated');
    });
  }

  // Overview card next to the checklists.
  function reqsCard(p) {
    var st = M.reqStats(p), idx = checkIdx(p);
    var failing = M.liveReqs(p).filter(function (q) { return reqFailing(q, idx); }).length;
    var pct = st.total ? Math.round(100 * st.pass / st.total) : 0;
    return '<button class="card cl-card" data-act="view" data-view="reqs">' +
      '<div class="cl-card-top"><div><div class="cl-card-title">Requirements</div><div class="cl-card-desc">' +
      (st.total ? 'What this ' + W.thing + ' must do, how each is verified, and the checks that show it.' : 'None yet. List what this ' + W.thing + ' must do and trace each to the checks that prove it.') +
      '</div></div>' + ring(pct, 46, 5, pct, '') + '</div>' +
      '<div class="bar"><i class="b-pass" style="width:' + (st.total ? 100 * st.pass / st.total : 0) + '%"></i><i class="b-issue" style="width:' + (st.total ? 100 * st.fail / st.total : 0) + '%"></i></div>' +
      '<div class="cl-card-foot"><span><b>' + st.pass + '</b>/' + st.total + ' verified</span>' +
      (failing ? '<span style="color:var(--issue)"><b>' + failing + '</b> failing</span>' : '') +
      (st.total && st.unlinked ? '<span>' + st.unlinked + ' not traced</span>' : '') + '</div></button>';
  }

  function reqsReport(p) {
    var all = M.liveReqs(p);
    if (!all.length) return '';
    var idx = checkIdx(p), st = M.reqStats(p);
    return '<h2>Requirements</h2><p class="r-cmt" style="margin:0 0 8px">' + plural(st.total, 'requirement') + ', ' + st.approved + ' approved, ' + st.pass + ' verified' + (st.fail ? ', ' + st.fail + ' failed' : '') + '.</p>' +
      '<table><thead><tr><th>ID</th><th>Requirement</th><th>Verify by</th><th>Status</th><th>Verified</th><th>Traced checks</th></tr></thead><tbody>' +
      all.map(function (q) {
        var t = M.reqTrace(q, idx);
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

  function projectSheet(p) {
    var editing = !!p;
    var contractors = M.liveUsers(roster).filter(function (u) { return u.role === 'contractor'; });
    var defaults = C.defaultChecklists || TEMPLATES.map(function (t) { return t.id; });
    var m = p ? p.meta : { name: '', client: '', board: '', revision: '', stage: C.defaultStage, description: '', profile: [], checklists: TEMPLATES.map(function (t) { return t.id; }).filter(function (id) { return defaults.indexOf(id) >= 0; }).concat(['reqs']) };
    var reqsPicked = p ? reqsOn(p) : true;
    var reqCount = p ? M.liveReqs(p).length : 0;
    var w = sheet('<div class="sheet-head"><h2>' + (editing ? 'Project details' : 'New design review') + '</h2><p>' + (editing ? 'Changes sync to everyone on this project.' : 'Pick the checklists and describe the ' + W.thing + '. Checks that don’t fit its profile are set aside as N/A, and you can still bring any of them back.') + '</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field"><label for="f-name">Project name</label><input class="input" id="f-name" value="' + esc(m.name) + '" placeholder="' + esc(W.namePlaceholder) + '" maxlength="120"></div>' +
      '<div class="row2"><div class="field"><label for="f-client">Client</label><input class="input" id="f-client" value="' + esc(m.client) + '" placeholder="Optional"></div>' +
      '<div class="field"><label for="f-board">' + esc(W.number) + '</label><input class="input" id="f-board" value="' + esc(m.board) + '" placeholder="' + esc(W.numberPlaceholder) + '"></div></div>' +
      '<div class="row2"><div class="field"><label for="f-rev">Revision</label><input class="input" id="f-rev" value="' + esc(m.revision) + '" placeholder="e.g. 03"></div>' +
      '<div class="field"><label for="f-stage">Stage</label><select class="input" id="f-stage">' + M.STAGES.map(function (s) { return '<option' + (s === m.stage ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div></div>' +
      '<div class="field"><label for="f-desc">Scope / notes</label><textarea class="input" id="f-desc" placeholder="What is being reviewed, which documents, anything reviewers should know">' + esc(m.description) + '</textarea></div>' +
      '<div class="field"><span class="field-label">Checklists</span><div class="pick-grid" id="f-checklists">' +
      '<button type="button" class="pick' + (reqsPicked ? ' on' : '') + '" data-pick="reqs"><b>Requirements</b><span>' +
      (reqCount ? plural(reqCount, 'requirement') : 'Your own list, traced to checks') + '</span></button>' +
      TEMPLATES.map(function (t) {
        var n = 0; t.sections.forEach(function (s) { n += s.items.length; });
        return '<button type="button" class="pick' + (m.checklists.indexOf(t.id) >= 0 ? ' on' : '') + '" data-pick="' + t.id + '"><b>' + esc(t.short) + '</b><span>' + n + ' checks</span></button>';
      }).join('') + '</div></div>' +
      '<div class="field"><span class="field-label">' + esc(W.profile) + ' — select everything that applies</span><div class="pick-grid" id="f-profile">' + M.TAGS.map(function (t) {
        return '<button type="button" class="pick' + (m.profile.indexOf(t.id) >= 0 ? ' on' : '') + '" data-pick="' + t.id + '"><b>' + esc(t.label) + '</b><span>' + esc(t.desc) + '</span></button>';
      }).join('') + '</div><p class="note" id="f-count"></p></div>' +
      (!DEMO && contractors.length ? '<div class="field"><span class="field-label">Contractors on this project \u2014 ' + (editing && M.sharedRepo(roster, p.id) ? 'shared as ' + esc(M.sharedRepo(roster, p.id)) : 'adding one moves it into its own private repository') + '</span><div class="pick-grid" id="f-people">' + contractors.map(function (u) {
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
      var b = e.target.closest('[data-sheet]');
      if (!b) return;
      if (b.dataset.sheet === 'cancel') return closeSheet();
      if (b.dataset.sheet === 'archive') { updateMeta({ archived: !m.archived }); closeSheet(); toast(m.archived ? 'Project restored' : 'Project archived'); return; }
      var name = w.querySelector('#f-name').value.trim();
      if (!name) { w.querySelector('#f-name').focus(); return; }
      var fields = {
        name: name, client: w.querySelector('#f-client').value.trim(), board: w.querySelector('#f-board').value.trim(),
        revision: w.querySelector('#f-rev').value.trim(), stage: w.querySelector('#f-stage').value,
        description: w.querySelector('#f-desc').value.trim(), profile: picked('f-profile'), checklists: picked('f-checklists')
      };
      if (!fields.checklists.length) { toast('Pick at least one checklist'); return; }
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
        if (!confirm((share ? 'Move this project into its own private repository and invite ' : adds.length ? 'Invite ' : '') + adds.join(', ') +
          (drops.length ? (adds.length ? '; remove ' : 'Remove ') + drops.join(', ') : '') + '?\n\nGitHub emails the invitations.')) return;
        setTimeout(function () {
          runAccessOps('Updating who can open this project', adds.map(function (l, i) { return { login: l, share: share && i === 0 ? [projectId] : [], invite: share ? [] : [projectId] }; })
            .concat(drops.map(function (l) { return { login: l, revoke: [projectId] }; })));
        }, 0);
      }
      // Requirements is chosen like a checklist; from now on that choice is explicit.
      fields.reqsDecided = true;
      if (editing) { assign(p.id); updateMeta(fields); closeSheet(); return; }
      var doc = M.newProject(fields, me(), TEMPLATES);
      doc.meta.reqsDecided = true;
      var slug = doc.slug, n = 2;
      while (projects[slug]) slug = doc.slug + '-' + n++;
      doc.slug = slug;
      projects[slug] = doc;
      ui.slug = slug; ui.view = 'overview'; ui.page = '';
      assign(doc.id);
      touch(doc); saveUi(); closeSheet(); render();
      toast('Review created');
    });
  }

  function settingsSheet() {
    var token = getToken();
    var remembered = false;
    try { remembered = !!localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    var w = sheet('<div class="sheet-head"><h2>Settings</h2><p>Your name goes on comments and changes. Reviews sync through private GitHub repositories, so everyone works on the same copy.</p></div>' +
      '<div class="sheet-body">' +
      '<div class="field"><label for="s-user">Your name</label><input class="input" id="s-user" value="' + esc(settings.user) + '" placeholder="First Last"></div>' +
      '<div class="field"><span class="field-label">Appearance</span><div class="seg full" id="s-theme">' + [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(function (t) {
        return '<button type="button" class="' + (settings.theme === t[0] ? 'on' : '') + '" data-theme="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>' +
      (DEMO ? '<p class="note">Git sync is off in demo mode. <a href="' + esc(location.pathname) + '">Open the full tool</a>.</p>' :
        '<div class="field-label" style="margin-top:20px;font-size:13px;color:var(--text);font-weight:600">GitHub</div>' +
        (settings.login ? '<p class="note" style="margin:0 0 12px">Signed in as <b>' + esc(settings.login) + '</b> · ' +
          (dataAccess === 'none' ? 'Contractor: you see the projects shared with you' : dataAccess === 'ok' ? 'FTE: you see every project' : 'not synced yet') + '</p>' : '') +
        '<details class="guide"' + (getToken() ? '' : ' open') + '><summary>New to GitHub? Set up in four steps</summary><ol>' +
        '<li>Create a free account at <a href="https://github.com/signup" target="_blank" rel="noopener">github.com/signup</a>.</li>' +
        '<li>Send your username to your Dovetail contact.</li>' +
        '<li><a href="https://github.com/settings/tokens/new?scopes=repo&amp;description=Dovetail%20Signoff" target="_blank" rel="noopener">Create a token</a> (the link fills in the settings; pick an expiry and click <i>Generate token</i>).</li>' +
        '<li>Paste the token below and click <b>Save &amp; sync</b>. Signoff shows any invitations waiting for you, with an Accept button.</li></ol></details>' +
        '<div class="field"><label for="s-token">Access token</label><input class="input" id="s-token" type="password" value="' + esc(token) + '" placeholder="ghp_… or github_pat_…" autocomplete="off">' +
        '<p class="note">Kept in this browser and sent only to api.github.com. Collaborators use a classic token with the <b>repo</b> scope. The account owner can use a fine-grained token with <b>All repositories</b> and <b>Contents</b> and <b>Administration</b> set to read and write; sharing creates new repositories, which a token limited to selected repositories can’t reach.</p></div>' +
        '<label class="check"><input type="checkbox" id="s-remember"' + (remembered ? ' checked' : '') + '> Remember the token after closing the browser (avoid on shared computers)</label>' +
        '<details class="guide" style="margin-top:14px"><summary>Repositories</summary>' +
        '<div class="row2" style="margin-top:10px"><div class="field"><label for="s-owner">Account or organization</label><input class="input" id="s-owner" value="' + esc(settings.owner) + '"></div>' +
        '<div class="field"><label for="s-branch">Branch</label><input class="input" id="s-branch" value="' + esc(settings.branch) + '"></div></div>' +
        '<div class="row2"><div class="field"><label for="s-data">Data repo (FTEs)</label><input class="input" id="s-data" value="' + esc(settings.dataRepo) + '"></div>' +
        '<div class="field"><label for="s-tool">Tool repo (FTEs)</label><input class="input" id="s-tool" value="' + esc(settings.toolRepo) + '"></div></div>' +
        '<div class="field"><label for="s-prefix">Shared project repos start with</label><input class="input" id="s-prefix" value="' + esc(settings.prefix) + '"></div>' +
        (settings.suiteRepos.length ? '<p class="note">FTEs are also invited to the rest of the suite: ' + settings.suiteRepos.map(esc).join(', ') + ' (set in assets/config.js).</p>' : '') + '</details>' +
        '<div class="log" id="s-log" hidden></div>') +
      '</div><div class="sheet-foot">' + (DEMO ? '' : '<button class="btn" data-sheet="test">Test connection</button>') + '<span class="spacer"></span>' +
      '<button class="btn" data-sheet="cancel">Cancel</button><button class="btn btn-primary" data-sheet="ok">' + (DEMO ? 'Done' : 'Save & sync') + '</button></div>');

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
      var s = read();
      var tok = DEMO ? '' : cleanToken(w.querySelector('#s-token').value);
      if (b.dataset.sheet === 'test') {
        var ws = new S.Workspace(s, tok);
        log('Checking your token…');
        ws.account.user().then(function (u) {
          log('Signed in as ' + u.login, 'ok');
          if (!w.querySelector('#s-user').value.trim()) w.querySelector('#s-user').value = u.name || u.login;
          return ws.dataStore().snapshot().then(function () { log('Data repo ' + ws.dataFull() + ': OK (FTE access)', 'ok'); },
            function () { log('Data repo ' + ws.dataFull() + ': no access (fine for contractors)'); });
        }).then(function () {
          return ws.account.listRepos(s.owner, s.prefix).then(function (names) { log(plural(names.length, 'shared project repo') + ' reachable', 'ok'); });
        }).then(function () {
          return ws.account.invitations().then(function (inv) { if (inv.length) log(plural(inv.length, 'invitation') + ' waiting — accept them after saving'); });
        }).catch(function (err) { log(err.message, 'err'); });
        return;
      }
      if (!s.user) { w.querySelector('#s-user').focus(); toast('Add your name so others know who commented'); return; }
      if (!DEMO) {
        // A different token or account may be a different person: start the identity over.
        if (tok !== getToken() || s.owner !== settings.owner || s.dataRepo !== settings.dataRepo) { s.login = ''; dataAccess = ''; save('dataAccess', dataAccess); accessMap = {}; }
        setToken(tok, w.querySelector('#s-remember').checked);
      }
      settings = s; save('settings', settings); saveSharedTheme(settings.theme);
      closeSheet(); render();
      if (!DEMO && tok) sync();
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

  function stateNow() {
    var byId = {};
    Object.keys(projects).forEach(function (k) { byId[projects[k].id] = projects[k]; });
    return { login: settings.login, projects: byId, roster: roster, homes: homes, cache: cache, dataAccess: dataAccess };
  }

  function loadAccess(force) {
    if (DEMO || !getToken() || accessLoading) return;
    var ws = workspace(), repos = ws.fteRepos(stateNow()).filter(function (r) { return force || !accessMap[r]; });
    if (!repos.length) return;
    accessLoading = true;
    Promise.all(repos.map(function (r) {
      return ws.access(r).then(function (a) { accessMap[r] = a; }, function (err) {
        accessMap[r] = { error: err.status === 403 || err.status === 404 ? 'needs an admin token' : err.message };
      });
    })).then(function () { accessLoading = false; if (ui.page === 'people') renderPage(); });
  }

  function repoName(full) { return full.split('/')[1]; }
  // For one person: the repos they should be on and aren't, and the ones with an invite pending.
  function accessGaps(u) {
    var ws = workspace(), want;
    if (u.role === 'fte') want = ws.fteRepos(stateNow());
    else want = (u.projects || []).map(function (id) { return M.sharedRepo(roster, id); }).filter(Boolean);
    var missing = [], pending = [], unknown = false;
    want.forEach(function (r) {
      var a = accessMap[r];
      if (!a || a.error) { unknown = true; return; }
      if (a.collaborators.indexOf(u.login) >= 0) return;
      (a.invited.indexOf(u.login) >= 0 ? pending : missing).push(r);
    });
    var unshared = u.role === 'contractor' ? (u.projects || []).filter(function (id) { return !M.sharedRepo(roster, id); }) : [];
    return { want: want, missing: missing, pending: pending, unknown: unknown, unshared: unshared };
  }

  function accessCell(u) {
    if (u.login === String(settings.owner).toLowerCase()) return '<span class="res fixed">Owner</span>';
    if (!getToken()) return '<span class="muted">Sync to check</span>';
    if (accessLoading) return '<span class="muted">Checking…</span>';
    var g = accessGaps(u);
    if (g.unknown && !g.missing.length) return '<span class="muted">Only the owner can see this</span>';
    var parts = [];
    if (g.missing.length || g.unshared.length) {
      parts.push('<span class="res open">' + (g.missing.length ? 'Not on ' + g.missing.map(repoName).join(', ') : plural(g.unshared.length, 'project') + ' not shared yet') + '</span>');
      parts.push('<button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="fix-access" data-login="' + esc(u.login) + '">Give access</button>');
    }
    if (g.pending.length) parts.push('<span class="res waived">Invite pending' + (g.pending.length > 1 ? ' ×' + g.pending.length : '') + '</span>');
    if (!parts.length) parts.push('<span class="res fixed">' + (u.role === 'fte' ? 'All repos' : g.want.length ? 'Has access' : 'No projects') + '</span>');
    return parts.join(' ');
  }

  function peoplePage() {
    loadAccess(false);
    var people = M.liveUsers(roster);
    var byId = stateNow().projects;
    var html = '<div class="page"><div class="cl-head"><div><div class="eyebrow">' + esc(settings.owner) + '</div><h1 class="page-title">People &amp; access</h1>' +
      '<div class="page-sub"><span>FTEs can open every project. A contractor can open only the projects shared with them, each in its own private repository.</span></div></div>' +
      '<div style="display:flex;gap:8px"><button class="btn" data-act="refresh-access">Refresh</button><button class="btn btn-primary" data-act="add-person">Add person</button></div></div>';
    if (!isOwner()) {
      html += '<div class="card" style="padding:14px 18px;margin-bottom:14px;font-size:13.5px">Only <b>' + esc(settings.owner) + '</b> can create project repositories and invite people while the repos are in a personal account. You can still edit this list; the owner applies the access.</div>';
    }
    if (!people.length) {
      html += '<div class="card" style="padding:18px 20px;margin-bottom:14px"><b>No one is listed yet.</b> Add yourself and the other FTEs first, then contractors.' +
        (settings.login ? ' <button class="btn btn-plain" data-act="add-self">Add me (' + esc(settings.login) + ') as FTE</button>' : '') + '</div>';
    } else {
      html += '<div class="card" style="overflow:hidden"><table class="table people"><thead><tr><th>Person</th><th>Role</th><th>Projects</th><th>GitHub access</th><th></th></tr></thead><tbody>' +
        people.map(function (u) {
          var projs = u.role === 'fte' ? '<span class="muted">All projects</span>' :
            ((u.projects || []).map(function (id) { return byId[id] ? '<span class="chip">' + esc(byId[id].meta.name) + '</span>' : ''; }).join(' ') || '<span class="muted">None yet</span>') +
            ' <button class="btn btn-plain" style="padding:2px 8px;font-size:12px" data-act="person-projects" data-login="' + esc(u.login) + '">Edit</button>';
          return '<tr><td><div style="display:flex;gap:10px;align-items:center">' + avatar(u.name || u.login) + '<div><div>' + esc(u.name || u.login) + (u.login === settings.login ? ' <span class="muted">(you)</span>' : '') + '</div><div class="muted">@' + esc(u.login) + '</div></div></div></td>' +
            '<td><div class="seg">' + [['fte', 'FTE'], ['contractor', 'Contractor']].map(function (r) {
              return '<button class="' + (u.role === r[0] ? 'on' : '') + '" data-act="person-role" data-login="' + esc(u.login) + '" data-role="' + r[0] + '">' + r[1] + '</button>';
            }).join('') + '</div></td>' +
            '<td style="max-width:300px">' + projs + '</td>' +
            '<td style="max-width:260px">' + accessCell(u) + '</td>' +
            '<td><button class="cmt-del" style="opacity:1" data-act="remove-person" data-login="' + esc(u.login) + '">Remove</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var sharedIds = Object.keys(roster.shared || {}).filter(function (id) { return M.sharedRepo(roster, id); });
    if (sharedIds.length) {
      html += '<div class="section-title">Shared project repositories</div><div class="card" style="overflow:hidden"><table class="table people"><thead><tr><th>Project</th><th>Repository</th><th>Contractors</th></tr></thead><tbody>' +
        sharedIds.map(function (id) {
          var repo = M.sharedRepo(roster, id), p = byId[id];
          var names = assignedContractors(id).map(function (u) { return esc(u.name || u.login); }).join(', ') || '<span class="muted">None</span>';
          return '<tr><td>' + esc(p ? p.meta.name : roster.shared[id].name || id) + '</td><td><a href="https://github.com/' + esc(repo) + '" target="_blank" rel="noopener">' + esc(repo) + '</a></td><td>' + names + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '<p class="note" style="margin-top:14px">Internal projects live in <b>' + esc(settings.dataRepo) + '</b>, which only FTEs can open. ' +
      'Adding a contractor to a project moves it into its own private <b>' + esc(settings.prefix) + '…</b> repository and invites them to that one repository only. ' +
      (settings.suiteRepos.length ? 'FTEs are also invited to ' + settings.suiteRepos.map(function (r) { return '<b>' + esc(r) + '</b>'; }).join(', ') + '; the other tool’s shared projects are granted from its own People page. ' : '') +
      'On a personal account every collaborator can push to the repositories they’re on; an organization allows narrower roles.</p></div>';
    return html;
  }

  function personSheet(login) {
    var u = login ? roster.users[login] : null;
    var list = visibleProjects().filter(function (p) { return !p.meta.archived; }).sort(function (a, b) { return a.meta.name.localeCompare(b.meta.name); });
    var role = u ? u.role : 'contractor';
    var picked = u ? (u.projects || []).slice() : [];
    var w = sheet('<div class="sheet-head"><h2>' + (u ? esc(u.name || u.login) : 'Add person') + '</h2><p>' + (u ? 'Choose the projects this contractor works on. Each one is shared through its own private repository.' : 'They’ll need a free GitHub account. Use their GitHub username here.') + '</p></div>' +
      '<div class="sheet-body">' +
      (u ? '' : '<div class="row2"><div class="field"><label for="p-name">Name</label><input class="input" id="p-name" placeholder="First Last"></div>' +
        '<div class="field"><label for="p-login">GitHub username</label><input class="input" id="p-login" placeholder="username" autocomplete="off"></div></div>' +
        '<div class="field"><span class="field-label">Role</span><div class="seg full" id="p-role"><button type="button" data-role="fte">FTE — every project</button><button type="button" class="on" data-role="contractor">Contractor — chosen projects</button></div></div>') +
      '<div class="field" id="p-projects-field"' + (role === 'fte' ? ' hidden' : '') + '><span class="field-label">Projects</span><div class="pick-grid" id="p-projects">' +
      (list.length ? list.map(function (p) {
        var shared = !!M.sharedRepo(roster, p.id);
        return '<button type="button" class="pick' + (picked.indexOf(p.id) >= 0 ? ' on' : '') + '" data-pick="' + esc(p.id) + '"><b>' + esc(p.meta.name) + '</b><span>' + (shared ? 'Shared' : 'Internal') + (p.meta.client ? ' · ' + esc(p.meta.client) : '') + '</span></button>';
      }).join('') : '<p class="note">No projects yet.</p>') + '</div></div>' +
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
    var lines = [];
    if (toShare.length) lines.push('Move ' + toShare.map(function (id) { return byId[id] ? byId[id].meta.name : id; }).join(', ') + ' into ' + (toShare.length === 1 ? 'its own private repository' : 'their own private repositories'));
    if (added.length) lines.push('Invite ' + login + ' to ' + plural(added.length, 'project'));
    if (removed.length) lines.push('Remove ' + login + ' from ' + plural(removed.length, 'project'));
    if (!confirm(lines.join('\n') + '\n\nGitHub emails the invitations. Go ahead?')) { toast('Saved in People. Use “Give access” when you’re ready.'); return; }
    runAccessOps('Updating access for ' + login, [{ login: login, share: toShare, invite: added.filter(function (id) { return toShare.indexOf(id) < 0; }), revoke: removed }]);
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
      ui2.done(); accessMap = {}; persist(); sync(); if (ui.page === 'people') renderPage();
    });
  }

  // Invite (or share) whatever this person is missing according to the People list.
  function fixAccess(login) {
    var u = roster.users[login];
    if (!u || !getToken()) return;
    var g = accessGaps(u);
    var repos = u.role === 'fte' ? (Object.keys(accessMap).length ? g.missing : workspace().fteRepos(stateNow())) : [];
    var invite = u.role === 'contractor' ? (u.projects || []).filter(function (id) { var r = M.sharedRepo(roster, id); return r && (g.missing.indexOf(r) >= 0 || !accessMap[r]); }) : [];
    var share = g.unshared;
    if (!repos.length && !invite.length && !share.length) { toast((u.name || login) + ' already has access'); return; }
    var what = u.role === 'fte' ? 'Invite ' + login + ' to ' + repos.map(repoName).join(', ') :
      (share.length ? 'Share ' + plural(share.length, 'project') + ' (each gets its own private repository) and invite ' + login : 'Invite ' + login + ' to ' + plural(invite.length, 'project repository', 'project repositories'));
    if (!confirm(what + '?\n\nGitHub emails the invitations.')) return;
    runAccessOps('Giving access to ' + login, [{ login: login, repos: repos, invite: invite, share: share }]);
  }

  // ── Invitations waiting for me ───────────────────────────
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
    if (!confirm('Discard unsynced changes?\n\n' + names.join('\n') + '\n\nThey go back to the last version on GitHub. A project that was never synced is removed from this browser. This can’t be undone.')) return;
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
      if (removed) parts.push(plural(removed, 'unsynced project') + ' removed');
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
    syncing = true; renderSyncState('busy');
    var started = Object.assign({}, dirty);
    var st0 = stateNow();
    var names = Object.keys(dirty).map(function (k) { return k === 'roster' ? 'people' : st0.projects[k] ? st0.projects[k].meta.name : k; });
    var message = names.length ? 'Review update: ' + names.join(', ') + ' (' + me() + ')' : 'Review update (' + me() + ')';
    var currentId = projects[ui.slug] && projects[ui.slug].id;
    workspace().sync(st0, { message: message, onRetry: function () { toast('Someone else just synced — merging their changes'); } })
      .then(function (res) {
        var st = res.state;
        if (res.userName && !settings.user) settings.user = res.userName;
        settings.login = st.login; save('settings', settings);
        // Edits made while the sync ran are merged on top, and stay unsynced.
        var nowById = stateNow().projects, merged = {};
        Object.keys(st.projects).forEach(function (id) { merged[id] = nowById[id] ? M.mergeProjects(nowById[id], st.projects[id]) : st.projects[id]; });
        // Projects that only exist locally and weren't touched by this sync (e.g. its repo
        // failed) are kept.
        Object.keys(nowById).forEach(function (id) { if (!merged[id] && res.dropped.indexOf(id) < 0) merged[id] = nowById[id]; });
        // Slugs are only local handles for the sidebar; two projects with one name get a suffix.
        var next = {};
        Object.keys(merged).forEach(function (id) {
          var doc = merged[id], base = doc.slug || M.slugify(doc.meta.name), slug = base, n = 2;
          while (next[slug]) slug = base + '-' + n++;
          next[slug] = doc;
        });
        projects = next;
        homes = st.homes; cache = st.cache; dataAccess = st.dataAccess;
        roster = M.mergeRosters(roster, st.roster);
        var failedRepos = res.errors.map(function (e) { return e.repo; });
        Object.keys(started).forEach(function (k) {
          if (dirty[k] !== started[k]) return;
          var repo = k === 'roster' ? settings.owner + '/' + settings.dataRepo : st.homes[k] || (settings.owner + '/' + settings.dataRepo);
          if (failedRepos.indexOf(repo) < 0) delete dirty[k];
        });
        res.dropped.forEach(function (id) { delete dirty[id]; });
        ui.slug = Object.keys(projects).filter(function (k) { return projects[k].id === currentId; })[0] || '';
        if (res.templates && res.templates.length) { pulledTemplates = res.templates; save('templates', pulledTemplates); refreshTemplates(); }
        invitations = res.invitations || [];
        lastSync = { at: M.now(), version: res.version || (lastSync && lastSync.version), errors: res.errors };
        save('cache2', cache); save('lastSync', lastSync); save('dataAccess', dataAccess); save('invitations', invitations); persist();
        lastError = res.errors.length ? res.errors[0].message : '';
        syncing = false;
        render();
        if (res.dropped.length) toast(plural(res.dropped.length, 'project') + ' no longer shared with you ' + (res.dropped.length === 1 ? 'was' : 'were') + ' removed from this browser');
        if (res.errors.length) toast(res.errors[0].message + (res.errors.length > 1 ? ' (+' + (res.errors.length - 1) + ' more)' : ''));
        else toast(res.pushed ? 'Synced — ' + plural(res.pushed, 'change') + ' pushed' : 'Up to date');
        if (syncAgain) { syncAgain = false; sync(); }
      })
      .catch(function (err) {
        syncing = false; syncAgain = false; lastError = err.message;
        renderSyncState('error');
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
      '<div class="r-head"><div><div class="r-brand"><svg width="14" height="16" viewBox="0 0 16 18"><path d="M0 0h6v7.6L0 8.4zM0 9.6l6 .8V18H0z" fill="#004952"/><path d="M7 0l9 3v12l-9 3v-7.4l5-.9V8.3l-5-.9z" fill="#004952"/></svg>DOVETAIL · ' + esc(C.tagline.toUpperCase()) + '</div>' +
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
          var r = x.row, res = r.state.resolution;
          var cm = M.liveComments(p, r.id);
          return '<tr><td>' + (i + 1) + '</td><td><span class="sev ' + r.severity + '">' + r.severity[0].toUpperCase() + r.severity.slice(1) + '</span></td><td><b style="font-weight:500">' + esc(r.def.text) + '</b><div class="r-cmt">' + esc(x.template.short + ' › ' + x.section.title) + (r.state.ref ? ' · ' + esc(r.state.ref) : '') + '</div>' +
            cm.map(function (c) { return '<div class="r-cmt">' + esc(c.author) + ' (' + fmtDate(c.at) + '): ' + esc(c.text) + '</div>'; }).join('') + '</td>' +
            '<td>' + esc(r.state.assignee || '—') + '</td><td>' + (res === 'fixed' ? 'Fixed' : res === 'waived' ? 'Waived' : 'Open') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p>No issues were raised.</p>') +
      (reqsOn(p) ? reqsReport(p) : '') +
      '<div class="sign"><div>Reviewed by</div><div>Approved by</div></div>' +
      '<div class="r-foot"><span>Generated by ' + esc(C.product) + ' ' + esc((window.SIGNOFF_VERSION || {}).hash || '') + '</span><span>' + esc(m.name) + '</span></div></div>';
    var r = $('#report'); r.innerHTML = html; r.hidden = false;
  }

  function exportCsv() {
    var p = current(); if (!p) return;
    var rows = [['Severity', 'Checklist', 'Section', 'Check', 'Reference', 'Owner', 'Status', 'Comments']];
    allFindings(p).forEach(function (x) {
      var r = x.row;
      rows.push([r.severity, x.template.title, x.section.title, r.def.text, r.state.ref || '', r.state.assignee || '',
        r.state.resolution || 'open', M.liveComments(p, r.id).map(function (c) { return c.author + ': ' + c.text; }).join(' | ')]);
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
      else { toast('Not a ' + C.product + ' project' + ((C.legacyTabs || []).length ? ' or old checklist export' : '')); return; }
      var slug = doc.slug || M.slugify(doc.meta.name);
      if (projects[slug] && projects[slug].id !== doc.id) { var n = 2; while (projects[slug + '-' + n]) n++; slug = slug + '-' + n; }
      doc.slug = slug;
      projects[slug] = M.mergeProjects(projects[slug], doc);
      ui.slug = slug; ui.view = 'overview';
      touch(projects[slug]); saveUi(); render();
      toast(M.isLegacy(data) ? 'Imported from the old checklist' : 'Project imported');
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
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
    return new Promise(function (resolve) {
      m.addEventListener('click', function (e) { var b = e.target.closest('[data-menu]'); if (b) { closeMenu(); resolve(b.dataset.menu); } });
    });
  }
  function closeMenu() { var m = $('#menu'); if (m) m.remove(); }

  function toast(text) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, 3200);
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
      var res = M.mergeLocalCopies(projects, theirs);
      if (!res.changed) return;
      projects = res.projects;
      save('projects', projects);
      render();
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
    if (!e.target.closest('#menu')) closeMenu();
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'new-project': if (isFte()) projectSheet(null); break;
      case 'people': ui.page = 'people'; selected = null; closeInspector(); renderSidebar(); renderPage(); $('#app').classList.remove('nav-open'); break;
      case 'edit-project': projectSheet(current()); break;
      case 'open-project':
        ui.slug = el.dataset.slug; ui.view = 'overview'; ui.page = ''; ui.query = ''; ui.filter = 'all'; selected = null;
        closeInspector(); saveUi(); render(); $('#app').classList.remove('nav-open'); $('#main').scrollTop = 0; break;
      case 'toggle-archived': ui.showArchived = !ui.showArchived; saveUi(); renderSidebar(); break;
      case 'view':
        ui.view = el.dataset.view; ui.query = ''; selected = null; closeInspector(); saveUi(); renderPage(); $('#main').scrollTop = 0; break;
      case 'filter': ui.filter = el.dataset.filter; saveUi(); renderPage(); break;
      case 'toggle-sec':
        if (e.target.closest('[data-act="sec-na"]')) return;
        collapsed[el.dataset.sec] = !collapsed[el.dataset.sec]; save('collapsed', collapsed);
        el.closest('.sec').classList.toggle('collapsed'); break;
      case 'collapse-all': {
        var secs = Array.prototype.map.call(document.querySelectorAll('.sec[data-sec]'), function (s) { return s.dataset.sec; });
        var all = secs.every(function (s) { return collapsed[s]; });
        secs.forEach(function (s) { collapsed[s] = !all; }); save('collapsed', collapsed); renderPage(); break;
      }
      case 'sec-na': e.stopPropagation(); toggleSectionNA(el.dataset.sec); break;
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
      case 'close-insp': closeInspector(); break;
      case 'post-comment': { var ta = $('#comment-input'); addComment(selected, ta.value); var t2 = $('#comment-input'); if (t2) { t2.value = ''; t2.focus(); } break; }
      case 'del-comment': if (confirm('Delete this comment?')) deleteComment(id); break;
      case 'req-add': addReq(); break;
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
        if (rd && confirm('Delete ' + rd.ref + '? Its discussion is kept in the project history.')) { setReq(selected, { deleted: true }); selected = null; closeInspector(); renderPage(); }
        break;
      }
      case 'delete-custom':
        if (confirm('Delete this project check?')) { var pp = current(); pp.custom[id] = M.stamp(Object.assign({}, pp.custom[id], { deleted: true }), me()); touch(pp); closeInspector(); renderPage(); }
        break;
      case 'goto-item': {
        if (!id) break;
        var d = itemDef(current(), id);
        if (d.template) { ui.view = d.template.id; ui.filter = 'all'; ui.query = ''; collapsed[(d.section || {}).id] = false; showHidden[(d.section || {}).id] = true; saveUi(); renderPage(); }
        select(id, true); break;
      }
      case 'discard': discard(); break;
      case 'open-fabcheck': { var w = window.open(el.dataset.href, 'dovetail-fabcheck'); if (w) w.focus(); break; }
      case 'sync': if (!DEMO && lastError && el.id === 'sync-pill' && !syncing) toast(lastError); sync(); break;
      case 'settings': settingsSheet(); break;
      case 'theme': toggleTheme(); break;
      case 'add-person': personSheet(null); break;
      case 'add-self': setPerson(settings.login, { name: settings.user || settings.login, role: 'fte', projects: [], deleted: false }); renderPage(); break;
      case 'fix-access': fixAccess(el.dataset.login); break;
      case 'refresh-access': accessMap = {}; loadAccess(true); renderPage(); break;
      case 'accept-invites': acceptInvitations(); break;
      case 'person-projects': personSheet(el.dataset.login); break;
      case 'person-role':
        if (el.dataset.login === settings.login && el.dataset.role !== 'fte' && !confirm('Make yourself a contractor? You would stop seeing most projects.')) break;
        if ((roster.users[el.dataset.login] || {}).role === el.dataset.role) break;
        setPerson(el.dataset.login, { role: el.dataset.role }); renderPage();
        if (el.dataset.role === 'fte') fixAccess(el.dataset.login);
        else if (getToken()) {
          var internal = workspace().internalRepos();
          if (confirm('Also remove ' + el.dataset.login + ' from ' + internal.map(repoName).join(', ') + ' on GitHub?')) runAccessOps('Removing FTE access', [{ login: el.dataset.login, revokeRepos: internal }]);
        }
        break;
      case 'remove-person':
        if (!confirm('Remove ' + el.dataset.login + ' from People?')) break;
        (function (login) {
          var u = roster.users[login], repos = u.role === 'fte' ? workspace().fteRepos(stateNow()) : (u.projects || []).map(function (id) { return M.sharedRepo(roster, id); }).filter(Boolean);
          setPerson(login, { deleted: true, projects: [] }); renderPage();
          if (getToken() && repos.length && confirm('Also take away their GitHub access to ' + repos.map(repoName).join(', ') + '?')) runAccessOps('Removing ' + login, [{ login: login, revokeRepos: repos }]);
        })(el.dataset.login);
        break;

      case 'report': openReport(); break;
      case 'close-report': $('#report').hidden = true; break;
      case 'print': window.print(); break;
      case 'export-csv': exportCsv(); break;
      case 'nav': toggleSidebar(); break;
      case 'project-menu':
        menu(el, (isFte() ? [['edit', 'Project details\u2026']] : []).concat([['report', 'Review report'], ['csv', 'Export findings (CSV)'], ['json', 'Export project (JSON)']],
          isFte() ? ['-', ['import', (C.legacyTabs || []).length ? 'Import project or old checklist\u2026' : 'Import project\u2026'], '-', ['archive', current().meta.archived ? 'Unarchive project' : 'Archive project', true]] : []))
          .then(function (choice) {
            if (choice === 'edit') projectSheet(current());
            else if (choice === 'report') openReport();
            else if (choice === 'csv') exportCsv();
            else if (choice === 'json') download(current().slug + '.json', M.stableStringify(current()));
            else if (choice === 'import') $('#import-file').click();
            else if (choice === 'archive') { updateMeta({ archived: !current().meta.archived }); }
          });
        break;
    }
  });

  document.addEventListener('keydown', function (e) {
    var inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); sync(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement.id === 'comment-input') { e.preventDefault(); $('[data-act="post-comment"]').click(); return; }
    if (e.key === 'Escape') {
      if ($('#sheet')) { closeSheet(); applyTheme(settings.theme); return; }
      if (!$('#report').hidden) { $('#report').hidden = true; return; }
      if (inField) { document.activeElement.blur(); return; }
      if ($('#inspector').classList.contains('open')) { closeInspector(); return; }
    }
    if (inField || e.ctrlKey || e.metaKey || e.altKey || $('#sheet')) return;
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
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.dataset && e.target.dataset.add && e.key === 'Enter') {
      var parts = e.target.dataset.add.split('|');
      var id = addCustom(parts[0], parts[1], e.target.value);
      if (id) { toast('Check added to this project'); var inp = document.querySelector('[data-add="' + parts[0] + '|' + parts[1] + '"]'); if (inp) inp.focus(); }
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
  $('#main').addEventListener('scroll', function () { $('#toolbar').classList.toggle('scrolled', $('#main').scrollTop > 60); }, { passive: true });

  // ── Boot ─────────────────────────────────────────────────
  function render() { renderSidebar(); renderSyncState(); renderPage(); renderInspector(); }

  applyTheme(settings.theme);
  if (ui.sideCollapsed && !narrow.matches) $('#app').classList.add('side-collapsed');
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
  if (!projects[ui.slug]) ui.slug = Object.keys(projects).filter(function (k) { return !projects[k].meta.archived; })[0] || '';
  render();
  if (!settings.user && !DEMO) settingsSheet();
  else if (!DEMO && getToken()) sync();
  setInterval(function () { renderSyncState(syncing ? 'busy' : undefined); }, 60000);

  S.app = { sync: sync, render: render };
})(window.Signoff = window.Signoff || {});
