/* Signoff PL 3D models: a STEP attached to a Part becomes a small simplified mesh and a few
   pictures, so the product's data repo doesn't fill up with CAD.

   readStep(bytes)          OpenCascade (occt-import-js, pinned) in assets/occt-worker.js → mesh
   simplify(mesh, maxTris)  vertex clustering until the mesh has at most maxTris triangles
   encode(mesh) / decode()  "PLM1": 16-bit positions over the bounding box, indices, a color, and a
                            CAD face per triangle; gzipped
   render(mesh, opts)       a small z-buffer renderer (no WebGL, no libraries) → ImageData
   renderScene(objs, cam)   several placed parts, board pictures as textures, and which part and
                            triangle is under each pixel (for picking)
   features(mesh)           what a part can be snapped by: corners, hole centers, edges, flat faces
   alignMove(a, b)          the translation that puts feature a onto feature b
   VIEWS                    the stored pictures: iso, top, front, right

   A mesh is { pos: Float32Array (mm, Z up), idx: Uint32Array, col: Uint8Array (rgb per triangle),
   fid: Uint32Array (the CAD face each triangle came from) }. A board slab also has uv (per vertex)
   and tex (per triangle: 1 top picture, 2 bottom picture). */
(function (S) {
  'use strict';

  // Same build and hashes as Partcheck (partcheck/assets/libs.js).
  var JSD = 'https://cdn.jsdelivr.net/npm/';
  var OCCT = { js: JSD + 'occt-import-js@0.0.23/dist/occt-import-js.js', jsSri: 'sha384-Z8pO9JEhFZF+mvDKxMuLvPT85VP7nly8CqYjBatl0bMeW9OsaKCes4gEUPL4nihc',
    wasm: JSD + 'occt-import-js@0.0.23/dist/occt-import-js.wasm', wasmSri: 'sha384-6BbVZ7iPDgcRszsoavxGz4TaYCwC2EkeYCy1aR9XFwqMZYXDQP+0vZSTP6Yw35iD' };

  var MAX_TRIS = 60000;          // stored meshes are simplified to this
  var DEFAULT_RGB = [196, 199, 204];

  // ── Reading STEP ─────────────────────────────────────────
  var worker = null, seq = 0, pending = {};
  function cadWorker() {
    if (!worker) {
      if (location.protocol === 'file:') throw new Error('Reading STEP needs the hosted page or a local server; a page opened from disk can’t start the STEP reader.');
      // A page whose worker sits elsewhere (Signoff ME's vendored copy) sets S.model3d.workerUrl first.
      worker = new Worker((S.model3d && S.model3d.workerUrl) || 'assets/occt-worker.js');
      worker.onmessage = function (e) { var p = pending[e.data.id]; if (!p) return; delete pending[e.data.id]; if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error)); };
      worker.onerror = function (e) {
        Object.keys(pending).forEach(function (k) { pending[k].reject(new Error('The STEP reader stopped: ' + (e.message || 'worker error'))); });
        pending = {}; worker = null;
      };
    }
    return worker;
  }
  function readStep(bytes) {
    return new Promise(function (resolve, reject) {
      var id = ++seq, copy = bytes.slice();
      pending[id] = { resolve: resolve, reject: reject };
      cadWorker().postMessage({ id: id, lib: OCCT, kind: 'step', bytes: copy, params: { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 } }, [copy.buffer]);
    }).then(function (res) {
      if (!res.success || !(res.meshes || []).length) throw new Error('No solid geometry found in this file. Is it a STEP (.step or .stp) with bodies in it?');
      return fromOcct(res);
    });
  }

  function rgb(c) { return c && c.length >= 3 ? [0, 1, 2].map(function (k) { return Math.max(0, Math.min(255, Math.round(c[k] * 255))); }) : null; }
  // occt-import-js meshes → one mesh. Colors come from each face, else its body, else light gray.
  function fromOcct(res) {
    var nv = 0, nt = 0;
    res.meshes.forEach(function (m) { nv += m.attributes.position.array.length / 3; nt += m.index.array.length / 3; });
    var pos = new Float32Array(nv * 3), idx = new Uint32Array(nt * 3), col = new Uint8Array(nt * 3), fid = new Uint32Array(nt);
    var vo = 0, to = 0, face = 0;
    res.meshes.forEach(function (m) {
      var p = m.attributes.position.array, ix = m.index.array, body = rgb(m.color) || DEFAULT_RGB, n = ix.length / 3;
      pos.set(p, vo * 3);
      for (var i = 0; i < ix.length; i++) idx[to * 3 + i] = ix[i] + vo;
      var bodyFace = face++;
      for (var t = 0; t < n; t++) { col.set(body, (to + t) * 3); fid[to + t] = bodyFace; }
      // Each B-rep face keeps its own id, so edges are where CAD faces meet, not where facets do.
      (m.brep_faces || []).forEach(function (f) {
        var c = rgb(f.color), id = face++;
        for (var t2 = f.first; t2 <= f.last && t2 < n; t2++) { fid[to + t2] = id; if (c) col.set(c, (to + t2) * 3); }
      });
      vo += p.length / 3; to += n;
    });
    return { pos: pos, idx: idx, col: col, fid: fid };
  }

  function bbox(pos) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < pos.length; i += 3) for (var k = 0; k < 3; k++) { var v = pos[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    if (!pos.length) { lo = [0, 0, 0]; hi = [0, 0, 0]; }
    return { lo: lo, hi: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  }

  // ── Simplifying ──────────────────────────────────────────
  // Snap vertices to a grid of `cells` along the longest side and keep the triangles whose corners
  // land in three different cells. A fine grid just welds the duplicate vertices STEP meshes carry.
  function cluster(mesh, box, cells) {
    var L = Math.max(box.size[0], box.size[1], box.size[2]) || 1, step = L / cells;
    var nx = Math.floor(box.size[0] / step) + 1, ny = Math.floor(box.size[1] / step) + 1;
    var nvIn = mesh.pos.length / 3, map = new Uint32Array(nvIn), cellOf = new Map(), sums = [];
    for (var v = 0; v < nvIn; v++) {
      var x = mesh.pos[v * 3], y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
      var key = Math.floor((x - box.lo[0]) / step) + nx * (Math.floor((y - box.lo[1]) / step) + ny * Math.floor((z - box.lo[2]) / step));
      var c = cellOf.get(key);
      if (c === undefined) { c = sums.length / 4; cellOf.set(key, c); sums.push(0, 0, 0, 0); }
      sums[c * 4] += x; sums[c * 4 + 1] += y; sums[c * 4 + 2] += z; sums[c * 4 + 3]++;
      map[v] = c;
    }
    var nc = sums.length / 4, pos = new Float32Array(nc * 3);
    for (var i = 0; i < nc; i++) for (var k = 0; k < 3; k++) pos[i * 3 + k] = sums[i * 4 + k] / sums[i * 4 + 3];
    var idx = [], col = [], fid = [], seen = new Set(), nt = mesh.idx.length / 3;
    for (var t = 0; t < nt; t++) {
      var a = map[mesh.idx[t * 3]], b = map[mesh.idx[t * 3 + 1]], d = map[mesh.idx[t * 3 + 2]];
      if (a === b || b === d || a === d) continue;
      var s = [a, b, d].sort(function (p, q) { return p - q; }), sk = s[0] + ',' + s[1] + ',' + s[2];
      if (seen.has(sk)) continue;
      seen.add(sk);
      idx.push(a, b, d); col.push(mesh.col[t * 3], mesh.col[t * 3 + 1], mesh.col[t * 3 + 2]); fid.push(mesh.fid ? mesh.fid[t] : 0);
    }
    return { pos: pos, idx: new Uint32Array(idx), col: new Uint8Array(col), fid: new Uint32Array(fid) };
  }
  function simplify(mesh, maxTris) {
    maxTris = maxTris || MAX_TRIS;
    var box = bbox(mesh.pos), cells = 4096, out = cluster(mesh, box, cells);
    while (out.idx.length / 3 > maxTris && cells > 8) {
      cells = Math.floor(cells * Math.max(0.35, Math.min(0.85, Math.sqrt(maxTris / (out.idx.length / 3)))));
      out = cluster(mesh, box, cells);
    }
    return out;
  }

  // ── Storing ──────────────────────────────────────────────
  function gzip(bytes, mode) {
    var cs = mode === 'gunzip' ? new DecompressionStream('gzip') : new CompressionStream('gzip');
    return new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function pad4(n) { return (n + 3) & ~3; }
  function encode(mesh) {
    var box = bbox(mesh.pos), nv = mesh.pos.length / 3, nt = mesh.idx.length / 3;
    var palette = [], pIdx = {}, ci = new Uint8Array(nt);
    for (var t = 0; t < nt; t++) {
      var k = mesh.col[t * 3] + ',' + mesh.col[t * 3 + 1] + ',' + mesh.col[t * 3 + 2];
      if (pIdx[k] === undefined) { if (palette.length < 256) { pIdx[k] = palette.length; palette.push([mesh.col[t * 3], mesh.col[t * 3 + 1], mesh.col[t * 3 + 2]]); } else pIdx[k] = 0; }
      ci[t] = pIdx[k];
    }
    var fids = mesh.fid || new Uint32Array(nt), nf = 0;
    for (t = 0; t < nt; t++) if (fids[t] >= nf) nf = fids[t] + 1;
    var head = new TextEncoder().encode(JSON.stringify({ v: 2, nv: nv, nt: nt, nf: nf, lo: box.lo, hi: box.hi, palette: palette }));
    var wide = nv > 65535, fwide = nf > 65535, posBytes = nv * 6, idxBytes = nt * 3 * (wide ? 4 : 2);
    var o1 = pad4(8 + head.length), o2 = o1 + pad4(posBytes), o3 = o2 + pad4(idxBytes), o4 = o3 + pad4(nt);
    var buf = new ArrayBuffer(o4 + nt * (fwide ? 4 : 2)), u8 = new Uint8Array(buf), dv = new DataView(buf);
    u8.set([80, 76, 77, 49], 0);   // "PLM1"
    dv.setUint32(4, head.length, true);
    u8.set(head, 8);
    var q = new Uint16Array(buf, o1, nv * 3);
    for (var v = 0; v < nv; v++) for (var a = 0; a < 3; a++) {
      var span = box.size[a] || 1;
      q[v * 3 + a] = Math.round((mesh.pos[v * 3 + a] - box.lo[a]) / span * 65535);
    }
    (wide ? new Uint32Array(buf, o2, nt * 3) : new Uint16Array(buf, o2, nt * 3)).set(mesh.idx);
    u8.set(ci, o3);
    (fwide ? new Uint32Array(buf, o4, nt) : new Uint16Array(buf, o4, nt)).set(fids);
    return gzip(u8);
  }
  function decode(gz) {
    return gzip(gz, 'gunzip').then(function (u8) {
      if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'PLM1') throw new Error('Not a PL mesh');
      var buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), dv = new DataView(buf), hl = dv.getUint32(4, true);
      var h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
      var nv = h.nv, nt = h.nt, wide = nv > 65535;
      var o1 = pad4(8 + hl), o2 = o1 + pad4(nv * 6), o3 = o2 + pad4(nt * 3 * (wide ? 4 : 2));
      var q = new Uint16Array(buf, o1, nv * 3), pos = new Float32Array(nv * 3);
      for (var v = 0; v < nv; v++) for (var a = 0; a < 3; a++) pos[v * 3 + a] = h.lo[a] + q[v * 3 + a] / 65535 * ((h.hi[a] - h.lo[a]) || 1);
      var idx = new Uint32Array(wide ? new Uint32Array(buf, o2, nt * 3) : new Uint16Array(buf, o2, nt * 3));
      var ci = new Uint8Array(buf, o3, nt), col = new Uint8Array(nt * 3);
      for (var t = 0; t < nt; t++) col.set(h.palette[ci[t]] || DEFAULT_RGB, t * 3);
      var fid = new Uint32Array(nt);
      if (h.v >= 2) fid.set(h.nf > 65535 ? new Uint32Array(buf, pad4(o3 + nt), nt) : new Uint16Array(buf, pad4(o3 + nt), nt));
      return { pos: pos, idx: idx, col: col, fid: fid };
    });
  }

  // ── Rendering ────────────────────────────────────────────
  // Orthographic views. az turns the part about Z; el raises the eye. CAD is Z up; front looks
  // along +Y, right along -X.
  var D = Math.PI / 180;
  var VIEWS = [
    { key: 'iso', label: 'Iso', az: -45 * D, el: 30 * D },
    { key: 'top', label: 'Top', az: 0, el: 90 * D },
    { key: 'front', label: 'Front', az: 0, el: 0 },
    { key: 'right', label: 'Right', az: -90 * D, el: 0 }
  ];

  // The eye: right, up, and toward-the-eye directions in world coordinates.
  function camera(az, el) {
    var ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    return { r: [ca, -sa, 0], u: [sa * se, ca * se, ce], f: [-sa * ce, -ca * ce, se] };
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // A placed copy of a mesh: world = R·(p − pivot) + pivot + T. R is row-major 3×3.
  var IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function place(o, p, out) {
    var R = o.R || IDENT, pv = o.pivot || [0, 0, 0], T = o.T || [0, 0, 0];
    var x = p[0] - pv[0], y = p[1] - pv[1], z = p[2] - pv[2];
    out = out || [0, 0, 0];
    out[0] = R[0] * x + R[1] * y + R[2] * z + pv[0] + T[0];
    out[1] = R[3] * x + R[4] * y + R[5] * z + pv[1] + T[1];
    out[2] = R[6] * x + R[7] * y + R[8] * z + pv[2] + T[2];
    return out;
  }
  // A direction turns but doesn't move.
  function turn(o, d) {
    var R = o.R || IDENT;
    return [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
  }
  // Rotation from degrees about X, then Y, then Z (fixed axes).
  function rotation(rx, ry, rz) {
    var a = (rx || 0) * D, b = (ry || 0) * D, c = (rz || 0) * D;
    var cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c);
    var R = [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
    return R.map(function (v) { return Math.abs(v) < 1e-12 ? 0 : v; });
  }
  // A placed object's world bounding box.
  function placedBox(o) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], q = [0, 0, 0], p = [0, 0, 0], pos = o.mesh.pos;
    for (var i = 0; i < pos.length; i += 3) {
      p[0] = pos[i]; p[1] = pos[i + 1]; p[2] = pos[i + 2]; place(o, p, q);
      for (var k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
    }
    return { lo: lo, hi: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
  }

  // The rasterizer. view: { cam, scale (px per mm), cx, cy (view X/Y at the canvas center) }.
  // Returns RGBA plus, per pixel, the object and triangle drawn there (−1 for none).
  function raster(objs, view, W, H, opts) {
    var cam = view.cam, zb = new Float32Array(W * H).fill(-Infinity), rgba = new Uint8ClampedArray(W * H * 4);
    var oid = new Int16Array(W * H).fill(-1), tid = new Int32Array(W * H).fill(-1);
    var L = [-0.35, 0.45, 0.82], ll = Math.hypot(L[0], L[1], L[2]);
    L = L.map(function (c) { return c / ll; });
    var q = [0, 0, 0], p = [0, 0, 0];
    objs.forEach(function (o, oi) {
      if (o.hidden) return;   // hidden in the view: not drawn, never picked, keeps its index
      var m = o.mesh, nv = m.pos.length / 3, sx = new Float32Array(nv), sy = new Float32Array(nv), sz = new Float32Array(nv);
      for (var v = 0; v < nv; v++) {
        p[0] = m.pos[v * 3]; p[1] = m.pos[v * 3 + 1]; p[2] = m.pos[v * 3 + 2]; place(o, p, q);
        sx[v] = W / 2 + (dot(cam.r, q) - view.cx) * view.scale; sy[v] = H / 2 - (dot(cam.u, q) - view.cy) * view.scale; sz[v] = dot(cam.f, q);
      }
      var nt = m.idx.length / 3, tint = o.tint;
      for (var t = 0; t < nt; t++) {
        var a = m.idx[t * 3], b = m.idx[t * 3 + 1], c = m.idx[t * 3 + 2];
        var ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], qx = sx[c], qy = sy[c];
        var area = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
        if (Math.abs(area) < 1e-9) continue;
        var x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx))), x9 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
        var y0 = Math.max(0, Math.floor(Math.min(ay, by, qy))), y9 = Math.min(H - 1, Math.ceil(Math.max(ay, by, qy)));
        if (x0 > x9 || y0 > y9) continue;
        // Face normal in view space (screen y points down, so flip it back up); lit from both sides.
        var ux = bx - ax, uy = -(by - ay), uz = sz[b] - sz[a], wx = qx - ax, wy = -(qy - ay), wz = sz[c] - sz[a];
        var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        var dif = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]), spec = Math.pow(Math.max(0, nz * 0.92 + dif * 0.08), 40) * 0.12;
        var tx = m.tex && m.tex[t] && o.tex && o.tex[m.tex[t]];
        var k = tx ? 0.62 + 0.38 * dif : 0.42 + 0.58 * dif;
        var cr = m.col[t * 3], cg = m.col[t * 3 + 1], cb = m.col[t * 3 + 2];
        if (tint) { cr = cr * (1 - tint[3]) + tint[0] * tint[3]; cg = cg * (1 - tint[3]) + tint[1] * tint[3]; cb = cb * (1 - tint[3]) + tint[2] * tint[3]; }
        var r = Math.min(255, cr * k + 255 * spec), g = Math.min(255, cg * k + 255 * spec), bl = Math.min(255, cb * k + 255 * spec);
        var inv = 1 / area, za = sz[a], zbv = sz[b], zc = sz[c];
        var ua = 0, va = 0, ub = 0, vb = 0, uc = 0, vc = 0;
        if (tx) { ua = m.uv[a * 2]; va = m.uv[a * 2 + 1]; ub = m.uv[b * 2]; vb = m.uv[b * 2 + 1]; uc = m.uv[c * 2]; vc = m.uv[c * 2 + 1]; }
        for (var py = y0; py <= y9; py++) {
          var fy = py + 0.5;
          for (var px = x0; px <= x9; px++) {
            var fx = px + 0.5;
            var w0 = ((bx - fx) * (qy - fy) - (by - fy) * (qx - fx)) * inv;
            var w1 = ((qx - fx) * (ay - fy) - (qy - fy) * (ax - fx)) * inv;
            var w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            var depth = w0 * za + w1 * zbv + w2 * zc, o2 = py * W + px;
            if (depth <= zb[o2]) continue;
            if (tx) {
              // Orthographic, so the flat mapping is exact. See-through where the picture is.
              var tu = w0 * ua + w1 * ub + w2 * uc, tv = w0 * va + w1 * vb + w2 * vc;
              var ix = Math.min(tx.crop[2] - 1, Math.max(tx.crop[0], Math.floor(tx.crop[0] + tu * (tx.crop[2] - tx.crop[0]))));
              var iy = Math.min(tx.crop[3] - 1, Math.max(tx.crop[1], Math.floor(tx.crop[1] + tv * (tx.crop[3] - tx.crop[1]))));
              var ti = (iy * tx.w + ix) * 4;
              if (tx.data[ti + 3] < 128) continue;
              zb[o2] = depth; oid[o2] = oi; tid[o2] = t;
              rgba[o2 * 4] = tx.data[ti] * k; rgba[o2 * 4 + 1] = tx.data[ti + 1] * k; rgba[o2 * 4 + 2] = tx.data[ti + 2] * k; rgba[o2 * 4 + 3] = 255;
              continue;
            }
            zb[o2] = depth; oid[o2] = oi; tid[o2] = t;
            rgba[o2 * 4] = r; rgba[o2 * 4 + 1] = g; rgba[o2 * 4 + 2] = bl; rgba[o2 * 4 + 3] = 255;
          }
        }
      }
    });
    // Outline where the depth jumps or one part meets another, for the drawn, technical look. The
    // selected part's outline is in the accent color.
    var jump = opts.jump, sel = opts.sel == null ? -1 : opts.sel, acc = opts.accent || [0, 150, 166], thick = opts.selWidth || 1;
    function apart(i0, n) { var zn = zb[n]; return zn === -Infinity || zb[i0] - zn > jump || (oid[n] !== oid[i0] && zb[i0] > zn); }
    for (var yy = 1; yy < H - 1; yy++) for (var xx = 1; xx < W - 1; xx++) {
      var i0 = yy * W + xx;
      if (zb[i0] === -Infinity) continue;
      var selEdge = false;
      if (sel >= 0 && oid[i0] === sel) {
        for (var dy = -thick; dy <= thick && !selEdge; dy++) for (var dx = -thick; dx <= thick; dx++) {
          var xn = xx + dx, yn = yy + dy;
          if (xn < 0 || yn < 0 || xn >= W || yn >= H || oid[yn * W + xn] !== sel) { selEdge = true; break; }
        }
      }
      if (selEdge) { rgba[i0 * 4] = acc[0]; rgba[i0 * 4 + 1] = acc[1]; rgba[i0 * 4 + 2] = acc[2]; }
      else if (apart(i0, i0 - 1) || apart(i0, i0 + 1) || apart(i0, i0 - W) || apart(i0, i0 + W)) { rgba[i0 * 4] *= 0.45; rgba[i0 * 4 + 1] *= 0.45; rgba[i0 * 4 + 2] *= 0.45; }
    }
    return { rgba: rgba, oid: oid, tid: tid, zb: zb, W: W, H: H };
  }
  // Box-filter down by ss (premultiplied, so edges blend into the transparency).
  function shrink(rgba, W, H, ss) {
    if (ss === 1) return new ImageData(rgba, W, H);
    var w = Math.floor(W / ss), h = Math.floor(H / ss), out = new Uint8ClampedArray(w * h * 4), n = ss * ss;
    for (var oy = 0; oy < h; oy++) for (var ox = 0; ox < w; ox++) {
      var R = 0, G = 0, B = 0, A = 0;
      for (var dy = 0; dy < ss; dy++) for (var dx = 0; dx < ss; dx++) {
        var s = ((oy * ss + dy) * W + ox * ss + dx) * 4, al = rgba[s + 3] / 255;
        R += rgba[s] * al; G += rgba[s + 1] * al; B += rgba[s + 2] * al; A += al;
      }
      var q2 = (oy * w + ox) * 4;
      if (A) { out[q2] = R / A; out[q2 + 1] = G / A; out[q2 + 2] = B / A; out[q2 + 3] = A / n * 255; }
    }
    return new ImageData(out, w, h);
  }

  // One part, fitted to the picture. opts: { w, h, az, el, ss (default 2), zoom (default 1),
  // fit and box (a viewer keeps the part centered and the scale steady as it turns), c (with fit: the
  // world point at the center, for panning; default the box's center) } → ImageData with a
  // transparent background.
  function render(mesh, opts) {
    var ss = opts.ss || 2, W = opts.w * ss, H = opts.h * ss, cam = camera(opts.az, opts.el);
    var box = opts.box || bbox(mesh.pos), c = (opts.fit && opts.c) || [(box.lo[0] + box.hi[0]) / 2, (box.lo[1] + box.hi[1]) / 2, (box.lo[2] + box.hi[2]) / 2];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, q = [0, 0, 0];
    for (var i = 0; i < mesh.pos.length; i += 3) {
      q[0] = mesh.pos[i] - c[0]; q[1] = mesh.pos[i + 1] - c[1]; q[2] = mesh.pos[i + 2] - c[2];
      var X = dot(cam.r, q), Y = dot(cam.u, q);
      if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
    }
    var fit = opts.fit || Math.max(maxX - minX, maxY - minY, 1e-6);
    var view = { cam: cam, scale: Math.min(W, H) * 0.88 / fit * (opts.zoom || 1), cx: dot(cam.r, c), cy: dot(cam.u, c) };
    if (!opts.fit) { view.cx += (minX + maxX) / 2; view.cy += (minY + maxY) / 2; }
    var r = raster([{ mesh: mesh }], view, W, H, { jump: fit * 0.012 });
    return shrink(r.rgba, W, H, ss);
  }

  // Several placed parts. cam: { az, el, zoom, fit (mm across the view at zoom 1), c: [x, y, z]
  // (the point at the center) }. opts: { ss, sel (object index to outline) }.
  // Returns { image, pick(x, y) → { obj, tri } | null, project(world) → [x, y] in canvas px,
  // unproject(dx, dy) → the world move for a drag of that many canvas px }.
  function renderScene(objs, cam, w, h, opts) {
    opts = opts || {};
    var ss = opts.ss || 1, W = w * ss, H = h * ss, cm = camera(cam.az, cam.el), c = cam.c || [0, 0, 0];
    var view = { cam: cm, scale: Math.min(W, H) * 0.88 / (cam.fit || 100) * (cam.zoom || 1), cx: dot(cm.r, c), cy: dot(cm.u, c) };
    var r = raster(objs, view, W, H, { jump: (cam.fit || 100) * 0.004 / (cam.zoom || 1), sel: opts.sel, selWidth: ss * 2 - 1 });
    var k = ss / view.scale;
    return {
      image: shrink(r.rgba, W, H, ss),
      pick: function (x, y) {
        var px = Math.floor(x * ss), py = Math.floor(y * ss);
        if (px < 0 || py < 0 || px >= W || py >= H) return null;
        var i = py * W + px;
        return r.oid[i] < 0 ? null : { obj: r.oid[i], tri: r.tid[i], depth: r.zb[i] };
      },
      // [x, y, depth toward the eye] in canvas px; compare depth with pick().depth.
      project: function (q) { return [(W / 2 + (dot(cm.r, q) - view.cx) * view.scale) / ss, (H / 2 - (dot(cm.u, q) - view.cy) * view.scale) / ss, dot(cm.f, q)]; },
      unproject: function (dx, dy) {
        return [0, 1, 2].map(function (i) { return (cm.r[i] * dx - cm.u[i] * dy) * k; });
      },
      // The world point under canvas px (x, y) at a pick()'s depth: the inverse of project.
      point: function (x, y, depth) {
        var a = view.cx + (x * ss - W / 2) / view.scale, b = view.cy - (y * ss - H / 2) / view.scale;
        return [0, 1, 2].map(function (i) { return cm.r[i] * a + cm.u[i] * b + cm.f[i] * depth; });
      },
      cam: cm
    };
  }

  function png(mesh, view, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(render(mesh, { w: w, h: h, az: view.az, el: view.el }), 0, 0);
    return new Promise(function (resolve, reject) { c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Couldn’t make the picture')); }, 'image/png'); });
  }

  // Turning by a drag of dx, dy CSS px, shared by the viewer and Exploded. The part follows the
  // pointer as if held: drag right and its near side moves right, drag down and its top comes toward
  // you. (Until 2026-11-09 a drag to the right swung the eye right, so the part turned against the
  // pointer; Chris found it backward.)
  var TURN = 0.01;   // radians per px
  function orbit(az, el, dx, dy) {
    return { az: az + dx * TURN, el: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, el + dy * TURN)) };
  }

  // How a canvas of w × h device px is drawn: quick frames while it moves, a sharp one when it stops.
  // The renderer's time goes with pixels (about 30 ms a megapixel at 60k triangles, measured
  // 2026-11-09), so a big canvas draws fewer and CSS stretches them. → { k (backing-store scale), ss }
  var QUICK_PX = 1e6, SHARP_PX = 8e6;
  function budget(w, h, sharp) {
    var px = Math.max(1, w * h);
    if (!sharp) return { k: Math.min(1, Math.sqrt(QUICK_PX / px)), ss: 1 };
    var k2 = Math.min(1, Math.sqrt(SHARP_PX / (4 * px)));
    return k2 >= 0.7 ? { k: k2, ss: 2 } : { k: Math.min(1, Math.sqrt(SHARP_PX / px)), ss: 1 };
  }

  // A rotatable view in a canvas: drag to turn, Shift-, right- or middle-drag to pan, wheel to zoom
  // about the pointer, double-click to reset. It redraws whenever the canvas changes size (so a canvas
  // laid out after the mesh arrives isn't left blank) and stops once the canvas leaves the page.
  // Returns a handle: get() and set(state) with state { az, el, zoom, c (world point at the center) },
  // view(az, el) (turn and fit), fit(), reset(), turn(daz, del) (radians, as a drag would), zoomBy(f),
  // and destroy().
  function viewer(canvas, mesh) {
    var box = bbox(mesh.pos), fit = Math.hypot(box.size[0], box.size[1], box.size[2]) || 1;
    var mid = [0, 1, 2].map(function (i) { return (box.lo[i] + box.hi[i]) / 2; }), ZOOM = 1.25;
    function home() { return { az: VIEWS[0].az, el: VIEWS[0].el, zoom: 1, c: mid.slice() }; }
    function zoomed(z) { return Math.max(0.4, Math.min(20, z)); }
    var st = home(), drag = null, raf = 0, idle = 0, ro = null, dead = false, size = '';
    function pxPerMm() { return Math.min(canvas.clientWidth, canvas.clientHeight) * 0.88 / fit * st.zoom * ZOOM; }
    function draw(sharp) {
      if (dead) return;
      if (!canvas.isConnected) { destroy(); return; }
      var dpr = Math.min(2, window.devicePixelRatio || 1), cw = canvas.clientWidth * dpr, ch = canvas.clientHeight * dpr;
      size = canvas.clientWidth + 'x' + canvas.clientHeight;
      if (!cw || !ch) return;
      var b = budget(cw, ch, sharp), w = Math.max(1, Math.round(cw * b.k)), h = Math.max(1, Math.round(ch * b.k));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.getContext('2d').putImageData(render(mesh, { w: w, h: h, az: st.az, el: st.el, zoom: st.zoom * ZOOM, fit: fit, box: box, c: st.c, ss: b.ss }), 0, 0);
    }
    function later() {
      if (dead) return;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(function () { draw(false); });
      clearTimeout(idle); idle = setTimeout(function () { draw(true); }, 220);
    }
    function get() { return { az: st.az, el: st.el, zoom: st.zoom, c: st.c.slice() }; }
    function destroy() { dead = true; drag = null; cancelAnimationFrame(raf); clearTimeout(idle); if (ro) ro.disconnect(); }
    canvas.addEventListener('pointerdown', function (e) {
      if (e.button > 2) return;
      if (e.button === 1) e.preventDefault();   // no autoscroll
      drag = { x: e.clientX, y: e.clientY, pan: e.button > 0 || e.shiftKey, st: get() };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y, s0 = drag.st;
      if (drag.pan) {
        var cm = camera(s0.az, s0.el), k = 1 / pxPerMm();
        st.c = [0, 1, 2].map(function (i) { return s0.c[i] - (cm.r[i] * dx - cm.u[i] * dy) * k; });
      } else {
        var o = orbit(s0.az, s0.el, dx, dy);
        st.az = o.az; st.el = o.el;
      }
      later();
    });
    canvas.addEventListener('pointerup', function () { drag = null; });
    canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // The point under the pointer stays put.
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var z = zoomed(st.zoom * Math.exp(-e.deltaY * 0.0015)), f = z / st.zoom;
      if (f === 1) return;
      var r = canvas.getBoundingClientRect(), ox = e.clientX - r.left - r.width / 2, oy = e.clientY - r.top - r.height / 2;
      var cm = camera(st.az, st.el), k = (1 - 1 / f) / pxPerMm();
      st.c = [0, 1, 2].map(function (i) { return st.c[i] + (cm.r[i] * ox - cm.u[i] * oy) * k; });
      st.zoom = z;
      later();
    }, { passive: false });
    canvas.addEventListener('dblclick', function () { st = home(); later(); });
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () {
        if (!canvas.isConnected) destroy();
        else if (canvas.clientWidth + 'x' + canvas.clientHeight !== size) later();
      });
      ro.observe(canvas);
    }
    draw(true);
    return {
      get: get,
      set: function (s) { st = { az: s.az, el: s.el, zoom: zoomed(s.zoom || 1), c: (s.c || mid).slice() }; later(); },
      view: function (az, el) { st = { az: az, el: el, zoom: 1, c: mid.slice() }; later(); },
      fit: function () { st.zoom = 1; st.c = mid.slice(); later(); },
      reset: function () { st = home(); later(); },
      turn: function (daz, del) { var o = orbit(st.az, st.el, daz / TURN, del / TURN); st.az = o.az; st.el = o.el; later(); },
      zoomBy: function (f) { st.zoom = zoomed(st.zoom * f); later(); },
      destroy: destroy
    };
  }

  // ── Arranging ────────────────────────────────────────────
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vtx(mesh, i) { return [mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]]; }

  // What a part can be snapped by, in its own coordinates:
  //   region   the face each triangle belongs to (CAD faces, joined as described below)
  //   segs     edges (where two faces meet, or an open border) as vertex pairs; .g is the chain
  //            (one run between corners), .circle the round edge it belongs to, or −1
  //   corners  vertices where edges turn or meet
  //   circles  round edges (holes, bosses): { c, r, n }, snapped by their axis
  //   planes   flat faces by region: { n, p }
  // Accuracy follows the stored mesh: a simplified part's vertices moved by up to one grid cell.
  function features(mesh) {
    var nv = mesh.pos.length / 3, nt = mesh.idx.length / 3, fid = mesh.fid || new Uint32Array(nt), edges = new Map(), t, k;
    // Triangle normals.
    var tn = new Float32Array(nt * 3), area = new Float32Array(nt);
    for (t = 0; t < nt; t++) {
      var A0 = vtx(mesh, mesh.idx[t * 3]), N0 = cross(sub(vtx(mesh, mesh.idx[t * 3 + 1]), A0), sub(vtx(mesh, mesh.idx[t * 3 + 2]), A0));
      var l0 = Math.hypot(N0[0], N0[1], N0[2]);
      area[t] = l0 / 2;
      if (l0 > 0) { tn[t * 3] = N0[0] / l0; tn[t * 3 + 1] = N0[1] / l0; tn[t * 3 + 2] = N0[2] / l0; }
    }
    for (t = 0; t < nt; t++) for (k = 0; k < 3; k++) {
      var a = mesh.idx[t * 3 + k], b = mesh.idx[t * 3 + (k + 1) % 3], lo = Math.min(a, b), hi = Math.max(a, b), key = lo * nv + hi;
      var e = edges.get(key);
      if (!e) edges.set(key, { a: lo, b: hi, t: [t] }); else e.t.push(t);
    }
    // Faces as a person sees them. Triangles of one CAD face belong together, and so do
    // neighbors in one plane. A faceted STEP (every face a facet or two) has no real faces, so
    // there neighbors meeting at under 30° are joined too: a faceted wall becomes one curved face.
    var nf = 0, seenF = {};
    for (t = 0; t < nt; t++) if (!seenF[fid[t]]) { seenF[fid[t]] = 1; nf++; }
    var faceted = nf > nt / 4, smooth = Math.cos(30 * D);
    var parent = new Int32Array(nt);
    for (t = 0; t < nt; t++) parent[t] = t;
    function root(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function join(x, y) { x = root(x); y = root(y); if (x !== y) parent[Math.max(x, y)] = Math.min(x, y); }
    function cos(x, y) { return tn[x * 3] * tn[y * 3] + tn[x * 3 + 1] * tn[y * 3 + 1] + tn[x * 3 + 2] * tn[y * 3 + 2]; }
    edges.forEach(function (e) {
      if (e.t.length !== 2) return;
      var x = e.t[0], y = e.t[1], c = cos(x, y);
      if (fid[x] === fid[y] || c > 0.9998 || (faceted && c > smooth)) join(x, y);
    });
    var region = new Uint32Array(nt);
    for (t = 0; t < nt; t++) region[t] = root(t);
    // Edges: where two faces meet, or an open border.
    var segs = [], at = {};
    edges.forEach(function (e) {
      if (e.t.length === 2 && region[e.t[0]] === region[e.t[1]]) return;
      e.circle = -1; e.g = -1;
      (at[e.a] = at[e.a] || []).push(segs.length);
      (at[e.b] = at[e.b] || []).push(segs.length);
      segs.push(e);
    });
    // Corners: an open end, three or more edges meeting, or two meeting at a turn sharper than 150°.
    function dirFrom(v, e) { return unit(sub(vtx(mesh, e.a === v ? e.b : e.a), vtx(mesh, v))); }
    var corners = Object.keys(at).map(Number).filter(function (v) {
      var list = at[v];
      return list.length !== 2 || dot(dirFrom(v, segs[list[0]]), dirFrom(v, segs[list[1]])) > -0.87;
    });
    var isCorner = {};
    corners.forEach(function (v) { isCorner[v] = 1; });
    // Chains: runs of edges between corners (or closed loops). A chain is one edge for picking, and
    // a round one is a hole or boss: fitted through three spread-out points, then checked against all.
    var chains = [];
    segs.forEach(function (e0, i0) {
      if (e0.g >= 0) return;
      var g = chains.length, list = [i0], ends = [e0.a, e0.b];
      e0.g = g;
      ends.forEach(function (v0) {
        var v = v0;
        while (!isCorner[v] && at[v].length === 2) {
          var nxt = at[v].filter(function (si) { return segs[si].g < 0; })[0];
          if (nxt == null) break;
          segs[nxt].g = g; list.push(nxt);
          v = segs[nxt].a === v ? segs[nxt].b : segs[nxt].a;
        }
      });
      chains.push(list);
    });
    var circles = [];
    chains.forEach(function (list) {
      if (list.length < 6) return;
      var seen = {}, pts = [];
      list.forEach(function (si) { [segs[si].a, segs[si].b].forEach(function (v) { if (!seen[v]) { seen[v] = 1; pts.push(vtx(mesh, v)); } }); });
      var p0 = pts[0], p1 = p0, p2 = p0, best = -1;
      pts.forEach(function (p) { var d = Math.hypot.apply(null, sub(p, p0)); if (d > best) { best = d; p1 = p; } });
      var ax = unit(sub(p1, p0));
      best = -1;
      pts.forEach(function (p) { var v = sub(p, p0), d = Math.hypot.apply(null, sub(v, ax.map(function (x) { return x * dot(v, ax); }))); if (d > best) { best = d; p2 = p; } });
      if (best <= 0) return;
      var u = sub(p1, p0), w = sub(p2, p0), n = cross(u, w), nn = dot(n, n);
      if (nn < 1e-12) return;
      var nu1 = cross(n, u), wn = cross(w, n);
      var c = p0.map(function (x, i) { return x + (nu1[i] * dot(w, w) + wn[i] * dot(u, u)) / (2 * nn); });
      var r = Math.hypot.apply(null, sub(p0, c)), nu = unit(n);
      if (!(r > 0) || !pts.every(function (p) { var d = sub(p, c); return Math.abs(Math.hypot(d[0], d[1], d[2]) - r) < 0.04 * r && Math.abs(dot(d, nu)) < 0.04 * r; })) return;
      var idx = -1;
      circles.forEach(function (o, i) { if (Math.hypot.apply(null, sub(o.c, c)) < 0.05 * r && Math.abs(o.r - r) < 0.05 * r) idx = i; });
      if (idx < 0) { idx = circles.length; circles.push({ c: c, r: r, n: nu }); }
      list.forEach(function (si) { segs[si].circle = idx; });
    });
    // Flat faces: every triangle of the face points the same way (within about 2.5°).
    var acc = {}, planes = {};
    for (t = 0; t < nt; t++) {
      if (!area[t]) continue;
      var f = region[t], s0 = acc[f], n0 = [tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]];
      if (!s0) acc[f] = { n: n0.map(function (x) { return x * area[t]; }), list: [t], p: vtx(mesh, mesh.idx[t * 3]) };
      else { s0.n[0] += n0[0] * area[t]; s0.n[1] += n0[1] * area[t]; s0.n[2] += n0[2] * area[t]; s0.list.push(t); }
    }
    Object.keys(acc).forEach(function (f) {
      var nm = unit(acc[f].n);
      if (acc[f].list.every(function (x) { return Math.abs(tn[x * 3] * nm[0] + tn[x * 3 + 1] * nm[1] + tn[x * 3 + 2] * nm[2]) > 0.999; })) planes[f] = { n: nm, p: acc[f].p };
    });
    return { segs: segs, corners: corners, circles: circles, planes: planes, region: region, chains: chains };
  }

  // The move that puts feature a onto feature b (both in world coordinates):
  //   point  { p }        a corner: meets a point, or the nearest place on a line or plane
  //   line   { p, d }     an edge, or a hole's axis: lines become one line (parallel), or cross
  //   plane  { p, n }     a flat face: only the distance between the planes is taken away
  // Translation only; turning is left to the 90° buttons.
  function alignMove(a, b) {
    var d = sub(b.p, a.p);
    function along(n) { var k = dot(d, n); return [n[0] * k, n[1] * k, n[2] * k]; }
    function across(u) { var k = dot(d, u); return [d[0] - u[0] * k, d[1] - u[1] * k, d[2] - u[2] * k]; }
    if (b.type === 'plane') return along(unit(b.n));
    if (a.type === 'plane') return along(unit(a.n));
    if (a.type === 'line' && b.type === 'line') {
      var x = cross(unit(a.d), unit(b.d)), l = Math.hypot(x[0], x[1], x[2]);
      return l < 1e-6 ? across(unit(b.d)) : along([x[0] / l, x[1] / l, x[2] / l]);
    }
    if (b.type === 'line') return across(unit(b.d));
    if (a.type === 'line') return across(unit(a.d));
    return d;
  }

  // A board as a slab, w × h × t mm, centered on its own origin, with its pictures on the top and
  // bottom faces (tex 1 and 2) and plain sides. Bottom pictures are drawn as seen from below.
  var BOARD_RGB = [38, 96, 66], EDGE_RGB = [24, 64, 44];
  function slab(w, h, t) {
    var x = w / 2, y = h / 2, z = t / 2, pos = [], uv = [], idx = [], col = [], fid = [], tex = [];
    function quad(ps, uvs, rgb, face, tx) {
      var o = pos.length / 3;
      ps.forEach(function (p, i) { pos.push(p[0], p[1], p[2]); uv.push(uvs[i][0], uvs[i][1]); });
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
      for (var k = 0; k < 2; k++) { col.push(rgb[0], rgb[1], rgb[2]); fid.push(face); tex.push(tx); }
    }
    quad([[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [[0, 1], [1, 1], [1, 0], [0, 0]], BOARD_RGB, 0, 1);
    quad([[-x, -y, -z], [-x, y, -z], [x, y, -z], [x, -y, -z]], [[1, 1], [1, 0], [0, 0], [0, 1]], BOARD_RGB, 1, 2);
    var zero = [[0, 0], [0, 0], [0, 0], [0, 0]];
    quad([[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], zero, EDGE_RGB, 2, 0);
    quad([[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]], zero, EDGE_RGB, 3, 0);
    quad([[x, y, -z], [-x, y, -z], [-x, y, z], [x, y, z]], zero, EDGE_RGB, 4, 0);
    quad([[-x, y, -z], [-x, -y, -z], [-x, -y, z], [-x, y, z]], zero, EDGE_RGB, 5, 0);
    return { pos: new Float32Array(pos), idx: new Uint32Array(idx), col: new Uint8Array(col), fid: new Uint32Array(fid), uv: new Float32Array(uv), tex: new Uint8Array(tex) };
  }
  // A picture as a texture: its pixels, cropped to where it isn't see-through (Fabcheck draws the
  // board with a margin around it).
  function texture(imageData) {
    var d = imageData.data, w = imageData.width, h = imageData.height, x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < x0) return null;
    return { data: d, w: w, h: h, crop: [x0, y0, x1 + 1, y1 + 1] };
  }

  // A STEP file → what PL stores: the simplified mesh (gzipped), its pictures, the original
  // STEP gzipped (kept only when asked and under the cap), and facts for the Part.
  var STEP_CAP = 10 * 1024 * 1024;   // gzipped
  function prepare(name, bytes, onStep) {
    var say = onStep || function () {};
    say('Reading the STEP…');
    return readStep(bytes).then(function (raw) {
      var srcTris = raw.idx.length / 3, box = bbox(raw.pos);
      say('Simplifying ' + srcTris.toLocaleString() + ' triangles…');
      var mesh = simplify(raw, MAX_TRIS);
      say('Drawing the views…');
      return Promise.all([encode(mesh), gzip(bytes)].concat(VIEWS.map(function (v) { return png(mesh, v, 480, 360); }))).then(function (r) {
        return {
          name: name, size: bytes.length, srcTris: srcTris, tris: mesh.idx.length / 3, bboxMm: box.size.map(function (x) { return Math.round(x * 10) / 10; }),
          mesh: mesh, meshGz: r[0], stepGz: r[1], stepFits: r[1].length <= STEP_CAP,
          views: VIEWS.map(function (v, i) { return { key: v.key, blob: r[i + 2], w: 480, h: 360 }; })
        };
      });
    });
  }

  // ── Part models kept with a Signoff ME review (docs/part-models.md) ──
  // One folder, <ME review's repo>/partcheck/<review id>/preview/, holds every model of the review's parts:
  // index.json (Partcheck's v: 1 index with `parts`), each part's pictures, its PLM1 mesh, and, if kept, its
  // STEP gzipped. Partcheck's Send, Signoff PL, and Signoff ME all write it; the latest write for a part
  // number wins. `store` is the engine's GitHubStore (snapshot, blobBytes, putFiles), `dir` the folder.
  var parts = (function () {
    // A part number as a file-name key: lowercase a-z, 0-9, and dashes, at most 25 characters, so
    // "<key>-front" stays within the 32 the readers allow (the same as Partcheck's Send).
    function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 25).replace(/-+$/, ''); }
    // Part numbers compare trimmed and lowercased, as Signoff PL matches a Part to its part.
    function norm(s) { return String(s || '').trim().toLowerCase(); }
    // The files an index uses (anything else in the folder is removed when it's written).
    function named(index) {
      var out = { 'index.json': 1 };
      ((index && index.images) || []).forEach(function (i) { if (i && i.file) out[i.file] = 1; });
      ((index && index.parts) || []).forEach(function (x) {
        if (x && x.mesh && x.mesh.file) out[x.mesh.file] = 1;
        if (x && x.step && x.step.file) out[x.step.file] = 1;
      });
      return out;
    }
    function find(index, partNumber) {
      var n = norm(partNumber);
      return ((index && index.parts) || []).filter(function (x) { return x && norm(x.partNumber) === n; })[0] || null;
    }
    function freeKey(index, want) {
      var used = {};
      index.parts.forEach(function (x) { if (x && x.key) used[x.key] = 1; });
      if (want && !used[want]) return want;
      var i = 1;
      while (used['p' + i]) i++;
      return 'p' + i;
    }
    function bytesOf(blob) {
      return blob instanceof Uint8Array ? Promise.resolve(blob) : blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    function copy(prev) {
      var index = prev ? JSON.parse(JSON.stringify(prev)) : { v: 1, tool: 'signoff', runId: '', at: '', hero: '', images: [], parts: [] };
      index.images = (Array.isArray(index.images) ? index.images : []).filter(function (i) { return i && typeof i === 'object'; });
      index.parts = (Array.isArray(index.parts) ? index.parts : []).filter(function (x) { return x && typeof x === 'object'; });
      // A part Partcheck sent has no time of its own (the folder's is its); keep it before the folder's moves on.
      if (index.at) index.parts.forEach(function (x) { if (!x.at) x.at = index.at; });
      return index;
    }
    // Take a part (and its pictures) out of an index.
    function drop(index, partNumber) {
      var old = find(index, partNumber), gone = {};
      if (!old) return null;
      Object.keys(old.views || {}).forEach(function (v) { gone[old.views[v]] = 1; });
      index.parts = index.parts.filter(function (x) { return x !== old; });
      index.images = index.images.filter(function (i) { return !gone[i.key]; });
      return old;
    }
    function heroOk(index) {
      if (!index.images.some(function (i) { return i.key === index.hero; })) {
        var first = index.parts[0], v = first && first.views ? first.views : {};
        index.hero = v.iso || v[Object.keys(v)[0]] || '';
      }
      return index;
    }
    // Read the folder at one commit, apply edit(index or null) → { index, files: [{ name, bytes }] } (or
    // null for no change), and write it in one commit on that head, removing files no part names any more
    // (an index with no parts left removes the folder). A repo that moved on is read again (three tries).
    // Resolves { res, index } or null.
    function write(store, dir, edit, message, tries) {
      tries = tries || 0;
      return store.snapshot().then(function (snap) {
        var entries = snap.entries.filter(function (e) { return e.type === 'blob' && e.path.indexOf(dir) === 0; });
        var at = entries.filter(function (e) { return e.path === dir + 'index.json'; })[0];
        return (at ? store.blobBytes(at.sha).then(function (b) {
          try { var d = JSON.parse(new TextDecoder().decode(b)); return d && typeof d === 'object' ? d : null; } catch (e) { return null; }
        }) : Promise.resolve(null)).then(edit).then(function (out) {
          if (!out) return null;
          var live = out.index.parts.length > 0, keep = live ? named(out.index) : {};
          var files = (live ? out.files.concat([{ name: 'index.json', text: JSON.stringify(out.index, null, 1) }]) : [])
            .map(function (f) { return f.bytes ? { path: dir + f.name, bytes: f.bytes } : { path: dir + f.name, text: f.text }; })
            .concat(entries.filter(function (e) { return !keep[e.path.slice(dir.length)]; }).map(function (e) { return { path: e.path, remove: true }; }));
          return store.putFiles(files, { head: snap.head, message: message }).then(function (res) { return { res: res, index: out.index }; });
        });
      }).catch(function (err) {
        if (err && err.code === 'moved' && tries < 2) return write(store, dir, edit, message, tries + 1);
        throw err;
      });
    }
    /* Put one part's model in the folder, replacing any part with the same number, whoever wrote it.
       o: { prep (prepare's result), partNumber, revision, name, source ('pl' | 'me'), by, at, keepStep, message } */
    function put(store, dir, o) {
      var at = o.at || new Date().toISOString();
      var step = o.keepStep && o.prep.stepFits && o.prep.stepGz ? o.prep.stepGz : null;
      return Promise.all([bytesOf(o.prep.meshGz)].concat(o.prep.views.map(function (v) { return bytesOf(v.blob); }))).then(function (bytes) {
        return write(store, dir, function (prev) {
          var index = copy(prev), old = drop(index, o.partNumber);
          var key = old && /^[a-z0-9-]{1,25}$/.test(old.key || '') ? old.key : freeKey(index, slug(o.partNumber));
          var files = [{ name: key + '.plm.gz', bytes: bytes[0] }], views = {};
          o.prep.views.forEach(function (v, i) {
            var k = key + '-' + v.key, webp = v.blob && v.blob.type === 'image/webp', file = k + (webp ? '.webp' : '.png');
            files.push({ name: file, bytes: bytes[i + 1] });
            index.images.push({ key: k, file: file, type: webp ? 'image/webp' : 'image/png', w: v.w, h: v.h });
            views[v.key] = k;
          });
          var entry = { key: key, partNumber: String(o.partNumber || '').trim(), revision: o.revision || '', name: o.name || '', views: views,
            mesh: { file: key + '.plm.gz', size: bytes[0].length, tris: o.prep.tris, srcTris: o.prep.srcTris, bboxMm: o.prep.bboxMm } };
          if (step) {
            files.push({ name: key + '.step.gz', bytes: step });
            entry.step = { file: key + '.step.gz', size: step.length };
          }
          entry.file = String(o.prep.name || '').slice(0, 160);
          entry.source = o.source || 'pl'; entry.at = at; entry.by = o.by || '';
          index.parts.push(entry);
          index.at = at;
          return { index: heroOk(index), files: files };
        }, o.message || ('Signoff: model for ' + (o.partNumber || 'a part')));
      });
    }
    // Take one part (by number) out of the folder. Resolves null when it wasn't there.
    function remove(store, dir, partNumber, message) {
      return write(store, dir, function (prev) {
        var index = copy(prev);
        if (!drop(index, partNumber)) return null;
        index.at = new Date().toISOString();
        return { index: heroOk(index), files: [] };
      }, message || ('Signoff: model for ' + partNumber + ' removed'));
    }
    return { slug: slug, norm: norm, named: named, find: find, put: put, remove: remove, write: write };
  })();

  S.model3d = { VIEWS: VIEWS, MAX_TRIS: MAX_TRIS, STEP_CAP: STEP_CAP, readStep: readStep, fromOcct: fromOcct, bbox: bbox, simplify: simplify,
    encode: encode, decode: decode, gzip: gzip, render: render, png: png, viewer: viewer, orbit: orbit, budget: budget, prepare: prepare,
    renderScene: renderScene, rotation: rotation, place: place, turn: turn, placedBox: placedBox, features: features, alignMove: alignMove,
    slab: slab, texture: texture, parts: parts };
})(window.Signoff = window.Signoff || {});
