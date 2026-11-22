/* Signoff engine: the pin map, drawn (2026-11-20, Chris: "a part and used pin view, where you can click available
   pins for peripherals", as CubeMX has). Edit it in ee_design_review only. It draws a plan from assets/pinmap.js;
   it never changes data itself: picks go out through callbacks. Scribe EE's MCU block opens it full window
   (app.js, *Pins*); Pincheck's lab (../pincheck/lab/pinmap.html) mounts it too. Styles: styles.css, *Pin map*.

   const view = window.SignoffPinView.mount(root, {
     part, result,                 // SignoffPinmap.part(file) and .plan(part, conns, map)
     map,                          // the picks the plan was made with ({ pad: { req, sig, fn, gpio } })
     view, sel,                    // which view ('package', 'block', 'ports', 'matrix', 'table'), selected requirement
     canEdit,                      // false: no picks, no fixes (the views still show everything)
     onPick(pad, fn, reqId, gpio), onUnpick(pad), onClear(reqId), onType(reqId, itemKeys, value), onLock(reqIds, on), onLockPads(pads, on), onAuto(), onUnassign(), onFix(reqId), onView(view)
   });
   view.update({ part, result, map })   draws again, keeping the view and the selection
   view.destroy()

   A connection (requirement) in the list lights the pins it could use in every view; a pin opens its functions,
   and a click on one is a pick for the requirement it serves (or for none: a function no connection asks for). Every state has a
   mark or a pattern as well as a color (Chris is colorblind).
*/
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const VIEWS = [['package', 'Package'], ['block', 'Block'], ['ports', 'Ports'], ['matrix', 'Matrix'], ['table', 'Table']];
  const LEGEND = [['used', 'Assigned'], ['cand', 'Could use'], ['taken', 'Could use, taken'], ['issue', 'Problem'], ['warn', 'To check'], ['special', 'Clock or boot'], ['fixed', 'Power and reset'], ['free', 'Free']];
  const MARK = { issue: '✕', warn: '▲', todo: '○', ok: '✓' };
  const RANK = ['issue', 'warn', 'todo', 'ok'];
  // A row's lock (Chris, 2026-11-21): closed holds its pins through Auto-assign and Unassign.
  const LOCK_SVG = on => '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor"/><path d="' + (on ? 'M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2' : 'M5.2 7V5a2.8 2.8 0 0 1 5.5-.7') + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  let uid = 0;

  function mount(root, opts) {
    const P = window.SignoffPinmap, FIXED = P.FIXED, TYPES = P.TYPES, nat = P.nat, sevOf = P.sevOf;
    const id = 'pv' + (++uid);                    // SVG pattern ids, unique per mounted view
    const S = { part: opts.part, result: opts.result, map: opts.map || {}, view: VIEWS.some(v => v[0] === opts.view) ? opts.view : 'package', sel: opts.sel || null, selConn: null, selPad: null, mineIds: new Set(), cand: {}, open: new Set() };
    const can = () => opts.canEdit !== false;
    root.innerHTML = '<div class="pv"><aside class="pv-side"><div class="pv-sum"></div><div class="pv-conns"></div></aside>' +
      '<section class="pv-stage"><div class="pv-tabs"><div class="seg pv-views" role="tablist">' + VIEWS.map(v => '<button data-view="' + v[0] + '">' + v[1] + '</button>').join('') + '</div><div class="pv-legend"></div></div><div class="pv-view"></div><div class="pv-acts"></div></section>' +
      '<div class="pv-pop" hidden></div></div>';
    const $ = s => root.querySelector(s);
    const pop = $('.pv-pop');

    const selReq = () => S.result.reqs.find(r => r.id === S.sel) || null;
    function padState(num) {
      const pad = S.part.byNum[num], u = S.result.used[num];
      if (u && u.stray) return 'stray';
      if (u) return sevOf(u.req) === 'issue' ? 'issue' : sevOf(u.req) === 'warn' ? 'warn' : 'used';
      if (!pad.gpio || pad.role !== 'io') return pad.fns.length && !FIXED.has(pad.role) ? 'special' : 'fixed';
      return 'free';
    }
    function padLabel(num) {
      const u = S.result.used[num];
      if (!u) return '';
      if (u.stray) return u.sig;
      if (u.fn) return u.fn.full;
      return u.req.type === 'PINS' || u.req.type === 'GPIO' ? 'GPIO' : u.sig;
    }
    const padFor = num => { const u = S.result.used[num]; return u && u.req ? u.req.users.map(x => x.block).join(', ') : u && u.stray ? 'no connection' : ''; };
    const isCand = num => Object.prototype.hasOwnProperty.call(S.cand, num);
    // What's selected: one signal (S.sel, a requirement id), or a whole connection (S.selConn, Chris 2026-11-21: a row
    // with several signals selects them all on the drawing).
    const selIds = () => {
      if (S.selPad) return new Set();
      if (S.selConn) return new Set(S.result.reqs.filter(r => r.users.some(u => u.conn.id === S.selConn)).map(r => r.id));
      return new Set(S.sel ? [S.sel] : []);
    };
    const isMine = num => { if (S.selPad) return String(num) === String(S.selPad); const u = S.result.used[num]; return !!(u && u.req && S.mineIds && S.mineIds.has(u.req.id)); };
    const what = r => r.type === 'PINS' ? 'Pins' : TYPES[r.type].single ? r.type : (r.inst || r.want || r.item.inst || r.type) + (r.item.count > 1 ? ' × ' + r.item.count : '');

    function render() {
      renderSide();
      renderView();
      root.querySelectorAll('.pv-views button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
    }

    function renderSide() {
      const c = S.result.counts;
      $('.pv-sum').innerHTML = '<span><b>' + c.used + '</b> of ' + c.io + ' I/O pins assigned</span>' +
        (c.problems ? '<span class="pv-tag issue">✕ ' + c.problems + (c.problems === 1 ? ' problem' : ' problems') + '</span>' : '') +
        (c.warnings ? '<span class="pv-tag warn">▲ ' + c.warnings + ' to check</span>' : '') +
        (c.unassigned ? '<span class="pv-tag todo">○ ' + c.unassigned + ' not assigned</span>' : '') +
        (!c.problems && !c.warnings && !c.unassigned ? '<span class="pv-tag ok">✓ All placed</span>' : '');
      // The lock button for one or more requirements: on when every stored pin of theirs is locked.
      const lockBtn = (rs, label) => {
        rs = rs.filter(r => !TYPES[r.type].fixed && r.slots.length);
        if (!rs.length || !can() || !opts.onLock) return '';
        const on = rs.every(r => r.slots.every(sl => sl.lock));
        return '<button class="pv-lock' + (on ? ' on' : '') + '" data-lock="' + esc(rs.map(r => r.id).join(' ')) + '" data-on="' + (on ? '0' : '1') + '" aria-pressed="' + on + '" title="' + (on ? 'Locked: Auto-assign and Unassign leave ' + esc(label) + '. Click to unlock.' : 'Lock ' + esc(label) + '’s pins, so Auto-assign and Unassign leave them') + '">' + LOCK_SVG(on) + '</button>';
      };
      const groups = P.typeOptions(S.part);
      // Type: what the planner takes a signal to be, over the label (Chris, 2026-11-21: "Sense1_I2C" as I2C). It sets
      // this connection's signal only, even on a bus other blocks share.
      const typeSel = (r, u) => {
        if (r.type === 'PINS' || !can() || !opts.onType || !u) return '';
        const cur = (u.item && u.item.set) || '';
        const o = (v, t) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>';
        return '<label class="pv-type-l">Type <select class="pv-type" data-req="' + esc(r.id) + '" data-keys="' + esc(u.key) + '" title="What the planner takes this signal to be; the label stays as written">' +
          o('', cur ? 'From the label' : 'From the label (' + (TYPES[r.type].single ? r.type : r.inst || r.want || r.type) + ')') + o('GPIO', 'GPIO') +
          groups.map(g => g.insts.length ? '<optgroup label="' + esc(TYPES[g.type].name || g.type) + '">' + o(g.type, g.type + ', any') + g.insts.map(i => o(i, i)).join('') + '</optgroup>' : o(g.type, g.type)).join('') +
          '</select></label>';
      };
      // A requirement's pins in reading order: a bus by its signals (SCK, MOSI, MISO), anything else by pin.
      const slotsOf = r => { const T = TYPES[r.type]; return r.slots.slice().sort((a, b) => T.bus ? T.sigs.indexOf(a.sig) - T.sigs.indexOf(b.sig) : nat(a.gpio, b.gpio)); };
      const pinsOf = r => slotsOf(r).map(s => '<span class="pv-pin' + (s.lock ? ' lock' : '') + '">' + esc(s.gpio) + (s.sig && s.sig !== s.gpio && s.sig !== 'GPIO' ? ' <i>' + esc(s.sig) + '</i>' : '') + '</span>').join('');
      const caret = (id, open, label) => '<button class="pv-caret" data-fold="' + esc(id) + '" aria-expanded="' + open + '" aria-label="' + (open ? 'Close' : 'Open') + ' ' + esc(label) + '’s signals" title="' + (open ? 'Close' : 'Show each signal') + '"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
      const noteList = r => r.problems.map(t => '<li class="issue">' + esc(t.text) + '</li>').concat(r.notes.map(n => '<li class="' + esc(n.sev) + '">' + esc(n.text) + '</li>')).join('');
      const fixes = r => (r.fix && can() && opts.onFix ? '<button class="btn btn-plain btn-sm pv-fix" data-fix="' + esc(r.id) + '">Write it as ' + esc(r.fix.to) + '</button>' : '') +
        (r.slots.some(sl => sl.lock) && can() && opts.onClear ? '<button class="btn btn-plain btn-sm pv-fix" data-clear="' + esc(r.id) + '" title="Remove your picks for this signal; it goes back to not assigned">Clear picks</button>' : '');
      const netName = u => String((u.item && u.item.text) || '').replace(/^\d+\s*[x×]?\s+/, '');
      // One pin of a requirement (Chris, 2026-11-21: a connection folds open to a row per pin): its signal, pin, and lock.
      const pinRow = (r, u, sl, i, n) => {
        const T = TYPES[r.type], name = r.type === 'PINS' ? sl.gpio : T.bus ? sl.sig : (netName(u) || r.type) + (n > 1 ? ' ' + (i + 1) : '');
        const fn = sl.fn && !T.bus ? sl.fn.full : '';
        const lk = !T.fixed && can() && opts.onLockPads ? '<button class="pv-lock' + (sl.lock ? ' on' : '') + '" data-lockpad="' + esc(sl.pad) + '" data-on="' + (sl.lock ? '0' : '1') + '" aria-pressed="' + !!sl.lock + '" title="' + (sl.lock ? 'Locked. Click to unlock ' : 'Lock ') + esc(name) + ' on ' + esc(sl.gpio) + '">' + LOCK_SVG(!!sl.lock) + '</button>' : '';
        return '<div class="pv-pinrow' + (S.selPad === sl.pad ? ' sel' : '') + '" data-selpad="' + esc(sl.pad) + '" tabindex="0"><span class="pv-pr-name">' + esc(name) + '</span>' +
          '<span class="pv-pin' + (sl.lock ? ' lock' : '') + '">' + esc(sl.gpio) + '</span>' + (fn ? '<span class="pv-pr-fn">' + esc(fn) + '</span>' : '') + lk + '</div>';
      };
      const pinRows = (r, u) => { const ss = slotsOf(r); return ss.map((sl, i) => pinRow(r, u, sl, i, ss.length)).join(''); };
      // A plain row: one connection with one pin, or none yet.
      const oneRow = (r, u, c) => {
        const sev = sevOf(r), pins = pinsOf(r), notes = noteList(r);
        return '<div class="pv-conn ' + sev + (S.sel === r.id ? ' sel' : '') + '" data-req="' + esc(r.id) + '" tabindex="0">' +
          '<div class="pv-conn-top"><span class="pv-mark ' + sev + '">' + MARK[sev] + '</span><span class="pv-what">' + esc(c.block) + '</span><span class="pv-blocks">' + esc(what(r)) + '</span>' + lockBtn([r], c.block) + '</div>' +
          '<div class="pv-conn-label">“' + esc(c.label) + '”' + (c.dir && c.dir !== 'out' ? ' · ' + esc(c.dir) : '') + typeSel(r, u) + '</div>' +
          (pins ? '<div class="pv-pins">' + pins + '</div>' : '') + (notes ? '<ul class="pv-notes">' + notes + '</ul>' : '') + fixes(r) + '</div>';
      };
      // An interface inside a connection with several ("SPI2" in "LCD SPI2 + EXTCOMIN"): its heading, then its pins.
      const ifaceRows = (r, u) => {
        const sev = sevOf(r), notes = noteList(r), name = netName(u);
        return '<div class="pv-conn kid ' + sev + (S.sel === r.id ? ' sel' : '') + '" data-req="' + esc(r.id) + '" tabindex="0">' +
          '<div class="pv-conn-top"><span class="pv-mark ' + sev + '">' + MARK[sev] + '</span><span class="pv-what">' + esc(what(r)) + '</span><span class="pv-blocks">' + esc(name.toLowerCase() === what(r).toLowerCase() ? '' : name) + '</span>' + lockBtn([r], name || what(r)) + '</div>' +
          '<div class="pv-conn-label">' + typeSel(r, u) + '</div>' + (notes ? '<ul class="pv-notes">' + notes + '</ul>' : '') + fixes(r) + '</div>' +
          (r.slots.length ? '<div class="pv-pinrows">' + pinRows(r, u) + '</div>' : '');
      };
      // One row per connection into the MCU (Chris, 2026-11-21), in the order Scribe lists them. A connection with two
      // or more pins folds open: to a row per pin, or, with several interfaces, to each interface and its pins.
      const order = {}; (S.result.conns || []).forEach((c, i) => { order[c.id] = i; });
      const conns = [], byId = {};
      S.result.reqs.forEach(r => r.users.forEach(u => {
        const id = u.conn.id;
        let c = byId[id];
        if (!c) { c = byId[id] = { id, block: u.block, label: u.conn.label || '', dir: u.conn.dir || r.dir, items: [] }; conns.push(c); }
        c.items.push({ r, u, ii: +String(u.key || '').split('#').pop() || 0 });
      }));
      conns.sort((a, b) => (order[a.id] != null ? order[a.id] : 1e6) - (order[b.id] != null ? order[b.id] : 1e6));
      const worst = list => list.map(x => sevOf(x.r)).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
      const rows = conns.map(c => {
        c.items.sort((a, b) => a.ii - b.ii);
        const multi = c.items.length > 1, nPins = c.items.reduce((n, x) => n + x.r.slots.length, 0);
        if (!multi && nPins < 2) return oneRow(c.items[0].r, c.items[0].u, c);
        const sev = worst(c.items), open = S.open.has(c.id) || (multi && c.items.some(x => x.r.id === S.sel)) || c.items.some(x => x.r.slots.some(sl => sl.pad === S.selPad));
        const one = !multi ? c.items[0] : null, notes = one ? noteList(one.r) : '';
        // The caret opens and closes the fold; a click elsewhere on the row selects all its pins on the drawing.
        return '<div class="pv-cgrp ' + sev + (open ? ' open' : '') + '">' +
          '<div class="pv-conn pv-chead ' + sev + (S.selConn === c.id || (one && S.sel === one.r.id) ? ' sel' : '') + '" data-conn="' + esc(c.id) + '"' + (one ? ' data-req="' + esc(one.r.id) + '"' : '') + ' tabindex="0">' +
          '<div class="pv-conn-top">' + caret(c.id, open, c.block) + '<span class="pv-mark ' + sev + '">' + MARK[sev] + '</span><span class="pv-what">' + esc(c.block) + '</span><span class="pv-blocks">' + (one ? esc(what(one.r)) : c.items.length + ' signals') + '</span>' + lockBtn(c.items.map(x => x.r), c.block) + '</div>' +
          '<div class="pv-conn-label">“' + esc(c.label) + '”' + (c.dir && c.dir !== 'out' ? ' · ' + esc(c.dir) : '') + (one ? typeSel(one.r, one.u) : '') + '</div>' +
          (open ? '' : '<div class="pv-pins">' + c.items.map(x => pinsOf(x.r)).join('') + '</div>') +
          (notes ? '<ul class="pv-notes">' + notes + '</ul>' : '') + (one ? fixes(one.r) : '') + '</div>' +
          (open ? '<div class="pv-kids">' + (one ? '<div class="pv-pinrows">' + pinRows(one.r, one.u) + '</div>' : c.items.map(x => ifaceRows(x.r, x.u)).join('')) + '</div>' : '') + '</div>';
      }).join('');
      const stray = S.result.stray.map(s => '<div class="pv-conn warn"><div class="pv-conn-top"><span class="pv-mark warn">▲</span><span class="pv-what">' + esc(s.fn) + '</span><span class="pv-blocks">' + esc((S.part.byNum[s.pad] || { names: [s.pad] }).names[0]) + '</span></div><div class="pv-conn-label">You picked this function on the pin, but no connection to the MCU asks for it. The pin stays reserved for it.</div>' +
        (can() && opts.onUnpick ? '<button class="btn btn-plain btn-sm pv-fix" data-unpick="' + esc(s.pad) + '">Remove the pick</button>' : '') + '</div>').join('');
      $('.pv-conns').innerHTML = rows + stray || '<p class="pv-hint">No connections yet. Connect blocks to the MCU, naming the interface: IMU (I2C1), Wi-Fi module (UART).</p>';
    }

    // Unassign and Auto-assign, at the drawing's bottom left (Chris, 2026-11-21).
    function renderActs() {
      const el = $('.pv-acts');
      if (!el) return;
      const unlocked = Object.keys(S.map || {}).some(k => S.map[k].auto), open = S.result.reqs.some(r => r.todo);
      el.innerHTML = can() && (opts.onAuto || opts.onUnassign) ?
        (opts.onUnassign ? '<button class="btn btn-sm" data-act-pv="unassign"' + (unlocked ? '' : ' disabled') + ' title="Take every pin off its connection, except locked rows">Unassign</button>' : '') +
        (opts.onAuto ? '<button class="btn btn-sm btn-primary" data-act-pv="auto"' + (open ? '' : ' disabled') + ' title="Place every connection not assigned yet, around the ones that are">Auto-assign</button>' : '') : '';
    }
    function renderView() {
      renderActs();
      $('.pv-legend').innerHTML = LEGEND.map(l => '<span class="pv-lg"><i class="pv-sw ' + l[0] + '"></i>' + l[1] + '</span>').join('');
      S.mineIds = selIds();
      S.cand = S.selConn || S.selPad ? {} : P.candidates(S.part, selReq(), S.result.used);   // a whole connection lights its own pins only
      const v = $('.pv-view');
      v.className = 'pv-view v-' + S.view;
      v.innerHTML = ({ package: viewPackage, block: viewBlock, ports: viewPorts, matrix: viewMatrix, table: viewTable }[S.view] || viewPackage)();
    }

    const DEFS = '<defs><pattern id="' + id + 'hi" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="5" height="5" class="pv-p-ibg"/><line x1="0" y1="0" x2="0" y2="5" class="pv-p-iln"/></pattern>' +
      '<pattern id="' + id + 'hw" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" class="pv-p-wbg"/><circle cx="2" cy="2" r="0.9" class="pv-p-wdt"/></pattern>' +
      '<symbol id="' + id + 'lock" viewBox="0 0 10 12"><path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="1" y="5" width="8" height="6.5" rx="1.2" fill="currentColor"/></symbol></defs>';

    function padRect(num, x, y, w, h) {
      const st = padState(num), u = S.result.used[num];
      const fill = st === 'issue' ? ' fill="url(#' + id + 'hi)"' : st === 'warn' || st === 'stray' ? ' fill="url(#' + id + 'hw)"' : '';
      const cls = ['pv-pad', st, isCand(num) ? (S.cand[num].taken ? 'cand taken' : 'cand') : '', isMine(num) ? 'mine' : ''].join(' ');
      const lock = u && u.lock ? '<use href="#' + id + 'lock" x="' + (x + w / 2 - 4) + '" y="' + (y + h / 2 - 5) + '" width="8" height="10" class="pv-lockg"/>' : '';
      return '<g class="pv-hit" data-pad="' + esc(num) + '"><rect class="' + cls + '"' + fill + ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="2"/>' + lock + '<title>' + esc(tip(num)) + '</title></g>';
    }
    function tip(num) {
      const p = S.part.byNum[num], u = S.result.used[num];
      return p.num + ' · ' + p.name + (p.bonded ? ' (pin shared by ' + p.names.join(' and ') + ')' : '') + (u ? '\n→ ' + padLabel(num) + ' for ' + padFor(num) : '') +
        (p.fns.length ? '\n' + p.fns.map(f => f.full + (f.af != null ? ' AF' + f.af : '') + (p.bonded ? ' [' + f.gpio + ']' : '')).join(', ') : '');
    }
    // An exposed pad (role 'pad', the QFN's pin 33) sits under the body, not on a side.
    const edgePads = () => S.part.pads.filter(p => p.role !== 'pad');
    function layoutKind() {
      const pk = String(S.part.meta.package || '').toUpperCase(), n = edgePads().length;
      if (/BGA|WLCSP|CSP/.test(pk) || S.part.pads.every(p => /^[A-Z]+\d+$/.test(p.num))) return 'grid';
      if (/SO|SOP|SSOP|TSSOP|DIP/.test(pk) && !/QFP|QFN/.test(pk)) return 'dual';
      return n % 4 === 0 ? 'quad' : 'dual';
    }
    const svg = (W, H, g) => '<svg class="pv-svg" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px">' + DEFS + g + '</svg>';

    function viewPackage() {
      const kind = layoutKind();
      if (kind === 'grid') return viewGrid();
      const pads = edgePads().sort((a, b) => nat(a.num, b.num)), n = pads.length;
      const per = kind === 'quad' ? n / 4 : Math.ceil(n / 2);
      const pitch = 26, padL = 22, padW = 15, lab = 118;
      const bodyW = kind === 'quad' ? pitch * (per + 4) : 220, bodyH = pitch * (per + (kind === 'quad' ? 4 : 1));
      const ox = padL + lab + 8, oy = kind === 'quad' ? padL + lab + 8 : 20, W = bodyW + 2 * ox, H = bodyH + 2 * oy;
      let g = '';
      pads.forEach((p, i) => {
        const side = kind === 'quad' ? Math.floor(i / per) : (i < per ? 0 : 2);
        const k = kind === 'quad' ? i % per : (i < per ? i : i - per);
        const t = pitch * (k + (kind === 'quad' ? 2.5 : 1));
        let x, y, w, h, nx, ny, lx, ly, rot = 0, aIn, aOut;
        if (side === 0) { x = ox - padL; y = oy + t - padW / 2; w = padL; h = padW; nx = ox + 6; ny = oy + t; aIn = 'start'; lx = x - 6; ly = ny; aOut = 'end'; }
        else if (side === 1) { x = ox + t - padW / 2; y = oy + bodyH; w = padW; h = padL; nx = ox + t; ny = oy + bodyH - 6; rot = -90; aIn = 'start'; lx = nx; ly = y + padL + 6; aOut = 'end'; }
        else if (side === 2) { const tt = bodyH - t; x = ox + bodyW; y = oy + tt - padW / 2; w = padL; h = padW; nx = ox + bodyW - 6; ny = oy + tt; aIn = 'end'; lx = x + padL + 6; ly = ny; aOut = 'start'; }
        else { const tt = bodyW - t; x = ox + tt - padW / 2; y = oy - padL; w = padW; h = padL; nx = ox + tt; ny = oy + 6; rot = -90; aIn = 'end'; lx = nx; ly = y - 6; aOut = 'start'; }
        const tr = (px, py) => (rot ? ' transform="rotate(' + rot + ' ' + px + ' ' + py + ')"' : '');
        const label = padLabel(p.num);
        g += padRect(p.num, x, y, w, h);
        g += '<text class="pv-pname' + (p.gpio ? '' : ' dim') + '" x="' + nx + '" y="' + ny + '" text-anchor="' + aIn + '" dominant-baseline="central"' + tr(nx, ny) + '>' + esc(p.names.join('/')) + '</text>';
        if (label) g += '<text class="pv-plab ' + padState(p.num) + '" x="' + lx + '" y="' + ly + '" text-anchor="' + aOut + '" dominant-baseline="central"' + tr(lx, ly) + '>' + esc(label) + '</text>';
        if ((side === 0 || side === 2) && (k === 0 || (k + 1) % 4 === 0)) g += '<text class="pv-pnum" x="' + (x + w / 2) + '" y="' + (y - 3) + '" text-anchor="middle">' + esc(p.num) + '</text>';
      });
      S.part.pads.filter(p => p.role === 'pad').forEach((p, i) => {
        const ew = Math.min(bodyW, bodyH) * 0.42, ex = ox + (bodyW - ew) / 2 + i * 8, ey = oy + (bodyH - ew) / 2 + i * 8;
        g += '<g class="pv-ep">' + padRect(p.num, ex, ey, ew, ew) + '</g><text class="pv-pnum" x="' + (ex + ew / 2) + '" y="' + (ey + ew - 8) + '" text-anchor="middle">' + esc(p.num) + ' · ' + esc(p.names[0]) + ' (exposed pad)</text>';
      });
      const r = selReq(), cv = Object.values(S.cand);
      g += '<text class="pv-cname" x="' + (ox + bodyW / 2) + '" y="' + (oy + bodyH / 2 - 10) + '" text-anchor="middle">' + esc(S.part.meta.mpn) + '</text>' +
        '<text class="pv-csub" x="' + (ox + bodyW / 2) + '" y="' + (oy + bodyH / 2 + 12) + '" text-anchor="middle">' + esc(S.part.meta.package || '') +
        (r ? ' · ' + esc(what(r)) + ': ' + cv.filter(c => !c.taken).length + ' free pins could serve, ' + cv.filter(c => c.taken).length + ' taken' : '') + '</text>';
      return svg(W, H, '<rect class="pv-body" x="' + ox + '" y="' + oy + '" width="' + bodyW + '" height="' + bodyH + '" rx="6"/><circle class="pv-dot1" cx="' + (ox + 14) + '" cy="' + (oy + 14) + '" r="4"/>' + g);
    }

    function viewGrid() {
      const balls = S.part.pads.map(p => { const m = /^([A-Z]+)(\d+)$/.exec(p.num) || [0, 'A', p.num]; return { p, row: m[1], col: +m[2] || 1 }; });
      const rows = [...new Set(balls.map(b => b.row))].sort(nat), cols = Math.max(...balls.map(b => b.col)), s = 34, o = 30;
      let g = '';
      rows.forEach((r, i) => { g += '<text class="pv-pnum" x="' + (o - 14) + '" y="' + (o + i * s + s / 2) + '" text-anchor="middle" dominant-baseline="central">' + esc(r) + '</text>'; });
      for (let c = 1; c <= cols; c++) g += '<text class="pv-pnum" x="' + (o + (c - 1) * s + s / 2) + '" y="' + (o - 10) + '" text-anchor="middle">' + c + '</text>';
      balls.forEach(b => {
        const x = o + (b.col - 1) * s + 3, y = o + rows.indexOf(b.row) * s + 3;
        g += padRect(b.p.num, x, y, s - 6, s - 6) + '<text class="pv-bname" x="' + (x + (s - 6) / 2) + '" y="' + (y + (s - 6) / 2) + '" text-anchor="middle" dominant-baseline="central">' + esc(b.p.names[0].slice(0, 5)) + '</text>';
      });
      return svg(o * 2 + cols * s, o * 2 + rows.length * s, g);
    }

    function viewBlock() {
      const reqs = S.result.reqs.filter(r => r.slots.length || r.problems.length);
      const left = reqs.filter(r => r.dir === 'in'), right = reqs.filter(r => r.dir !== 'in');
      const rowH = 17, gap = 16, headH = 18;
      const groupH = r => headH + Math.max(1, r.slots.length) * rowH;
      const colH = list => list.reduce((h, r) => h + Math.max(groupH(r), r.users.length * 26) + gap, gap);
      const power = S.part.pads.filter(p => FIXED.has(p.role) && p.role !== 'nc'), fixed = S.part.pads.filter(p => !p.gpio && !FIXED.has(p.role));
      const bodyH = Math.max(colH(left), colH(right), 240) + 40, bx = 250, bw = 300, by = 60, W = bx * 2 + bw, H = by + bodyH + 70;
      let g = '<rect class="pv-body" x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bodyH + '" rx="8"/>' +
        '<text class="pv-cname" x="' + (bx + bw / 2) + '" y="' + (by + bodyH / 2 - 6) + '" text-anchor="middle">MCU</text><text class="pv-csub" x="' + (bx + bw / 2) + '" y="' + (by + bodyH / 2 + 14) + '" text-anchor="middle">' + esc(S.part.meta.mpn) + '</text>';
      const seen = {};
      const strip = (list, y, up) => list.filter(p => { const k = p.names[0]; if (seen[k]) return false; seen[k] = 1; return true; }).forEach((p, i, arr) => {
        const x = bx + 30 + i * Math.min(60, (bw - 60) / Math.max(1, arr.length - 1 || 1));
        g += '<line class="pv-wire dim" x1="' + x + '" y1="' + y + '" x2="' + x + '" y2="' + (y + (up ? -18 : 18)) + '"/><text class="pv-pname dim" x="' + x + '" y="' + (y + (up ? -24 : 30)) + '" text-anchor="middle">' + esc(p.names[0]) + '</text>';
      });
      strip(power.filter(p => p.role !== 'ground'), by, true); strip(power.filter(p => p.role === 'ground'), by + bodyH, false);
      const drawCol = (list, isLeft) => {
        let y = by + gap + 10;
        list.forEach(r => {
          const h = Math.max(groupH(r), r.users.length * 26), sev = sevOf(r), edge = isLeft ? bx : bx + bw;
          const tx = isLeft ? bx + 10 : bx + bw - 10, anchor = isLeft ? 'start' : 'end';
          g += '<g class="pv-grp' + (S.sel === r.id ? ' sel' : '') + '" data-req="' + esc(r.id) + '"><text class="pv-ghead ' + sev + '" x="' + tx + '" y="' + (y + 12) + '" text-anchor="' + anchor + '">' + (sev === 'ok' ? '' : MARK[sev] + ' ') + esc(what(r)) + '</text>';
          const ys = [];
          (r.slots.length ? r.slots.slice().sort((a, b) => nat(a.sig, b.sig)) : [null]).forEach((s, i) => {
            const yy = y + headH + i * rowH + rowH / 2;
            ys.push(yy);
            if (s) g += padRect(s.pad, isLeft ? edge - 16 : edge, yy - 5, 16, 10) + '<text class="pv-prow" x="' + tx + '" y="' + yy + '" text-anchor="' + anchor + '" dominant-baseline="central">' + esc(s.gpio) + (s.sig !== s.gpio && s.sig !== 'GPIO' ? ' · ' + esc(s.sig) : '') + '</text>';
            else g += '<text class="pv-prow issue" x="' + tx + '" y="' + yy + '" text-anchor="' + anchor + '" dominant-baseline="central">no pins</text>';
          });
          // Lines end on the pins (Chris, 2026-11-21: they met the group's middle, beside the pins): one pin takes the
          // line at its own height; several are joined by a short bar just outside them, and the lines meet its middle.
          const out = isLeft ? -1 : 1, padOut = edge + out * 16, pc = (ys[0] + ys[ys.length - 1]) / 2;
          let endX = padOut;
          if (r.slots.length > 1) {
            endX = padOut + out * 12;
            ys.forEach(yy => { g += '<line class="pv-wire ' + sev + '" x1="' + padOut + '" y1="' + yy + '" x2="' + endX + '" y2="' + yy + '"/>'; });
            g += '<line class="pv-wire ' + sev + '" x1="' + endX + '" y1="' + ys[0] + '" x2="' + endX + '" y2="' + ys[ys.length - 1] + '"/>';
          }
          const ux = isLeft ? 20 : bx + bw + 60, uw = 170, n = r.users.length;
          const top = Math.min(Math.max(pc - (n * 26) / 2, y), y + h - n * 26);
          r.users.forEach((u, i) => {
            const uy = top + i * 26 + 2, ex = isLeft ? ux + uw : ux, c1 = (ex + endX) / 2;
            g += '<path class="pv-wire ' + sev + '" d="M' + ex + ' ' + (uy + 11) + ' C ' + c1 + ' ' + (uy + 11) + ', ' + c1 + ' ' + pc + ', ' + endX + ' ' + pc + '"/>' +
              '<rect class="pv-ublock" x="' + ux + '" y="' + uy + '" width="' + uw + '" height="22" rx="4"/><text class="pv-utext" x="' + (ux + 8) + '" y="' + (uy + 11) + '" dominant-baseline="central">' + esc(trunc(u.block, 24)) + '</text>';
          });
          g += '</g>';
          y += h + gap;
        });
      };
      drawCol(left, true); drawCol(right, false);
      if (fixed.length) g += '<text class="pv-csub" x="' + (bx + bw / 2) + '" y="' + (by + bodyH - 14) + '" text-anchor="middle">' + esc(fixed.map(p => p.names[0] + (p.also ? ' ' + p.also : '')).join(' · ')) + '</text>';
      return svg(W, H, g);
    }

    function viewPorts() {
      const ports = {};
      S.part.pads.forEach(p => p.names.forEach(n => { const q = P.portOf(n); if (q && q.bit < 16) (ports[q.port] = ports[q.port] || {})[q.bit] = p; }));
      const head = '<tr><th></th>' + Array.from({ length: 16 }, (_, b) => '<th>' + b + '</th>').join('') + '</tr>';
      const body = Object.keys(ports).sort().map(port => '<tr><th>P' + port + '</th>' + Array.from({ length: 16 }, (_, b) => {
        const p = ports[port][b];
        if (!p) return '<td class="pv-nb" title="Not bonded out in this package"><span>—</span></td>';
        const u = S.result.used[p.num];
        return '<td class="pv-cell ' + padState(p.num) + (isCand(p.num) ? ' cand' : '') + (isMine(p.num) ? ' mine' : '') + '" data-pad="' + esc(p.num) + '" title="' + esc(tip(p.num)) + '"><b>P' + port + b + '</b><small>' + (esc(padLabel(p.num).replace(/^(.*?)_/, '$1 ')) || '&nbsp;') + '</small>' +
          (u && u.lock ? '<i class="pv-lk">⚿</i>' : '') + (p.bonded ? '<i class="pv-shared" title="Pin ' + esc(p.num) + ' is shared by ' + esc(p.names.join(' and ')) + '">⇄</i>' : '') + '</td>';
      }).join('') + '</tr>').join('');
      return '<div class="pv-scroll"><table class="pv-ports">' + head + body + '</table></div><p class="pv-hint">A dash is a bit this package doesn’t bond out. ⇄ marks a pin two GPIOs share, so using one takes the other’s pin too.</p>';
    }

    function viewMatrix() {
      const portKey = p => { const q = P.portOf(p.names[0]); return q ? q.port + String(q.bit).padStart(2, '0') : 'Z' + p.num; };
      const gp = S.part.pads.filter(p => p.fns.length && !FIXED.has(p.role)).sort((a, b) => nat(portKey(a), portKey(b)));
      const insts = S.part.insts.filter(i => gp.some(p => p.fns.some(f => f.inst === i))), used = S.result.used;
      const head = '<tr><th class="pv-stick"></th>' + gp.map(p => '<th class="pv-vert' + (isCand(p.num) ? ' cand' : '') + '" data-pad="' + esc(p.num) + '"><span>' + esc(p.names.join('/')) + '</span></th>').join('') + '</tr>';
      const body = insts.map(i => {
        const owner = S.result.reqs.find(r => r.inst === i && TYPES[r.type] && TYPES[r.type].bus);
        return '<tr><th class="pv-stick' + (owner ? ' own' : '') + '" title="' + (owner ? 'Used by ' + esc(owner.users.map(u => u.block).join(', ')) : '') + '">' + esc(i) + (owner ? ' ●' : '') + '</th>' + gp.map(p => {
          const fs = p.fns.filter(f => f.inst === i);
          if (!fs.length) return '<td></td>';
          const u = used[p.num], on = u && u.fn && u.fn.inst === i;
          return '<td class="pv-m ' + (on ? 'on ' + padState(p.num) : u ? 'gone' : 'can') + (isCand(p.num) && S.cand[p.num].f && S.cand[p.num].f.inst === i ? ' cand' : '') + '" data-pad="' + esc(p.num) + '" title="' + esc(p.names[0] + ': ' + fs.map(f => f.full).join(', ')) + '">' + (on ? '■' : u ? '·' : '•') + '</td>';
        }).join('') + '</tr>';
      }).join('');
      return '<div class="pv-scroll"><table class="pv-matrix">' + head + body + '</table></div><p class="pv-hint">• the peripheral can use the pin · ■ assigned there · · the pin is taken by something else. ● a peripheral a connection holds.</p>';
    }

    function viewTable() {
      const rows = S.part.pads.slice().sort((a, b) => nat(a.num, b.num)).map(p => {
        const st = padState(p.num), u = S.result.used[p.num];
        return '<tr class="' + (isCand(p.num) ? 'cand' : '') + (isMine(p.num) ? ' mine' : '') + '" data-pad="' + esc(p.num) + '"><td class="num">' + esc(p.num) + '</td><td>' + esc(p.names.join(' / ')) + (p.also ? ' <span class="pv-dim">' + esc(p.also) + '</span>' : '') + '</td>' +
          '<td><span class="pv-chip ' + st + '">' + (st === 'issue' ? '✕ ' : st === 'warn' || st === 'stray' ? '▲ ' : '') + esc(padLabel(p.num) || (st === 'fixed' || st === 'special' ? p.role : '')) + '</span>' + (u && u.lock ? ' ⚿' : '') + '</td>' +
          '<td>' + esc(padFor(p.num)) + '</td><td class="pv-fns">' + esc(p.fns.map(f => f.full).join(', ')) + '</td></tr>';
      }).join('');
      return '<div class="pv-scroll"><table class="pv-table"><thead><tr><th>Pin</th><th>Name</th><th>Assigned</th><th>For</th><th>Other functions</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    // A pin's functions, each with the requirement it would serve; a click is a pick.
    function openPop(num, ev) {
      const p = S.part.byNum[num], u = S.result.used[num], r = selReq();
      const groups = {};
      P.choices(S.part, S.result, num, S.sel).forEach(c => { (groups[c.fn.fam] = groups[c.fn.fam] || []).push(c); });
      const mine = fam => (r && TYPES[r.type] && (TYPES[r.type].fams || []).includes(fam) ? 0 : 1);
      const items = Object.keys(groups).sort((a, b) => mine(a) - mine(b) || nat(a, b)).map(fam => '<div class="pv-pop-g">' + esc(fam) + '</div>' + groups[fam].map(c => {
        const f = c.fn, q = c.req, on = u && u.fn && u.fn.full === f.full && u.fn.gpio === f.gpio;
        return '<button class="pv-pop-i' + (on ? ' on' : '') + (q ? ' fit' : '') + '" data-fn="' + esc(f.full) + '" data-gpio="' + esc(f.gpio) + '" data-req="' + (q ? esc(q.id) : '') + '"' + (can() ? '' : ' disabled') + '><span>' + esc(f.full) + (p.bonded ? ' <small>[' + esc(f.gpio) + ']</small>' : '') + '</span><small>' + (f.af != null ? 'AF' + f.af : 'analog or extra') + (q ? ' · for ' + esc(q.users[0].block) : ' · no connection uses it') + '</small></button>';
      }).join('')).join('');
      const gpio = r && (r.type === 'GPIO' || r.type === 'PINS') && p.gpio && can() ? '<button class="pv-pop-i fit" data-fn="" data-req="' + esc(r.id) + '"><span>GPIO</span><small>' + esc(r.users[0].block) + '</small></button>' : '';
      pop.innerHTML = '<div class="pv-pop-h"><b>' + esc(p.num) + ' · ' + esc(p.names.join(' / ')) + '</b>' + (p.also ? ' <span class="pv-dim">' + esc(p.also) + '</span>' : '') +
        '<div class="pv-dim">' + esc(p.role) + (u ? ' · now ' + esc(padLabel(num)) + (padFor(num) ? ' for ' + esc(padFor(num)) : '') : '') + '</div>' + (can() ? '' : '<div class="pv-dim">Read only.</div>') + '</div>' +
        gpio + (items || '<div class="pv-dim pv-pop-none">No alternate functions.</div>') +
        (S.map[num] && can() && opts.onUnpick ? '<button class="pv-pop-i" data-unpick="1"><span>Let the planner choose</span><small>Remove your pick</small></button>' : '');
      pop.hidden = false;
      pop.dataset.pad = num;
      const bw = window.innerWidth, bh = window.innerHeight, w = Math.min(300, bw - 24);
      pop.style.width = w + 'px';
      let x = ev.clientX + 10, y = ev.clientY + 10;
      if (x + w > bw - 12) x = Math.max(12, ev.clientX - w - 10);
      pop.style.left = x + 'px'; pop.style.top = '0px';
      const h = pop.offsetHeight;
      if (y + h > bh - 12) y = Math.max(12, bh - h - 12);
      pop.style.top = y + 'px';
    }
    const closePop = () => { pop.hidden = true; };

    function onClick(e) {
      const t = e.target;
      if (t.closest('.pv-type-l')) return;                       // the Type list, not the row
      if (t.closest('.pv-pop')) {
        const b = t.closest('button'); if (!b || b.disabled) return;
        const num = pop.dataset.pad;
        closePop();
        if (b.dataset.unpick) { if (opts.onUnpick) opts.onUnpick(num); return; }
        if (b.dataset.req) S.sel = b.dataset.req;
        if (opts.onPick) opts.onPick(num, b.dataset.fn || null, b.dataset.req || null, b.dataset.gpio || null);
        return;
      }
      const vb = t.closest('.pv-views button');
      if (vb) { S.view = vb.dataset.view; closePop(); render(); if (opts.onView) opts.onView(S.view); return; }
      const fx = t.closest('[data-fix]');
      if (fx) { if (opts.onFix) opts.onFix(fx.dataset.fix); return; }
      const pa = t.closest('[data-act-pv]');
      if (pa) { if (pa.disabled) return; if (pa.dataset.actPv === 'auto' && opts.onAuto) opts.onAuto(); if (pa.dataset.actPv === 'unassign' && opts.onUnassign) opts.onUnassign(); return; }
      const lp = t.closest('[data-lockpad]');
      if (lp) { if (opts.onLockPads) opts.onLockPads([lp.dataset.lockpad], lp.dataset.on === '1'); return; }
      const sp = t.closest('[data-selpad]');
      if (sp) { S.selPad = S.selPad === sp.dataset.selpad ? null : sp.dataset.selpad; S.sel = null; S.selConn = null; render(); return; }
      const lk = t.closest('[data-lock]');
      if (lk) { if (opts.onLock) opts.onLock(lk.dataset.lock.split(' ').filter(Boolean), lk.dataset.on === '1'); return; }
      const cl = t.closest('[data-clear]');
      if (cl) { if (opts.onClear) opts.onClear(cl.dataset.clear); return; }
      const up = t.closest('[data-unpick]');
      if (up) { if (opts.onUnpick) opts.onUnpick(up.dataset.unpick); return; }
      const padEl = t.closest('.pv-view [data-pad]');
      if (padEl) { openPop(padEl.dataset.pad, e); return; }
      closePop();
      const fold = t.closest('[data-fold]');
      if (fold) { const id = fold.dataset.fold; if (fold.getAttribute('aria-expanded') === 'true') { S.open.delete(id); const inside = S.result.reqs.filter(r => r.users.some(u => u.conn.id === id)); if (S.selPad && inside.some(r => r.slots.some(sl => sl.pad === S.selPad))) S.selPad = null; if (inside.length > 1 && inside.some(r => r.id === S.sel)) { S.sel = null; S.selConn = id; } } else S.open.add(id); render(); return; }
      const head = t.closest('[data-conn]');
      // One interface: the header selects it, so the pins it could use light too; several: all of them.
      if (head && head.dataset.req) { S.sel = S.sel === head.dataset.req ? null : head.dataset.req; S.selConn = null; S.selPad = null; render(); return; }
      if (head) { S.selConn = S.selConn === head.dataset.conn ? null : head.dataset.conn; S.sel = null; S.selPad = null; render(); return; }
      const row = t.closest('.pv-conn[data-req], .pv-grp[data-req]');
      if (row) { S.sel = S.sel === row.dataset.req ? null : row.dataset.req; S.selConn = null; S.selPad = null; render(); }
    }
    function onKey(e) {
      if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('pv-conn')) e.target.click();   // a row, or a connection's fold
      if (e.key === 'Escape' && !pop.hidden) { closePop(); e.stopPropagation(); }
    }
    function onChange(e) {
      const sel = e.target.closest && e.target.closest('select.pv-type');
      if (!sel || !opts.onType) return;
      const r = S.result.reqs.find(q => q.id === sel.dataset.req);
      if (r) opts.onType(r.id, (sel.dataset.keys || '').split(' ').filter(Boolean), sel.value);
    }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
    const outside = e => { if (!root.contains(e.target)) closePop(); };
    document.addEventListener('mousedown', outside);
    render();

    return {
      update(o) {
        if (o.part) S.part = o.part;
        if (o.result) S.result = o.result;
        if (o.map) S.map = o.map;
        if (S.sel && !S.result.reqs.some(r => r.id === S.sel)) S.sel = null;
        if (S.selConn && !S.result.reqs.some(r => r.users.some(u => u.conn.id === S.selConn))) S.selConn = null;
        if (S.selPad && !S.result.used[S.selPad]) S.selPad = null;
        closePop(); render();
      },
      state() { return { view: S.view, sel: S.sel }; },
      closePop,
      destroy() { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); root.removeEventListener('change', onChange); document.removeEventListener('mousedown', outside); root.innerHTML = ''; },
    };
  }

  window.SignoffPinView = { mount, VIEWS };
})();
