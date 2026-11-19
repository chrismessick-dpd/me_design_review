// Wire routing (Chris, 2026-11-10): wires walk around the parts in straight runs at right angles,
// joined by rounded corners, and every straight run in the middle can be dragged to shape them.
//
// A route runs from terminal A to terminal B. A terminal is a point where the route leaves or
// arrives level (along x): `out` is the way it leaves A (+1 right, -1 left), `in` the way it arrives
// at B. So a route is always level at both ends, and its shape is the list of its middle runs'
// positions, `v`: the first vertical run's x, the next level run's y, the next vertical run's x, and
// so on, ending with a vertical run's x (an odd count). An empty list is a straight level route.
//   v = [x1]          A ─ (x1, A.y) │ (x1, B.y) ─ B
//   v = [x1, y2, x3]  A ─ (x1, A.y) │ (x1, y2) ─ (x3, y2) │ (x3, B.y) ─ B
// Moving a part moves its terminal: the end runs follow it and the middle runs stay put.
//
// `auto` finds a route on a grid (A*: length, a cost per bend, and a cost for running along or
// across routes laid down before it, so trunks spread out instead of lying on each other), around
// rectangles it may not enter. `shape` draws a route with rounded corners as samples along it, each
// with its arc length s and the normal on its left (nx, ny), the form conn.js's paths take.
(function (LM) {
  'use strict';

  // ── Values and corners ──
  // The corners of a route, A and B included, in order. Zero-length runs are kept, so run j of the
  // result is always the run between corners j and j + 1, and run j (1 to v.length) is set by v[j - 1].
  function corners(A, B, v) {
    const out = [{ x: A.x, y: A.y }];
    let x = A.x, y = A.y;
    v.forEach((val, k) => { if (k % 2 === 0) x = +val; else y = +val; out.push({ x, y }); });
    if (v.length) out.push({ x, y: B.y });
    out.push({ x: B.x, y: B.y });
    return out;
  }
  // The runs of a route: { j, axis ('h' level, 'v' vertical), a, b, k (its index in v, or -1 for
  // the two end runs, which belong to the terminals) }.
  function runs(A, B, v) {
    const C = corners(A, B, v), out = [];
    for (let j = 0; j < C.length - 1; j++) {
      const a = C[j], b = C[j + 1], end = j === 0 || j === C.length - 2;
      out.push({ j, axis: j % 2 === 0 ? 'h' : 'v', a, b, k: end ? -1 : j - 1 });
    }
    return out;
  }
  // Whether a stored route still fits its terminals: an odd count of runs (or none, when A and B
  // are level), and its first and last vertical runs at least `stub` out from A and B the way they
  // leave and arrive, so a route never doubles back into a part.
  // A terminal may carry its own stub (A.stub, B.stub: a breakout needs less room than a part).
  const stubOf = (T, stub) => (T.stub != null ? T.stub : stub);
  function fits(A, B, v, stub) {
    if (!Array.isArray(v) || v.some(x => !isFinite(+x))) return false;
    if (!v.length) return Math.abs(A.y - B.y) < 0.5 && (B.x - A.x) * A.out > 0 && A.out === B.in;
    if (v.length % 2 === 0) return false;
    return (v[0] - A.x) * A.out >= stubOf(A, stub) - 0.5 && (B.x - v[v.length - 1]) * B.in >= stubOf(B, stub) - 0.5;
  }
  // Tidy a route after an edit: a run that has shrunk to nothing goes, and the runs either side of
  // it, now in line, become one (Chris: drag a run flush with its neighbor to remove that bend).
  function tidy(A, B, v) {
    v = v.map(Number);
    const near = (p, q) => Math.abs(p - q) < 0.5;
    for (let again = true; again;) {
      again = false;
      const m = v.length;
      for (let k = 0; k < m; k++) {
        if (k % 2 === 0) {
          // A vertical run with level runs at the same height either side.
          const y0 = k === 0 ? A.y : v[k - 1], y1 = k === m - 1 ? B.y : v[k + 1];
          if (!near(y0, y1)) continue;
          if (m === 1) v = [];
          else if (k === m - 1) v.splice(k - 1, 2);
          else v.splice(k, 2);
          again = true; break;
        } else {
          // A level run with vertical runs at the same x either side.
          if (!near(v[k - 1], v[k + 1])) continue;
          v.splice(k, 2);
          again = true; break;
        }
      }
    }
    return v;
  }
  // A bend added where run j is clicked (at p): a zero-length jog in it, so the new piece can be
  // dragged out. Returns the new v and the index in it of the run to drag.
  function addBend(A, B, v, j, p) {
    v = v.slice();
    const R = runs(A, B, v)[j];
    if (!R) return null;
    if (R.axis === 'h') {
      const y = R.a.y;
      if (j === 0) { v.splice(0, 0, p.x, y); return { v, k: 1 }; }
      if (j === v.length + 1) { v.splice(v.length, 0, y, p.x); return { v, k: v.length - 2 }; }
      v.splice(j, 0, p.x, y);
      return { v, k: j + 1 };
    }
    const x = R.a.x;
    v.splice(j, 0, p.y, x);
    return { v, k: j + 1 };
  }

  // A run shorter than minJog between two others is too short to round for a wide route (its outer
  // wires fold; Chris, 2026-11-10, a kink where a bundle met its corner). Line up the runs either
  // side of it, moving the shorter of them, when that keeps the route out of the blocks and clear of
  // its terminals; else leave it.
  function straighten(A, B, v, minJog, blocks, stub) {
    if (!minJog) return v;
    const into = (p, q) => blocks.some(r => (Math.abs(p.y - q.y) < 0.01
      ? p.y > r.y0 && p.y < r.y1 && Math.max(p.x, q.x) > r.x0 && Math.min(p.x, q.x) < r.x1
      : p.x > r.x0 && p.x < r.x1 && Math.max(p.y, q.y) > r.y0 && Math.min(p.y, q.y) < r.y1));
    // The end runs count from where they clear their own parts (a stub out), which blocks cover.
    const clear = w => fits(A, B, w, stub) && !runs(A, B, w).some(r => {
      if (r.k >= 0) return into(r.a, r.b);
      if (r.j === 0) return into({ x: A.x + A.out * stubOf(A, stub), y: r.a.y }, r.b);
      return into(r.a, { x: B.x - B.in * stubOf(B, stub), y: r.b.y });
    });
    for (let guard = 0; guard < 20; guard++) {
      const R = runs(A, B, v), short = R.find(r => r.k >= 0 && Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) > 0.5 && Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) < minJog);
      if (!short) break;
      // The runs either side are set by v[k - 1] and v[k + 1]; past either end of v they're the
      // terminals' own runs (A.y, B.y), which can't move but can be lined up with.
      const k = short.k, m = v.length, len = r => (r ? Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) : Infinity);
      const before = k - 1 >= 0 ? v[k - 1] : A.y, after = k + 1 < m ? v[k + 1] : B.y, tries = [];
      if (k - 1 >= 0) tries.push({ len: len(R[short.j - 1]), w: v.map((x, i) => (i === k - 1 ? after : x)) });
      if (k + 1 < m) tries.push({ len: len(R[short.j + 1]), w: v.map((x, i) => (i === k + 1 ? before : x)) });
      const ok = tries.sort((a, b) => a.len - b.len).map(t => tidy(A, B, t.w)).find(clear);
      if (!ok) break;
      v = ok;
    }
    return v;
  }

  // ── Drawing a route ──
  // Samples along the route with rounded corners. Each corner's radius is r, less where its runs
  // are short: up to half a middle run, or all of an end run (a terminal has no corner of its own).
  // A jog (a run shorter than 2r between two runs heading the same way) is too short for two corners
  // of radius r, and a wide route's outer wires would fold round them (Chris, 2026-11-10: a kink
  // where a bundle met its corner); it's drawn as one S-curve spread along the runs either side
  // instead, as long as they have the room.
  // need: the tightest bend the route's widest wire can take (its half-width and a little). Where the
  // corners and S-curves above still bend tighter (a wide bundle dragged into several small steps),
  // the line is smoothed until none does (ease), keeping its two end runs straight into the pins.
  // A.from and B.to, when given, are lead-ins drawn before A and after B (a system connector's exit
  // inside its board, connect.js); a harness has none.
  function shape(A, B, v, r, need) {
    const raw = (A.from ? [A.from] : []).concat(corners(A, B, v), B.to ? [B.to] : []), C = [];
    raw.forEach(p => { const q = C[C.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.01) C.push(p); });
    // Drop points in line with their neighbors (a zero-length run leaves two runs in line).
    for (let i = 1; i < C.length - 1;) {
      const a = C[i - 1], b = C[i], c = C[i + 1];
      if (Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 0.01) C.splice(i, 1); else i++;
    }
    const pts = [];
    const push = (x, y, tx, ty) => {
      const q = pts[pts.length - 1];
      if (q && Math.hypot(x - q.x, y - q.y) < 0.01) return;
      const m = Math.hypot(tx, ty) || 1;
      pts.push({ x, y, nx: -ty / m, ny: tx / m });
    };
    const dirOf = (a, b) => { const L = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / L, y: (b.y - a.y) / L, L }; };
    const n = C.length;
    if (n < 2) { const d = { x: A.out || 1, y: 0 }; push(A.x, A.y, d.x, d.y); push(A.x + d.x, A.y, d.x, d.y); }
    else {
      const seg = i => dirOf(C[i], C[i + 1]);
      // How much of segment i a plain corner at its start or end may take: all of an end run,
      // else half of it.
      const share = i => (i === 0 || i === n - 2 ? 1 : 0.5);
      const jogs = new Map();
      for (let i = 1; i <= n - 3; i++) {
        const d0 = seg(i - 1), d1 = seg(i), d2 = seg(i + 1);
        if (d1.L >= 2 * r || d0.x * d2.x + d0.y * d2.y < 0.99 || jogs.has(i - 1)) continue;
        // Room on the runs either side, past what's at their far ends: a corner, or a jog before
        // this one that shares the run before it.
        const before = d0.L - (jogs.has(i - 2) ? jogs.get(i - 2) : i - 1 > 0 ? Math.min(r, d0.L / 2) : 0), after = d2.L - (i + 1 < n - 2 ? Math.min(r, d2.L / 2) : 0);
        // Only as long as it must be: a cubic S with its handles hs long turns tightest at its ends,
        // radius 3hs²/(2L), which must clear the route's outer wire (r - 6 from its middle).
        const hs = Math.min(Math.max(d1.L, Math.sqrt(2 * d1.L * (r - 4) / 3) + 2), before, after);
        if (hs > d1.L * 0.75) jogs.set(i, hs);
      }
      const d0 = seg(0);
      push(C[0].x, C[0].y, d0.x, d0.y);
      for (let i = 1; i < n - 1; i++) {
        if (jogs.has(i)) {
          // The S: from hs before the jog along the run before it, to hs past it along the run after.
          const hs = jogs.get(i), da = seg(i - 1), db = seg(i + 1);
          const P = { x: C[i].x - da.x * hs, y: C[i].y - da.y * hs }, Q = { x: C[i + 1].x + db.x * hs, y: C[i + 1].y + db.y * hs };
          const c1 = { x: P.x + da.x * hs, y: P.y + da.y * hs }, c2 = { x: Q.x - db.x * hs, y: Q.y - db.y * hs }, N = 24;
          for (let k = 0; k <= N; k++) {
            const t = k / N, u = 1 - t;
            const x = u * u * u * P.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * Q.x, y = u * u * u * P.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * Q.y;
            const tx = 3 * u * u * (c1.x - P.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (Q.x - c2.x), ty = 3 * u * u * (c1.y - P.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (Q.y - c2.y);
            push(x, y, tx, ty);
          }
          i++;
          continue;
        }
        const a = C[i - 1], c = C[i], b = C[i + 1], d1 = dirOf(a, c), d2 = dirOf(c, b);
        const rr = Math.max(0, Math.min(r, d1.L * share(i - 1) - (jogs.has(i - 2) ? jogs.get(i - 2) : 0), d2.L * share(i) - (jogs.has(i + 1) ? jogs.get(i + 1) : 0)));
        const turn = d1.x * d2.y - d1.y * d2.x, dot = d1.x * d2.x + d1.y * d2.y;
        if (rr < 0.5 || Math.abs(turn) < 1e-6) { push(c.x, c.y, d1.x, d1.y); push(c.x, c.y, d2.x, d2.y); continue; }
        // An arc from S (rr before the corner) to E (rr after it), about O.
        const S = { x: c.x - d1.x * rr, y: c.y - d1.y * rr }, O = { x: S.x + d2.x * rr, y: S.y + d2.y * rr };
        const a0 = Math.atan2(S.y - O.y, S.x - O.x), sweep = Math.sign(turn) * Math.acos(Math.max(-1, Math.min(1, dot)));
        const m = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 16)));
        for (let s = 0; s <= m; s++) {
          const t = a0 + sweep * s / m, px = O.x + rr * Math.cos(t), py = O.y + rr * Math.sin(t);
          // The tangent turns with the arc: d1 at the start, d2 at the end.
          push(px, py, -Math.sin(t) * Math.sign(sweep), Math.cos(t) * Math.sign(sweep));
        }
      }
      const z = C[n - 1], dz = dirOf(C[n - 2], z);
      push(z.x, z.y, dz.x, dz.y);
    }
    let s = 0;
    pts.forEach((p, i) => { if (i) s += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); p.s = s; });
    if (need && tightest(pts) < need) return ease(pts, s, need, C);
    return { pts, S: s };
  }
  // The tightest bend along samples: the turn between points about 8 apart, over that distance.
  function tightest(pts) {
    const P = resample(pts, 4);
    let r = Infinity;
    for (let i = 2; i < P.length - 2; i++) {
      const a = P[i - 2], o = P[i], c = P[i + 2];
      let t = Math.atan2(c.y - o.y, c.x - o.x) - Math.atan2(o.y - a.y, o.x - a.x);
      while (t > Math.PI) t -= 2 * Math.PI;
      while (t < -Math.PI) t += 2 * Math.PI;
      if (Math.abs(t) > 1e-6) r = Math.min(r, 8 / Math.abs(t));
    }
    return r;
  }
  // Points every d along samples (with s).
  function resample(pts, d) {
    const S = pts[pts.length - 1].s, n = Math.max(2, Math.ceil(S / d)), out = [];
    let j = 1;
    for (let i = 0; i <= n; i++) {
      const s = S * i / n;
      while (j < pts.length - 1 && pts[j].s < s) j++;
      const a = pts[j - 1], b = pts[j], t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return out;
  }
  // Smooth a line (Laplacian steps) until it bends no tighter than need, its end runs held straight
  // for as far as they run (up to need) so the wires still leave and reach their pins level.
  function ease(pts, S, need, C) {
    const d = 3, P = resample(pts, d), n = P.length;
    const L0 = Math.min(need, Math.hypot(C[1].x - C[0].x, C[1].y - C[0].y) - 1), L1 = Math.min(need, Math.hypot(C[C.length - 1].x - C[C.length - 2].x, C[C.length - 1].y - C[C.length - 2].y) - 1);
    const lo = Math.max(1, Math.ceil(L0 / (S / (n - 1)))), hi = n - 1 - Math.max(1, Math.ceil(L1 / (S / (n - 1))));
    const sampled = () => { let s = 0; return P.map((p, i) => { if (i) s += Math.hypot(p.x - P[i - 1].x, p.y - P[i - 1].y); return { x: p.x, y: p.y, s }; }); };
    for (let it = 0; it < 1500; it++) {
      const prev = P.map(p => ({ x: p.x, y: p.y }));
      for (let i = lo; i <= hi; i++) { P[i].x = prev[i].x + 0.5 * ((prev[i - 1].x + prev[i + 1].x) / 2 - prev[i].x); P[i].y = prev[i].y + 0.5 * ((prev[i - 1].y + prev[i + 1].y) / 2 - prev[i].y); }
      if (it % 25 === 24 && tightest(sampled()) >= need) break;
    }
    const out = sampled();
    out.forEach((p, i) => {
      const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)], m = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      p.nx = -(b.y - a.y) / m; p.ny = (b.x - a.x) / m;
    });
    return { pts: out, S: out[out.length - 1].s, eased: true };
  }

  // ── Finding a route ──
  // A grid over the drawing (step g), the rectangles no route may enter, and what the routes laid
  // down so far cover (each cell: 1 level, 2 vertical).
  function grid(bounds, g) {
    const x0 = Math.floor(bounds.x0 / g) * g, y0 = Math.floor(bounds.y0 / g) * g;
    const W = Math.ceil((bounds.x1 - x0) / g) + 1, H = Math.ceil((bounds.y1 - y0) / g) + 1;
    return { g, x0, y0, W, H, occ: new Uint8Array(W * H), stamp: new Uint32Array(W * H * 4), gen: 0, dist: new Float32Array(W * H * 4), prev: new Int32Array(W * H * 4) };
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const cellOf = (G, p) => ({ i: Math.max(0, Math.min(G.W - 1, Math.round((p.x - G.x0) / G.g))), j: Math.max(0, Math.min(G.H - 1, Math.round((p.y - G.y0) / G.g))) });
  // A binary heap of [priority, state]. Swaps go through temporaries (2026-11-11: destructuring made a
  // new array per swap, most of a big system's routing time); the order of work is the same.
  function heap() {
    const P = [], V = [];
    return {
      get size() { return V.length; },
      push(p, s) {
        P.push(p); V.push(s);
        let i = V.length - 1;
        while (i) { const u = (i - 1) >> 1; if (P[u] <= P[i]) break; const tp = P[u]; P[u] = P[i]; P[i] = tp; const tv = V[u]; V[u] = V[i]; V[i] = tv; i = u; }
      },
      pop() {
        const top = V[0], lp = P.pop(), lv = V.pop();
        if (V.length) {
          P[0] = lp; V[0] = lv;
          const n = V.length;
          for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && P[l] < P[m]) m = l; if (r < n && P[r] < P[m]) m = r; if (m === i) break; const tp = P[m]; P[m] = P[i]; P[i] = tp; const tv = V[m]; V[m] = V[i]; V[i] = tv; i = m; }
        }
        return top;
      },
    };
  }
  // A route from A to B. blocks: rectangles { x0, y0, x1, y1 } the route's line should keep out of
  // (inflate them first for the route's width): it walks round them, but goes behind one when that's
  // much shorter (COST.behind a step; Chris, 2026-11-10: walk around, but go behind otherwise). stub:
  // how far it runs level out of A and into B. Returns v with its cost (v.cost), or null.
  const COST = { bend: 4, along: 6, across: 1.5, behind: 30 };
  function auto(G, A, B, blocks, stub, minJog) {
    const g = G.g, W = G.W, H = G.H, N = W * H;
    const blocked = new Uint8Array(N);
    blocks.forEach(b => {
      const i0 = Math.max(0, Math.ceil((b.x0 - G.x0) / g)), i1 = Math.min(W - 1, Math.floor((b.x1 - G.x0) / g));
      const j0 = Math.max(0, Math.ceil((b.y0 - G.y0) / g)), j1 = Math.min(H - 1, Math.floor((b.y1 - G.y0) / g));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * W + i] = 1;
    });
    const ta = { x: A.x + A.out * stubOf(A, stub), y: A.y }, tb = { x: B.x - B.in * stubOf(B, stub), y: B.y };
    const s = cellOf(G, ta), t = cellOf(G, tb);
    blocked[s.j * W + s.i] = 0; blocked[t.j * W + t.i] = 0;
    const sd = A.out > 0 ? 0 : 2, td = B.in > 0 ? 0 : 2;
    G.gen++;
    const gen = G.gen, st = G.stamp, dist = G.dist, prev = G.prev, q = heap();
    const hcost = (i, j) => Math.abs(i - t.i) + Math.abs(j - t.j);
    const start = (s.j * W + s.i) * 4 + sd;
    st[start] = gen; dist[start] = 0; prev[start] = -1;
    q.push(hcost(s.i, s.j), start);
    let found = -1, n = 0;
    while (q.size && n++ < 400000) {
      const cur = q.pop(), d = cur & 3, c = cur >> 2, i = c % W, j = (c - i) / W;
      if (c === t.j * W + t.i && d === td) { found = cur; break; }
      const base = dist[cur];
      // Straight on, then each turn (in that order, without a new array per step).
      for (let q3 = 0; q3 < 3; q3++) {
        const nd = q3 === 0 ? d : q3 === 1 ? (d + 1) & 3 : (d + 3) & 3;
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nc = nj * W + ni;
        const o = G.occ[nc];
        const cost = base + 1 + (nd !== d ? COST.bend : 0) + (o ? (o & (nd % 2 ? 2 : 1) ? COST.along : COST.across) : 0) + (blocked[nc] ? COST.behind : 0);
        const ns = nc * 4 + nd;
        if (st[ns] === gen && dist[ns] <= cost) continue;
        st[ns] = gen; dist[ns] = cost; prev[ns] = cur;
        q.push(cost + hcost(ni, nj), ns);
      }
    }
    if (found < 0) return null;
    // Back to the start: the cells, then the runs (a run per change of direction).
    const path = [];
    for (let x = found; x >= 0; x = prev[x]) path.push(x);
    path.reverse();
    const runsOf = [];
    path.forEach((x, k) => {
      const d = x & 3, c = x >> 2, i = c % W, j = (c - i) / W, p = { x: G.x0 + i * g, y: G.y0 + j * g };
      if (!k) { runsOf.push({ d, a: p, b: p }); return; }
      const r = runsOf[runsOf.length - 1];
      if (r.d === d) r.b = p; else runsOf.push({ d, a: r.b, b: p });
    });
    // v from the vertical runs: each one's x, and between two of them the height of the level run
    // joining them (where the second starts). Level runs at either end belong to the terminals.
    const out = [];
    runsOf.filter(r => r.d % 2).forEach((r, k) => { if (k) out.push(r.a.y); out.push(r.a.x); });
    // A grid point is up to half a step off a terminal's height, so a straight grid route between
    // terminals at slightly different heights still needs one vertical run.
    if (!out.length && Math.abs(A.y - B.y) > 0.5) out.push(Math.round((ta.x + tb.x) / 2 / g) * g);
    // A terminal off the grid leaves a jog shorter than a step next to it, too short to round (a
    // hook where a pair met its pins): the level run beside a terminal takes the terminal's height.
    if (out.length >= 3) {
      if (Math.abs(out[1] - A.y) < g) out[1] = A.y;
      if (Math.abs(out[out.length - 2] - B.y) < g) out[out.length - 2] = B.y;
    }
    const v = straighten(A, B, tidy(A, B, out), minJog || 0, blocks, stub);
    v.cost = dist[found];
    return v;
  }
  // Mark what a route covers, so routes after it keep clear of it: cells within `half` of each
  // run, level runs as 1 and vertical runs as 2.
  function occupy(G, A, B, v, half) {
    const g = G.g, W = G.W, H = G.H, k = Math.max(0, Math.round(half / g));
    runs(A, B, v).forEach(R => {
      const a = cellOf(G, R.a), b = cellOf(G, R.b), bit = R.axis === 'h' ? 1 : 2;
      const i0 = Math.min(a.i, b.i), i1 = Math.max(a.i, b.i), j0 = Math.min(a.j, b.j), j1 = Math.max(a.j, b.j);
      for (let j = Math.max(0, j0 - (bit === 1 ? k : 0)); j <= Math.min(H - 1, j1 + (bit === 1 ? k : 0)); j++)
        for (let i = Math.max(0, i0 - (bit === 2 ? k : 0)); i <= Math.min(W - 1, i1 + (bit === 2 ? k : 0)); i++) G.occ[j * W + i] |= bit;
    });
  }
  // The point on a route's runs nearest p: { j (the run), d (distance), at }.
  function nearestRun(A, B, v, p) {
    let best = null;
    runs(A, B, v).forEach(R => {
      const dx = R.b.x - R.a.x, dy = R.b.y - R.a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p.x - R.a.x) * dx + (p.y - R.a.y) * dy) / L2)) : 0;
      const at = { x: R.a.x + dx * t, y: R.a.y + dy * t }, d = Math.hypot(p.x - at.x, p.y - at.y);
      if (!best || d < best.d) best = { j: R.j, k: R.k, axis: R.axis, d, at };
    });
    return best;
  }

  LM.route = { corners, runs, fits, tidy, addBend, shape, grid, auto, occupy, nearestRun, straighten, COST };
})(window.LM = window.LM || {});
