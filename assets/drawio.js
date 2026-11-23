/* Signoff engine: draw.io files (2026-11-20, Chris: Scribe's diagram out to draw.io and back, as an SVG
   that is also an editable draw.io diagram). Edit it in ee_design_review only; ME and FW copy it.

   window.SignoffDrawio has two parts:
   - The format: write and read draw.io's XML (mxfile > diagram > mxGraphModel > cells), compressed pages,
     and an SVG carrying the diagram in its content attribute, which draw.io opens as a diagram (.drawio.svg).
   - Scribe's mapping, pure (no page): scribeFile(snap) turns a snapshot of the drawn block diagram into a
     draw.io page, and scribePlan(page, snap) lists the Scribe edits a page implies against what's drawn now.
     app.js takes the snapshot from the page and applies the plan. See docs/scribe-ee.md, *draw.io*.

   A snapshot (coordinates are the diagram's own, absolute):
     { review: { id, name, tool },
       sections: [{ id, title, gist, parent, x, y, w, h, grow: { l, t, r, b } }],   // outer ones first
       blocks: [{ id, title, gist, parent, x, y, w, h, kept (has a kept place), parts: [], reqs: [],
                  power: [{ rail, role, tree, x, y, w }] }],                       // flags: their box over the block
       lines: [{ key, a, b, word, dir ('out' | 'in' | 'both'), signal, t, pa: { x, y }, pb: { x, y },
                 corners: [{ x, y }], shaped (a kept route), portA, portB (kept ports) }],
       legend: { x, y } or null }
*/
(function () {
  'use strict';
  var FORMAT = 'scribe-drawio/1';
  var INK = '#4a5866', MUTED = '#6b7785', EDGE = '#9aa5b1';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
  }
  function styleText(o) {
    return Object.keys(o).map(function (k) { return o[k] === true ? k : k + '=' + o[k]; }).join(';') + ';';
  }
  function parseStyle(s) {
    var o = {};
    String(s || '').split(';').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      if (i < 0) o[kv] = '1'; else o[kv.slice(0, i)] = kv.slice(i + 1);
    });
    return o;
  }
  var num = function (n) { return String(Math.round(Number(n) * 100) / 100); };

  // ── Writing ──
  // c: { id, parent, value, style (object or text), vertex | edge, source, target, connectable,
  //      geo: { x, y, w, h } or { relative: true, x, points: [{ x, y }] }, data: { name: value } }.
  // Cells with data are wrapped in a UserObject, which draw.io keeps (Edit Data shows the values).
  function cellXml(c) {
    var g = c.geo || null, st = typeof c.style === 'string' ? c.style : c.style ? styleText(c.style) : '';
    var cell = '<mxCell' + (c.data ? '' : ' id="' + esc(c.id) + '"' + (c.value != null ? ' value="' + esc(c.value) + '"' : '')) +
      (st ? ' style="' + esc(st) + '"' : '') + (c.vertex ? ' vertex="1"' : '') + (c.edge ? ' edge="1"' : '') +
      (c.connectable === false ? ' connectable="0"' : '') + (c.parent ? ' parent="' + esc(c.parent) + '"' : '') +
      (c.source ? ' source="' + esc(c.source) + '"' : '') + (c.target ? ' target="' + esc(c.target) + '"' : '');
    if (!g) cell += '/>';
    else if (g.relative) {
      cell += '><mxGeometry' + (g.x != null ? ' x="' + num(g.x) + '"' : '') + ' relative="1" as="geometry">' +
        (g.points && g.points.length ? '<Array as="points">' + g.points.map(function (q) { return '<mxPoint x="' + num(q.x) + '" y="' + num(q.y) + '"/>'; }).join('') + '</Array>' : '') +
        (c.vertex ? '<mxPoint as="offset"/>' : '') + '</mxGeometry></mxCell>';
    } else cell += '><mxGeometry x="' + num(g.x) + '" y="' + num(g.y) + '" width="' + num(g.w) + '" height="' + num(g.h) + '" as="geometry"/></mxCell>';
    if (!c.data) return cell;
    return '<UserObject id="' + esc(c.id) + '" label="' + esc(c.value == null ? '' : c.value) + '"' +
      Object.keys(c.data).map(function (k) { return ' ' + k + '="' + esc(c.data[k]) + '"'; }).join('') + '>' + cell + '</UserObject>';
  }
  // The page's model: cell 0 (the root, carrying the file's own data) and 1 (the layer), then the cells.
  function modelXml(cells, rootData) {
    return '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>' +
      (rootData ? cellXml({ id: '0', value: '', data: rootData }) : '<mxCell id="0"/>') + '<mxCell id="1" parent="0"/>' +
      cells.map(cellXml).join('') + '</root></mxGraphModel>';
  }
  // pages: [{ id, name, model (XML text) }]; a page given as text (compressed) goes in as it is.
  function fileXml(pages) {
    return '<mxfile host="Signoff" type="device">' + pages.map(function (pg) {
      return '<diagram id="' + esc(pg.id) + '" name="' + esc(pg.name) + '">' + (pg.packed ? pg.packed : pg.model) + '</diagram>';
    }).join('') + '</mxfile>';
  }
  // draw.io's compressed page: base64 of raw deflate of the URI-encoded XML.
  function streamOf(bytes, t) { return new Response(new Blob([bytes]).stream().pipeThrough(t)); }
  function compress(text) {
    return streamOf(new TextEncoder().encode(encodeURIComponent(text)), new CompressionStream('deflate-raw')).arrayBuffer().then(function (buf) {
      var u = new Uint8Array(buf), bin = '';
      for (var i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(bin);
    });
  }
  function decompress(b64) {
    var bin = atob(String(b64).replace(/\s+/g, '')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return streamOf(u, new DecompressionStream('deflate-raw')).text().then(function (s) {
      try { return decodeURIComponent(s); } catch (err) { return s; }
    });
  }
  // An SVG that draw.io opens as the diagram: the file goes in the svg's content attribute, its pages
  // compressed (draw.io's own way). Everything else reads the svg as the picture it is.
  function svgWithFile(svgText, pages) {
    return Promise.all(pages.map(function (pg) { return compress(pg.model).then(function (z) { return { id: pg.id, name: pg.name, packed: z }; }); })).then(function (packed) {
      var doc = new DOMParser().parseFromString(svgText, 'image/svg+xml'), svg = doc.documentElement;
      if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG');
      svg.setAttribute('content', fileXml(packed));
      return new XMLSerializer().serializeToString(doc);
    });
  }

  // ── Reading ──
  // Any of: an .svg with a draw.io content attribute, an mxfile (pages plain or compressed), or a bare
  // mxGraphModel. Resolves { pages: [{ id, name, root (the file's own data), cells }] } or rejects with
  // a sentence to show.
  function read(text) {
    text = String(text || '').replace(/^﻿/, '');
    var doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return Promise.reject(new Error('That file isn’t readable XML'));
    var top = doc.documentElement, name = top.nodeName;
    if (name.toLowerCase() === 'svg') {
      var content = top.getAttribute('content');
      if (!content) return Promise.reject(new Error('That SVG has no draw.io diagram in it. Export it from Scribe, or save it from draw.io as an editable SVG.'));
      return read(content);
    }
    if (name === 'mxGraphModel') return Promise.resolve({ pages: [pageOf('page', 'Page-1', top)] });
    if (name !== 'mxfile') return Promise.reject(new Error('That isn’t a draw.io file'));
    var dias = Array.prototype.slice.call(top.getElementsByTagName('diagram'));
    if (!dias.length) return Promise.reject(new Error('That draw.io file has no pages'));
    return Promise.all(dias.map(function (d) {
      var m = d.getElementsByTagName('mxGraphModel')[0];
      if (m) return pageOf(d.getAttribute('id'), d.getAttribute('name'), m);
      return decompress(d.textContent).then(function (x) {
        var md = new DOMParser().parseFromString(x, 'text/xml').documentElement;
        if (!md || md.nodeName !== 'mxGraphModel') throw new Error('A page of that file couldn’t be read');
        return pageOf(d.getAttribute('id'), d.getAttribute('name'), md);
      });
    })).then(function (pages) { return { pages: pages }; });
  }
  // A page's cells by id: { id, data, label, style, vertex, edge, parent, source, target, geo, abs }.
  // abs is a vertex's box in page coordinates (children of a container are relative to it in the file).
  function pageOf(id, name, model) {
    var root = model.getElementsByTagName('root')[0], cells = {}, order = [];
    Array.prototype.forEach.call(root ? root.children : [], function (el) {
      var wrap = el.nodeName === 'UserObject' || el.nodeName === 'object';
      var c = wrap ? el.getElementsByTagName('mxCell')[0] : el.nodeName === 'mxCell' ? el : null;
      if (!c && !wrap) return;
      var data = {};
      if (wrap) Array.prototype.forEach.call(el.attributes, function (a) { if (a.name !== 'id' && a.name !== 'label' && a.name !== 'placeholders') data[a.name] = a.value; });
      var g = c && c.getElementsByTagName('mxGeometry')[0], pts = [];
      if (g) {
        var arr = Array.prototype.filter.call(g.getElementsByTagName('Array'), function (a) { return a.getAttribute('as') === 'points'; })[0];
        if (arr) pts = Array.prototype.map.call(arr.getElementsByTagName('mxPoint'), function (q) { return { x: +q.getAttribute('x') || 0, y: +q.getAttribute('y') || 0 }; });
      }
      var cid = el.getAttribute('id');
      cells[cid] = { id: cid, data: data, label: wrap ? el.getAttribute('label') || '' : (c.getAttribute('value') || ''), style: parseStyle(c && c.getAttribute('style')),
        vertex: !!c && c.getAttribute('vertex') === '1', edge: !!c && c.getAttribute('edge') === '1',
        parent: c ? c.getAttribute('parent') || '' : '', source: c ? c.getAttribute('source') || '' : '', target: c ? c.getAttribute('target') || '' : '',
        geo: g ? { x: +g.getAttribute('x') || 0, y: +g.getAttribute('y') || 0, w: +g.getAttribute('width') || 0, h: +g.getAttribute('height') || 0, relative: g.getAttribute('relative') === '1', points: pts } : null };
      order.push(cid);
    });
    var absOf = function (cid, depth) {
      var c = cells[cid];
      if (!c || !c.vertex || !c.geo || c.geo.relative || depth > 50) return { x: 0, y: 0 };
      var p = absOf(c.parent, depth + 1);
      return { x: p.x + c.geo.x, y: p.y + c.geo.y };
    };
    order.forEach(function (cid) { var c = cells[cid]; if (c.vertex && c.geo && !c.geo.relative) { var a = absOf(cid, 0); c.abs = { x: a.x, y: a.y, w: c.geo.w, h: c.geo.h }; } });
    var r0 = cells['0'];
    return { id: id || '', name: name || '', root: r0 ? r0.data : {}, cells: cells, order: order };
  }
  // A label's text: draw.io labels are HTML when the style says html=1.
  function plain(label, html) {
    var s = String(label || '');
    if (!html && !/[<&]/.test(s)) return s;
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n').replace(/<[^>]*>/g, '');
    return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&amp;/g, '&');
  }
  function firstLine(c) {
    return plain(c.label, c.style.html === '1').split('\n').map(function (t) { return t.replace(/\s+/g, ' ').trim(); }).filter(Boolean)[0] || '';
  }

  // ── Scribe: out ──
  // The rail symbols, as small pictures draw.io shows: a bar for a rail the block uses (sink), a circle
  // for one it makes (source). Import knows them by their data (scribeType power, role), not the picture.
  function railIcon(role) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="' + INK + '" stroke-width="1.6" stroke-linecap="round">' +
      (role === 'source' ? '<path d="M8 15V8.5"/><circle cx="8" cy="4.8" r="3.5"/>' : '<path d="M8 15V4"/><path d="M3 4h10"/>') + '</svg>';
    return 'data:image/svg+xml,' + btoa(svg);
  }
  function powerStyle(role) {
    return { shape: 'label', image: railIcon(role), imageWidth: 16, imageHeight: 16, imageAlign: 'left', imageVerticalAlign: 'middle',
      align: 'left', verticalAlign: 'middle', spacingLeft: 18, fillColor: 'none', strokeColor: 'none', fontSize: 10, fontColor: INK,
      resizable: 0, connectable: 0, rotatable: 0, html: 1, whiteSpace: 'nowrap' };
  }
  var PW_H = 16;
  function powerText(items) {
    return items.map(function (r) { return r.rail + ' (' + (r.role || 'sink') + (r.tree === false ? ', no tree' : '') + ')'; }).join(', ');
  }
  var cid = function (id) { return 'scribe-' + id; };
  // The page for a snapshot: { id, name, model }.
  function scribePage(snap) {
    var R = {}, cells = [], parentOf = {};
    snap.sections.concat(snap.blocks).forEach(function (s) { R[s.id] = s; parentOf[s.id] = s.parent || ''; });
    function rel(s) { var p = parentOf[s.id] && R[parentOf[s.id]]; return p ? { x: s.x - p.x, y: s.y - p.y, w: s.w, h: s.h } : { x: s.x, y: s.y, w: s.w, h: s.h }; }
    function par(s) { return parentOf[s.id] && R[parentOf[s.id]] ? cid(parentOf[s.id]) : '1'; }
    snap.sections.forEach(function (s) {
      cells.push({ id: cid(s.id), value: s.title || 'Untitled', parent: par(s), vertex: true, geo: rel(s),
        data: { scribeId: s.id, scribeType: 'section', gist: s.gist || '' },
        style: { rounded: 1, arcSize: 12, absoluteArcSize: 1, container: 1, collapsible: 0, fillColor: 'none', strokeColor: EDGE,
          verticalAlign: 'top', align: 'left', spacingLeft: 10, spacingTop: 2, fontStyle: 1, fontSize: 12, html: 1 } });
    });
    snap.blocks.forEach(function (b) {
      var parts = b.parts || [], sub = parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ' …' : '');
      cells.push({ id: cid(b.id), value: '<b>' + esc(b.title || 'Untitled') + '</b>' + (sub ? '<br><font style="font-size:10px" color="' + MUTED + '">' + esc(sub) + '</font>' : ''),
        parent: par(b), vertex: true, geo: rel(b),
        data: { scribeId: b.id, scribeType: 'block', title: b.title || '', gist: b.gist || '', parts: parts.join(', '), power: powerText(b.power || []), requirements: (b.reqs || []).join(', ') },
        style: { rounded: 1, arcSize: 8, absoluteArcSize: 1, whiteSpace: 'wrap', html: 1, fillColor: '#ffffff', strokeColor: INK, fontSize: 12, container: 0 } });
      // Each rail as a picture over the block, a child of it, so it moves with the block in draw.io.
      (b.power || []).forEach(function (r, i) {
        cells.push({ id: cid(b.id) + '-pw-' + i, value: r.rail, parent: cid(b.id), vertex: true, connectable: false,
          geo: { x: r.x - b.x, y: r.y - b.y, w: Math.max(30, r.w || 40), h: PW_H },
          data: { scribeType: 'power', role: r.role === 'source' ? 'source' : 'sink', tree: r.tree === false ? '0' : '1' }, style: powerStyle(r.role) });
      });
    });
    snap.lines.forEach(function (L, i) {
      var A = R[L.a], B = R[L.b];
      if (!A || !B) return;
      var id = 'scribe-line-' + (i + 1), dir = L.dir || 'out';
      var fx = function (q, r) { return Math.round((q.x - r.x) / r.w * 10000) / 10000; }, fy = function (q, r) { return Math.round((q.y - r.y) / r.h * 10000) / 10000; };
      cells.push({ id: id, value: '', parent: '1', edge: true, source: cid(L.a), target: cid(L.b),
        data: { scribeType: 'connection', scribeLine: L.key, from: L.a, to: L.b, word: L.word, direction: dir === 'both' ? 'both ways' : dir, signal: L.signal || '' },
        style: { edgeStyle: 'orthogonalEdgeStyle', rounded: 1, html: 1, strokeColor: INK, endArrow: dir === 'in' ? 'none' : 'block', endFill: 1,
          startArrow: dir === 'out' ? 'none' : 'block', startFill: 1, endSize: 6, startSize: 6,
          exitX: fx(L.pa, A), exitY: fy(L.pa, A), exitDx: 0, exitDy: 0, exitPerimeter: 0, entryX: fx(L.pb, B), entryY: fy(L.pb, B), entryDx: 0, entryDy: 0, entryPerimeter: 0 },
        geo: { relative: true, points: L.corners || [] } });
      if (L.signal) cells.push({ id: id + '-label', value: L.signal, parent: id, vertex: true, connectable: false,
        style: { edgeLabel: true, html: 1, align: 'center', verticalAlign: 'middle', resizable: 0, points: '[]', labelBackgroundColor: '#ffffff', labelBorderColor: EDGE, fontSize: 11 },
        geo: { relative: true, x: Math.round(((L.t == null ? 0.5 : L.t) * 2 - 1) * 1000) / 1000 } });
    });
    // The legend, also the pictures to copy: a copied rail renamed and dropped on a block's top edge adds
    // that rail to it on import.
    if (snap.legend) {
      cells.push({ id: 'scribe-legend', value: '', parent: '1', vertex: true, geo: { x: snap.legend.x, y: snap.legend.y, w: 140, h: PW_H },
        data: { scribeType: 'legend' }, style: { group: true, fillColor: 'none', strokeColor: 'none', connectable: 0 } });
      [['source', 'Source', 0], ['sink', 'Sink', 76]].forEach(function (o) {
        cells.push({ id: 'scribe-legend-' + o[0], value: o[1], parent: 'scribe-legend', vertex: true, connectable: false, geo: { x: o[2], y: 0, w: 60, h: PW_H },
          data: { scribeType: 'power', role: o[0], tree: '', sample: '1' }, style: powerStyle(o[0]) });
      });
    }
    var rv = snap.review || {};
    return { id: 'scribe-' + (rv.id || 'diagram'), name: (rv.name || 'Scribe') + ' block diagram',
      model: modelXml(cells, { scribeFormat: FORMAT, scribeTool: rv.tool || '', scribeReview: rv.id || '', scribeName: rv.name || '', exportedAt: new Date().toISOString() }) };
  }

  // ── Scribe: back ──
  var GRID = 10, snapTo = function (v) { return Math.round(v / GRID) * GRID; };
  var near = function (a, b, e) { return Math.abs(Number(a) - Number(b)) <= (e == null ? 0.5 : e); };
  // A changed port: where on its block's box (page coordinates) a line's end now meets it.
  function endAt(style, k, box) {
    if (!(k + 'X' in style) || !(k + 'Y' in style)) return null;
    return { x: box.x + Number(style[k + 'X']) * box.w, y: box.y + Number(style[k + 'Y']) * box.h, fx: Number(style[k + 'X']), fy: Number(style[k + 'Y']) };
  }
  // The edits a page implies, against the snapshot of what's drawn now. Only real differences make an edit,
  // so reading an unchanged export back gives none (nothing derived is written). Each change:
  //   { op, ... , text (a sentence for the list), ask (true: off until ticked, a deletion) }
  //   ops: review (the file is another review's), rename, nest, move, parts, power, grow, add-section, add-block,
  //   add-link, signal, dir, port, route, delete-block, delete-link, skip.
  function scribePlan(page, snap) {
    var cells = page.cells, all = page.order.map(function (k) { return cells[k]; }), out = [];
    var byId = {}, kind = {};
    snap.sections.forEach(function (s) { byId[s.id] = s; kind[s.id] = 'section'; });
    snap.blocks.forEach(function (b) { byId[b.id] = b; kind[b.id] = 'block'; });
    var title = function (id) { return byId[id] ? byId[id].title || 'Untitled' : 'a new block'; };
    var root = page.root || {};
    if (root.scribeReview && snap.review && root.scribeReview !== snap.review.id) out.push({ op: 'review', ask: true, text: 'This file was exported from ' + (root.scribeName || 'another review') + ', not this one. Its blocks will be matched by name only.' });
    var foreign = !!(root.scribeReview && snap.review && root.scribeReview !== snap.review.id);
    var isLabel = function (c) { return c.vertex && cells[c.parent] && cells[c.parent].edge; };
    var under = function (c, type) { var p = cells[c.parent]; while (p) { if (p.data.scribeType === type) return true; p = cells[p.parent]; } return false; };
    var isPower = function (c) { return c.data.scribeType === 'power'; };
    var isLegend = function (c) { return c.data.scribeType === 'legend' || under(c, 'legend'); };
    var hasKids = {};
    all.forEach(function (c) { if (c.vertex && !isLabel(c) && !isPower(c) && cells[c.parent]) hasKids[c.parent] = 1; });
    var isSection = function (c) { return c.data.scribeType === 'section' || c.style.container === '1' || 'swimlane' in c.style || (!!hasKids[c.id] && c.data.scribeType !== 'block'); };
    // The shapes that are blocks or sections: drawn boxes, not labels, rails, the legend, or bare text and pictures.
    var shapes = all.filter(function (c) {
      if (!c.vertex || !c.abs || isLabel(c) || isPower(c) || isLegend(c)) return false;
      if (c.data.scribeType === 'block' || c.data.scribeType === 'section') return true;
      if (c.style.text === '1' || c.style.shape === 'image' || c.style.edgeLabel === '1' || c.style.group === '1') return false;
      return !!firstLine(c) || isSection(c);
    });
    // Match: the first shape with a known id is that block (a copy pasted in draw.io keeps the id; it's new).
    // A file from another review matches by name.
    var idOf = {}, seen = {}, titleIdx = {};
    snap.sections.concat(snap.blocks).forEach(function (s) { titleIdx[String(s.title || '').toLowerCase()] = s.id; });
    shapes.forEach(function (c) {
      var s = c.data.scribeId;
      if (foreign) s = titleIdx[firstLine(c).toLowerCase()];
      if (s && byId[s] && !seen[s] && (kind[s] === 'section') === isSection(c)) { seen[s] = 1; idOf[c.id] = s; }
    });
    var keyOf = function (c) { return idOf[c.id] || 'new:' + c.id; };
    var secOf = function (c) {
      var p = cells[c.parent];
      while (p && p.vertex) { if (shapes.indexOf(p) >= 0 && isSection(p)) return keyOf(p); p = cells[p.parent]; }
      return '';
    };
    var moved = {}, newTitles = {};
    shapes.forEach(function (c) { if (!idOf[c.id]) newTitles[c.id] = firstLine(c) || (isSection(c) ? 'New section' : 'New block'); });
    shapes.forEach(function (c) {
      var s = idOf[c.id], t = firstLine(c), sec = isSection(c), parent = secOf(c);
      if (!s) {
        var nt = newTitles[c.id];
        out.push({ op: sec ? 'add-section' : 'add-block', key: 'new:' + c.id, title: nt, parent: parent,
          members: sec ? shapes.filter(function (k) { return secOf(k) === 'new:' + c.id; }).map(keyOf) : [],
          x: snapTo(c.abs.x), y: snapTo(c.abs.y), text: 'Add ' + (sec ? 'the section ' : 'the block ') + nt });
        return;
      }
      var x = byId[s];
      if (t && t !== (x.title || '')) out.push({ op: 'rename', id: s, from: x.title, to: t, text: 'Rename ' + (x.title || 'Untitled') + ' to ' + t });
      if (parent !== (x.parent || '')) out.push({ op: 'nest', id: s, to: parent, text: 'Move ' + (x.title || 'Untitled') + (parent ? ' into ' + (byId[parent] ? byId[parent].title : newTitles[parent.slice(4)] || 'a new section') : ' out of its section') });
      if (!sec) {
        // A block's size is Scribe's (160 × 60, grown by its ports): never read. Its place, only if it moved.
        if (!near(c.abs.x, x.x) || !near(c.abs.y, x.y)) { moved[s] = 1; out.push({ op: 'move', id: s, x: snapTo(c.abs.x), y: snapTo(c.abs.y), text: 'Move ' + (x.title || 'Untitled') + ' in the diagram' }); }
        if ('parts' in c.data && c.data.parts !== (x.parts || []).join(', ')) out.push({ op: 'parts', id: s, to: c.data.parts, text: 'Parts of ' + (x.title || 'Untitled') + ': ' + (c.data.parts || 'none') });
      } else {
        // A section's box is its blocks plus how far it was dragged bigger (grow): checked after the blocks.
        out.push({ op: '_box', id: s, box: c.abs });
      }
    });
    // Rails: each power picture belongs to the block it's a child of, or else the block whose top edge it sits on.
    var blockCells = shapes.filter(function (c) { return !isSection(c); });
    var rails = {}, railSeen = {};
    all.forEach(function (c) {
      if (!isPower(c) || isLegend(c) || !c.abs) return;
      var owner = cells[c.parent] && blockCells.indexOf(cells[c.parent]) >= 0 ? cells[c.parent] : null;
      if (!owner) owner = blockCells.filter(function (b) {
        var cx = c.abs.x + 8;
        return cx >= b.abs.x - 4 && cx <= b.abs.x + b.abs.w + 4 && c.abs.y + c.abs.h >= b.abs.y - 12 && c.abs.y <= b.abs.y + 8;
      })[0];
      var rail = plain(c.label, true).replace(/\s+/g, ' ').trim();
      if (!owner) { out.push({ op: 'skip', text: 'A rail picture (' + (rail || 'unnamed') + ') isn’t on a block, so it was left out' }); return; }
      if (c.data.sample === '1' && /^(source|sink)$/i.test(rail)) { out.push({ op: 'skip', text: 'A copied rail picture still says ' + rail + ': name it for its rail' }); return; }
      if (!rail) return;
      var k = keyOf(owner); rails[k] = rails[k] || [];
      if (railSeen[k + '|' + rail.toLowerCase()]) return;
      railSeen[k + '|' + rail.toLowerCase()] = 1;
      rails[k].push({ rail: rail, role: c.data.role === 'source' ? 'source' : 'sink', tree: c.data.tree !== '0', x: c.abs.x });
    });
    blockCells.forEach(function (c) {
      var k = keyOf(c), list = (rails[k] || []).sort(function (u, v) { return v.x - u.x; }).map(function (r) { return { rail: r.rail, role: r.role, tree: r.tree }; });
      var was = idOf[c.id] ? byId[idOf[c.id]].power || [] : [];
      // Order on the page doesn't count; the set of rails, roles, and tree flags does.
      var norm = function (a) { return a.map(function (r) { return r.rail.toLowerCase() + '|' + (r.role || 'sink') + '|' + (r.tree === false ? 0 : 1); }).sort().join(','); };
      if (norm(list) === norm(was)) return;
      // Keep the block's own order for rails it already had, then the new ones.
      // A rail it had keeps its other words (the power budget's numbers) as written.
      var used = [], ordered = was.map(function (r) {
        var q = list.filter(function (q2) { return q2.rail.toLowerCase() === r.rail.toLowerCase(); })[0];
        if (!q) return null;
        used.push(q); return r.label ? Object.assign({}, q, { label: r.label }) : q;
      }).filter(Boolean);
      list.forEach(function (q) { if (used.indexOf(q) < 0) ordered.push(q); });
      out.push({ op: 'power', id: idOf[c.id] || k, items: ordered, text: 'Power of ' + (idOf[c.id] ? title(idOf[c.id]) : newTitles[c.id]) + ': ' + (ordered.length ? powerText(ordered) : 'none') });
    });
    // Section boxes: the fit around the blocks (as drawn now, with moved blocks where they went) plus grow.
    var boxOps = out.filter(function (o) { return o.op === '_box'; });
    out = out.filter(function (o) { return o.op !== '_box'; });
    boxOps.forEach(function (o) {
      var s = byId[o.id], g = s.grow || { l: 0, t: 0, r: 0, b: 0 }, b = o.box;
      if (near(b.x, s.x) && near(b.y, s.y) && near(b.w, s.w) && near(b.h, s.h)) return;
      var fit = { x0: s.x + (g.l || 0), y0: s.y + (g.t || 0), x1: s.x + s.w - (g.r || 0), y1: s.y + s.h - (g.b || 0) };
      // With blocks moved, the fit moves with them: only a box drawn past the new fit grows.
      if (Object.keys(moved).length) return;
      var ng = { l: Math.max(0, snapTo(fit.x0 - b.x)), t: Math.max(0, snapTo(fit.y0 - b.y)), r: Math.max(0, snapTo(b.x + b.w - fit.x1)), b: Math.max(0, snapTo(b.y + b.h - fit.y1)) };
      if (['l', 't', 'r', 'b'].every(function (k) { return (g[k] || 0) === ng[k]; })) return;
      out.push({ op: 'grow', id: o.id, grow: ng, text: 'Resize the section ' + (s.title || 'Untitled') });
    });
    // Lines: one per pair of blocks and word, as Scribe draws them.
    var have = {}, used = {};
    snap.lines.forEach(function (L) { have[[L.a, L.b].sort().join('|') + '|' + String(L.word).toLowerCase()] = L; });
    var findLine = function (a, b) {
      var ks = Object.keys(have).filter(function (k) { return k.indexOf([a, b].sort().join('|') + '|') === 0; });
      return ks.length ? have[ks[0]] : null;
    };
    all.forEach(function (e) {
      if (!e.edge) return;
      var sc = cells[e.source], tc = cells[e.target];
      var a = sc && shapes.indexOf(sc) >= 0 && !isSection(sc) ? keyOf(sc) : '', b = tc && shapes.indexOf(tc) >= 0 && !isSection(tc) ? keyOf(tc) : '';
      if (!a || !b || a === b) { out.push({ op: 'skip', text: 'A line with an end that isn’t on a block was left out' }); return; }
      var kids = all.filter(function (k) { return k.vertex && k.parent === e.id; }).map(function (k) { return plain(k.label, true).trim(); }).filter(Boolean);
      var signal = [plain(e.label, e.style.html === '1').trim()].concat(kids).filter(Boolean).join(' / ').replace(/\s+/g, ' ');
      var s0 = e.style.startArrow && e.style.startArrow !== 'none', e0 = !('endArrow' in e.style) || e.style.endArrow !== 'none';
      var dir = s0 && e0 ? 'both' : s0 ? 'in' : 'out';
      var L = a.indexOf('new:') === 0 || b.indexOf('new:') === 0 ? null : findLine(a, b);
      if (!L || used[L.key]) {
        out.push({ op: 'add-link', from: a, to: b, signal: signal, dir: e0 || s0 ? dir : 'out',
          text: 'Connect ' + (byId[a] ? title(a) : newTitles[a.slice(4)]) + ' to ' + (byId[b] ? title(b) : newTitles[b.slice(4)]) + (signal ? ' (' + signal + ')' : '') });
        return;
      }
      used[L.key] = 1;
      var flip = L.a !== a, want = flip ? (dir === 'out' ? 'in' : dir === 'in' ? 'out' : dir) : dir;
      var name = title(L.a) + ' to ' + title(L.b);
      if (signal !== (L.signal || '')) out.push({ op: 'signal', line: L.key, a: L.a, b: L.b, word: L.word, to: signal, text: 'Signal of ' + name + ': ' + (signal || 'none') });
      if (want !== (L.dir || 'out')) out.push({ op: 'dir', line: L.key, a: L.a, b: L.b, word: L.word, to: want, text: 'Direction of ' + name + ': ' + (want === 'both' ? 'both ways' : want) });
      // Ports: where the ends meet their blocks, as fractions of each box. Only a change is written.
      var boxA = flip ? tc.abs : sc.abs, boxB = flip ? sc.abs : tc.abs, A = byId[L.a], B = byId[L.b];
      var qa = endAt(e.style, flip ? 'entry' : 'exit', boxA), qb = endAt(e.style, flip ? 'exit' : 'entry', boxB);
      var fa = function (q, r) { return { x: (q.x - r.x) / r.w, y: (q.y - r.y) / r.h }; };
      var was = { a: fa(L.pa, A), b: fa(L.pb, B) }, portMoved = false;
      [['a', qa, L.a, L.b], ['b', qb, L.b, L.a]].forEach(function (o) {
        if (!o[1] || (near(o[1].fx, was[o[0]].x, 0.01) && near(o[1].fy, was[o[0]].y, 0.01))) return;
        portMoved = true;
        out.push({ op: 'port', line: L.key, block: o[2], other: o[3], word: L.word, at: { x: o[1].x, y: o[1].y }, box: o[0] === 'a' ? boxA : boxB, text: 'Where ' + name + ' meets ' + title(o[2]) });
      });
      // A kept route goes when its line changed in draw.io, or either block moved there (draw.io keeps the
      // old waypoints and draws from them); Scribe routes it afresh.
      if (L.shaped) {
        var pts = e.geo ? e.geo.points : [], cs = L.corners || [];
        var same = pts.length === cs.length && pts.every(function (q, i) { return near(q.x, cs[i].x) && near(q.y, cs[i].y); });
        if (!same || portMoved || moved[L.a] || moved[L.b]) out.push({ op: 'route', line: L.key, a: L.a, b: L.b, word: L.word, text: 'Route ' + name + ' again (its shape from draw.io isn’t kept)' });
      }
    });
    snap.lines.forEach(function (L) {
      if (!used[L.key]) out.push({ op: 'delete-link', ask: true, line: L.key, a: L.a, b: L.b, word: L.word, text: 'Remove the connection ' + title(L.a) + ' to ' + title(L.b) + (L.signal ? ' (' + L.signal + ')' : '') + ': it’s not in the file' });
    });
    snap.sections.concat(snap.blocks).forEach(function (s) {
      if (!seen[s.id]) out.push({ op: 'delete-block', ask: true, id: s.id, text: 'Delete ' + (kind[s.id] === 'section' ? 'the section ' : 'the block ') + (s.title || 'Untitled') + ' and its text: it’s not in the file' });
    });
    return out;
  }

  window.SignoffDrawio = {
    FORMAT: FORMAT, esc: esc, styleText: styleText, parseStyle: parseStyle, cellXml: cellXml, modelXml: modelXml, fileXml: fileXml,
    compress: compress, decompress: decompress, svgWithFile: svgWithFile, read: read, plain: plain,
    scribePage: scribePage, scribePlan: scribePlan, powerText: powerText,
  };
})();
