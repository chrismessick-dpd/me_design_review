// Connections (Chris, 2026-11-11): one engine routes every Connection in Loom. A Connection is anything
// that joins two blocks: on a harness, a wire (or the group of wires one route carries) between
// connectors and splices; in a system, a cable between connectors on boards and devices, whether it is a
// Loom harness, a purchased cable, or a generic connection. Both route, shape, and drag the same way, and
// the harness's routing (docs/routing.md) is the baseline: this is its code, moved out of conn.js
// unchanged (tests/golden.js checks the harness still routes exactly as it did).
//
// A caller hands over its parts (rectangles a route walks round) and its connections, each with:
//   key      what its stored shape is kept under (h.routes[key], or a system cable's routes[key])
//   weight   how big it is; bigger ones route first (a harness: its wire count)
//   combos   the end pairs it may take, [{ A, B }]: route.js terminals, level at both ends. A terminal
//            with a choice of sides (a connector's two edges) says conn: true and its side ('l' or 'r');
//            node names the part it leaves, whose rectangle its end runs may cross.
//   half     how far its drawing reaches either side of its line; stub, how far it runs out level
//            before its first corner; r, its corner radius
//   shape    the stored record, { v, a, b, mode } (route.js v; the sides it was shaped on; mode
//            'behind' routes straight past parts), or null
// and gets back each connection's route, { key, A, B, v, half, stub, r, kept, behind }.
//
// The editing is shared too (grab, slide, release, bend, menu below): a drag on a straight run moves it
// sideways on the grid, an end run first gets a bend clear of its part, a double-click adds a bend, a
// run dragged flush with its neighbor merges, and the right-click menu has Walk around parts, Go behind
// parts, and Reset route.
(function (LM) {
  'use strict';
  const RT = () => LM.route;
  // Routes found for each document (a harness or a system), by connection key, so a layout that changes
  // nothing finds none again.
  const routeCache = new Map();

  // Every connection's route, biggest first, each keeping clear of those before it.
  // - A connection may have several end pairs (a connector end may leave from either edge; Chris,
  //   2026-11-10: P3 jumped its pins to the far edge because P2's middle was a little to its right):
  //   each is tried and the cheaper route wins, the first given (the edges facing each other) on a tie.
  // - A route shaped by hand (shape: v, and the edges it was shaped on, a and b) keeps its runs. Its
  //   edges follow its first and last vertical runs: dragged past a connector, it leaves from the other
  //   edge. A run inside a part's span fits neither, and the route runs behind the part (Chris: drags
  //   aren't stopped by parts).
  // - mode 'behind' (the right-click menu) routes straight past parts, behind them.
  // - A route found before is kept while its ends haven't moved, it doesn't now run through a part,
  //   and it doesn't lie along a route that changed before it in this pass (Chris: lines he hadn't
  //   touched kept changing). opts.fast (a part being dragged) re-routes only connections whose ends
  //   moved.
  // opts: { fast, grid (the search grid's step, 10), margin (room round everything, 300), onRoute(A, B)
  // (called for each route in order, as it's laid) }. Returns { routes (Map by key), G, rects }.
  function routeAll(docKey, rects, list, opts) {
    const o0 = opts || {}, RTm = RT();
    const all = list.map(c => {
      const shape = c.shape || null, combos = c.combos, stub = c.stub;
      let kept = null, ends = combos[0];
      if (shape && Array.isArray(shape.v) && shape.v.every(x => isFinite(+x))) {
        kept = shape.v.map(Number);
        const want = combos.find(x => (!x.A.conn || x.A.side === shape.a) && (!x.B.conn || x.B.side === shape.b)) || combos[0];
        ends = [want].concat(combos.filter(x => x !== want)).find(x => RTm.fits(x.A, x.B, kept, stub)) || want;
      }
      return { key: c.key, weight: c.weight, A: ends.A, B: ends.B, combos, half: c.half, stub, r: c.r, kept, behind: !!(shape && shape.mode === 'behind') };
    });
    const sig = o => JSON.stringify(o.combos.map(c => [c.A.x, c.A.y, c.A.out, c.B.x, c.B.y, c.B.in]).flat().concat(o.half, o.behind ? 1 : 0).map(v => Math.round(v * 10) / 10));
    const whole = JSON.stringify([rects.map(r => [r.x0, r.y0, r.x1, r.y1].map(Math.round)), all.map(o => o.key + sig(o) + (o.kept ? o.kept.join(',') + o.A.side + o.B.side : ''))]);
    const cache = routeCache.get(docKey) || { whole: '', v: new Map(), sig: new Map() };
    const same = cache.whole === whole;
    const xs = rects.flatMap(r => [r.x0, r.x1]).concat(all.flatMap(o => o.combos.flatMap(c => [c.A.x, c.B.x]))), ys = rects.flatMap(r => [r.y0, r.y1]).concat(all.flatMap(o => [o.A.y, o.B.y]));
    const M0 = o0.margin == null ? 300 : o0.margin;
    const G = RTm.grid({ x0: Math.min(0, ...xs) - M0, y0: Math.min(0, ...ys) - M0, x1: Math.max(0, ...xs) + M0, y1: Math.max(0, ...ys) + M0 }, o0.grid || 10);
    // One order whatever is shaped, so shaping one route moves as few others as it can.
    all.sort((p, q) => q.weight - p.weight || (p.key < q.key ? -1 : 1));
    const strict = (p, q, r) => (Math.abs(p.y - q.y) < 0.01
      ? p.y > r.y0 && p.y < r.y1 && Math.max(p.x, q.x) > r.x0 && Math.min(p.x, q.x) < r.x1
      : p.x > r.x0 && p.x < r.x1 && Math.max(p.y, q.y) > r.y0 && Math.min(p.y, q.y) < r.y1);
    const crosses = (A0, B0, v, half) => RTm.runs(A0, B0, v).some(r => rects.some(rc => {
      if (r.k < 0 && (rc.id === A0.node || rc.id === B0.node)) return false;
      const m = half + 2;
      return strict(r.a, r.b, { x0: rc.x0 - m, y0: rc.y0 - m, x1: rc.x1 + m, y1: rc.y1 + m });
    }));
    const along = (r, s, d) => {
      if (r.axis !== s.axis) return false;
      const lv = r.axis === 'h', gap = Math.abs(lv ? r.a.y - s.a.y : r.a.x - s.a.x);
      const lo = lv ? Math.max(Math.min(r.a.x, r.b.x), Math.min(s.a.x, s.b.x)) : Math.max(Math.min(r.a.y, r.b.y), Math.min(s.a.y, s.b.y));
      const hi = lv ? Math.min(Math.max(r.a.x, r.b.x), Math.max(s.a.x, s.b.x)) : Math.min(Math.max(r.a.y, r.b.y), Math.max(s.a.y, s.b.y));
      return gap < d && hi - lo > 1;
    };
    const changed = [];
    const nearChanged = (A0, B0, v, half) => { const mine = RTm.runs(A0, B0, v); return changed.some(c => c.runs.some(s => mine.some(r => along(r, s, half + c.half + 1)))); };
    const routes = new Map();
    all.forEach(o => {
      const prev = cache.v.get(o.key);
      let v = o.kept, A0 = o.A, B0 = o.B;
      if (!v) {
        const same1 = prev && cache.sig.get(o.key) === sig(o);
        // A route that was shaped by hand isn't one found here: undone or reset, it routes afresh (it
        // kept its shape until something moved, before 2026-11-11).
        const pc = prev && !prev.kept && o.combos.find(c => c.A.side === prev.a && c.B.side === prev.b);
        if (pc && (same || (same1 && (o0.fast || (!crosses(pc.A, pc.B, prev.v, o.half) && !nearChanged(pc.A, pc.B, prev.v, o.half)))))) { v = prev.v; A0 = pc.A; B0 = pc.B; }
        else {
          const m = o.half + 8, blocks = o.behind ? [] : rects.map(r => ({ x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m }));
          let best = null;
          o.combos.forEach(c => {
            let cv = RTm.auto(G, c.A, c.B, blocks, o.stub, 2 * o.r);
            if (!cv || !RTm.fits(c.A, c.B, cv, o.stub)) cv = null;
            if (cv && (!best || cv.cost < best.v.cost - 0.5)) best = { v: cv, c };
          });
          if (best) { v = best.v; A0 = best.c.A; B0 = best.c.B; }
          else v = RTm.fits(A0, B0, [], o.stub) ? [] : [A0.x + A0.out * o.stub];
        }
      }
      if (!prev || prev.v.join(',') !== v.join(',') || prev.a !== A0.side || prev.b !== B0.side) changed.push({ half: o.half, runs: RTm.runs(A0, B0, v) });
      RTm.occupy(G, A0, B0, v, o.half + 6);
      if (o0.onRoute) o0.onRoute(A0, B0);
      routes.set(o.key, { key: o.key, A: A0, B: B0, v, half: o.half, stub: o.stub, r: o.r, kept: !!o.kept, behind: o.behind });
    });
    const next = { whole, v: new Map(), sig: new Map() };
    all.forEach(o => { const R0 = routes.get(o.key); next.v.set(o.key, { v: R0.v, a: R0.A.side, b: R0.B.side, kept: R0.kept }); next.sig.set(o.key, sig(o)); });
    routeCache.set(docKey, next);
    return { routes, G, rects };
  }

  // A route's drawing: route.js shape, from A.from (a lead-in before the terminal, such as a system
  // connector's exit inside its board) to B.to.
  function draw(R0) { return RT().shape(R0.A, R0.B, R0.v, R0.r, R0.half + 4); }
  const pathD = pts => 'M' + pts.map(p => p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join('L');

  // ── Labels along a Connection ──
  // Chris, 2026-11-12 and 2026-11-15: a wire's or cable's label hangs from a dot on it, with a thin leader; the
  // dot slides along it (labelAt, 0 to 1) and the label drags anywhere (labelOff, from the dot). A lane is
  // the line as points with the distance along it (s).
  const lane = pts => { let s0 = 0; return pts.map((q, i) => { if (i) s0 += Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y); return { x: q.x, y: q.y, s: s0 }; }); };
  // The point t (0 to 1) along a lane.
  function laneAt(L, t) {
    const S0 = L[L.length - 1].s * Math.max(0, Math.min(1, t));
    for (let i = 1; i < L.length; i++) if (L[i].s >= S0) { const a = L[i - 1], b = L[i], u = (S0 - a.s) / Math.max(1e-6, b.s - a.s); return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; }
    return { x: L[0].x, y: L[0].y };
  }
  // How far along a lane (0 to 1) the point nearest p is.
  function laneT(L, p) {
    let best = Infinity, at = 0;
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1], b = L[i], vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1e-9;
      const u = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)), x = a.x + vx * u, y = a.y + vy * u, d = Math.hypot(p.x - x, p.y - y);
      if (d < best) { best = d; at = a.s + (b.s - a.s) * u; }
    }
    return L[L.length - 1].s ? at / L[L.length - 1].s : 0;
  }
  // A label's default spot clear of the parts, as the harness's labels find theirs (docs/routing.md, Third
  // round): along the level stretches, longest first, at their middle, then a quarter in from either end;
  // right of the dot, then left; the first whose box (w wide, h tall, its baseline at the dot less up)
  // overlaps no part (rects, grown by pad) and no label already placed (taken, which it joins). null: none
  // is clear. Returns { t, dot, x0, y0, end } (end: the text runs left of x0).
  function labelSpot(L, w, h, rects, taken, o) {
    o = Object.assign({ gap: 8, up: 9, pad: 4, min: 0 }, o);
    if (!L || L.length < 2) return null;
    const S = L[L.length - 1].s, segs = [];
    for (let i = 1; i < L.length; i++) { const a = L[i - 1], b = L[i]; if (Math.abs(a.y - b.y) < 0.5 && b.s - a.s > o.min) segs.push({ a, b }); }
    segs.sort((p, q) => (q.b.s - q.a.s) - (p.b.s - p.a.s));
    const hits = (x0, y0) => { const r = { x0: x0 - 5, y0: y0 - h + 4, x1: x0 + w + 5, y1: y0 + 4 }; return rects.some(q => r.x1 > q.x0 - o.pad && r.x0 < q.x1 + o.pad && r.y1 > q.y0 - o.pad && r.y0 < q.y1 + o.pad) || taken.some(q => r.x1 > q.x0 && r.x0 < q.x1 && r.y1 > q.y0 && r.y0 < q.y1) ? null : r; };
    for (const g of segs) for (const f of [0.5, 0.25, 0.75]) {
      const sAt = g.a.s + (g.b.s - g.a.s) * f, dot = { x: g.a.x + (g.b.x - g.a.x) * f, y: g.a.y };
      for (const end of [false, true]) {
        const x0 = end ? dot.x - o.gap - w : dot.x + o.gap, y0 = dot.y - o.up, r = hits(x0, y0);
        if (r) { taken.push(r); return { t: S ? sAt / S : 0.5, dot, x0, y0, end }; }
      }
    }
    return null;
  }

  // ── Shaping ──
  // The run of a route nearest p: route.js nearestRun with its route, { route, j, k, axis, d, at }.
  function runAt(R0, p) { const n = RT().nearestRun(R0.A, R0.B, R0.v, p); return n ? Object.assign({ route: R0 }, n) : null; }
  // The run of a route under a run handle (run index j).
  function runOf(R0, j) { const R = RT().runs(R0.A, R0.B, R0.v)[j]; return R ? { route: R0, j, k: R.k, axis: R.axis, at: { x: (R.a.x + R.b.x) / 2, y: (R.a.y + R.b.y) / 2 }, d: 0 } : null; }
  // The middle runs a selected route shows handles on, with their run index j.
  function handles(R0) { return RT().runs(R0.A, R0.B, R0.v).filter(r => r.k >= 0 && Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) > 0.5); }
  // A drag's start on run (from runAt or runOf): the shape it drags and which of its values (k) moves,
  // on which axis. snap rounds a value to the grid. null: nothing to drag there.
  // Chris, 2026-11-11: a drag moves the whole straight run under the pointer; Shift-drag (brk) breaks it
  // where it's grabbed and drags the piece from there.
  // - A middle run moves as it is; broken, it gets a bend at the grab and the piece past it drags.
  // - An end run belongs to its part, so it bends a stub out from the part (the route's stub, or its
  //   terminal's own when that's longer, as a system connector's inside its board) and everything past
  //   that drags; broken, it bends at the grab instead (at least a stub out).
  // - A straight route (no middle runs) lifts everything between its two stubs; broken, the piece from
  //   the grab to the far end's stub. Either way a vertical run stays either side of the level one.
  function grab(run, snap, brk) {
    const R0 = run.route, RTm = RT();
    let v = R0.v.slice(), k = run.k;
    const sn = x => (snap ? snap(x) : x);
    if (k >= 0) {
      if (!brk) return done(R0, v, k);
      const at = run.axis === 'h' ? { x: sn(run.at.x), y: run.at.y } : { x: run.at.x, y: sn(run.at.y) };
      const nb = RTm.addBend(R0.A, R0.B, v, run.j, at);
      if (!nb) return null;
      return done(R0, nb.v, nb.k);
    }
    const stA = Math.max(R0.stub, R0.A.stub || 0), stB = Math.max(R0.stub, R0.B.stub || 0);
    const xa = R0.A.x + R0.A.out * stA, xb = R0.B.x - R0.B.in * stB;
    const at = Object.assign({}, run.at);
    if (run.j === 0) at.x = R0.A.out > 0 ? Math.max(at.x, xa) : Math.min(at.x, xa);
    else at.x = R0.B.in > 0 ? Math.min(at.x, xb) : Math.max(at.x, xb);
    if (!v.length) {
      // (Before 2026-11-11 the harness added a bend here, which left a straight wire's shape with an
      // even count of values: drawn wrong, and never fitting its ends.)
      if (!brk) v = [xa, R0.A.y, xb];
      else { const x = sn(at.x); v = Math.abs(xb - at.x) >= Math.abs(at.x - xa) ? [x, R0.A.y, xb] : [xa, R0.A.y, x]; }
      k = 1;
    } else {
      const nb = RTm.addBend(R0.A, R0.B, v, run.j, brk ? { x: sn(at.x), y: at.y } : { x: run.j === 0 ? xa : xb, y: at.y });
      if (!nb) return null;
      v = nb.v; k = nb.k;
    }
    return done(R0, v, k);
  }
  // A grab's drag state: the shape, the value that moves, its axis, and the lines that would make the
  // route straight there (lines): the runs either side of the dragged one, which it lines up with to take
  // its two bends out. For a level run, the level runs before and after it (or a terminal's own height);
  // for a vertical run, the vertical runs before and after it, and, next to an end that leaves from the
  // top or bottom of its connector (a lead-in, A.from or B.to, straight above or below it), that exit's
  // line: there the cable drops straight out of the connector (Chris, 2026-11-11). A harness's ends
  // leave from the side, where its level runs already line up with their pins.
  function done(R0, v, k) {
    const n = v.length, lines = [];
    const under = (T, L) => L && Math.abs(L.x - T.x) < 0.5 && Math.abs(L.y - T.y) > 0.5;
    if (k % 2) { lines.push(k - 2 >= 0 ? +v[k - 2] : R0.A.y, k + 2 < n ? +v[k + 2] : R0.B.y); }
    else {
      if (k - 2 >= 0) lines.push(+v[k - 2]); if (k + 2 < n) lines.push(+v[k + 2]);
      if (k === 0 && under(R0.A, R0.A.from)) lines.push(R0.A.x);
      if (k === n - 1 && under(R0.B, R0.B.to)) lines.push(R0.B.x);
    }
    return { v0: v, k, axis: k % 2 ? 'h' : 'v', lines };
  }
  // Within STICK steps of the grid of a line that makes it straight, a dragged run lines up with it, and
  // stays there until it's dragged more than STICK steps away (Chris, 2026-11-11: a broken line moved
  // back snaps straight, and resists going back to curved). Let go there, release takes the bends out.
  const STICK = 5;
  // The shape while dragging: the grabbed value moved by the pointer's travel (p0 to p), snapped. step:
  // the grid step for the straight snap (0 or none: no snap, as with Ctrl).
  function slide(st, p0, p, snap, step) {
    const v = st.v0.slice();
    const val = st.v0[st.k] + (st.axis === 'v' ? p.x - p0.x : p.y - p0.y);
    v[st.k] = snap ? snap(val) : val;
    const t = stick(val, st.lines, step);
    if (t != null) v[st.k] = t;
    return v;
  }
  // The line a value sticks to: the nearest of lines within STICK steps of it, or null (slide).
  function stick(val, lines, step) {
    if (!(step > 0) || !lines || !lines.length) return null;
    const t = lines.reduce((m, x) => (Math.abs(x - val) < Math.abs(m - val) ? x : m));
    return Math.abs(t - val) <= STICK * step ? t : null;
  }
  // One run drag, the same on a harness and a system (Chris, 2026-11-15: wires and cables drag alike). The
  // canvas keeps the gesture (g) and says what was grabbed; this keeps the rest on g:
  // - dragStart(g, run, rec, snap, brk, p0, st): the engine's grab (st: one the canvas made itself, as a
  //   system's lead-in), the record's sides and mode frozen (g.keep), and where it started (g.p0). Returns
  //   the record to keep at once, or null when there's nothing to drag there.
  // - dragTo(g, p, snap, step): the record as the pointer stands (snap: the grid, or null for anywhere;
  //   step: the snap-straight step, 0 for none, as with Ctrl).
  // - release(R0, v, rec), below, when it's let go.
  function dragStart(g, run, rec, snap, brk, p0, st) {
    st = st || grab(run, snap, brk);
    if (!st) return null;
    const R0 = run.route;
    // A moved split point stays (Chris, 2026-11-15: a run drag dropped it, in the harness editor too).
    g.keep = { a: R0.A.side, b: R0.B.side, mode: rec && rec.mode };
    ['split0', 'split1'].forEach(k => { if (rec && rec[k]) g.keep[k] = rec[k]; });
    Object.assign(g, st, { p0 });
    return Object.assign({ v: st.v0 }, g.keep);
  }
  const dragTo = (g, p, snap, step) => Object.assign({ v: slide(g, g.p0, p, snap, step) }, g.keep);
  // Let go: a run dragged flush with its neighbor merges into it (route.js tidy). The record to keep,
  // with the sides the route was shaped on and its mode.
  function release(R0, v, rec) { return Object.assign({}, rec, { v: RT().tidy(R0.A, R0.B, v), a: R0.A.side, b: R0.B.side }); }
  // A double-click on a run: a bend where it was clicked (an end run's, at least a stub out from its
  // part), on the grid, as the record to keep (null: none there).
  function bend(run, snap, rec) {
    const R0 = run.route, at = Object.assign({}, run.at), st = Math.max(R0.stub, (run.j === 0 ? R0.A.stub : R0.B.stub) || 0);
    if (run.j === 0) at.x = R0.A.out > 0 ? Math.max(at.x, R0.A.x + st) : Math.min(at.x, R0.A.x - st);
    if (run.k < 0 && run.j > 0) at.x = R0.B.in > 0 ? Math.min(at.x, R0.B.x - st) : Math.max(at.x, R0.B.x + st);
    if (snap) { at.x = snap(at.x); at.y = snap(at.y); }
    const nb = RT().addBend(R0.A, R0.B, R0.v, run.j, at);
    return nb ? Object.assign({}, rec, { v: nb.v, a: R0.A.side, b: R0.B.side }) : null;
  }
  // The right-click menu's route items for a stored record (Chris, 2026-11-10): how the route treats the
  // parts in its way, walking round them or running straight past behind them, and Reset route once
  // shaped. Buttons with data-ctx around, behind, and reset-route, then a rule.
  function menuHtml(rec) {
    const behind = !!(rec && rec.mode === 'behind');
    return `<button data-ctx="around" role="menuitemradio" aria-checked="${!behind}"><span>${behind ? '' : '✓ '}Walk around parts</span></button>` +
      `<button data-ctx="behind" role="menuitemradio" aria-checked="${behind}"><span>${behind ? '✓ ' : ''}Go behind parts</span></button>` +
      (rec && (rec.v || rec.split0 || rec.split1) ? `<button data-ctx="reset-route" role="menuitem"><span>Reset route</span></button>` : '') + '<hr>';
  }
  // A menu item (around, behind, or reset-route) applied to a record: the new record, or null when
  // nothing is left to keep.
  function apply(rec, k) {
    const r = Object.assign({}, rec);
    if (k === 'behind') r.mode = 'behind';
    else if (k === 'around') delete r.mode;
    else if (k === 'reset-route') { delete r.v; delete r.a; delete r.b; delete r.split0; delete r.split1; }
    return r.v || r.mode || r.split0 || r.split1 ? r : null;
  }
  // A stored record as given (a bare v, from before records, becomes { v }).
  const record = x => (Array.isArray(x) ? { v: x } : x && typeof x === 'object' ? x : null);

  LM.connect = { lane, laneAt, laneT, labelSpot, routeAll, draw, pathD, runAt, runOf, handles, grab, slide, stick, dragStart, dragTo, release, bend, menuHtml, apply, record };
})(window.LM = window.LM || {});
