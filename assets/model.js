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
      custom: {}
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
      custom: mergeMaps(local.custom, remote.custom)
    };
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
    projectStats: projectStats, liveComments: liveComments, retiredItems: retiredItems,
    newer: newer, mergeMaps: mergeMaps, mergeProjects: mergeProjects,
    stableStringify: stableStringify, importLegacy: importLegacy, isLegacy: isLegacy,
    emptyRoster: emptyRoster, mergeRosters: mergeRosters, liveUsers: liveUsers, roleOf: roleOf, sharedRepo: sharedRepo
  };
})(window.Signoff = window.Signoff || {});
