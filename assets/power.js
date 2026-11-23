/* Signoff power budget (Scribe EE's Power tab; Chris, 2026-11-23, from lab/power-budget.html). Engine file.
   Power parameters live in each block's Power line, as more words in a rail's brackets:
     Power: 5V (sink, 4.5–5.5 V, 72 mA, max 144 mA), 3V3 (source, 3.25–3.35 V, up to 2 A, buck 88%)
   model.specPowerItems reads rail, role, and "no tree" from the same text and specPowerText keeps the rest; this
   file reads the numbers (parse) and writes them back (write), each word kept as written unless its field changed.
   The budget follows the power tree, by rail name: a rail's load is what its sinks draw, a converter's input is
   worked out from its outputs (efficiency, quiescent current when linear, or pass-through), and the blocks that
   make a rail and use none are the input. Pure apart from the HTML its views return. window.SignoffPower. */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ── Numbers and units ──
  function num(s) { var x = parseFloat(String(s).replace(',', '.')); return isFinite(x) ? x : null; }
  function tidy(x, p) { return String(+(+x).toPrecision(p || 4)); }
  function toMa(v, u) { u = String(u || '').toLowerCase(); return u === 'a' ? v * 1000 : u === 'µa' || u === 'ua' ? v / 1000 : v; }
  function toW(v, u) { return String(u).toLowerCase() === 'mw' ? v / 1000 : v; }
  function fmtI(ma) {
    if (ma == null || !isFinite(ma)) return '—';
    var a = Math.abs(ma);
    return a >= 1000 ? tidy(ma / 1000, 3) + ' A' : a < 1 && a > 0 ? tidy(ma * 1000, 3) + ' µA' : tidy(ma, 3) + ' mA';
  }
  function fmtP(w) {
    if (w == null || !isFinite(w)) return '—';
    return Math.abs(w) >= 1 ? tidy(w, 3) + ' W' : tidy(w * 1000, 3) + ' mW';
  }
  function fmtV(a, b) { return a == null && b == null ? '' : a === b || b == null ? tidy(a) + ' V' : a == null ? tidy(b) + ' V' : tidy(a) + '–' + tidy(b) + ' V'; }
  function pct(x) { return Math.round(x * 100) + '%'; }

  // ── Read and write a Power line ──
  // Words in a rail's brackets: source | sink, a voltage or range ("3.0–3.6 V", "3.3 V", "3.3 V ±3%"), a current
  // ("80 mA", "max 350 mA"), a power ("0.2 W", "max 0.5 W"), "up to 2 A" (a source's capacity), a converter
  // ("buck 88%", "88%", "switching", "linear", "LDO", "Iq 50 µA", "pass-through"), "limit 1.5 W" (an input's
  // budget), "no budget", and "no tree". Anything else is kept as written (extra).
  var CONV = /^(buck|boost|buck-boost|sepic|flyback|switching|switcher|converter|dc-dc)$/i;
  var GROUPS = ['role', 'v', 'ityp', 'imax', 'ptyp', 'pmax', 'cap', 'conv', 'iq', 'limit', 'budget', 'tree'];
  function groupVals(o) {
    return { role: o.role, v: [o.vmin, o.vmax], ityp: o.ityp, imax: o.imax, ptyp: o.ptyp, pmax: o.pmax, cap: o.cap, conv: [o.conv, o.eff, o.convWord], iq: o.iq, limit: o.limit, budget: o.budget, tree: o.tree };
  }
  function wordGroup(w) { var l = w.toLowerCase(); return l === 'source' || l === 'sink' ? 'role' : l === 'tree' || l === 'no tree' ? 'tree' : 'extra'; }
  function parseWords(label) {
    var o = { role: 'sink', tree: true, budget: true, vmin: null, vmax: null, ityp: null, imax: null, ptyp: null, pmax: null, cap: null, conv: '', convWord: '', eff: null, iq: null, limit: null, extra: [], toks: [] };
    String(label || '').split(',').map(function (w) { return w.trim(); }).filter(Boolean).forEach(function (w) {
      var b0 = JSON.parse(JSON.stringify(groupVals(o))), nx = o.extra.length;
      word(w);
      var after = groupVals(o), g = GROUPS.filter(function (k) { return JSON.stringify(after[k]) !== JSON.stringify(b0[k]); });
      // "Iq …" also sets the converter to linear; it belongs to iq. A word that changes nothing is still its group's.
      o.toks.push({ w: w, g: o.extra.length > nx ? 'extra' : g.indexOf('iq') >= 0 ? 'iq' : g[0] || wordGroup(w) });
    });
    o.toks.forEach(function (t) { t.snap = t.g === 'extra' ? null : JSON.stringify(groupVals(o)[t.g]); });
    return o;
    function word(w) {
      var l = w.toLowerCase().replace(/\s+/g, ' '), m;
      if (l === 'source' || l === 'sink') o.role = l;
      else if (l === 'no tree') o.tree = false;
      else if (l === 'tree') o.tree = true;
      else if (l === 'no budget') o.budget = false;
      else if ((m = /^([\d.]+)\s*(?:–|—|-|to)\s*([\d.]+)\s*v$/.exec(l))) { o.vmin = num(m[1]); o.vmax = num(m[2]); }
      else if ((m = /^([\d.]+)\s*v\s*±\s*([\d.]+)\s*%$/.exec(l))) { var v = num(m[1]), t = num(m[2]) / 100; o.vmin = +(v * (1 - t)).toPrecision(4); o.vmax = +(v * (1 + t)).toPrecision(4); }
      else if ((m = /^([\d.]+)\s*v$/.exec(l))) { o.vmin = o.vmax = num(m[1]); }
      else if ((m = /^up to ([\d.]+)\s*(µa|ua|ma|a)$/.exec(l))) o.cap = toMa(num(m[1]), m[2]);
      else if ((m = /^max ([\d.]+)\s*(µa|ua|ma|a)$/.exec(l))) o.imax = toMa(num(m[1]), m[2]);
      else if ((m = /^max ([\d.]+)\s*(mw|w)$/.exec(l))) o.pmax = toW(num(m[1]), m[2]);
      else if ((m = /^limit ([\d.]+)\s*(mw|w)$/.exec(l))) o.limit = toW(num(m[1]), m[2]);
      else if ((m = /^iq ([\d.]+)\s*(µa|ua|ma|a)$/.exec(l))) { o.iq = toMa(num(m[1]), m[2]); o.conv = 'linear'; }
      else if ((m = /^([\d.]+)\s*(µa|ua|ma|a)$/.exec(l))) o.ityp = toMa(num(m[1]), m[2]);
      else if ((m = /^([\d.]+)\s*(mw|w)$/.exec(l))) o.ptyp = toW(num(m[1]), m[2]);
      else if ((m = /^(?:([a-z-]+)\s+)?([\d.]+)\s*%$/.exec(l)) && (!m[1] || CONV.test(m[1]))) { o.eff = num(m[2]); o.conv = 'switch'; o.convWord = m[1] || ''; }
      else if (CONV.test(l)) { o.conv = 'switch'; o.convWord = l; }
      else if (l === 'linear' || l === 'ldo') { o.conv = 'linear'; o.convWord = l === 'ldo' ? 'LDO' : ''; }
      else if (l === 'pass-through' || l === 'pass through') o.conv = 'pass';
      else o.extra.push(w);
    }
  }
  // The text's rails, in order (as model.specPowerItems lists them), each with its numbers.
  function parse(text) {
    var M = window.Signoff && window.Signoff.model;
    return M.specLinkItems(text).filter(function (it) { return it.name.trim(); }).map(function (it) {
      var o = parseWords(it.label); o.rail = it.name.trim(); return o;
    });
  }
  function canonWords(o) {
    var w = [], add = function (g, x) { w.push({ g: g, w: x }); };
    add('role', o.role);
    var v = fmtV(o.vmin, o.vmax); if (v) add('v', v);
    if (o.role === 'sink') {
      if (o.ityp != null) add('ityp', fmtI(o.ityp));
      if (o.imax != null) add('imax', 'max ' + fmtI(o.imax));
      if (o.ptyp != null) add('ptyp', fmtP(o.ptyp));
      if (o.pmax != null) add('pmax', 'max ' + fmtP(o.pmax));
    } else {
      if (o.cap != null) add('cap', 'up to ' + fmtI(o.cap));
      if (o.conv === 'switch') add('conv', o.eff != null ? (o.convWord ? o.convWord + ' ' : '') + tidy(o.eff, 3) + '%' : o.convWord || 'switching');
      if (o.conv === 'linear') { add('conv', o.convWord || 'linear'); if (o.iq != null) add('iq', 'Iq ' + fmtI(o.iq)); }
      if (o.conv === 'pass') add('conv', 'pass-through');
      if (o.limit != null) add('limit', 'limit ' + fmtP(o.limit));
    }
    if (o.budget === false) add('budget', 'no budget');
    if (o.tree === false) add('tree', 'no tree');
    return w;
  }
  // A rail's words: each as written while its field is unchanged, else the field written afresh; extras kept.
  function itemWords(o) {
    var canon = {}, want = canonWords(o);
    want.forEach(function (x) { (canon[x.g] = canon[x.g] || []).push(x.w); });
    var out = [], done = {}, vals = groupVals(o);
    (o.toks || []).forEach(function (t) {
      if (t.g === 'extra') { if ((o.extra || []).indexOf(t.w) >= 0) out.push(t.w); return; }
      if (done[t.g]) return;
      done[t.g] = 1;
      if (JSON.stringify(vals[t.g]) === t.snap && (canon[t.g] || []).length) out.push(t.w);
      else out = out.concat(canon[t.g] || []);
    });
    want.forEach(function (x) { if (!done[x.g]) out.push(x.w); });
    (o.extra || []).forEach(function (w) { if (out.indexOf(w) < 0) out.push(w); });
    return out;
  }
  function write(items) {
    return items.map(function (o) { return (/[,()"]/.test(o.rail) ? '"' + o.rail.replace(/"/g, '') + '"' : o.rail) + ' (' + itemWords(o).join(', ') + ')'; }).join(', ');
  }
  function newItem(rail, role) { var o = parseWords(role || 'sink'); o.rail = rail; return o; }

  // ── The budget ──
  function railNameV(name) {
    var m = /^(\d+)V(\d+)$/i.exec(name); if (m) return num(m[1] + '.' + m[2]);
    m = /(\d+(?:\.\d+)?)\s*V\b/i.exec(name); return m ? num(m[1]) : null;
  }
  // blocks: [{ id, title, power }] (power: the Power line's text). scn: 'typ' or 'max'. margin: percent.
  function analyse(blocks, scn, margin) {
    var B = blocks.map(function (b, bi) { return { bi: bi, id: b.id, title: b.title, items: parse(b.power || '') }; });
    var rails = {}, order = [], issues = [];
    B.forEach(function (b) {
      b.items.forEach(function (it, ii) {
        it.b = b; it.ii = ii;
        var k = it.rail.toLowerCase();
        if (!rails[k]) { rails[k] = { key: k, name: it.rail, sources: [], sinks: [] }; order.push(k); }
        (it.role === 'source' ? rails[k].sources : rails[k].sinks).push(it);
        it.r = rails[k];
      });
      b.outs = b.items.filter(function (x) { return x.role === 'source' && x.budget; });
      b.ins = b.items.filter(function (x) { return x.role === 'sink' && x.budget && !b.items.some(function (y) { return y.role === 'source' && y.r === x.r; }); });
      b.conv = b.outs.length > 0 && b.ins.length > 0;
      b.root = b.outs.length > 0 && b.ins.length === 0;
      b.input = b.conv ? b.ins[0] : null;
      if (b.conv && b.ins.length > 1) issues.push({ sev: 'na', id: b.id, text: b.title + ' uses ' + b.ins.map(function (x) { return x.rail; }).join(' and ') + '; its outputs are charged to ' + b.input.rail + ' only.' });
    });
    function srcs(r) { return r.sources.filter(function (s) { return s.budget; }); }
    // Typical: the middle of the source's range. Worst case: its top for a load's power (P = V·I) and its
    // bottom for a converter's input current (low line draws the most).
    function railV(r, end) {
      var s = srcs(r)[0] || r.sources[0];
      if (s && s.vmin != null) return scn !== 'max' ? (s.vmin + s.vmax) / 2 : end === 'lo' ? s.vmin : s.vmax;
      return railNameV(r.name);
    }
    var memo = {}, busy = {};
    function sinkLoad(it) {
      if (!it.budget) return { i: 0, p: 0, off: true };
      if (it.b.conv && it === it.b.input) { var d = convIn(it.b); return { i: d.iin, p: d.pin, derived: true, assumed: d.assumed }; }
      var V = railV(it.r);
      var i = scn === 'max' ? (it.imax != null ? it.imax : it.ityp) : (it.ityp != null ? it.ityp : it.imax);
      var p = scn === 'max' ? (it.pmax != null ? it.pmax : it.ptyp) : (it.ptyp != null ? it.ptyp : it.pmax);
      if (i != null) p = V != null ? V * i / 1000 : p;
      else if (p != null && V) i = p / V * 1000;
      return { i: i, p: p, missing: i == null && p == null };
    }
    function railOut(r) {
      if (memo['r' + r.key]) return memo['r' + r.key];
      if (busy['r' + r.key]) return { i: 0, p: 0, loop: true };
      busy['r' + r.key] = 1;
      var o = { i: 0, p: 0, missing: [] };
      r.sinks.forEach(function (k) {
        if (r.sources.some(function (s) { return s.b === k.b; })) return;
        var l = sinkLoad(k);
        if (l.missing) { o.missing.push(k); return; }
        o.i += l.i || 0; o.p += l.p || 0;
      });
      return (memo['r' + r.key] = o);
    }
    function convIn(b) {
      if (memo['b' + b.bi]) return memo['b' + b.bi];
      if (busy['b' + b.bi]) return { pin: 0, iin: 0, loss: 0 };
      busy['b' + b.bi] = 1;
      var vin = b.input ? railV(b.input.r, 'lo') : null, vinP = b.input ? railV(b.input.r, 'hi') : null, pin = 0, pout = 0, iin = 0, assumed = false;
      b.outs.forEach(function (s) {
        var n = srcs(s.r).length || 1, o = railOut(s.r);
        s.iout = o.i / n; s.pout = o.p / n;
        var V = railV(s.r);
        if (s.conv === 'linear') { s.iin = s.iout + (s.iq || 0); s.pin = vinP != null ? vinP * s.iin / 1000 : s.pout; }
        else if (s.conv === 'pass' || b.root) { s.pin = s.pout; s.iin = vin ? s.pin / vin * 1000 : null; }
        else { var e = s.eff != null ? s.eff : 85; if (s.eff == null) { assumed = true; s.effAssumed = true; } s.pin = s.pout / (e / 100); s.iin = vin ? s.pin / vin * 1000 : null; }
        if (s.iin != null) iin += s.iin;
        s.loss = s.pin - s.pout;
        if (s.conv === 'linear' && vin != null && V != null && vin < V) s.dropout = true;
        pin += s.pin; pout += s.pout;
      });
      return (memo['b' + b.bi] = { pin: pin, pout: pout, loss: pin - pout, iin: vin ? iin : null, assumed: assumed });
    }
    B.forEach(function (b) { if (b.outs.length) b.res = convIn(b); });
    B.forEach(function (b) { b.items.forEach(function (it) { if (it.role === 'sink') it.load = sinkLoad(it); }); });

    // Totals: what the inputs deliver, what the loads take, what the converters lose.
    var t = { input: 0, loads: 0, losses: 0, limit: null };
    B.forEach(function (b) {
      if (b.root) { t.input += b.res.pout; b.outs.forEach(function (s) { if (s.limit != null) t.limit = (t.limit || 0) + s.limit; }); }
      else if (b.conv) t.losses += b.res.loss;
      b.items.forEach(function (it) { if (it.role === 'sink' && it.budget && !it.load.derived && !it.load.missing && !b.root && !(b.conv && it === b.input)) t.loads += it.load.p || 0; });
    });
    t.eff = t.input ? t.loads / t.input : null;

    // Checks
    var m = margin / 100;
    B.forEach(function (b) { b.flags = 0; });
    B.forEach(function (b) {
      b.outs.forEach(function (s) {
        if (s.cap != null) {
          s.util = s.iout / s.cap;
          if (s.util > 1) { issues.push({ sev: 'bad', id: b.id, text: b.title + ': ' + s.rail + ' loads ' + fmtI(s.iout) + ', over the ' + fmtI(s.cap) + ' it can supply.' }); b.flags++; }
          else if (s.util > 1 - m) { issues.push({ sev: 'warn', id: b.id, text: b.title + ': ' + s.rail + ' at ' + pct(s.util) + ' of ' + fmtI(s.cap) + ', under the ' + margin + '% margin.' }); b.flags++; }
        } else if (!b.root) issues.push({ sev: 'na', id: b.id, text: b.title + ': no capacity for ' + s.rail + ' ("up to …").' });
        if (s.effAssumed) issues.push({ sev: 'na', id: b.id, text: b.title + ': no efficiency for ' + s.rail + '; 85% assumed.' });
        if (s.dropout) { issues.push({ sev: 'bad', id: b.id, text: b.title + ': a linear regulator making ' + s.rail + ' from a lower input.' }); b.flags++; }
        if (srcs(s.r).length > 1) issues.push({ sev: 'na', id: b.id, text: s.rail + ' has ' + srcs(s.r).length + ' sources; its load is split evenly.' });
        s.r.sinks.forEach(function (k) {
          if (k.b === b || s.vmin == null || k.vmin == null) return;
          if (k.vmin > s.vmin + 1e-9 || k.vmax < s.vmax - 1e-9) {
            k.vbad = true;
            issues.push({ sev: 'bad', id: k.b.id, text: k.b.title + ' accepts ' + fmtV(k.vmin, k.vmax) + ' on ' + k.rail + ', but ' + b.title + ' makes ' + fmtV(s.vmin, s.vmax) + '.' }); k.b.flags++;
          }
        });
      });
      b.items.forEach(function (it) {
        if (it.role !== 'sink' || !it.budget) return;
        if (it.load.missing) issues.push({ sev: 'warn', id: b.id, text: b.title + ': no current or power for ' + it.rail + '.' });
        if (!it.r.sources.length) issues.push({ sev: 'warn', id: b.id, text: 'No block makes ' + it.rail + ' (used by ' + b.title + ').' });
        if (it.vmin == null && !(b.conv && it === b.input)) issues.push({ sev: 'na', id: b.id, text: b.title + ': no voltage range for ' + it.rail + ', so it isn’t checked.' });
      });
    });
    if (t.limit != null) {
      if (t.input > t.limit) issues.unshift({ sev: 'bad', text: 'The board draws ' + fmtP(t.input) + ', over its ' + fmtP(t.limit) + ' limit.' });
      else if (t.input > t.limit * (1 - m)) issues.unshift({ sev: 'warn', text: 'The board draws ' + fmtP(t.input) + ', within ' + margin + '% of its ' + fmtP(t.limit) + ' limit.' });
    }
    // Depths for the drawings: a block sits one column right of the blocks that make the rails it uses.
    B.forEach(function (b) { b.depth = 0; });
    for (var n = 0; n < B.length; n++) {
      B.forEach(function (b) {
        b.items.forEach(function (it) {
          if (it.role !== 'sink') return;
          it.r.sources.forEach(function (s) { if (s.b !== b) b.depth = Math.max(b.depth, Math.min(s.b.depth + 1, B.length)); });
        });
      });
    }
    var rank = { bad: 0, warn: 1, na: 2 };
    issues.sort(function (a, c) { return rank[a.sev] - rank[c.sev]; });
    var byId = {}; B.forEach(function (b) { byId[b.id] = b; });
    return { B: B, byId: byId, rails: rails, order: order, t: t, issues: issues, railV: railV, srcs: srcs, scn: scn, margin: margin };
  }
  // Both scenarios at once: { typ, max, scn, margin }.
  function budget(blocks, scn, margin) {
    margin = isFinite(+margin) ? Math.max(0, Math.min(90, +margin)) : 20;
    return { typ: analyse(blocks, 'typ', margin), max: analyse(blocks, 'max', margin), scn: scn === 'max' ? 'max' : 'typ', margin: margin };
  }
  function any(A) { return A.typ.B.some(function (b) { return b.items.length; }); }

  // ── The block panel's Power rows: a chevron per row opens its numbers ──
  var CHEV = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';
  function inp(id, ii, k, v, opts) {
    opts = opts || {};
    var shown = v == null ? '' : opts.scale ? tidy(v * opts.scale) : tidy(v);
    return '<input class="input pw-num" type="number" step="any" min="0" data-b="' + esc(id) + '" data-i="' + ii + '" data-k="' + k + '"' + (opts.scale ? ' data-scale="' + opts.scale + '"' : '') + ' value="' + esc(shown) + '" placeholder="' + esc(opts.ph || '') + '" aria-label="' + esc(opts.label || k) + '">';
  }
  function gist(A, it) {
    var b = it.b, bits = [];
    if (it.role === 'sink') {
      if (b.conv && it === b.input) {
        var ty = A.typ.byId[b.id].input.load, mx = A.max.byId[b.id].input.load;
        bits.push('draws ' + fmtI(ty.i) + ', max ' + fmtI(mx.i) + ' (from its outputs)');
      } else {
        var v = fmtV(it.vmin, it.vmax); if (v) bits.push('<span' + (it.vbad ? ' class="bad"' : '') + '>accepts ' + esc(v) + '</span>');
        if (it.ityp != null || it.imax != null) bits.push(fmtI(it.ityp) + (it.imax != null ? ', max ' + fmtI(it.imax) : ''));
        else if (it.ptyp != null || it.pmax != null) bits.push(fmtP(it.ptyp) + (it.pmax != null ? ', max ' + fmtP(it.pmax) : ''));
        else if (it.budget) bits.push('<span class="bad">no current yet</span>');
      }
    } else {
      var v2 = fmtV(it.vmin, it.vmax); if (v2) bits.push(esc(v2));
      if (it.cap != null) {
        var s2 = A[A.scn].byId[b.id].items[it.ii];
        bits.push('up to ' + fmtI(it.cap) + (s2.util != null ? ' · <span' + (s2.util > 1 ? ' class="bad"' : '') + '>' + pct(s2.util) + ' used</span>' : ''));
      }
      if (it.conv === 'switch') bits.push(it.eff != null ? tidy(it.eff, 3) + '%' : 'switching');
      if (it.conv === 'linear') bits.push('linear');
      if (it.conv === 'pass') bits.push('pass-through');
      if (it.limit != null) bits.push('limit ' + fmtP(it.limit));
    }
    if (!it.budget) bits.push('not in the budget');
    if (!it.tree) bits.push('not in the power tree');
    return bits.join(' · ');
  }
  function detail(A, it) {
    var id = it.b.id, ii = it.ii, h = '';
    var f = function (label, body, note) { return '<div class="pw-f"><span>' + label + '</span><div class="pw-in">' + body + (note ? ' <small>' + note + '</small>' : '') + '</div></div>'; };
    if (it.role === 'sink') {
      if (it.b.conv && it === it.b.input) {
        var ty = A.typ.byId[id].input.load, mx = A.max.byId[id].input.load;
        h += '<div class="pw-derived">Worked out from its outputs: <b>' + fmtI(ty.i) + '</b> typical, <b>' + fmtI(mx.i) + '</b> worst case (' + fmtP(ty.p) + ', ' + fmtP(mx.p) + ').</div>';
        h += f('Accepts', inp(id, ii, 'vmin', it.vmin, { ph: 'min', label: 'Minimum input' }) + '–' + inp(id, ii, 'vmax', it.vmax, { ph: 'max', label: 'Maximum input' }) + ' V');
      } else {
        h += f('Accepts', inp(id, ii, 'vmin', it.vmin, { ph: 'min', label: 'Minimum voltage' }) + '–' + inp(id, ii, 'vmax', it.vmax, { ph: 'max', label: 'Maximum voltage' }) + ' V');
        h += f('Current', inp(id, ii, 'ityp', it.ityp, { ph: 'typical', label: 'Typical current' }) + inp(id, ii, 'imax', it.imax, { ph: 'max', label: 'Maximum current' }) + ' mA', 'typical, max');
        h += f('Or power', inp(id, ii, 'ptyp', it.ptyp, { ph: 'typical', label: 'Typical power' }) + inp(id, ii, 'pmax', it.pmax, { ph: 'max', label: 'Maximum power' }) + ' W', it.ityp != null || it.imax != null ? 'current wins' : '');
      }
    } else {
      h += f('Output', inp(id, ii, 'vmin', it.vmin, { ph: 'min', label: 'Minimum output' }) + '–' + inp(id, ii, 'vmax', it.vmax, { ph: 'max', label: 'Maximum output' }) + ' V');
      h += f('Can supply', inp(id, ii, 'cap', it.cap, { ph: 'max', label: 'Capacity' }) + ' mA');
      h += f('Converter', '<div class="seg">' + [['switch', 'Switching'], ['linear', 'Linear'], ['pass', 'Pass-through']].map(function (o) {
        return '<button class="' + (it.conv === o[0] ? 'on' : '') + '" data-act="spec-power-num" data-b="' + esc(id) + '" data-i="' + ii + '" data-k="conv" data-v="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>');
      if (it.conv === 'switch' || !it.conv) h += f('Efficiency', inp(id, ii, 'eff', it.eff, { ph: '85', label: 'Efficiency' }) + ' %', it.eff == null ? '85% assumed' : '');
      if (it.conv === 'linear') h += f('Quiescent', inp(id, ii, 'iq', it.iq, { ph: 'Iq', label: 'Quiescent current', scale: 1000 }) + ' µA');
      if (it.b.root) h += f('Input limit', inp(id, ii, 'limit', it.limit, { ph: 'none', label: 'Input limit' }) + ' W', 'the most the board may draw');
      var st = A.typ.byId[id].items[ii], sm = A.max.byId[id].items[ii];
      h += '<div class="pw-derived">Load now: <b>' + fmtI(st.iout) + '</b>' + (st.util != null ? ' (' + pct(st.util) + ')' : '') + ' typical, <b>' + fmtI(sm.iout) + '</b>' + (sm.util != null ? ' (' + pct(sm.util) + ')' : '') + ' worst case' +
        (it.b.root ? '' : '; it loses ' + fmtP(st.loss) + ' and ' + fmtP(sm.loss)) + '.</div>';
    }
    h += '<div class="pw-checks"><label><input type="checkbox" data-act="spec-power-num" data-b="' + esc(id) + '" data-i="' + ii + '" data-k="budget"' + (it.budget ? ' checked' : '') + '> Count in budget</label>' +
      '<label><input type="checkbox" data-act="spec-power-tree" data-i="' + ii + '"' + (it.tree ? ' checked' : '') + '> Show in power tree</label></div>';
    return '<div class="pw-detail">' + h + '</div>';
  }
  // rows for block id: open is { '<index>': true }.
  function rowsHtml(A, id, open) {
    var b = A[A.scn].byId[id]; if (!b) return '';
    return '<div class="pw-power">' + b.items.map(function (it, ii) {
      var o = !!(open && open[ii]);
      return '<div class="pw-row"><span class="spec-power-rail">' + esc(it.rail) + '</span><div class="seg spec-power-seg">' + [['source', 'Source'], ['sink', 'Sink'], ['', 'N/A']].map(function (r) {
        return '<button class="' + (it.role === r[0] ? 'on' : '') + '" data-act="spec-power-role" data-i="' + ii + '" data-role="' + r[0] + '" title="' + esc(r[0] === 'source' ? 'It makes ' + it.rail : r[0] === 'sink' ? 'It uses ' + it.rail : 'Take ' + it.rail + ' off') + '">' + r[1] + '</button>';
      }).join('') + '</div><button class="pw-chev' + (o ? ' open' : '') + '" data-act="spec-power-open" data-i="' + ii + '" title="' + (o ? 'Fold' : 'Power numbers for ' + esc(it.rail)) + '" aria-expanded="' + o + '" aria-label="' + (o ? 'Fold ' : 'Open ') + esc(it.rail) + '">' + CHEV + '</button>' +
        '<div class="pw-gist">' + gist(A, it) + '</div>' + (o ? detail(A, it) : '') + '</div>';
    }).join('') + '</div>';
  }

  // ── Displays ──
  var DEFS = '<defs><pattern id="pw-hb" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="1.4" height="5" fill="rgba(255,255,255,0.55)"/></pattern>' +
    '<pattern id="pw-hw" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.8" fill="rgba(0,0,0,0.45)"/></pattern></defs>';
  function bar(x, y, w, h, util, margin) {
    var cls = util > 1 ? 'bad' : util > 1 - margin / 100 ? 'warn' : '';
    var fw = Math.max(1, Math.min(1, util) * w);
    return '<rect class="barbg" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/><rect class="barfill ' + cls + '" x="' + x + '" y="' + y + '" width="' + fw + '" height="' + h + '" rx="2"/>' +
      (cls ? '<rect x="' + x + '" y="' + y + '" width="' + fw + '" height="' + h + '" fill="url(#' + (cls === 'bad' ? 'pw-hb' : 'pw-hw') + ')"/>' : '');
  }
  function hit(b) { return ' data-act="spec-block" data-id="' + esc(b.id) + '"'; }
  // The power tree with each line's current and power, each source's load against what it can supply, and each
  // converter's efficiency and loss (after ADI's LTpowerPlanner).
  function treeHtml(A, sel) {
    var a = A[A.scn], margin = A.margin;
    var nodes = a.B.filter(function (b) { return b.items.some(function (it) { return it.tree; }); });
    if (!nodes.length) return '<p class="note">No block is in the power tree.</p>';
    var W = 200, GAP = 130, cols = {};
    nodes.forEach(function (b) { (cols[b.depth] = cols[b.depth] || []).push(b); });
    var maxY = 0;
    Object.keys(cols).forEach(function (d) {
      var y = 20;
      cols[d].forEach(function (b) {
        var outs = b.items.filter(function (it) { return it.role === 'source' && it.tree; });
        var ins = b.items.filter(function (it) { return it.role === 'sink' && it.tree; });
        b.x = 20 + d * (W + GAP); b.y = y;
        b.h = Math.max(30 + outs.length * 30 + 16, 26 + ins.length * 18 + 8);
        outs.forEach(function (s, j) { s.py = b.y + 38 + j * 30; });
        ins.forEach(function (k, j) { k.py = b.y + (b.h * (j + 1)) / (ins.length + 1); });
        y += b.h + 34; maxY = Math.max(maxY, y);
      });
    });
    var wires = '', labels = '', boxes = '', maxD = Math.max.apply(null, nodes.map(function (b) { return b.depth; }).concat([0]));
    nodes.forEach(function (b) {
      b.items.forEach(function (s) {
        if (s.role !== 'source' || !s.tree) return;
        var sinks = s.r.sinks.filter(function (k) { return k.tree && k.b !== b && nodes.indexOf(k.b) >= 0; });
        if (!sinks.length) return;
        var x1 = b.x + W, trunk = x1 + 28 + (s.ii % 3) * 10;
        sinks.forEach(function (k) {
          var x2 = k.b.x, y2 = k.py, off = !k.budget || !s.budget;
          wires += '<path class="wire' + (off ? ' nobudget' : '') + '" d="M' + x1 + ' ' + s.py + ' H' + trunk + ' V' + y2 + ' H' + x2 + '"/>';
          var l = k.load || {};
          var t = off ? 'not counted' : l.missing ? 'no current' : fmtI(l.i) + ' · ' + fmtP(l.p);
          labels += '<text class="t2" x="' + (x2 - 8) + '" y="' + (y2 - 5) + '" text-anchor="end">' + esc(t) + '</text>';
        });
        labels += '<text class="tb" x="' + (x1 + 6) + '" y="' + (s.py - 6) + '">' + esc(s.rail) + '</text>' +
          (s.budget ? '<text class="t3" x="' + (x1 + 6) + '" y="' + (s.py + 13) + '">' + esc(fmtI(s.iout)) + '</text>' : '');
      });
    });
    nodes.forEach(function (b) {
      var h = '<g class="hit"' + hit(b) + '><title>' + esc(b.title) + '</title><rect class="blk' + (b.id === sel ? ' sel' : '') + '" x="' + b.x + '" y="' + b.y + '" width="' + W + '" height="' + b.h + '" rx="9"/>';
      h += '<text class="tb" x="' + (b.x + 12) + '" y="' + (b.y + 19) + '">' + esc(b.title.length > 24 ? b.title.slice(0, 23) + '…' : b.title) + '</text>';
      b.items.filter(function (it) { return it.role === 'source' && it.tree; }).forEach(function (s) {
        h += '<text class="t2" x="' + (b.x + 12) + '" y="' + (s.py + 4) + '">' + esc(s.rail) + '</text>';
        if (s.cap != null && s.budget) h += bar(b.x + 56, s.py - 5, 56, 10, s.util, margin) + '<text class="t3" x="' + (b.x + 118) + '" y="' + (s.py + 4) + '">' + esc(pct(s.util)) + ' of ' + esc(fmtI(s.cap)) + '</text>';
        else if (s.budget) h += '<text class="t3" x="' + (b.x + 62) + '" y="' + (s.py + 4) + '">' + esc(fmtV(s.vmin, s.vmax) || 'no range') + '</text>';
      });
      var foot = '';
      if (b.conv) foot = b.outs.map(function (s) { return s.conv === 'linear' ? 'linear' : s.conv === 'pass' ? 'pass-through' : 'η ' + (s.eff != null ? tidy(s.eff, 3) : '85?') + '%'; }).join(', ') + ' · loss ' + fmtP(b.res.loss);
      else if (b.root) foot = 'delivers ' + fmtP(b.res.pout) + (b.outs.some(function (s) { return s.limit != null; }) ? ' of ' + fmtP(a.t.limit) : '');
      else { var p = 0, miss = false; b.items.forEach(function (it) { if (it.role === 'sink' && it.budget) { if (it.load.missing) miss = true; else p += it.load.p || 0; } }); foot = (miss ? 'some current missing · ' : '') + 'draws ' + fmtP(p); }
      h += '<text class="t3" x="' + (b.x + 12) + '" y="' + (b.y + b.h - 9) + '">' + esc(foot) + '</text>';
      if (b.flags) h += '<text class="flag" x="' + (b.x + W - 14) + '" y="' + (b.y + 19) + '">△</text>';
      boxes += h + '</g>';
    });
    var w = 20 + (maxD + 1) * (W + GAP), hgt = maxY + 10;
    return '<svg class="pw-svg" style="max-width:' + w + 'px" viewBox="0 0 ' + w + ' ' + hgt + '">' + DEFS + wires + boxes + labels + '</svg>' +
      '<div class="pw-legend"><span><span class="pw-sw ok"></span>Load against what the source can supply</span><span><span class="pw-sw warn"></span>Under the margin</span><span><span class="pw-sw bad"></span>Over</span><span>- - - not in the budget</span></div>';
  }
  // One row per load, grouped by rail, both scenarios side by side, with margin per rail (after FPGA power
  // estimators and design-note spreadsheets).
  function tableHtml(A) {
    var ty = A.typ, mx = A.max, margin = A.margin, rowsH = '';
    var order = ty.order.slice().sort(function (p, q) {
      var sp = ty.rails[p].sources[0], sq = ty.rails[q].sources[0];
      return (sp ? sp.b.depth : 99) - (sq ? sq.b.depth : 99) || ty.order.indexOf(p) - ty.order.indexOf(q);
    });
    order.forEach(function (k) {
      var r = ty.rails[k], s = ty.srcs(r)[0], sm = s && mx.byId[s.b.id].items[s.ii];
      var sinks = r.sinks.filter(function (x) { return !r.sources.some(function (y) { return y.b === x.b; }); });
      if (!sinks.length) return;
      var head = s ? 'from ' + esc(s.b.title) + (fmtV(s.vmin, s.vmax) ? ' · ' + esc(fmtV(s.vmin, s.vmax)) : '') + (s.cap != null ? ' · up to ' + esc(fmtI(s.cap)) : '') : 'no block makes it';
      rowsH += '<tr class="rail"><td colspan="7">' + esc(r.name) + '<small>' + head + '</small></td></tr>';
      var sum = { it: 0, im: 0, pt: 0, pm: 0 };
      sinks.forEach(function (x) {
        var xm = mx.byId[x.b.id].items[x.ii], lt = x.load, lm = xm.load, der = lt.derived;
        if (x.budget && !lt.missing) { sum.it += lt.i || 0; sum.pt += lt.p || 0; }
        if (x.budget && !lm.missing) { sum.im += lm.i || 0; sum.pm += lm.p || 0; }
        var vchip = x.vmin == null ? '<span class="pw-chip na">no range</span>' : x.vbad ? '<span class="pw-chip bad">out of range</span>' : s && s.vmin != null ? '<span class="pw-chip ok">in range</span>' : '';
        rowsH += '<tr class="hit"' + hit(x.b) + '><td>' + esc(x.b.title) + (der ? ' <span class="muted">(its outputs)</span>' : '') + (!x.budget ? ' <span class="muted">(not counted)</span>' : '') + (lt.missing && x.budget ? ' <span class="pw-chip warn">no current</span>' : '') + '</td>' +
          '<td>' + esc(fmtV(x.vmin, x.vmax) || '—') + '</td>' +
          '<td class="n">' + (x.budget ? (der ? '<i>' + fmtI(lt.i) + '</i>' : fmtI(lt.i)) : '—') + '</td>' +
          '<td class="n">' + (x.budget ? (der ? '<i>' + fmtI(lm.i) + '</i>' : fmtI(lm.i)) : '—') + '</td>' +
          '<td class="n">' + (x.budget ? fmtP(lt.p) : '—') + '</td><td class="n">' + (x.budget ? fmtP(lm.p) : '—') + '</td><td>' + vchip + '</td></tr>';
      });
      function marg(u) { if (u == null) return '<span class="pw-chip na">no capacity</span>'; var left = 1 - u; return '<span class="pw-chip ' + (u > 1 ? 'bad' : u > 1 - margin / 100 ? 'warn' : 'ok') + '">' + (left >= 0 ? pct(left) + ' left' : pct(-left) + ' over') + '</span>'; }
      rowsH += '<tr class="sub"><td>Load on ' + esc(r.name) + '</td><td></td><td class="n">' + fmtI(sum.it) + '</td><td class="n">' + fmtI(sum.im) + '</td><td class="n">' + fmtP(sum.pt) + '</td><td class="n">' + fmtP(sum.pm) + '</td><td>' + (s && !s.b.root ? marg(s.util) + ' ' + marg(sm && sm.util) : '') + '</td></tr>';
    });
    function lim(t) { if (t.limit == null) return ''; return '<span class="pw-chip ' + (t.input > t.limit ? 'bad' : t.input > t.limit * (1 - margin / 100) ? 'warn' : 'ok') + '">' + fmtP(t.input) + ' of ' + fmtP(t.limit) + '</span>'; }
    rowsH += '<tr class="total"><td>Input power</td><td></td><td></td><td></td><td class="n">' + fmtP(ty.t.input) + '</td><td class="n">' + fmtP(mx.t.input) + '</td><td>' + lim(ty.t) + ' ' + lim(mx.t) + '</td></tr>' +
      '<tr><td>Converter losses</td><td></td><td></td><td></td><td class="n">' + fmtP(ty.t.losses) + '</td><td class="n">' + fmtP(mx.t.losses) + '</td><td></td></tr>' +
      '<tr><td>To the loads</td><td></td><td></td><td></td><td class="n">' + fmtP(ty.t.loads) + ' <span class="muted">' + (ty.t.eff != null ? pct(ty.t.eff) : '') + '</span></td><td class="n">' + fmtP(mx.t.loads) + ' <span class="muted">' + (mx.t.eff != null ? pct(mx.t.eff) : '') + '</span></td><td></td></tr>';
    return '<div class="pw-table-wrap"><table class="pw-t"><thead><tr><th>Block</th><th>Accepts</th><th class="n">Current, typical</th><th class="n">Current, worst</th><th class="n">Power, typical</th><th class="n">Power, worst</th><th>Check</th></tr></thead><tbody>' + rowsH + '</tbody></table></div>';
  }
  // Each source's load, stacked by what draws it, against what it can supply, with the margin line.
  function headHtml(A) {
    var h = '', any = false, margin = A.margin;
    A.typ.B.forEach(function (b) {
      b.outs.forEach(function (s) {
        if (b.root) return;
        any = true;
        var sm = A.max.byId[b.id].items[s.ii];
        var loads = function (a) { return a.rails[s.r.key].sinks.filter(function (k) { return k.b !== a.byId[b.id] && k.budget && !k.load.missing; }).map(function (k) { return { name: k.b.title, i: (k.load.i || 0) / (a.srcs(k.r).length || 1) }; }); };
        var lt = loads(A.typ), lm = loads(A.max);
        var scale = Math.max(s.cap || 0, sm.iout || 0, s.iout || 0) * 1.12 || 1;
        function row(label, list, tot, util) {
          var x = 0, segs = list.map(function (l, j) {
            var w = l.i / scale * 100, seg = '<div class="pw-hr-seg' + (j % 2 ? ' alt' : '') + '" style="left:' + x + '%;width:' + w + '%" title="' + esc(l.name + ': ' + fmtI(l.i)) + '">' + esc(l.name) + '</div>';
            x += w; return seg;
          }).join('');
          if (s.cap != null && tot > s.cap) segs += '<div class="pw-hr-seg over" style="left:' + (s.cap / scale * 100) + '%;width:' + ((tot - s.cap) / scale * 100) + '%" title="Over by ' + esc(fmtI(tot - s.cap)) + '"></div>';
          var marks = s.cap != null ? '<div class="pw-hr-cap" style="left:' + (s.cap / scale * 100) + '%" title="Can supply ' + esc(fmtI(s.cap)) + '"></div><div class="pw-hr-marg" style="left:' + (s.cap * (1 - margin / 100) / scale * 100) + '%" title="' + margin + '% margin"></div>' : '';
          return '<div class="pw-hr-row"><span>' + label + '</span><div class="pw-hr-bar">' + segs + marks + '</div><span>' + fmtI(tot) + (util != null ? ' · ' + pct(util) : '') + '</span></div>';
        }
        h += '<div class="pw-hr-rail"><h3>' + esc(s.rail) + ' <small>from ' + esc(b.title) + (s.cap != null ? ', up to ' + esc(fmtI(s.cap)) : ', no capacity given') + '</small></h3>' +
          row('Typical', lt, s.iout, s.util) + row('Worst case', lm, sm.iout, sm.util) + '</div>';
      });
    });
    var t = A.typ.t, tm = A.max.t;
    if (t.limit != null) {
      var sc = Math.max(t.limit, tm.input) * 1.12;
      var r2 = function (label, x) { return '<div class="pw-hr-row"><span>' + label + '</span><div class="pw-hr-bar"><div class="pw-hr-seg" style="left:0;width:' + (Math.min(x.input, t.limit) / sc * 100) + '%">loads ' + esc(fmtP(x.loads)) + ' + losses ' + esc(fmtP(x.losses)) + '</div>' +
        (x.input > t.limit ? '<div class="pw-hr-seg over" style="left:' + (t.limit / sc * 100) + '%;width:' + ((x.input - t.limit) / sc * 100) + '%"></div>' : '') +
        '<div class="pw-hr-cap" style="left:' + (t.limit / sc * 100) + '%"></div><div class="pw-hr-marg" style="left:' + (t.limit * (1 - margin / 100) / sc * 100) + '%"></div></div><span>' + fmtP(x.input) + ' · ' + pct(x.input / t.limit) + '</span></div>'; };
      h = '<div class="pw-hr-rail"><h3>Input power <small>limit ' + esc(fmtP(t.limit)) + '</small></h3>' + r2('Typical', t) + r2('Worst case', tm) + '</div>' + h;
      any = true;
    }
    return '<div class="pw-hr">' + (any ? h : '<p class="note">No sources yet.</p>') + '</div>' +
      '<div class="pw-legend"><span><span class="pw-sw cap"></span>What it can supply</span><span><span class="pw-sw marg"></span>Margin</span><span><span class="pw-sw bad"></span>Over</span></div>';
  }
  // Each rail's output range against the range each load accepts.
  function voltHtml(A) {
    var a = A[A.scn], h = '';
    a.order.forEach(function (k) {
      var r = a.rails[k], s = r.sources.filter(function (x) { return x.vmin != null; })[0];
      var sinks = r.sinks.filter(function (x) { return x.vmin != null && !r.sources.some(function (y) { return y.b === x.b; }); });
      if (!s && !sinks.length) return;
      var lo = Math.min.apply(null, sinks.map(function (x) { return x.vmin; }).concat(s ? [s.vmin] : [])), hi = Math.max.apply(null, sinks.map(function (x) { return x.vmax; }).concat(s ? [s.vmax] : []));
      var pad = (hi - lo) * 0.08 || hi * 0.05 || 1; lo -= pad; hi += pad;
      var X = function (v) { return ((v - lo) / (hi - lo) * 100); };
      var win = s ? '<div class="pw-win" style="left:' + X(s.vmin) + '%;width:' + Math.max(0.4, X(s.vmax) - X(s.vmin)) + '%"></div>' : '';
      h += '<div class="pw-hr-rail"><h3>' + esc(r.name) + ' <small>' + (s ? esc(s.b.title) + ' makes ' + esc(fmtV(s.vmin, s.vmax)) : 'no source range') + '</small></h3>';
      if (s) h += '<div class="pw-hr-row"><span>Made</span><div class="pw-hr-bar">' + win + '<div class="pw-hr-seg" style="left:' + X(s.vmin) + '%;width:' + Math.max(0.6, X(s.vmax) - X(s.vmin)) + '%"></div></div><span>' + esc(fmtV(s.vmin, s.vmax)) + '</span></div>';
      sinks.forEach(function (x) {
        h += '<div class="pw-hr-row hit"' + hit(x.b) + '><span title="' + esc(x.b.title) + '">' + esc(x.b.title) + '</span><div class="pw-hr-bar">' + win +
          '<div class="pw-hr-seg' + (x.vbad ? ' over' : ' alt') + '" style="left:' + X(x.vmin) + '%;width:' + (X(x.vmax) - X(x.vmin)) + '%"></div></div><span>' + esc(fmtV(x.vmin, x.vmax)) + (x.vbad ? ' <span class="pw-chip bad">out</span>' : '') + '</span></div>';
      });
      h += '<div class="pw-hr-row pw-hr-scale"><span></span><div class="pw-scale"><span>' + tidy(lo, 3) + ' V</span><span>' + tidy(hi, 3) + ' V</span></div><span></span></div></div>';
    });
    return '<div class="pw-hr">' + (h || '<p class="note">No voltage ranges yet.</p>') + '</div>' +
      '<div class="pw-legend"><span><span class="pw-sw win"></span>What its source makes, across every row</span><span><span class="pw-sw alt"></span>What a load accepts</span><span><span class="pw-sw bad"></span>Doesn’t cover the source</span></div>';
  }
  // Power from the input through each converter to the loads, as wide as it is, losses as a branch.
  function flowHtml(A) {
    var a = A[A.scn], nodes = [], flows = [];
    a.B.forEach(function (b) {
      var v = b.root ? b.res.pout : b.conv ? b.res.pin : b.items.reduce(function (s, it) { return s + (it.role === 'sink' && it.budget && !it.load.missing ? it.load.p || 0 : 0); }, 0);
      if (v > 0) { b.v = v; nodes.push(b); }
    });
    if (!nodes.length) return '<p class="note">No power to show yet.</p>';
    nodes.forEach(function (b) {
      if (b.root) return;
      b.items.forEach(function (it) {
        if (it.role !== 'sink' || !it.budget || it.load.missing) return;
        a.srcs(it.r).forEach(function (s) { if (s.b !== b && nodes.indexOf(s.b) >= 0) flows.push({ from: s.b, to: b, v: (it.load.p || 0) / a.srcs(it.r).length, rail: it.rail }); });
      });
    });
    var maxD = Math.max.apply(null, nodes.map(function (b) { return b.depth; }).concat([0]));
    var loss = { title: 'Losses', depth: maxD + 1, v: 0, loss: true };
    nodes.forEach(function (b) { if (b.conv && b.res.loss > 0) { flows.push({ from: b, to: loss, v: b.res.loss, isLoss: true }); loss.v += b.res.loss; } });
    if (loss.v > 0) nodes.push(loss);
    var cols = {}, H = 340, NW = 14, CW = 190, G = 22;
    nodes.forEach(function (b) { (cols[b.depth] = cols[b.depth] || []).push(b); });
    var maxSum = 0;
    Object.keys(cols).forEach(function (d) { maxSum = Math.max(maxSum, cols[d].reduce(function (s, b) { return s + b.v; }, 0)); });
    var k = maxSum ? H / maxSum : 1, top = 20;
    Object.keys(cols).forEach(function (d) {
      var tot = cols[d].reduce(function (s, b) { return s + b.v * k; }, 0) + (cols[d].length - 1) * G, y = top + Math.max(0, (H + 60 - tot) / 2);
      cols[d].forEach(function (b) { b.sx = 30 + d * CW; b.sy = y; b.sh = Math.max(2, b.v * k); b.oy = y; b.iy = y; y += b.sh + G; });
    });
    if (loss.v > 0) { loss.sy = loss.oy = loss.iy = top + H + 60 - loss.sh; }   // losses sit at the bottom, out of the way
    var bands = '';
    flows.sort(function (p, q) { return p.from.sy - q.from.sy || (p.isLoss ? 1 : 0) - (q.isLoss ? 1 : 0) || p.to.sy - q.to.sy; });
    flows.forEach(function (f) {
      var h = Math.max(1, f.v * k), x0 = f.from.sx + NW, x1 = f.to.sx, y0 = f.from.oy, y1 = f.to.iy, xm = (x0 + x1) / 2;
      f.from.oy += h; f.to.iy += h;
      bands += '<path class="band' + (f.isLoss ? ' loss' : '') + '" d="M' + x0 + ' ' + y0 + ' C' + xm + ' ' + y0 + ' ' + xm + ' ' + y1 + ' ' + x1 + ' ' + y1 + ' L' + x1 + ' ' + (y1 + h) + ' C' + xm + ' ' + (y1 + h) + ' ' + xm + ' ' + (y0 + h) + ' ' + x0 + ' ' + (y0 + h) + 'Z"><title>' + esc((f.isLoss ? f.from.title + ' loses ' : f.from.title + ' → ' + f.to.title + ' (' + f.rail + '): ') + fmtP(f.v)) + '</title></path>';
    });
    var boxes = nodes.map(function (b) {
      return '<g' + (b.loss ? '' : ' class="hit"' + hit(b)) + '><rect class="node' + (b.loss ? ' loss' : '') + '" x="' + b.sx + '" y="' + b.sy + '" width="' + NW + '" height="' + b.sh + '" rx="2"/>' +
        '<text class="tb" x="' + (b.sx + NW + 6) + '" y="' + (b.sy + Math.min(b.sh / 2, 12) + 4) + '">' + esc(b.title) + '</text><text class="t3" x="' + (b.sx + NW + 6) + '" y="' + (b.sy + Math.min(b.sh / 2, 12) + 18) + '">' + esc(fmtP(b.v)) + '</text></g>';
    }).join('');
    var w = 30 + (maxD + 1) * CW + 170, hgt = H + 100;
    return '<svg class="pw-svg" style="max-width:' + w + 'px" viewBox="0 0 ' + w + ' ' + hgt + '">' + bands + boxes + '</svg>' +
      '<div class="pw-legend"><span><span class="pw-sw flow"></span>Power on a rail, as wide as it is</span><span><span class="pw-sw loss"></span>Lost in a converter</span></div>';
  }
  function summaryHtml(A) {
    var a = A[A.scn], t = a.t, m = A.margin / 100;
    var limCls = t.limit == null ? '' : t.input > t.limit ? ' bad' : t.input > t.limit * (1 - m) ? ' warn' : '';
    var bad = a.issues.filter(function (x) { return x.sev === 'bad'; }).length, warn = a.issues.filter(function (x) { return x.sev === 'warn'; }).length;
    return '<div class="pw-stat' + limCls + '"><b>' + fmtP(t.input) + '</b><span>Input' + (t.limit != null ? ', limit ' + fmtP(t.limit) : '') + (limCls === ' bad' ? ': over' : '') + '</span></div>' +
      '<div class="pw-stat"><b>' + fmtP(t.loads) + '</b><span>To the loads</span></div>' +
      '<div class="pw-stat"><b>' + fmtP(t.losses) + '</b><span>Converter losses</span></div>' +
      '<div class="pw-stat"><b>' + (t.eff != null ? pct(t.eff) : '—') + '</b><span>Overall efficiency</span></div>' +
      '<div class="pw-stat' + (bad ? ' bad' : warn ? ' warn' : '') + '"><b>' + bad + ' · ' + warn + '</b><span>Problems · warnings</span></div>';
  }
  function issuesHtml(A) {
    var a = A[A.scn];
    if (!a.issues.length) return '<li><span class="pw-chip ok">OK</span> Nothing to flag.</li>';
    return a.issues.map(function (x) {
      return '<li' + (x.id ? ' class="hit" data-act="spec-block" data-id="' + esc(x.id) + '"' : '') + '><span class="pw-chip ' + x.sev + '">' + (x.sev === 'bad' ? 'Problem' : x.sev === 'warn' ? 'Warning' : 'Note') + '</span><span>' + esc(x.text) + '</span></li>';
    }).join('');
  }
  var VIEWS = [['tree', 'Annotated tree'], ['table', 'Budget table'], ['head', 'Headroom'], ['volt', 'Voltage windows'], ['flow', 'Power flow']];
  var HELP = {
    tree: 'The power tree with each line’s current and power, each source’s load against what it can supply, and each converter’s efficiency and loss.',
    table: 'One row per load, grouped by rail, typical and worst case side by side, with the margin left on each rail.',
    head: 'Each source’s load, stacked by what draws it, against what it can supply, with the margin line.',
    volt: 'Each rail’s output range against the range each load accepts. A load whose range doesn’t cover its source’s is flagged.',
    flow: 'Power from the input through each converter to the loads, as wide as it is, with each converter’s loss as a branch. Hover a band for its number.'
  };
  function viewHtml(A, view, sel) {
    return view === 'table' ? tableHtml(A) : view === 'head' ? headHtml(A) : view === 'volt' ? voltHtml(A) : view === 'flow' ? flowHtml(A) : treeHtml(A, sel);
  }

  window.SignoffPower = {
    parse: parse, write: write, parseWords: parseWords, newItem: newItem, budget: budget, analyse: analyse, any: any,
    rowsHtml: rowsHtml, viewHtml: viewHtml, summaryHtml: summaryHtml, issuesHtml: issuesHtml, VIEWS: VIEWS, HELP: HELP,
    fmtI: fmtI, fmtP: fmtP, fmtV: fmtV, num: num
  };
})();
