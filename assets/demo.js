/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Sample projects for demo mode (index.html?demo). Built from whatever templates are
   loaded, so the demo always matches the current checklists. Nothing here is real. */
(function (S) {
  'use strict';

  // Deterministic pseudo-random numbers, so every visitor sees the same demo.
  function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

  // The sample projects, findings, and comments are in assets/config.js (demo). Findings and
  // comments are pinned to specific checks. A project's `findings` / `comments` lists (ids)
  // say which ones it gets; without a list it gets every one whose check it has. Any whose
  // check isn't in a project's checklists, or is outside its profile, is skipped.
  var D = (window.SIGNOFF_CONFIG || {}).demo || {};
  var FINDINGS = D.findings || [];
  var COMMENTS = D.comments || [];

  function build(fields, templates, seed, passRatio, users, reqs, only) {
    var M = S.model, rand = rng(seed);
    var p = M.newProject(fields, users[0], templates);
    var day = 86400000, start = Date.now() - 12 * day;
    p.createdAt = new Date(start).toISOString();
    function at(frac) { return new Date(start + frac * 11 * day).toISOString(); }
    templates.forEach(function (t) {
      if (p.meta.checklists.indexOf(t.id) < 0) return;
      var ratio = passRatio[t.id] || 0;
      M.checklistRows(p, t).forEach(function (g) {
        g.rows.forEach(function (r) {
          if (r.hidden || rand() > ratio) return;
          var who = users[Math.floor(rand() * users.length)];
          p.items[r.id] = { status: rand() < 0.04 ? 'na' : 'pass', text: r.def.text, checklist: t.id, updatedAt: at(rand()), updatedBy: who };
        });
      });
    });
    function findRow(id) {
      var hit = null;
      templates.forEach(function (t) {
        if (hit || !passRatio[t.id] || p.meta.checklists.indexOf(t.id) < 0) return;
        M.checklistRows(p, t).forEach(function (g) {
          g.rows.forEach(function (r) { if (r.id === id && !r.hidden) hit = { r: r, t: t }; });
        });
      });
      return hit;
    }
    function wanted(list, id) { return !list || list.indexOf(id) >= 0; }
    // Times run through the review in the order each project's own findings appear, so they
    // stay in the past however many findings the tool defines.
    var nf = 0;
    FINDINGS.forEach(function (f, i) {
      if (!wanted(only.findings, f.id)) return;
      var h = findRow(f.id); if (!h) return;
      var t0 = 0.2 + 0.07 * nf++;
      p.items[h.r.id] = { status: 'issue', severity: f.sev, resolution: f.res, assignee: f.who, ref: f.ref, text: h.r.def.text, checklist: h.t.id, updatedAt: at(t0 + 0.2), updatedBy: f.by };
      f.notes.forEach(function (n, j) {
        var id = 'c' + seed + '-' + i + '-' + j, when = at(t0 + 0.1 * j);
        p.comments[id] = { id: id, item: h.r.id, author: j ? (f.who || users[1]) : f.by, at: when, text: n, updatedAt: when, updatedBy: f.by };
      });
    });
    var nc = 0;
    COMMENTS.forEach(function (c, i) {
      if (!wanted(only.comments, c.id)) return;
      var h = findRow(c.id); if (!h) return;
      var id = 'n' + seed + '-' + i, when = at(Math.min(0.95, 0.5 + 0.1 * nc++));
      p.comments[id] = { id: id, item: h.r.id, author: c.by, at: when, text: c.text, updatedAt: when, updatedBy: c.by };
    });
    // Fabcheck issues on the Fabrication & Release checklist, as Send to Signoff writes them, with
    // the run they came from (docs/fabcheck-link.md). The run opens in Fabcheck's demo.
    var fab = only.fabcheck;
    if (fab && p.meta.checklists.indexOf('fab') >= 0) {
      var run = JSON.parse(JSON.stringify(fab.run));
      if (typeof run.at === 'number') run.at = at(run.at);
      (fab.issues || []).forEach(function (f, i) {
        var when = at(Math.min(0.97, 0.87 + 0.01 * i)), by = run.by || users[0];
        p.custom[f.id] = { id: f.id, checklist: 'fab', section: f.section, text: f.text, hint: f.hint, severity: f.severity, createdAt: when, updatedAt: when, updatedBy: by, deleted: false,
          source: { tool: 'fabcheck', check: f.check, gone: false, run: run, locations: f.locations || [] } };
        p.items[f.id] = { status: 'issue', severity: f.severity, resolution: f.res || '', assignee: f.who || '', ref: f.ref || '', text: f.text, checklist: 'fab', updatedAt: when, updatedBy: by };
        var cid = 'f' + seed + '-' + i;
        p.comments[cid] = { id: cid, item: f.id, author: by, at: when, text: 'Raised by Fabcheck from ' + run.package.name.replace(/\.zip$/, '') + '.', updatedAt: when, updatedBy: by };
        (f.notes || []).forEach(function (n, j) {
          var id = cid + '-' + j, t = at(Math.min(0.99, 0.9 + 0.02 * i + 0.01 * j));
          p.comments[id] = { id: id, item: f.id, author: f.by || by, at: t, text: n, updatedAt: t, updatedBy: f.by || by };
        });
      });
      // The run tagged as a revision, as the Revisions tab does it ({ label, title, status, house,
      // sent and at as fractions of the review period, ref, notes, by }).
      var cleanRun = M.cleanRun({ run: run, findings: [] });
      (fab.revisions || []).forEach(function (v, i) {
        if (!cleanRun) return;
        var rec = M.newRevision(cleanRun, { label: v.label, title: v.title, status: v.status, house: v.house,
          sentAt: v.sent == null ? '' : at(v.sent).slice(0, 10), ref: v.ref, notes: v.notes }, v.by || run.by || users[0]);
        rec.id = 'v' + seed + '-' + i;
        rec.createdAt = rec.updatedAt = at(v.at == null ? 0.9 : v.at);
        p.revisions = p.revisions || {};
        p.revisions[rec.id] = rec;
      });
    }
    // Requirements, traced only to checks this project actually has.
    var known = M.checkIndex(p, templates);
    (reqs || []).forEach(function (r, i) {
      var when = at(0.05 + 0.04 * i);
      var q = M.newReq(p, { ref: r.ref, text: r.text, kind: r.kind || 'shall', category: r.category || '', source: r.source || '',
        method: r.method || 'inspection', status: r.status || 'draft', verify: r.verify || 'open', evidence: r.evidence || '',
        links: (r.links || []).filter(function (id) { return known[id]; }), createdAt: when }, r.by || users[0]);
      // Flow-down from Signoff PL's demo product (its fixed ids, signoff_pl/assets/demo.js).
      if (r.parent) q.parent = { tool: 'pl', project: r.parent.project, id: r.parent.id, ref: r.parent.ref, text: r.parent.text };
      q.id = 'q' + seed + '-' + i; q.updatedAt = when;
      p.reqs[q.id] = q;
    });
    // The description (config.spec), written as one text: refs and #titles resolve to the ids
    // above; sections get fixed ids so links into the demo keep working.
    if (only.spec && only.spec.length) {
      var recs = M.specSave(p, null, only.spec.join('\n'), users[0]), rename = {};
      recs.forEach(function (r, i) { rename[r.id] = 's' + seed + '-' + i; });
      p.spec = {};
      recs.forEach(function (r, i) {
        var when = at(0.3 + 0.6 * i / recs.length);
        r.id = rename[r.id]; r.createdAt = r.updatedAt = when; r.updatedBy = users[i % users.length];
        // Built, not edited: no history, so an older demo's copy (from a tab still open) merges newer-wins
        // instead of looking like two people's edits (mergeSpec would keep a conflict copy).
        delete r.hist;
        r.body = r.body.replace(/\bs:([\w-]+)/g, function (all, id) { return rename[id] ? 's:' + rename[id] : all; });
        p.spec[r.id] = r;
      });
    }
    // An MCU block's pin plan (config.pins: { '<section title>': '<global holding a part file>' }; EE's is
    // assets/demo-part.js): the part copied onto the section, as Start a pin plan does, so the pin map shows (2026-11-21).
    if (only.pins && p.spec) Object.keys(only.pins).forEach(function (title) {
      var file = typeof only.pins[title] === 'string' ? window[only.pins[title]] : only.pins[title];
      var part = file && M.specPinPart && M.specPinPart(file);
      var r = Object.keys(p.spec).map(function (k) { return p.spec[k]; }).filter(function (x) { return x.title === title; })[0];
      if (r && part) r.pins = { part: part };
    });
    // Bring-up reworks (config.rework), with pictures in assets/demo-previews/ and their discussion.
    if (only.rework && only.rework.length && M.reworkOn(p)) {
      p.rework = {};
      only.rework.forEach(function (w, i) {
        var id = 'w' + seed + '-' + i, when = at(w.at == null ? 0.5 : w.at), by = w.by || users[0];
        var pics = (w.pics || []).map(function (x) {
          return { id: x.id, file: x.id + '.' + M.REWORK_PIC_TYPES[x.type], type: x.type, w: x.w || 0, h: x.h || 0, sha256: '', name: x.name || '', at: when, by: by };
        });
        var steps = (w.steps || []).map(function (s, j) {
          return { id: 's' + seed + 'r' + i + 'n' + j, text: s.text || '', pics: (s.pics || []).map(function (x) {
            return { id: x.id, file: x.id + '.' + M.REWORK_PIC_TYPES[x.type], type: x.type, w: x.w || 0, h: x.h || 0, sha256: '', name: x.name || '', at: when, by: by };
          }) };
        });
        p.rework[id] = { id: id, ref: w.ref, title: w.title, problem: w.problem || '', fix: w.fix || '', parts: w.parts || '', nets: w.nets || '',
          status: w.status, next: !!w.next, by: w.by || '', doneAt: w.done == null ? '' : at(w.done).slice(0, 10), revision: '', pics: pics, steps: steps,
          createdAt: when, updatedAt: at(w.done == null ? w.at || 0.5 : w.done), updatedBy: by };
        (w.comments || []).forEach(function (c, j) {
          var cid = 'r' + seed + '-' + i + '-' + j, t = at(c.at == null ? 0.8 : c.at);
          p.comments[cid] = { id: cid, item: id, author: c.by, at: t, text: c.text, updatedAt: t, updatedBy: c.by };
        });
      });
    }
    // Firmware releases (config.releases): examples without files. { version, state, file, size, sha256, load,
    // notes, at, released, withdrawnWhy, by }, times as fractions of the review period; only.load is the target's own.
    if (M.releasesOn() && only.load) p.meta.load = M.cleanLoad(only.load, '');
    if (M.releasesOn() && only.releases && only.releases.length) {
      p.releases = {};
      only.releases.forEach(function (r, i) {
        var id = 'r' + seed + '-' + i, when = at(r.at == null ? 0.5 : r.at), kind = M.releaseKindOf(r.file);
        p.releases[id] = { id: id, version: r.version, state: r.state, file: { name: r.file, kind: kind, size: r.size || 0, sha256: r.sha256, parts: 0 },
          load: M.cleanLoad(r.load || only.load, kind), source: r.source || { repo: '', sha: '', dirty: false }, notes: r.notes || '',
          releasedAt: r.released == null ? '' : at(r.released).slice(0, 10), withdrawnWhy: r.withdrawnWhy || '',
          createdAt: when, updatedAt: at(r.updated == null ? (r.at == null ? 0.5 : r.at) : r.updated), updatedBy: r.by || users[0], deleted: false };
      });
    }
    p.meta.updatedAt = at(1);
    return p;
  }

  S.demo = {
    projects: function (templates) {
      return (D.projects || []).map(function (d) {
        var p = build(d.fields, templates, d.seed, d.ratios, d.users, d.requirements, { findings: d.findings, comments: d.comments, fabcheck: d.fabcheck, spec: d.spec, pins: d.pins, rework: d.rework, releases: d.releases, load: d.load });
        p.id = demoId(d.seed);
        return p;
      });
    },
    id: demoId,
    // Bump when demo ids or content change, so browsers holding an older demo rebuild it.
    VERSION: 23
  };
  // Fixed per sample project, so links into the demo (from Signoff PL's demo) keep working:
  // e.g. pdemo7 in Signoff EE, mdemo5 in Signoff ME.
  function demoId(seed) { return (((window.SIGNOFF_CONFIG || {}).ids || {}).project || 'p') + 'demo' + seed; }
})(window.Signoff = window.Signoff || {});
