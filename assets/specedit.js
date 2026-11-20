/* Signoff engine: Scribe's section editor (2026-11-19, Chris: "the markup stuff in the text becomes small badges";
   a toolbar inserts it, so nobody has to type it). Engine file: edit it only here, in Signoff EE; ME and FW copy it
   (tools/sync_engine.py).

   window.SignoffSpecEdit.mount(el, text, opts) turns a <div id="spec-editor"> into the editor and returns its api.
   The text is the model, exactly as the old textarea held it: every edit (typing, Enter, Backspace, paste, the
   toolbar) changes the text, and the lines it touched are drawn again. Opening a section and saving it unedited
   gives back the same text, byte for byte. On the screen:
     - a line's leading markup is a badge: "#" to "####" (H1 to H4, and a heading's " * kind"), list markers ("- ",
       "1. ", drawn as • or 1.1 by level), "> " (Gist), "Check:", and the link words ("Connects:", "Supplies:",
       "Uses:", "Parts:");
     - a mark, [words]{REQ-001} / {std} / {#Section}, is one badge: its words and a chip naming what it points at;
     - @req is a flag badge;
     - **bold**, *italic*, and ~~struck~~ words are drawn so, their markers kept as faint characters;
     - code fences and table lines stay as typed.
   A badge is one unit: Backspace takes it whole, and a click on it asks opts.onBadge what to do. Copy puts the
   text with its markup on the clipboard; paste takes plain text. Undo and Redo are the editor's own.
   The element gets a textarea-like face (value, selectionStart, selectionEnd, setSelectionRange), so the app's
   heading tools work on it as they did on the textarea, and it fires "input" after every change.

   opts: { model (Signoff.model), words() (the link words, e.g. ['Connects', 'Supplies']), markLabel(inner) ->
   { label, title, missing }, onBadge(info, el) } */
(function () {
  'use strict';

  var LIST = /^(\s*)([-*]|\d+[.)])(\s+)/;
  var TAG = /(^|[^\w@])(@req\b:?)/ig;
  var PH = '';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function indentLv(sp) { return Math.floor(sp.replace(/\t/g, '  ').length / 2); }

  // Where the bold, italic, and struck markers in a text are, by the model's own rule (Signoff.model.specRich):
  // [{ i, n, k, open }].
  function richMarks(text) {
    var out = [], st = { b: false, i: false, s: false };
    function closes(from, tok) {
      for (var j = from; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (tok === '*' && text.substr(j, 2) === '**') { j++; continue; }
        if (text.substr(j, tok.length) === tok && j > from && !/\s/.test(text[j - 1])) return true;
      }
      return false;
    }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\\' && (text[i + 1] === '*' || text[i + 1] === '~')) { i++; continue; }
      var two = text.substr(i, 2), k = two === '**' ? 'b' : two === '~~' ? 's' : ch === '*' ? 'i' : '';
      if (!k) continue;
      var tok = k === 'i' ? '*' : two, nx = text[i + tok.length] || '', pv = text[i - 1] || '';
      if (st[k] ? pv && !/\s/.test(pv) : nx && !/\s/.test(nx) && !(k === 'i' && /\w/.test(pv)) && closes(i + tok.length, tok)) {
        out.push({ i: i, n: tok.length, k: k, open: !st[k] }); st[k] = !st[k]; i += tok.length - 1;
      }
    }
    return out;
  }

  function mount(el, text, o) {
    var M = o.model;
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var atoms = [], shown = [];
    var undo = [], redo = [], lastKind = '', lastAt = 0, composing = false;

    el.setAttribute('contenteditable', 'true');
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    el.setAttribute('spellcheck', 'true');
    el.classList.add('se');

    function value() { return lines.join('\n'); }
    function lineStart(i) { var g = 0; for (var k = 0; k < i; k++) g += lines[k].length + 1; return g; }
    function pos(g) {
      for (var i = 0; i < lines.length; i++) { if (g <= lines[i].length) return { i: i, o: g }; g -= lines[i].length + 1; }
      return { i: lines.length - 1, o: lines[lines.length - 1].length };
    }

    // ── Drawing a line ──
    function badge(kind, raw, label, extra, title) {
      return '<span class="se-b se-' + kind + (extra || '') + '" contenteditable="false" data-raw="' + esc(raw) + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</span><span class="se-z">​</span>';
    }
    function prefixOf(raw, ctx) {
      var m;
      if ((m = /^(#{1,4})(\s+)/.exec(raw)) && M.specHeading(raw)) return { raw: m[0], kind: 'h', label: 'H' + m[1].length, cls: ' se-hb', line: 'se-h se-h' + m[1].length, title: 'Heading, level ' + m[1].length };
      var words = (o.words ? o.words() : []).concat(['Parts']);
      for (var w = 0; w < words.length; w++) {
        var re = new RegExp('^(\\s*)' + words[w].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s?', 'i');
        if ((m = re.exec(raw))) return { raw: m[0], kind: 'word', label: esc(words[w]), cls: ' se-wordb', line: 'se-links', title: words[w] === 'Parts' ? 'Parts: reference designators, separated by commas' : words[w] + ': blocks, separated by commas' };
      }
      if ((m = /^(\s*)>\s?/.exec(raw))) return { raw: m[0], kind: 'gist', label: 'Gist', cls: ' se-gistb', line: 'se-gist', title: 'The section’s one-line gist' };
      if ((m = LIST.exec(raw))) {
        var lv = Math.min(5, indentLv(m[1])), num = /\d/.test(m[2]);
        return { raw: m[0], kind: 'li', label: num ? esc(ctx.num || '1.') : '•', cls: num ? ' se-numb' : ' se-bulb', line: 'se-li se-lv' + lv, title: num ? 'Numbered line, ' + (lv ? 'level ' + (lv + 1) : 'top level') : 'Bullet' + (lv ? ', level ' + (lv + 1) : ''), lv: lv, num: num };
      }
      if ((m = /^(\s*)check:\s?/i.exec(raw))) return { raw: m[0], kind: 'check', label: 'Check', cls: ' se-checkb', line: 'se-check', title: 'A review note' };
      return null;
    }
    // The atoms (badges) of a line's rest: marks, @req flags, and a heading's kind.
    function restAtoms(rest, off, head) {
      var out = [];
      if (head) {
        var hk = M.specHeading('# ' + rest), km = hk && hk.kind ? /\s+([*·]\s*[a-z]+|\([a-z]+\))\s*$/i.exec(rest) : null;
        if (km) out.push({ s: off + km.index, e: off + rest.length, kind: 'kind', raw: rest.slice(km.index), label: esc(hk.kind) });
        return out;
      }
      M.specSpans(rest).forEach(function (m) {
        var L = o.markLabel ? o.markLabel(m.inner) : { label: m.inner };
        out.push({ s: off + m.index, e: off + m.end, kind: 'mark', raw: m.all, txt: m.txt, inner: m.inner, missing: !!L.missing, std: /^\s*std\s*$/i.test(m.inner),
          label: '<span class="se-words">' + esc(M.specRichPlain ? M.specRichPlain(m.txt) : m.txt) + '</span><span class="se-chip">' + esc(L.label) + '</span>', title: L.title || '' });
      });
      var code = [], cm, cre = /`[^`\n]*`/g;
      while ((cm = cre.exec(rest))) code.push([cm.index, cm.index + cm[0].length]);
      var tm; TAG.lastIndex = 0;
      while ((tm = TAG.exec(rest))) {
        var s = tm.index + tm[1].length, e = s + tm[2].length;
        if (code.some(function (c) { return s >= c[0] && s < c[1]; }) || out.some(function (a) { return s < a.e - off && e > a.s - off; })) continue;
        out.push({ s: off + s, e: off + e, kind: 'tag', raw: tm[2], label: '@req', title: 'Flagged to become a requirement' });
      }
      return out.sort(function (a, b) { return a.s - b.s; });
    }
    function lineHtml(i, ctx) {
      var raw = lines[i], cls = 'se-line', html = '', at = [];
      if (ctx.code) { atoms[i] = []; return { cls: 'se-line se-code' + (/^\s*```/.test(raw) ? ' se-fence' : ''), html: raw ? esc(raw) : '<br>' }; }
      if (/^\s*\|/.test(raw)) { atoms[i] = []; return { cls: 'se-line se-table', html: esc(raw) }; }
      var pre = prefixOf(raw, ctx), off = 0;
      if (pre) {
        cls += ' ' + pre.line; off = pre.raw.length;
        at.push({ s: 0, e: off, kind: 'prefix', pkind: pre.kind, raw: pre.raw, lv: pre.lv, num: pre.num });
        html += '<span class="se-z">​</span>' + badge('pre', pre.raw, pre.label, pre.cls, pre.title);
      }
      var rest = raw.slice(off), ra = restAtoms(rest, off, pre && pre.kind === 'h');
      at = at.concat(ra);
      // The rest, with each atom as one placeholder character, so bold may wrap a link.
      var flat = '', map = [], k = off;
      ra.forEach(function (a) { while (k < a.s) { flat += raw[k]; map.push(k); k++; } flat += PH; map.push(a); k = a.e; });
      while (k < raw.length) { flat += raw[k]; map.push(k); k++; }
      var marks = pre && pre.kind === 'h' ? [] : richMarks(flat), mi = 0, st = { b: false, i: false, s: false }, chunk = '';
      function flush() {
        if (!chunk) return;
        var h = esc(chunk);
        if (st.s) h = '<s>' + h + '</s>';
        if (st.i) h = '<em>' + h + '</em>';
        if (st.b) h = '<strong>' + h + '</strong>';
        html += h; chunk = '';
      }
      for (var j = 0; j < flat.length; j++) {
        if (mi < marks.length && marks[mi].i === j) {
          var mk = marks[mi++];
          flush();
          html += '<span class="se-mk">' + flat.substr(j, mk.n) + '</span>';
          st[mk.k] = mk.open; j += mk.n - 1; continue;
        }
        var m2 = map[j];
        if (typeof m2 === 'object') { flush(); html += badge(m2.kind === 'mark' ? 'mark' : m2.kind, m2.raw, m2.label, (m2.missing ? ' se-missing' : '') + (m2.std ? ' se-std' : ''), m2.title); continue; }
        chunk += flat[j];
      }
      flush();
      atoms[i] = at;
      return { cls: cls, html: html || '<br>' };
    }
    // Every line's drawing; only lines that changed are put in the page.
    function draw() {
      var fence = false, run = [], nums = {};
      // List numbers over each run of list lines (the model's rule).
      for (var i = 0; i <= lines.length; i++) {
        var m = i < lines.length && !fence && LIST.exec(lines[i]);
        if (i < lines.length && /^\s*```/.test(lines[i])) fence = !fence;
        if (m) { run.push({ i: i, lv: Math.min(5, indentLv(m[1])), num: /\d/.test(m[2]) }); continue; }
        if (i < lines.length && !fence && !lines[i].trim()) continue;   // a blank line doesn't end a list (as on the page)
        if (run.length) { var ns = M.specListNumbers(run); run.forEach(function (r, k) { nums[r.i] = ns[k]; }); run = []; }
      }
      fence = false;
      while (el.children.length > lines.length) el.removeChild(el.lastChild);
      for (var j = 0; j < lines.length; j++) {
        var isFence = /^\s*```/.test(lines[j]), h = lineHtml(j, { code: fence || isFence, num: nums[j] });
        if (isFence) fence = !fence;
        var key = h.cls + '|' + h.html, d = el.children[j];
        if (!d) { d = document.createElement('div'); el.appendChild(d); shown[j] = null; }
        if (shown[j] !== key || d.innerHTML !== h.html) { d.className = h.cls; d.innerHTML = h.html; shown[j] = key; }
      }
      shown.length = lines.length;
    }

    // ── The caret, as offsets in the text ──
    function lineOf(node) { while (node && node.parentNode !== el) node = node.parentNode; return node; }
    function rawLen(n) {
      if (n.nodeType === 3) return n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('se-z') ? 0 : n.nodeValue.replace(/​/g, '').length;
      if (n.nodeType !== 1) return 0;
      if (n.hasAttribute('data-raw')) return n.getAttribute('data-raw').length;
      var t = 0; for (var c = n.firstChild; c; c = c.nextSibling) t += rawLen(c); return t;
    }
    // A point in the page -> an offset in the text. Inside a badge it's before the badge (start) or after it.
    function toRaw(node, off, start) {
      if (node === el) { var ln = el.children[Math.min(off, el.children.length - 1)]; return off >= el.children.length ? value().length : lineStart(Array.prototype.indexOf.call(el.children, ln)); }
      var line = lineOf(node); if (!line) return 0;
      var li = Array.prototype.indexOf.call(el.children, line), count = 0, done = false;
      for (var b = node; b && b !== line; b = b.parentNode) if (b.nodeType === 1 && b.hasAttribute('data-raw')) { node = b.parentNode; off = Array.prototype.indexOf.call(node.childNodes, b) + (start ? 0 : 1); }
      (function walk(n) {
        for (var c = n.firstChild; c && !done; c = c.nextSibling) {
          if (n === node && Array.prototype.indexOf.call(n.childNodes, c) >= off) { done = true; return; }
          if (c === node) {
            if (c.nodeType === 3) { count += rawLen(c) ? c.nodeValue.slice(0, off).replace(/​/g, '').length : 0; done = true; return; }
            walk(c); if (!done) done = true; return;
          }
          if (c.nodeType === 1 && !c.hasAttribute('data-raw') && c.contains(node)) { walk(c); return; }
          count += rawLen(c);
        }
        if (n === node) done = true;
      })(line);
      return lineStart(li) + Math.min(count, lines[li].length);
    }
    function toDom(g) {
      var p = pos(g), line = el.children[p.i], left = p.o, hit = null;
      if (!line) return { node: el, off: 0 };
      (function walk(n) {
        for (var c = n.firstChild; c && !hit; c = c.nextSibling) {
          if (c.nodeType === 3) {
            var inZ = c.parentNode.classList && c.parentNode.classList.contains('se-z'), L = inZ ? 0 : c.nodeValue.length;
            if (!inZ && left <= L) { hit = { node: c, off: left }; return; }
            if (inZ && left === 0) { hit = { node: c, off: 1 }; return; }
            left -= L;
          } else if (c.nodeType === 1) {
            if (c.hasAttribute('data-raw')) { var R = c.getAttribute('data-raw').length; if (left < R) { hit = { node: n, off: Array.prototype.indexOf.call(n.childNodes, c) + 1 }; return; } left -= R; }
            else if (c.localName === 'br') continue;
            else walk(c);
          }
        }
      })(line);
      return hit || { node: line, off: line.childNodes.length && line.lastChild.localName === 'br' ? 0 : line.childNodes.length };
    }
    function getSel() {
      var s = getSelection();
      if (!s.rangeCount || !el.contains(s.anchorNode)) return null;
      var r = s.getRangeAt(0), a = toRaw(r.startContainer, r.startOffset, true), b = r.collapsed ? a : toRaw(r.endContainer, r.endOffset, false);
      return { a: Math.min(a, b), b: Math.max(a, b) };
    }
    function setSel(a, b) {
      var s = getSelection(), r = document.createRange(), A = toDom(a), B = b == null || b === a ? A : toDom(b);
      try { r.setStart(A.node, A.off); r.setEnd(B.node, B.off); } catch (e) { return; }
      s.removeAllRanges(); s.addRange(r);
      var ln = el.children[pos(b == null ? a : b).i];
      if (ln && document.activeElement === el) {
        var rr = ln.getBoundingClientRect(), box = el.getBoundingClientRect();
        if (el.scrollHeight > el.clientHeight + 2 && (rr.top < box.top || rr.bottom > box.bottom)) ln.scrollIntoView({ block: 'nearest' });
        else if (rr.bottom > innerHeight || rr.top < 0) ln.scrollIntoView({ block: 'nearest' });
      }
    }
    var cached = { a: 0, b: 0 };
    function sel() { var s = getSel(); if (s) cached = s; return cached; }

    // ── Changing the text ──
    function snapshot() { var s = sel(); return { text: value(), a: s.a, b: s.b }; }
    function record(kind) {
      var now = Date.now();
      if (kind && kind === lastKind && now - lastAt < 800) { lastAt = now; return; }
      undo.push(snapshot()); if (undo.length > 300) undo.shift(); redo = []; lastKind = kind || ''; lastAt = now;
    }
    function setText(t, a, b) {
      lines = String(t).split('\n');
      draw();
      if (a != null) {
        cached = { a: a, b: b == null ? a : b };
        // Move the page's caret too when it's in here, focused or not (a stale one would be read back).
        var ps = getSelection();
        if (document.activeElement === el || (ps.rangeCount && el.contains(ps.anchorNode))) setSel(a, b);
      }
    }
    function changed() { el.dispatchEvent(new Event('input', { bubbles: true })); }
    function replace(a, b, ins, caret, kind) {
      record(kind);
      var t = value();
      setText(t.slice(0, a) + ins + t.slice(b), caret == null ? a + ins.length : caret);
      changed();
    }
    // A range grown to cover every badge it touches.
    function grow(a, b) {
      var A = pos(a), B = pos(b);
      (atoms[A.i] || []).forEach(function (x) { if (A.o > x.s && A.o < x.e) a = lineStart(A.i) + x.s; });
      (atoms[B.i] || []).forEach(function (x) { if (B.o > x.s && B.o < x.e) b = lineStart(B.i) + x.e; });
      return { a: a, b: b };
    }
    function delBack(a, b) {
      if (a !== b) { var r = grow(a, b); replace(r.a, r.b, ''); return; }
      var p = pos(a);
      if (p.o === 0) { if (p.i > 0) replace(a - 1, a, ''); return; }
      var at = (atoms[p.i] || []).filter(function (x) { return x.e === p.o || (x.s < p.o && p.o < x.e); })[0];
      if (at) {
        // A list marker goes, its indent first: Backspace outdents, then makes a paragraph.
        if (at.kind === 'prefix' && at.pkind === 'li' && at.lv > 0) { var ls = lineStart(p.i), sp = /^\s*/.exec(lines[p.i])[0]; replace(ls, ls + Math.min(2, sp.length), '', a - Math.min(2, sp.length)); return; }
        replace(lineStart(p.i) + at.s, lineStart(p.i) + at.e, '', null, 'del'); return;
      }
      var t = value(), n = /[\udc00-\udfff]/.test(t[a - 1]) && a > 1 ? 2 : 1;
      replace(a - n, a, '', null, 'del');
    }
    function delFwd(a, b) {
      if (a !== b) { var r = grow(a, b); replace(r.a, r.b, ''); return; }
      var p = pos(a);
      if (p.o === lines[p.i].length) { if (p.i < lines.length - 1) replace(a, a + 1, ''); return; }
      var at = (atoms[p.i] || []).filter(function (x) { return x.s === p.o; })[0];
      if (at) { replace(lineStart(p.i) + at.s, lineStart(p.i) + at.e, '', null, 'del'); return; }
      var t = value(), n = /[\ud800-\udbff]/.test(t[a]) ? 2 : 1;
      replace(a, a + n, '', null, 'del');
    }
    function enter(a, b) {
      var r = grow(a, b), t = value();
      t = t.slice(0, r.a) + t.slice(r.b);
      var p = (function (g) { var L = t.split('\n'), i = 0; for (; i < L.length; i++) { if (g <= L[i].length) return { i: i, o: g, L: L }; g -= L[i].length + 1; } return { i: L.length - 1, o: 0, L: L }; })(r.a);
      var line = p.L[p.i], m = LIST.exec(line);
      record();
      if (m && p.o >= m[0].length) {
        if (!line.slice(m[0].length).trim()) {   // Enter on an empty list line ends the list
          var ls = r.a - p.o;
          setText(t.slice(0, ls) + t.slice(ls + line.length), ls); changed(); return;
        }
        var pre = '\n' + m[1] + (/\d/.test(m[2]) ? '1.' : m[2]) + ' ';
        setText(t.slice(0, r.a) + pre + t.slice(r.a), r.a + pre.length); changed(); return;
      }
      setText(t.slice(0, r.a) + '\n' + t.slice(r.a), r.a + 1); changed();
    }
    function rangeFrom(e) {
      var rs = e.getTargetRanges ? e.getTargetRanges() : [];
      if (!rs.length) return null;
      return { a: toRaw(rs[0].startContainer, rs[0].startOffset, true), b: toRaw(rs[0].endContainer, rs[0].endOffset, false) };
    }

    // ── Line tools ──
    function selLines() { var s = sel(); return { from: pos(s.a).i, to: pos(s.b).i, s: s }; }
    // Rewrite lines from..to with fn(line, i) -> new line, keeping the selection on the same text.
    function mapLines(fn, from, to) {
      var s = sel(), L = lines.slice(), A = pos(s.a), B = pos(s.b);
      record();
      for (var i = from; i <= to; i++) {
        var old = L[i], nw = fn(old, i), d = nw.length - old.length;
        L[i] = nw;
        if (A.i === i) A.o = Math.max(0, A.o + d); if (B.i === i) B.o = Math.max(0, B.o + d);
      }
      lines = L;
      var ga = lineStart(A.i) + Math.min(A.o, L[A.i].length), gb = lineStart(B.i) + Math.min(B.o, L[B.i].length);
      setText(value(), ga, gb); changed();
    }
    function bare(line) {   // a line without its list marker or gist and check prefixes
      var m = LIST.exec(line); if (m) return line.slice(m[0].length);
      return line.replace(/^\s*>\s?/, '').replace(/^\s*check:\s?/i, '');
    }
    function setList(kind) {   // 'b' bullets, 'n' numbered: off when every line already is
      var r = selLines(), all = true;
      for (var i = r.from; i <= r.to; i++) { var m = LIST.exec(lines[i]); if (!m || /\d/.test(m[2]) !== (kind === 'n')) all = false; }
      mapLines(function (l) {
        if (M.specHeading(l)) return l;
        var m = LIST.exec(l), ind = m ? m[1] : '';
        if (all) return ind + bare(l);
        return ind + (kind === 'n' ? '1. ' : '- ') + bare(l);
      }, r.from, r.to);
    }
    function shift(by, listsOnly) {
      var r = selLines(), any = false;
      for (var i = r.from; i <= r.to; i++) if (LIST.exec(lines[i])) any = true;
      if (listsOnly && !any) return false;
      mapLines(function (l) {
        if (!LIST.exec(l)) return l;
        var sp = /^\s*/.exec(l)[0], lv = indentLv(sp) + by;
        return lv < 0 ? l : new Array(Math.min(5, lv) + 1).join('  ') + l.slice(sp.length);
      }, r.from, r.to);
      return true;
    }
    function setPrefix(pre) {   // '> ' gist, 'Check: ', '' plain; toggles
      var r = selLines(), on = true;
      for (var i = r.from; i <= r.to; i++) if (lines[i].indexOf(pre) !== 0 && !(pre === 'Check: ' && /^check:/i.test(lines[i]))) on = false;
      mapLines(function (l) { if (M.specHeading(l)) return l; var b = bare(l).replace(/^\s+/, ''); return on ? b : pre + b; }, r.from, r.to);
    }
    function setHeading(level) {
      var r = selLines();
      mapLines(function (l) {
        var h = /^#{1,4}\s+/.exec(l), body = h ? l.slice(h[0].length) : bare(l).replace(/^\s+/, '');
        return level ? new Array(level + 1).join('#') + ' ' + body : body;
      }, r.from, r.to);
    }
    // Bold, italic, strikethrough: wrap the selection, or unwrap it when the markers sit right around it.
    // Where a line's own text starts: after its leading badge (a list marker, a heading's #, Gist, Check, …).
    function textStart(i) { var pre = (atoms[i] || []).filter(function (x) { return x.kind === 'prefix'; })[0]; return lineStart(i) + (pre ? pre.e : 0); }
    function toggleWrap(tok) {
      var s = sel(), t = value(), a = s.a, b = s.b, A = pos(a), B = pos(b);
      if (A.i !== B.i) {   // over several lines: each line's selected text on its own (markers don't cross lines)
        var segs = [];
        for (var li = A.i; li <= B.i; li++) {
          var x = Math.max(li === A.i ? a : 0, textStart(li)), y = li === B.i ? b : lineStart(li) + lines[li].length;
          while (x < y && /\s/.test(t[x])) x++;
          while (y > x && /\s/.test(t[y - 1])) y--;
          if (y > x) segs.push([x, y]);
        }
        if (!segs.length) return;
        record();
        var out = t, shiftBy = 0;
        segs.forEach(function (g) { out = out.slice(0, g[0] + shiftBy) + tok + out.slice(g[0] + shiftBy, g[1] + shiftBy) + tok + out.slice(g[1] + shiftBy); shiftBy += 2 * tok.length; });
        setText(out, segs[0][0] + tok.length, segs[segs.length - 1][1] + shiftBy - tok.length); changed(); return;
      }
      if (a < textStart(A.i)) a = textStart(A.i);
      if (b < a) b = a;
      var r0 = grow(a, b); a = r0.a; b = r0.b;
      if (t.slice(a - tok.length, a) === tok && t.slice(b, b + tok.length) === tok && !(tok === '*' && (t[a - 2] === '*' || t[b + 1] === '*'))) {
        record(); setText(t.slice(0, a - tok.length) + t.slice(a, b) + t.slice(b + tok.length), a - tok.length, b - tok.length); changed(); return;
      }
      if (t.slice(a, a + tok.length) === tok && t.slice(b - tok.length, b) === tok && b - a > 2 * tok.length) {
        record(); setText(t.slice(0, a) + t.slice(a + tok.length, b - tok.length) + t.slice(b), a, b - 2 * tok.length); changed(); return;
      }
      // Leave spaces outside the markers, or they don't count.
      while (a < b && /\s/.test(t[a])) a++;
      while (b > a && /\s/.test(t[b - 1])) b--;
      record();
      setText(t.slice(0, a) + tok + t.slice(a, b) + tok + t.slice(b), a + tok.length, b + tok.length); changed();
    }
    // Wrap the selected words in a mark ({inner}); with nothing selected, insert [words]{inner}.
    function wrapMark(inner, words) {
      var s = sel(), t = value(), a = s.a, b = s.b;
      if (a === b) { var ins = '[' + (words || inner) + ']{' + inner + '}'; replace(a, a, ins); return true; }
      if (pos(a).i !== pos(b).i) return false;
      if (a < textStart(pos(a).i)) a = textStart(pos(a).i);
      if ((atoms[pos(a).i] || []).some(function (x) { var ls = lineStart(pos(a).i); return x.kind === 'mark' && a < ls + x.e && b > ls + x.s; })) return false;
      while (a < b && /\s/.test(t[a])) a++;
      while (b > a && /[\s.,;:!?]/.test(t[b - 1])) b--;
      if (a === b) return false;
      replace(a, b, '[' + t.slice(a, b) + ']{' + inner + '}');
      return true;
    }
    function insertAtCaret(str, spaced) {
      var s = sel(), t = value(), a = s.b;
      var before = spaced && a > 0 && !/\s/.test(t[a - 1]) ? ' ' : '';
      replace(a, a, before + str);
    }

    // ── Events ──
    el.addEventListener('beforeinput', function (e) {
      var t = e.inputType;
      if (/^insertComposition|^deleteComposition/.test(t)) return;
      if (t === 'insertFromPaste' || t === 'deleteByCut') return;   // the paste and cut events do these
      e.preventDefault();
      var s = sel(), r;
      switch (t) {
        case 'insertText': if (e.data != null) { var g = grow(s.a, s.b); replace(g.a, g.b, e.data.replace(/ /g, ' '), null, 'type'); } break;
        case 'insertReplacementText': {
          r = rangeFrom(e) || s;
          var d = e.dataTransfer ? e.dataTransfer.getData('text/plain') : e.data;
          if (d != null) replace(r.a, r.b, d);
          break;
        }
        case 'insertParagraph': case 'insertLineBreak': enter(s.a, s.b); break;
        case 'deleteContentBackward': delBack(s.a, s.b); break;
        case 'deleteContentForward': delFwd(s.a, s.b); break;
        case 'historyUndo': step(undo, redo); break;
        case 'historyRedo': step(redo, undo); break;
        case 'formatBold': toggleWrap('**'); break;
        case 'formatItalic': toggleWrap('*'); break;
        case 'formatStrikeThrough': toggleWrap('~~'); break;
        default:
          if (/^delete/.test(t)) {
            r = rangeFrom(e);
            if (r && r.a !== r.b) { var gr = grow(Math.min(r.a, r.b), Math.max(r.a, r.b)); replace(gr.a, gr.b, ''); }
            else if (/Backward/.test(t)) delBack(s.a, s.b); else delFwd(s.a, s.b);
          }
      }
    });
    el.addEventListener('compositionstart', function () { composing = true; record(); });
    el.addEventListener('compositionend', function () {
      composing = false;
      // The browser typed into the page: read those lines back, then draw them as text again.
      var s = getSelection(), line = s.rangeCount ? lineOf(s.anchorNode) : null, li = line ? Array.prototype.indexOf.call(el.children, line) : -1;
      if (li < 0) { draw(); return; }
      var off = s.rangeCount ? (function () { var g = toRaw(s.anchorNode, s.anchorOffset, false); return g - lineStart(li); })() : 0;
      lines[li] = (function ser(n) {
        var out = '';
        for (var c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) out += c.parentNode.classList && c.parentNode.classList.contains('se-z') ? c.nodeValue.replace(/​/g, '') : c.nodeValue.replace(/​/g, '').replace(/ /g, ' ');
          else if (c.nodeType === 1) out += c.hasAttribute('data-raw') ? c.getAttribute('data-raw') : c.localName === 'br' ? '' : ser(c);
        }
        return out;
      })(line).replace(/\n/g, ' ');
      shown[li] = null;
      setText(value(), lineStart(li) + Math.min(off, lines[li].length)); changed();
    });
    el.addEventListener('copy', function (e) { var s = sel(); if (s.a === s.b) return; e.preventDefault(); var g = grow(s.a, s.b); e.clipboardData.setData('text/plain', value().slice(g.a, g.b)); });
    el.addEventListener('cut', function (e) { var s = sel(); e.preventDefault(); if (s.a === s.b) return; var g = grow(s.a, s.b); e.clipboardData.setData('text/plain', value().slice(g.a, g.b)); replace(g.a, g.b, ''); });
    el.addEventListener('paste', function (e) {
      e.preventDefault(); e.stopPropagation();
      var d = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!d) return;
      var s = sel(), g = grow(s.a, s.b);
      replace(g.a, g.b, d.replace(/\r\n?/g, '\n').replace(/ /g, ' '));
    });
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
    el.addEventListener('drop', function (e) { e.preventDefault(); });
    el.addEventListener('keydown', function (e) {
      if (composing || e.isComposing) return;
      var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && !e.altKey && k === 'z') { e.preventDefault(); if (e.shiftKey) step(redo, undo); else step(undo, redo); return; }
      if (mod && !e.altKey && k === 'y') { e.preventDefault(); step(redo, undo); return; }
      if (mod && !e.shiftKey && !e.altKey && (k === 'b' || k === 'i')) { e.preventDefault(); toggleWrap(k === 'b' ? '**' : '*'); return; }
      if (mod && e.shiftKey && k === 'x') { e.preventDefault(); toggleWrap('~~'); return; }
      if (mod && e.shiftKey && (e.code === 'Digit8' || e.code === 'Digit7')) { e.preventDefault(); setList(e.code === 'Digit8' ? 'b' : 'n'); return; }
      if (e.key === 'Tab' && !mod && !e.altKey) { if (shift(e.shiftKey ? -1 : 1, true)) e.preventDefault(); return; }
      if (e.key === 'Enter' && !mod) { e.preventDefault(); var s = sel(); enter(s.a, s.b); }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.se-b');
      if (!b || !el.contains(b) || !o.onBadge) return;
      var line = lineOf(b), li = Array.prototype.indexOf.call(el.children, line), g = toRaw(b.parentNode, Array.prototype.indexOf.call(b.parentNode.childNodes, b), true) - lineStart(li);
      var at = (atoms[li] || []).filter(function (x) { return x.s === g; })[0];
      if (!at) return;
      e.stopPropagation();   // the page's own click handling would close the menu this opens
      setSel(lineStart(li) + at.e);
      o.onBadge({ kind: at.kind === 'prefix' ? at.pkind : at.kind, raw: at.raw, txt: at.txt, inner: at.inner, a: lineStart(li) + at.s, b: lineStart(li) + at.e }, b);
    });
    document.addEventListener('selectionchange', function () { if (document.activeElement === el) sel(); });

    function step(from, to) {
      if (!from.length) return;
      to.push(snapshot());
      var x = from.pop(); lastKind = '';
      setText(x.text, x.a, x.b); changed();
    }

    // The textarea face.
    Object.defineProperty(el, 'value', { configurable: true, get: value, set: function (v) { record(); setText(String(v).replace(/\r\n?/g, '\n')); } });
    Object.defineProperty(el, 'selectionStart', { configurable: true, get: function () { return sel().a; } });
    Object.defineProperty(el, 'selectionEnd', { configurable: true, get: function () { return sel().b; } });
    el.setSelectionRange = function (a, b) { cached = { a: a, b: b == null ? a : b }; setSel(a, b); };

    draw();
    var api = {
      el: el, value: value,
      selection: function () { return sel(); },
      selectedText: function () { var s = sel(); return value().slice(s.a, s.b); },
      replace: function (a, b, ins) { replace(a, b, ins); },
      toggleWrap: toggleWrap, setList: setList, shift: shift, setPrefix: setPrefix, setHeading: setHeading,
      wrapMark: wrapMark, insert: insertAtCaret,
      lineAt: function () { return pos(sel().a).i; },
      line: function (i) { return lines[i]; },
      lineStart: lineStart,
      // The marks a selection is in (for the toolbar's lights).
      state: function () {
        var s = sel(), p = pos(s.a), l = lines[p.i] || '', m = LIST.exec(l), on = { b: false, i: false, s: false };
        richMarks(l).forEach(function (x) { if (x.i < p.o) on[x.k] = x.open; });
        return { list: m ? (/\d/.test(m[2]) ? 'n' : 'b') : '', heading: (/^(#{1,4})\s/.exec(l) || [, ''])[1].length, gist: /^\s*>/.test(l), check: /^\s*check:/i.test(l), bold: on.b, italic: on.i, strike: on.s };
      }
    };
    return api;
  }

  window.SignoffSpecEdit = { mount: mount, richMarks: richMarks };
})();
