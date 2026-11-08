/* Shared Signoff engine (EE, ME and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff data model: templates, project documents, progress and merging.
   Pure functions only (no DOM, no storage) so tests/test.html can exercise them. */
(function (S) {
  'use strict';

  var STATUSES = ['open', 'pass', 'issue', 'na'];
  var SEVERITIES = ['critical', 'major', 'minor'];
  var RESOLUTIONS = ['', 'fixed', 'waived'];

  // Discipline specifics (tags, stages, ID prefixes) come from assets/config.js, which
  // tools/validate_templates.py reads too.
  var C = S.config = window.SIGNOFF_CONFIG || {};
  var TAGS = C.tags || [];
  var STAGES = C.stages || [];
  var IDS = C.ids || {};

  function now() { return new Date().toISOString(); }

  // A value from a fixed list, or the fallback. Review files come from repositories other
  // people can write to, so a field that picks a CSS class or a label is never used as is.
  function oneOf(list, value, fallback) { return list.indexOf(value) >= 0 ? value : fallback; }

  function uid(prefix) {
    return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // A short fingerprint of a GitHub token (FNV-1a), so a tool notices when the token it shares
  // with the other Signoff tools has changed. It can't be turned back into the token.
  function tokenTag(token) {
    var h = 0x811c9dc5;
    token = String(token || '');
    for (var i = 0; i < token.length; i++) { h ^= token.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function slugify(text) {
    return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  }

  // ── Templates ────────────────────────────────────────────

  // Bundled templates (assets/templates.js) are the offline fallback. Templates pulled
  // from the repo win unless the bundled copy has a higher version (a newer local tool).
  function resolveTemplates(bundled, pulled) {
    var byId = {};
    (bundled || []).forEach(function (t) { byId[t.id] = t; });
    (pulled || []).forEach(function (t) {
      var b = byId[t.id];
      if (!b || (t.version || 0) >= (b.version || 0)) byId[t.id] = t;
    });
    var order = (bundled || []).map(function (t) { return t.id; });
    Object.keys(byId).forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    return order.map(function (id) { return byId[id]; });
  }

  function indexTemplates(templates) {
    var items = {}, sections = {};
    templates.forEach(function (t) {
      t.sections.forEach(function (s) {
        sections[s.id] = { template: t, section: s };
        s.items.forEach(function (it) { items[it.id] = { template: t, section: s, item: it }; });
      });
    });
    return { items: items, sections: sections };
  }

  function applies(tags, profile) {
    if (!tags || !tags.length) return true;
    for (var i = 0; i < tags.length; i++) if (profile.indexOf(tags[i]) >= 0) return true;
    return false;
  }

  // ── Project documents ────────────────────────────────────

  function newProject(fields, user, templates) {
    var t = now();
    var versions = {};
    (templates || []).forEach(function (tp) { versions[tp.id] = tp.version || 1; });
    return {
      schema: 1,
      id: uid(IDS.project || 'p'),
      slug: slugify(fields.name),
      createdAt: t,
      createdBy: user || '',
      templateVersions: versions,
      meta: {
        name: fields.name || 'Untitled project',
        project: fields.project || '',
        client: fields.client || '',
        board: fields.board || '',
        revision: fields.revision || '',
        stage: fields.stage || C.defaultStage || STAGES[0] || '',
        description: fields.description || '',
        profile: (fields.profile || []).slice(),
        checklists: (fields.checklists || []).slice(),
        archived: false,
        updatedAt: t,
        updatedBy: user || ''
      },
      items: {},
      sections: {},
      comments: {},
      custom: {},
      reqs: {}
    };
  }

  function stamp(rec, user) {
    rec.updatedAt = now();
    rec.updatedBy = user || '';
    return rec;
  }

  // The rows of one checklist in a project: template items in order, then the
  // project's custom items for each section. Each row carries its effective status.
  function checklistRows(project, template) {
    var profile = project.meta.profile || [];
    var customs = Object.keys(project.custom).map(function (k) { return project.custom[k]; })
      .filter(function (c) { return !c.deleted && c.checklist === template.id; })
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); });
    return template.sections.map(function (s) {
      var secState = project.sections[s.id] || {};
      var secApplies = applies(s.tags, profile);
      var rows = s.items.map(function (it) {
        return row(project, it.id, it, applies(it.tags, profile) && secApplies, !!secState.na, false);
      });
      customs.filter(function (c) { return c.section === s.id; }).forEach(function (c) {
        rows.push(row(project, c.id, c, true, !!secState.na, true));
      });
      return { section: s, state: secState, applies: secApplies, rows: rows };
    });
  }

  function row(project, id, def, applicable, sectionNA, custom) {
    var st = project.items[id] || {};
    var explicit = st.status && st.status !== 'open' ? oneOf(STATUSES, st.status, '') : '';
    var status;
    if (explicit) status = explicit;
    else if (sectionNA) status = 'na';
    else if (!applicable && !st.include) status = 'na';
    else status = 'open';
    return {
      id: id,
      def: def,
      state: st,
      status: status,
      auto: !explicit && status === 'na' ? (sectionNA ? 'section' : 'profile') : '',
      hidden: !applicable && !st.include && !explicit,
      custom: custom,
      // A reference copy, not a check: findings a checker (Fabcheck) waived, kept to read. Counted
      // nowhere (progress, issue tallies, the project summary), and shown as waived info.
      reference: !!(custom && def.reference === true),
      severity: oneOf(SEVERITIES, st.severity, oneOf(SEVERITIES, def.severity, 'minor')),
      resolution: oneOf(RESOLUTIONS, st.resolution, ''),
      comments: 0
    };
  }

  // Checks set aside by the board profile aren't counted at all (a new review starts at
  // 0%). Section N/A is a reviewer's decision, so those count as reviewed.
  // Reference rows (waived findings kept to read) aren't checks, so they count nowhere either.
  function countStatuses(rows) {
    var c = { total: 0, pass: 0, issue: 0, na: 0, open: 0, reviewed: 0, issuesOpen: 0, outside: 0, reference: 0 };
    rows.forEach(function (r) {
      if (r.reference) { c.reference++; return; }
      if (r.auto === 'profile') { c.outside++; return; }
      c.total++;
      c[r.status]++;
      if (r.status !== 'open') c.reviewed++;
      if (r.status === 'issue' && !r.resolution) c.issuesOpen++;
    });
    c.pct = c.total ? Math.round(100 * c.reviewed / c.total) : 0;
    return c;
  }

  function projectStats(project, templates) {
    var per = {}, all = [];
    templates.forEach(function (t) {
      if (project.meta.checklists.indexOf(t.id) < 0) return;
      var rows = [];
      checklistRows(project, t).forEach(function (g) { rows = rows.concat(g.rows); });
      per[t.id] = countStatuses(rows);
      all = all.concat(rows);
    });
    var total = countStatuses(all);
    total.per = per;
    return total;
  }

  // ── Summary ──────────────────────────────────────────────
  // A small digest written into each project file at sync (project.summary), so tools that
  // don't load this tool's checklists (Signoff PL) can show where a review stands. It is
  // derived, never merged: sync drops the old one and recomputes it from the document. It
  // depends only on the document and the checklists, so an unchanged project writes the same
  // bytes and isn't committed again. `at` / `by` are the latest edit in the document.
  function reqsEnabled(project) {
    if ((project.meta.checklists || []).indexOf('reqs') >= 0) return true;
    return !project.meta.reqsDecided && liveReqs(project).length > 0;
  }

  function lastEdit(project) {
    var last = { updatedAt: '', updatedBy: '' };
    function see(rec) { if (rec && newer(last, rec) === rec) last = rec; }
    see(project.meta);
    ['items', 'sections', 'comments', 'custom', 'reqs', 'revisions'].forEach(function (k) {
      Object.keys(project[k] || {}).forEach(function (id) { see(project[k][id]); });
    });
    return last;
  }

  // The records of a project edited after `since` (an ISO time; '' or missing: every record),
  // newest first, for the "unsynced changes" list. Read-only. Each entry:
  //   { kind: 'meta' | 'check' | 'section' | 'comment' | 'custom' | 'req' | 'revision',
  //     id, item (the check a comment or check record is about, '' if none),
  //     label (what it is), detail (its state or text), at, by, deleted }
  // Values come straight from the document (untrusted): callers escape them.
  function changesSince(project, since, templates) {
    var out = [], index = {}, cut = function (t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    since = since || '';
    try { index = checkIndex(project, templates || []); } catch (e) { /* no checklists: ids stand in */ }
    var secTitle = {};
    Object.keys(index).forEach(function (k) { var s = index[k].section; if (s && s.id && !secTitle[s.id]) secTitle[s.id] = cut(s.title, 120); });
    function checkText(id) { var c = id && index[id]; return c ? cut(c.text, 120) : String(id || ''); }
    function add(kind, rec, id, item, label, detail) {
      if (!rec || typeof rec !== 'object') return;
      var at = typeof rec.updatedAt === 'string' ? rec.updatedAt : '';
      if (since && !(at > since)) return;
      out.push({ kind: kind, id: String(id || ''), item: String(item || ''), label: label, detail: detail,
        at: at, by: typeof rec.updatedBy === 'string' ? rec.updatedBy : '', deleted: !!rec.deleted });
    }
    function each(k, fn) { var m = project[k] || {}; Object.keys(m).forEach(function (id) { fn(m[id] || {}, id); }); }
    add('meta', project.meta, project.id, '', 'Name, stage, profile or checklists', '');
    each('items', function (r, id) {
      var st = oneOf(STATUSES, r.status, ''), res = r.resolution ? oneOf(RESOLUTIONS, r.resolution, '') : '';
      add('check', r, id, id, checkText(id), (st || 'to review') + (res ? ', ' + res : ''));
    });
    each('sections', function (r, id) { add('section', r, id, '', 'Section: ' + (secTitle[id] || String(id)), r.na ? 'set aside (N/A)' : 'back in review'); });
    each('comments', function (r, id) {
      add('comment', r, id, r.item || '', r.item ? checkText(r.item) : 'Comment on the whole review', cut(r.text, 160));
    });
    each('custom', function (r, id) { add('custom', r, id, id, cut(r.text, 120) || String(id), 'added check'); });
    each('reqs', function (r, id) { add('req', r, id, '', ((r.ref ? r.ref + ' ' : '') + cut(r.text, 120)).trim() || String(id), oneOf(REQ_VERIFY, r.verify, 'open')); });
    each('revisions', function (r, id) { add('revision', r, id, '', 'Revision ' + cut(r.label, 40), oneOf(REV_STATUS, r.status, '')); });
    return out.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
  }

  var RECENT = 6;   // comments kept in summary.recent
  function projectSummary(project, templates) {
    var stats = projectStats(project, templates), meta = project.meta, checklists = {};
    var issues = { open: {}, fixed: 0, waived: 0 }, open = [];
    SEVERITIES.forEach(function (s) { issues.open[s] = 0; });
    templates.forEach(function (t) {
      if (meta.checklists.indexOf(t.id) < 0) return;
      var c = stats.per[t.id];
      checklists[t.id] = { name: t.short || t.title || t.id, total: c.total, reviewed: c.reviewed, pct: c.pct, issuesOpen: c.issuesOpen };
      checklistRows(project, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          if (r.status !== 'issue' || r.auto === 'profile' || r.reference) return;
          var res = r.resolution;
          if (res) { issues[res]++; return; }
          issues.open[r.severity] = (issues.open[r.severity] || 0) + 1;
          var text = String(r.def.text || '');
          open.push({ id: r.id, severity: r.severity, text: text.length > 160 ? text.slice(0, 159) + '…' : text,
            checklist: t.short || t.title || t.id, assignee: r.state.assignee || '', ref: r.state.ref || '' });
        });
      });
    });
    var reqs = null, reqList;
    if (reqsEnabled(project)) {
      var idx = checkIndex(project, templates), q = reqStats(project, idx);
      reqs = { total: q.total, approved: q.approved, pass: q.pass, fail: q.fail, risk: q.risk, open: q.open, unlinked: q.unlinked };
      reqList = reqSummaryList(project, idx);
    }
    // summary.recent: the latest discussion (newest first), for Signoff PL's Recent discussion.
    var index = checkIndex(project, templates), cut = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
    var recent = liveComments(project).filter(function (c) { return !(c.item && index[c.item] && index[c.item].reference); }).slice(-RECENT).reverse().map(function (c) {
      var chk = c.item && index[c.item];
      return { id: c.id, item: c.item || '', check: chk ? cut(chk.text, 160) : '', author: c.author || '', at: c.at || '', text: cut(c.text, 400) };
    });
    var last = lastEdit(project);
    // summary.revisions: the tagged revisions in order (Signoff PL, what was built for which
    // build). Left out while there are none, so reviews without any keep their bytes.
    var revs = liveRevisions(project).map(function (r) { return { label: r.label, status: r.status, sentAt: r.fab.sentAt }; });
    var out = {
      v: 1,
      tool: C.discipline || '',
      name: meta.name, project: meta.project || '', client: meta.client || '', number: meta.board || '', revision: meta.revision || '',
      stage: meta.stage || '', archived: !!meta.archived,
      total: stats.total, reviewed: stats.reviewed, pct: stats.pct,
      checklists: checklists, issues: issues, open: open.sort(function (a, b) { return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity); }),
      reqs: reqs, reqList: reqList, recent: recent,
      at: last.updatedAt || project.createdAt || '', by: last.updatedBy || ''
    };
    if (revs.length) out.revisions = revs;
    return out;
  }

  // summary.reqList: every requirement that isn't deleted (deprecated ones too, flagged by
  // status), with what Signoff PL shows and links by. `state` is reqState; `issues` are the
  // linked checks with an open issue (their detail is in summary.open). Text is cut to 500.
  function reqSummaryList(project, index) {
    return liveReqs(project).map(function (q) {
      var text = String(q.text || ''), parent = reqParent(q);
      var issues = (q.links || []).filter(function (id) { var c = index[id]; return c && c.status === 'issue' && !c.resolution; });
      var out = { id: q.id, ref: q.ref || '', text: text.length > 500 ? text.slice(0, 499) + '…' : text, discipline: reqDiscipline(q),
        kind: oneOf(['shall', 'should'], q.kind, 'shall'), category: q.category || '', method: oneOf(REQ_METHODS, q.method, 'inspection'),
        status: oneOf(REQ_STATUS, q.status, 'draft'), verify: oneOf(REQ_VERIFY, q.verify, 'open'), state: reqState(q, index),
        links: (q.links || []).length, issues: issues, at: q.updatedAt || '', by: q.updatedBy || '' };
      if (parent) out.parent = { tool: 'pl', project: parent.project, id: parent.id, ref: parent.ref };
      return out;
    });
  }

  // The document as written to its repository: the stored summary replaced by a fresh one.
  // A writer without checklists (Fabcheck) keeps the stored one; the next sync here renews it.
  // Reviews grouped by the client project they belong to (meta.project, e.g. one product's
  // boards), for the sidebar: [{ name, docs }], named groups A–Z (case-insensitive, trimmed),
  // then the reviews with no project under name ''. Each group keeps the order it was given.
  function projectGroups(docs) {
    var byKey = {}, order = [];
    docs.forEach(function (d) {
      var name = String((d.meta && d.meta.project) || '').trim(), key = name.toLowerCase();
      if (!byKey[key]) { byKey[key] = { name: name, docs: [] }; order.push(key); }
      byKey[key].docs.push(d);
    });
    return order.sort(function (a, b) { return (a === '') - (b === '') || a.localeCompare(b); }).map(function (k) { return byKey[k]; });
  }

  function withSummary(project, summarize) {
    if (!summarize) return project;
    var out = Object.assign({}, project);
    delete out.summary;
    try { out.summary = summarize(out); } catch (e) { /* no checklists yet: write without */ }
    return out;
  }

  function liveComments(project, itemId) {
    return Object.keys(project.comments).map(function (k) { return project.comments[k]; })
      .filter(function (c) { return !c.deleted && (itemId === undefined || c.item === itemId); })
      .sort(function (a, b) { return (a.at || '').localeCompare(b.at || ''); });
  }

  // Notes for the next revision: comments tagged @revnotes, grouped by the check they're on.
  // Newest first: groups by their latest tagged comment, and comments within a group. A custom
  // issue whose own text carries the tag forms a group too (comments may be empty).
  var REVNOTE = /(^|[^\w@])@revnotes\b/i;
  function isRevNote(text) { return REVNOTE.test(String(text || '')); }
  function stripRevNote(text) { return String(text || '').replace(/(^|[^\w@])@revnotes\b:?/ig, '$1').replace(/[ \t]{2,}/g, ' ').trim(); }
  function revNotes(project) {
    var groups = {}, order = [];
    function group(k, at) {
      if (!groups[k]) { groups[k] = { item: k, at: at || '', comments: [] }; order.push(k); }
      return groups[k];
    }
    liveComments(project).forEach(function (c) { if (isRevNote(c.text)) group(c.item || '', c.at).comments.push(c); });
    Object.keys(project.custom || {}).forEach(function (k) {
      var c = project.custom[k];
      if (c && !c.deleted && (isRevNote(c.text) || isRevNote(c.hint))) group(k, c.createdAt || c.updatedAt);
    });
    var latest = function (g) { return String((g.comments.length ? g.comments[0].at : g.at) || ''); };
    return order.map(function (k) { groups[k].comments.reverse(); return groups[k]; })
      .sort(function (a, b) { return latest(b).localeCompare(latest(a)); });
  }

  // Item states whose ID is in no current template and isn't a custom item:
  // the template retired them. Their state and comments are kept and shown.
  function retiredItems(project, index) {
    var ids = {};
    Object.keys(project.items).forEach(function (id) { ids[id] = 1; });
    liveComments(project).forEach(function (c) { if (c.item) ids[c.item] = 1; });
    return Object.keys(ids).filter(function (id) { return !index.items[id] && !project.custom[id]; });
  }

  // ── Merging ──────────────────────────────────────────────
  // Every record carries updatedAt / updatedBy; the newer one wins, key by key.
  // Deletions are tombstones (deleted: true), so merging never resurrects them.

  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ta = a.updatedAt || '', tb = b.updatedAt || '';
    if (ta !== tb) return ta > tb ? a : b;
    return (a.updatedBy || '') >= (b.updatedBy || '') ? a : b;
  }

  function mergeMaps(a, b) {
    var out = {};
    Object.keys(a || {}).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b || {}).forEach(function (k) { out[k] = newer(out[k], b[k]); });
    return out;
  }

  function mergeProjects(local, remote) {
    if (!local) return remote;
    if (!remote) return local;
    var versions = {};
    [remote.templateVersions || {}, local.templateVersions || {}].forEach(function (v) {
      Object.keys(v).forEach(function (k) { versions[k] = Math.max(versions[k] || 0, v[k]); });
    });
    return {
      schema: Math.max(local.schema || 1, remote.schema || 1),
      id: remote.id || local.id,
      slug: remote.slug || local.slug,
      createdAt: remote.createdAt < local.createdAt ? remote.createdAt : local.createdAt,
      createdBy: remote.createdBy || local.createdBy,
      templateVersions: versions,
      meta: newer(local.meta, remote.meta),
      items: mergeMaps(local.items, remote.items),
      sections: mergeMaps(local.sections, remote.sections),
      comments: mergeMaps(local.comments, remote.comments),
      custom: mergeMaps(local.custom, remote.custom),
      reqs: mergeMaps(local.reqs || {}, remote.reqs || {}),
      // Only once either copy has one, so documents without revisions keep their bytes.
      revisions: local.revisions || remote.revisions ? mergeMaps(local.revisions || {}, remote.revisions || {}) : undefined,
      // Derived (see projectSummary): carried along for writers that can't rebuild it.
      summary: local.summary && remote.summary && (local.summary.at || '') > (remote.summary.at || '') ? local.summary : remote.summary || local.summary
    };
  }

  // ── Requirements ─────────────────────────────────────────
  // A project's own requirements (not from a template), in project.reqs:
  //   { id, ref: 'REQ-001', text, kind: 'shall' | 'should', category, source,
  //     method: inspection | analysis | demonstration | test,
  //     status: draft | approved | changed | deprecated, verify: open | pass | fail, evidence,
  //     links: [check ids it traces to], createdAt, updatedAt, updatedBy, deleted,
  //     discipline: sys | ee | me | fw | other (missing: this tool's own),
  //     parent: { tool: 'pl', project, id, ref, text } when it flows down from a Signoff PL
  //             requirement. Written by PL; ref and text are a snapshot for people without PL. }
  // Comments on a requirement are ordinary comments with item = the requirement's id.
  // A deprecated requirement is kept for reference (lined out) but no longer counts: it's left
  // out of the totals, verification and failing flags.
  var REQ_METHODS = ['inspection', 'analysis', 'demonstration', 'test'];
  var REQ_STATUS = ['draft', 'approved', 'changed', 'deprecated'];
  var REQ_VERIFY = ['open', 'pass', 'fail'];
  var REQ_DISCIPLINES = ['sys', 'ee', 'me', 'fw', 'other'];

  // The discipline a requirement belongs to; records from before the field have this tool's.
  function ownDiscipline() {
    var d = String(C.discipline || '').toLowerCase();
    return d === 'pl' ? 'sys' : REQ_DISCIPLINES.indexOf(d) >= 0 ? d : 'other';
  }
  function reqDiscipline(q) { return oneOf(REQ_DISCIPLINES, q && q.discipline, ownDiscipline()); }

  // The PL requirement this one flows down from, or null. Review files are untrusted, so only
  // the known fields come through, as strings.
  function reqParent(q) {
    var p = q && q.parent;
    if (!p || typeof p !== 'object' || p.tool !== 'pl' || typeof p.id !== 'string' || typeof p.project !== 'string') return null;
    var s = function (v) { return typeof v === 'string' ? v.slice(0, 2000) : ''; };
    return { tool: 'pl', project: p.project.slice(0, 80), id: p.id.slice(0, 80), ref: s(p.ref).slice(0, 40), text: s(p.text) };
  }

  function refNumber(ref) { var m = /(\d+)\s*$/.exec(ref || ''); return m ? parseInt(m[1], 10) : 0; }

  function liveReqs(project) {
    var r = project.reqs || {};
    return Object.keys(r).map(function (k) { return r[k]; }).filter(function (q) { return !q.deleted; })
      .sort(function (a, b) {
        var pa = (a.ref || '').replace(/\d+\s*$/, ''), pb = (b.ref || '').replace(/\d+\s*$/, '');
        return pa.localeCompare(pb) || refNumber(a.ref) - refNumber(b.ref) || (a.createdAt || '').localeCompare(b.createdAt || '');
      });
  }

  // Next free ID, following the project's most-used numbering (an imported GEN-001… list goes on
  // with GEN-124), else REQ-001. Two people adding offline can pick the same number; the page flags it.
  function nextReqRef(project) {
    var counts = {}, max = {}, width = {};
    liveReqs(project).forEach(function (q) {
      var m = /^(.*?)(\d+)\s*$/.exec(q.ref || ''); if (!m) return;
      var pre = m[1];
      counts[pre] = (counts[pre] || 0) + 1;
      max[pre] = Math.max(max[pre] || 0, parseInt(m[2], 10));
      width[pre] = Math.max(width[pre] || 0, m[2].length);
    });
    var pre = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    return pre === undefined ? 'REQ-001' : pre + String(max[pre] + 1).padStart(width[pre], '0');
  }

  function newReq(project, fields, user) {
    var t = now();
    var q = Object.assign({ id: uid('q'), ref: nextReqRef(project), text: '', kind: 'shall', category: '', source: '',
      method: 'inspection', status: 'draft', verify: 'open', evidence: '', links: [], discipline: ownDiscipline(), createdAt: t }, fields || {});
    return stamp(q, user);
  }

  // Every check in the project's checklists, by id: { status, text, template, section, custom }.
  function checkIndex(project, templates) {
    var out = {};
    templates.forEach(function (t) {
      if (project.meta.checklists.indexOf(t.id) < 0) return;
      checklistRows(project, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          out[r.id] = { id: r.id, status: r.status, text: r.def.text, template: t, section: g.section, custom: r.custom, resolution: r.resolution, reference: r.reference };
        });
      });
    });
    return out;
  }

  // How the checks a requirement traces to stand: counts by status, plus links to checks that
  // no longer exist (removed custom checks, or checklists taken off the project).
  function reqTrace(req, index) {
    var t = { linked: 0, pass: 0, issue: 0, open: 0, na: 0, missing: 0 };
    (req.links || []).forEach(function (id) {
      var c = index[id];
      if (!c) { t.missing++; return; }
      t.linked++;
      // A fixed issue still needs checking again; a waived one has been accepted.
      if (c.status === 'issue' && c.resolution === 'fixed') t.open++;
      else if (c.status === 'issue' && c.resolution === 'waived') t.pass++;
      else t[c.status]++;
    });
    t.state = !t.linked ? 'none' : t.issue ? 'issue' : t.open ? 'open' : 'pass';
    return t;
  }

  // Where a requirement stands, worst first:
  //   deprecated; fail (its verification failed); risk (an open issue on a check it traces to,
  //   even if it was verified); pass (verified); open.
  function reqState(q, index) {
    if (q.status === 'deprecated') return 'deprecated';
    if (q.verify === 'fail') return 'fail';
    if (reqTrace(q, index || {}).state === 'issue') return 'risk';
    return q.verify === 'pass' ? 'pass' : 'open';
  }

  // With the check index, `risk` counts the requirements at risk (see reqState).
  function reqStats(project, index) {
    var s = { total: 0, approved: 0, draft: 0, changed: 0, deprecated: 0, pass: 0, fail: 0, open: 0, risk: 0, unlinked: 0, duplicates: [] };
    var seen = {};
    liveReqs(project).forEach(function (q) {
      var k = (q.ref || '').toUpperCase();
      if (k && seen[k]) s.duplicates.push(q.ref);
      seen[k] = 1;
      if (q.status === 'deprecated') { s.deprecated++; return; }
      s.total++;
      s[q.status] = (s[q.status] || 0) + 1;
      s[q.verify] = (s[q.verify] || 0) + 1;
      if (!(q.links || []).length) s.unlinked++;
      if (index && reqState(q, index) === 'risk') s.risk++;
    });
    return s;
  }

  // CSV or tab-separated text (as pasted from Excel) -> array of rows.
  function parseTable(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  }

  // Header names accepted when importing, by field.
  var REQ_COLUMNS = {
    ref: /^(id|ref|req(uirement)?\.?\s*(id|#|no\.?|number)|#)$/i,
    title: /^(name|title|short\s*name|summary)$/i,
    text: /^(requirement|text|description|statement|req(uirement)?\s*text)$/i,
    kind: /^(type|kind|shall\s*\/\s*should|level|priority)$/i,
    category: /^(category|area|group|sub-?\s*system)$/i,
    source: /^(source|spec|reference|doc(ument)?|origin|rationale)\b/i,
    method: /^(verification(\s*method)?|method|verify\s*by|v&v)$/i,
    status: /^(status|state)$/i,
    discipline: /^(discipline|class|classification|domain)$/i
  };

  // A spreadsheet's discipline words -> ours ('' keeps the requirement's own).
  function importDiscipline(raw) {
    if (!raw) return '';
    if (/^sys|system|product/.test(raw)) return 'sys';
    if (/^ee$|elec/.test(raw)) return 'ee';
    if (/^me$|mech/.test(raw)) return 'me';
    if (/^fw$|^sw$|firm|soft/.test(raw)) return 'fw';
    return 'other';
  }

  // A spreadsheet's status words -> ours ('' leaves the status as it is).
  function importStatus(raw) {
    if (/obsolete|deprecat|withdrawn|supersed|cancel|removed|deleted|retired/.test(raw)) return 'deprecated';
    if (/changed/.test(raw)) return 'changed';
    if (/approved|accepted|active|implemented|released|baselined/.test(raw)) return 'approved';
    return raw ? 'draft' : '';
  }

  // Rows (with a header row) -> requirement records for `project`. Rows whose ID matches an
  // existing requirement update it; the rest are added. Resolves { added, updated, skipped }.
  function importReqs(project, rows, user) {
    var res = { added: 0, updated: 0, skipped: 0, records: [] };
    if (rows.length < 2) return res;
    var head = rows[0].map(function (h) { return String(h).trim(); });
    var col = {};
    Object.keys(REQ_COLUMNS).forEach(function (f) {
      var i = head.findIndex(function (h) { return REQ_COLUMNS[f].test(h); });
      if (i >= 0) col[f] = i;
    });
    if (col.text === undefined) throw new Error('No "Requirement" (or "Text" / "Description") column in the first row');
    var byRef = {};
    liveReqs(project).forEach(function (q) { byRef[(q.ref || '').toUpperCase()] = q; });
    var scratch = { reqs: Object.assign({}, project.reqs || {}) };
    rows.slice(1).forEach(function (r) {
      var get = function (f) { return col[f] === undefined ? '' : String(r[col[f]] || '').trim(); };
      var text = get('text'), title = get('title');
      if (!text) { res.skipped++; return; }
      // A short name column ("Power input voltage") leads the statement, which often needs it.
      if (title && text.toLowerCase().indexOf(title.toLowerCase()) !== 0) text = title + ': ' + text;
      var kindRaw = get('kind').toLowerCase(), methodRaw = get('method').toLowerCase();
      var fields = {
        text: text,
        category: get('category'),
        source: get('source'),
        kind: /should|could|won'?t|may\b|desired|optional|goal|nice/.test(kindRaw) || (!kindRaw && /\bshould\b/i.test(text) && !/\bshall\b/i.test(text)) ? 'should' : 'shall',
        method: REQ_METHODS.filter(function (m) { return methodRaw.indexOf(m.slice(0, 4)) >= 0; })[0] || (methodRaw === 'i' ? 'inspection' : methodRaw === 'a' ? 'analysis' : methodRaw === 'd' ? 'demonstration' : methodRaw === 't' ? 'test' : 'inspection')
      };
      var status = importStatus(get('status').toLowerCase());
      if (status) fields.status = status;
      var discipline = importDiscipline(get('discipline').toLowerCase());
      if (discipline) fields.discipline = discipline;
      var ref = get('ref');
      var existing = ref && byRef[ref.toUpperCase()];
      var rec;
      if (existing) {
        rec = stamp(Object.assign({}, existing, fields, !status && existing.status === 'approved' && existing.text !== text ? { status: 'changed' } : {}), user);
        res.updated++;
      } else {
        rec = newReq(scratch, Object.assign(ref ? { ref: ref } : {}, fields), user);
        res.added++;
      }
      scratch.reqs[rec.id] = rec;
      if (rec.ref) byRef[rec.ref.toUpperCase()] = rec;
      res.records.push(rec);
    });
    return res;
  }

  function csvCell(v) { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }

  // Compliance matrix as CSV: one row per requirement, with what it traces to.
  function reqsCsv(project, index) {
    var rows = [['ID', 'Requirement', 'Type', 'Discipline', 'Category', 'Source', 'Parent', 'Verification method', 'Status', 'Verified', 'Evidence', 'Traced checks', 'Trace status', 'State']];
    liveReqs(project).forEach(function (q) {
      var t = reqTrace(q, index), parent = reqParent(q);
      rows.push([q.ref, q.text, q.kind, reqDiscipline(q), q.category, q.source, parent ? parent.ref + ' (Signoff PL)' : '', q.method, q.status, q.verify, q.evidence,
        (q.links || []).map(function (id) {
          var c = index[id];
          return c ? c.text + ' [' + c.status + (c.resolution ? ', ' + c.resolution : '') + ']' : id + ' [no longer in the project]';
        }).join(' | '),
        t.state === 'none' ? 'not traced' : t.pass + ' pass, ' + t.issue + ' issue, ' + t.open + ' to review' + (t.na ? ', ' + t.na + ' N/A' : ''),
        { fail: 'failing', risk: 'at risk', pass: 'verified', open: 'open', deprecated: 'deprecated' }[reqState(q, index)]]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  // Working copies (slug -> doc) written by another tab, or by Fabcheck's "Send to Signoff",
  // merged into ours. Projects match by id, not slug; a new one keeps its slug unless that
  // slug is taken here. changed is false when theirs adds nothing, so callers don't write back.
  function mergeLocalCopies(ours, theirs) {
    var out = {}, bySlug = {}, changed = false;
    Object.keys(ours || {}).forEach(function (slug) { out[slug] = ours[slug]; bySlug[ours[slug].id] = slug; });
    Object.keys(theirs || {}).forEach(function (slug) {
      var doc = theirs[slug];
      if (!doc || !doc.id || !doc.meta) return;
      var mine = bySlug[doc.id];
      if (mine) {
        var merged = mergeProjects(out[mine], doc);
        if (stableStringify(merged) !== stableStringify(out[mine])) { out[mine] = merged; changed = true; }
        return;
      }
      var free = slug, n = 2;
      while (out[free]) free = slug + '-' + n++;
      out[free] = doc; bySlug[doc.id] = free; changed = true;
    });
    return { projects: out, changed: changed };
  }

  // ── Revisions (docs/fabcheck-link.md, "Revisions") ────────
  // Tags on runs a checker stored with the review (Fabcheck's, for Signoff EE), in
  // project.revisions, merged like every other record:
  //   { id, label: '3.2', title, status: 'sent' | 'built' | 'withdrawn',
  //     source: { tool: 'fabcheck', run, at, package: { key, sha256, name }, zip: { path, sha256, size } | null },
  //     fab: { house, sentAt: 'YYYY-MM-DD', ref }, notes, createdAt, updatedAt, updatedBy, deleted }
  // A review round (later) adds `round` beside these fields.
  var REV_STATUS = ['sent', 'built', 'withdrawn'];
  var REV_STATUS_LABEL = { sent: 'Sent to fab', built: 'Used for builds', withdrawn: 'Withdrawn' };
  var RUN_ID = /^[A-Za-z0-9_-]{1,64}$/, HEX16 = /^[0-9a-f]{16}$/, HEX64 = /^[0-9a-f]{64}$/;
  function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
  function isoDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
  function isoTime(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) ? v : ''; }
  function hex(v, re) { v = typeof v === 'string' ? v.toLowerCase() : ''; return re.test(v) ? v : ''; }

  // A stored revision record as it's safe to use: known enums, text cut to size.
  function cleanRevision(r, key) {
    var src = r.source && typeof r.source === 'object' ? r.source : {};
    var pkg = src.package && typeof src.package === 'object' ? src.package : {};
    var zip = src.zip && typeof src.zip === 'object' ? src.zip : null;
    var fab = r.fab && typeof r.fab === 'object' ? r.fab : {};
    return {
      id: key, label: clip(r.label, 40), title: clip(r.title, 200), status: oneOf(REV_STATUS, r.status, 'sent'),
      source: { tool: oneOf(['fabcheck'], src.tool, ''), run: RUN_ID.test(src.run || '') ? src.run : '', at: isoTime(src.at),
        package: { key: hex(pkg.key, HEX16), sha256: hex(pkg.sha256, HEX64), name: clip(pkg.name, 200) },
        zip: zip ? { path: clip(zip.path, 400), sha256: hex(zip.sha256, HEX64), size: +zip.size || 0 } : null },
      fab: { house: clip(fab.house, 100), sentAt: isoDay(fab.sentAt), ref: clip(fab.ref, 100) },
      notes: clip(r.notes, 4000), createdAt: isoTime(r.createdAt), updatedAt: isoTime(r.updatedAt), updatedBy: clip(r.updatedBy, 100)
    };
  }

  // Live revisions, oldest first: by the run they tag, then when they were tagged. "Superseded"
  // and "latest" follow this order.
  function liveRevisions(project) {
    var r = project.revisions || {};
    // The id is the record's key, so an edit always lands on the record it came from.
    return Object.keys(r).filter(function (k) { var x = r[k]; return x && typeof x === 'object' && !x.deleted; })
      .map(function (k) { return cleanRevision(r[k], k); })
      .sort(function (a, b) {
        return (a.source.at || a.createdAt).localeCompare(b.source.at || b.createdAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      });
  }

  // The latest revision that wasn't withdrawn (else the latest), or null.
  function latestRevision(project) {
    var all = liveRevisions(project), live = all.filter(function (r) { return r.status !== 'withdrawn'; });
    return live[live.length - 1] || all[all.length - 1] || null;
  }

  // The revision that came after this one, skipping withdrawn ones; null for the latest.
  function supersededBy(project, id) {
    var all = liveRevisions(project), i = all.map(function (r) { return r.id; }).indexOf(id);
    if (i < 0 || all[i].status === 'withdrawn') return null;
    for (var j = i + 1; j < all.length; j++) if (all[j].status !== 'withdrawn') return all[j];
    return null;
  }

  // The revision a run is tagged as (the latest, if it's tagged twice), or null.
  function revisionForRun(project, runId) {
    var hits = runId ? liveRevisions(project).filter(function (r) { return r.source.run === runId; }) : [];
    return hits[hits.length - 1] || null;
  }

  // The suggested next label: the last number of the latest label, plus one (3.1 → 3.2, 3.9 →
  // 3.10). With none yet, the review's revision with .1, or 1.
  function nextRevLabel(project) {
    var all = liveRevisions(project), last = all[all.length - 1];
    if (last && /\d+(?!.*\d)/.test(last.label)) return last.label.replace(/(\d+)(?!.*\d)/, function (n) { return String(parseInt(n, 10) + 1); });
    var rev = String((project.meta && project.meta.revision) || '').trim();
    return rev ? rev + '.1' : '1';
  }

  // A new revision tagging `run` (cleanRun's shape). fields: { label, title, status, house, sentAt, ref, notes }.
  function newRevision(run, fields, user) {
    var t = now();
    return stamp({
      id: uid('v'), label: clip(fields.label, 40), title: clip(fields.title, 200), status: oneOf(REV_STATUS, fields.status, 'sent'),
      source: { tool: 'fabcheck', run: run.id, at: run.at, package: { key: run.package.key, sha256: run.package.sha256, name: run.package.name },
        zip: run.zip ? { path: run.zip.path, sha256: run.zip.sha256, size: run.zip.size } : null },
      fab: { house: clip(fields.house, 100), sentAt: isoDay(fields.sentAt), ref: clip(fields.ref, 100) },
      notes: clip(fields.notes, 4000), createdAt: t, deleted: false
    }, user);
  }

  // A run file Fabcheck stored ({ run, findings }, docs/fabcheck-link.md) as Signoff uses it, or
  // null if it isn't one. Anyone who can write the review's repo wrote it, so ids, hashes and
  // paths are checked and text is cut to size. The zip's place is kept relative to the run's
  // folder (`packages/<key>/<name>.zip`): its stored path can name the data repo's folder from
  // before the review was shared. `raw` is the record as stored, for handing on to Fabcheck.
  function cleanRun(file) {
    var run = file && file.run;
    if (!run || typeof run !== 'object' || !RUN_ID.test(run.id || '')) return null;
    var pkg = run.package && typeof run.package === 'object' ? run.package : {};
    var z = pkg.zip && typeof pkg.zip === 'object' ? pkg.zip : null, zip = null;
    var m = z && typeof z.path === 'string' && z.path.indexOf('..') < 0 && /(?:^|\/)packages\/([0-9a-f]{16})\/([\w.+-][\w.+ -]{0,150}\.zip)$/.exec(z.path);
    if (m && HEX64.test(String(z.sha256 || '').toLowerCase())) {
      zip = { rel: 'packages/' + m[1] + '/' + m[2], path: z.path, name: m[2], sha256: z.sha256.toLowerCase(), size: +z.size || 0, root: clip(z.root, 200),
        files: (Array.isArray(z.files) ? z.files : []).filter(function (f) { return f && typeof f === 'object'; }).slice(0, 2000).map(function (f) {
          return { path: clip(f.path, 400), to: clip(f.to, 400), size: +f.size || 0, sha256: hex(f.sha256, HEX64) };
        }) };
    }
    var sum = run.summary && typeof run.summary === 'object' ? run.summary : {}, set = run.settings && typeof run.settings === 'object' ? run.settings : {};
    return {
      id: run.id, at: isoTime(run.at), by: clip(run.by, 100),
      package: { key: hex(pkg.key, HEX16), sha256: hex(pkg.sha256, HEX64), name: clip(pkg.name, 200), size: +pkg.size || 0 },
      summary: { error: +sum.error || 0, warn: +sum.warn || 0, info: +sum.info || 0 },
      profile: clip(set.profileName || set.profile, 100), zip: zip,
      raw: run, findings: Array.isArray(file.findings) ? file.findings : []
    };
  }

  // Runs as the Revisions tab lists them: one group per package (by key), newest first, each with
  // its runs newest first.
  function groupRuns(runs) {
    var by = {}, order = [];
    runs.forEach(function (r) {
      var k = r.package.key || r.package.sha256 || r.id;
      if (!by[k]) { by[k] = { key: k, runs: [] }; order.push(k); }
      by[k].runs.push(r);
    });
    var newest = function (a, b) { return b.at.localeCompare(a.at) || b.id.localeCompare(a.id); };
    return order.map(function (k) { by[k].runs.sort(newest); return by[k]; })
      .sort(function (a, b) { return newest(a.runs[0], b.runs[0]); });
  }

  // A run's zip contents grouped by folder, as in the zip: [{ folder: 'Fabrication/Gerber', files:
  // [{ name, path, size }] }], Fabrication's folders first, then Assembly's, then the rest, then
  // files at the top.
  function zipFolders(zip) {
    var by = {}, root = zip && zip.root ? zip.root + '/' : '';
    ((zip && zip.files) || []).forEach(function (f) {
      var inZip = f.to && f.to.indexOf(root) === 0 ? f.to.slice(root.length) : (f.to || f.path);
      var cut = inZip.lastIndexOf('/'), folder = cut > 0 ? inZip.slice(0, cut) : '';
      (by[folder] = by[folder] || []).push({ name: cut > 0 ? inZip.slice(cut + 1) : inZip, path: f.path, size: f.size });
    });
    var rank = function (f) { var top = f.split('/')[0]; return top === 'Fabrication' ? 0 : top === 'Assembly' ? 1 : f ? 2 : 3; };
    return Object.keys(by).sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); }).map(function (f) {
      return { folder: f, files: by[f].sort(function (a, b) { return a.name.localeCompare(b.name); }) };
    });
  }

  // ── People ───────────────────────────────────────────────
  // users.json in the FTE-only data repo:
  //   users:  { login: { login, name, role: 'fte' | 'contractor', projects: [ids] } }
  //   shared: { projectId: { id, repo: 'owner/name', name } }  projects that live in their
  //           own private repository, so contractors can be given access to just that one.
  // GitHub collaborator lists decide who can actually open what; `projects` on a contractor
  // records who should be on which project, so the People page can flag differences.

  function emptyRoster() { return { schema: 1, users: {}, shared: {} }; }

  function mergeRosters(a, b) {
    return {
      schema: 1,
      users: mergeMaps((a && a.users) || {}, (b && b.users) || {}),
      shared: mergeMaps((a && a.shared) || {}, (b && b.shared) || {})
    };
  }

  function liveUsers(roster) {
    var users = (roster && roster.users) || {};
    return Object.keys(users).map(function (k) { return users[k]; }).filter(function (u) { return !u.deleted; })
      .sort(function (x, y) { return (x.role === y.role ? 0 : x.role === 'fte' ? -1 : 1) || (x.name || x.login).localeCompare(y.name || y.login); });
  }

  // The repository a shared project lives in ('owner/name'), or '' if it's internal.
  function sharedRepo(roster, projectId) {
    var s = roster && roster.shared && roster.shared[projectId];
    return s && !s.deleted ? s.repo : '';
  }

  // Role from the People list, for display. The repo owner is always an FTE, and so is
  // everyone while the list is empty (so the first person setting it up isn't locked out).
  function roleOf(login, roster, owner) {
    if (!login) return 'fte';
    login = login.toLowerCase();
    if (owner && owner.toLowerCase() === login) return 'fte';
    var people = liveUsers(roster);
    if (!people.length) return 'fte';
    var u = people.filter(function (x) { return x.login === login; })[0];
    return u ? u.role : 'none';
  }

  // JSON with sorted keys, so the same document always serializes the same way
  // and git diffs only show real changes.
  function stableStringify(value) {
    return JSON.stringify(sortKeys(value), null, 2) + '\n';
  }
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).sort().forEach(function (k) { if (v[k] !== undefined) out[k] = sortKeys(v[k]); });
      return out;
    }
    return v;
  }

  // ── Legacy import (design_review_checklists.html exports, version 3.0) ──
  // That tool stored checks[tab][itemId] = true | 'na' | false, sectionNA[tab][sectionId],
  // and the full (possibly edited) categories. Items it had that aren't in the current
  // templates come across as custom items.
  var LEGACY_TABS = C.legacyTabs || [];

  function importLegacy(data, user, templates) {
    var index = indexTemplates(templates);
    var p = newProject({
      name: data.projectName || 'Imported review',
      stage: C.defaultStage,
      checklists: LEGACY_TABS.filter(function (id) { return templates.some(function (t) { return t.id === id; }); })
    }, user, templates);
    var t = now();
    (data.categories || []).forEach(function (cats, tab) {
      var checklist = LEGACY_TABS[tab];
      var tpl = templates.filter(function (x) { return x.id === checklist; })[0];
      if (!tpl) return;
      (cats || []).forEach(function (cat) {
        // A section the user added in the old tool lands in the checklist's first section.
        var sec = index.sections[cat.id] ? cat.id : tpl.sections[0].id;
        (cat.items || []).forEach(function (it) {
          if (index.items[it.id]) return;
          p.custom[it.id] = { id: it.id, checklist: checklist, section: sec, text: it.text, hint: it.note || '',
            severity: 'minor', createdAt: t, updatedAt: t, updatedBy: user || '' };
        });
      });
    });
    (data.checks || []).forEach(function (checks) {
      Object.keys(checks || {}).forEach(function (id) {
        var v = checks[id];
        if (v === true) p.items[id] = { status: 'pass', updatedAt: t, updatedBy: user || '' };
        else if (v === 'na') p.items[id] = { status: 'na', updatedAt: t, updatedBy: user || '' };
      });
    });
    (data.sectionNA || []).forEach(function (sec) {
      Object.keys(sec || {}).forEach(function (id) {
        if (sec[id]) p.sections[id] = { na: true, updatedAt: t, updatedBy: user || '' };
      });
    });
    return p;
  }

  function isLegacy(data) {
    return LEGACY_TABS.length > 0 && !!data && Array.isArray(data.checks) && !data.meta;
  }

  S.model = {
    STATUSES: STATUSES, SEVERITIES: SEVERITIES, RESOLUTIONS: RESOLUTIONS, TAGS: TAGS, STAGES: STAGES,
    now: now, oneOf: oneOf, uid: uid, slugify: slugify, stamp: stamp, tokenTag: tokenTag,
    resolveTemplates: resolveTemplates, indexTemplates: indexTemplates, applies: applies,
    newProject: newProject, checklistRows: checklistRows, countStatuses: countStatuses,
    projectStats: projectStats, reqsEnabled: reqsEnabled, projectSummary: projectSummary, withSummary: withSummary, projectGroups: projectGroups,
    liveComments: liveComments, retiredItems: retiredItems, changesSince: changesSince,
    isRevNote: isRevNote, stripRevNote: stripRevNote, revNotes: revNotes,
    newer: newer, mergeMaps: mergeMaps, mergeProjects: mergeProjects, mergeLocalCopies: mergeLocalCopies,
    stableStringify: stableStringify, importLegacy: importLegacy, isLegacy: isLegacy,
    emptyRoster: emptyRoster, mergeRosters: mergeRosters, liveUsers: liveUsers, roleOf: roleOf, sharedRepo: sharedRepo,
    REQ_METHODS: REQ_METHODS, REQ_STATUS: REQ_STATUS, REQ_VERIFY: REQ_VERIFY, REQ_DISCIPLINES: REQ_DISCIPLINES,
    liveReqs: liveReqs, nextReqRef: nextReqRef, newReq: newReq, checkIndex: checkIndex, reqTrace: reqTrace, reqStats: reqStats,
    reqState: reqState, reqDiscipline: reqDiscipline, ownDiscipline: ownDiscipline, reqParent: reqParent, reqSummaryList: reqSummaryList,
    parseTable: parseTable, importReqs: importReqs, reqsCsv: reqsCsv,
    REV_STATUS: REV_STATUS, REV_STATUS_LABEL: REV_STATUS_LABEL, liveRevisions: liveRevisions, latestRevision: latestRevision,
    supersededBy: supersededBy, revisionForRun: revisionForRun, nextRevLabel: nextRevLabel, newRevision: newRevision,
    cleanRevision: cleanRevision, cleanRun: cleanRun, groupRuns: groupRuns, zipFolders: zipFolders
  };
})(window.Signoff = window.Signoff || {});
