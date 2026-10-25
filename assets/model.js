/* Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
   vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
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

  function uid(prefix) {
    return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
    var explicit = st.status && st.status !== 'open' ? st.status : '';
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
      severity: st.severity || def.severity || 'minor',
      comments: 0
    };
  }

  // Checks set aside by the board profile aren't counted at all (a new review starts at
  // 0%). Section N/A is a reviewer's decision, so those count as reviewed.
  function countStatuses(rows) {
    var c = { total: 0, pass: 0, issue: 0, na: 0, open: 0, reviewed: 0, issuesOpen: 0, outside: 0 };
    rows.forEach(function (r) {
      if (r.auto === 'profile') { c.outside++; return; }
      c.total++;
      c[r.status]++;
      if (r.status !== 'open') c.reviewed++;
      if (r.status === 'issue' && !r.state.resolution) c.issuesOpen++;
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
    ['items', 'sections', 'comments', 'custom', 'reqs'].forEach(function (k) {
      Object.keys(project[k] || {}).forEach(function (id) { see(project[k][id]); });
    });
    return last;
  }

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
          if (r.status !== 'issue' || r.auto === 'profile') return;
          var res = r.state.resolution;
          if (res) { issues[res]++; return; }
          issues.open[r.severity] = (issues.open[r.severity] || 0) + 1;
          var text = String(r.def.text || '');
          open.push({ id: r.id, severity: r.severity, text: text.length > 160 ? text.slice(0, 159) + '…' : text,
            checklist: t.short || t.title || t.id, assignee: r.state.assignee || '', ref: r.state.ref || '' });
        });
      });
    });
    var reqs = null;
    if (reqsEnabled(project)) {
      var q = reqStats(project);
      reqs = { total: q.total, approved: q.approved, pass: q.pass, fail: q.fail, open: q.open, unlinked: q.unlinked };
    }
    var last = lastEdit(project);
    return {
      v: 1,
      tool: C.discipline || '',
      name: meta.name, client: meta.client || '', number: meta.board || '', revision: meta.revision || '',
      stage: meta.stage || '', archived: !!meta.archived,
      total: stats.total, reviewed: stats.reviewed, pct: stats.pct,
      checklists: checklists, issues: issues, open: open.sort(function (a, b) { return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity); }),
      reqs: reqs,
      at: last.updatedAt || project.createdAt || '', by: last.updatedBy || ''
    };
  }

  // The document as written to its repository: the stored summary replaced by a fresh one.
  // A writer without checklists (Fabcheck) keeps the stored one; the next sync here renews it.
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
      // Derived (see projectSummary): carried along for writers that can't rebuild it.
      summary: local.summary && remote.summary && (local.summary.at || '') > (remote.summary.at || '') ? local.summary : remote.summary || local.summary
    };
  }

  // ── Requirements ─────────────────────────────────────────
  // A project's own requirements (not from a template), in project.reqs:
  //   { id, ref: 'REQ-001', text, kind: 'shall' | 'should', category, source,
  //     method: inspection | analysis | demonstration | test,
  //     status: draft | approved | changed | deprecated, verify: open | pass | fail, evidence,
  //     links: [check ids it traces to], createdAt, updatedAt, updatedBy, deleted }
  // Comments on a requirement are ordinary comments with item = the requirement's id.
  // A deprecated requirement is kept for reference (lined out) but no longer counts: it's left
  // out of the totals, verification and failing flags.
  var REQ_METHODS = ['inspection', 'analysis', 'demonstration', 'test'];
  var REQ_STATUS = ['draft', 'approved', 'changed', 'deprecated'];
  var REQ_VERIFY = ['open', 'pass', 'fail'];

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
      method: 'inspection', status: 'draft', verify: 'open', evidence: '', links: [], createdAt: t }, fields || {});
    return stamp(q, user);
  }

  // Every check in the project's checklists, by id: { status, text, template, section, custom }.
  function checkIndex(project, templates) {
    var out = {};
    templates.forEach(function (t) {
      if (project.meta.checklists.indexOf(t.id) < 0) return;
      checklistRows(project, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          out[r.id] = { id: r.id, status: r.status, text: r.def.text, template: t, section: g.section, custom: r.custom, resolution: (r.state || {}).resolution || '' };
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

  function reqStats(project) {
    var s = { total: 0, approved: 0, draft: 0, changed: 0, deprecated: 0, pass: 0, fail: 0, open: 0, unlinked: 0, duplicates: [] };
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
    status: /^(status|state)$/i
  };

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
    var rows = [['ID', 'Requirement', 'Type', 'Category', 'Source', 'Verification method', 'Status', 'Verified', 'Evidence', 'Traced checks', 'Trace status']];
    liveReqs(project).forEach(function (q) {
      var t = reqTrace(q, index);
      rows.push([q.ref, q.text, q.kind, q.category, q.source, q.method, q.status, q.verify, q.evidence,
        (q.links || []).map(function (id) {
          var c = index[id];
          return c ? c.text + ' [' + c.status + (c.resolution ? ', ' + c.resolution : '') + ']' : id + ' [no longer in the project]';
        }).join(' | '),
        t.state === 'none' ? 'not traced' : t.pass + ' pass, ' + t.issue + ' issue, ' + t.open + ' to review' + (t.na ? ', ' + t.na + ' N/A' : '')]);
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
    now: now, uid: uid, slugify: slugify, stamp: stamp,
    resolveTemplates: resolveTemplates, indexTemplates: indexTemplates, applies: applies,
    newProject: newProject, checklistRows: checklistRows, countStatuses: countStatuses,
    projectStats: projectStats, reqsEnabled: reqsEnabled, projectSummary: projectSummary, withSummary: withSummary,
    liveComments: liveComments, retiredItems: retiredItems,
    newer: newer, mergeMaps: mergeMaps, mergeProjects: mergeProjects, mergeLocalCopies: mergeLocalCopies,
    stableStringify: stableStringify, importLegacy: importLegacy, isLegacy: isLegacy,
    emptyRoster: emptyRoster, mergeRosters: mergeRosters, liveUsers: liveUsers, roleOf: roleOf, sharedRepo: sharedRepo,
    REQ_METHODS: REQ_METHODS, REQ_STATUS: REQ_STATUS, REQ_VERIFY: REQ_VERIFY,
    liveReqs: liveReqs, nextReqRef: nextReqRef, newReq: newReq, checkIndex: checkIndex, reqTrace: reqTrace, reqStats: reqStats,
    parseTable: parseTable, importReqs: importReqs, reqsCsv: reqsCsv
  };
})(window.Signoff = window.Signoff || {});
