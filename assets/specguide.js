/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* The Description guide: a walk through the Description tab (a written description tied to the
   requirements, and its diagram) on the demo review named by config.spec.guide, for anyone new to it.
   Signoff FW sets it (the thermostat firmware); a tool without it shows no Guide button.

   Modeled on Loom's guide (loom/assets/guide.js): a card carries each step (what the feature is and a
   Try it), steps are grouped in chapters, Contents jumps anywhere, and the card drags by its top line.
   Entering a step sets the page up (setup, through Signoff.app.spec, since the page is redrawn with
   innerHTML) and rings what it's about (spot), redrawn every frame. It runs only in the demo: started
   from a real review it reopens this page with ?demo&project=<id>&guide. Start offers to rebuild the
   demo review when the visitor has changed it, so the steps find what they describe; it never does so
   unasked. State: sessionStorage signoff.specGuide ({ step, x, y, mine, contents }). */
(function (S) {
  'use strict';
  var KEY = 'signoff.specGuide';
  var DEMO = /[?&]demo\b/.test(location.search);
  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function A() { return (S.app && S.app.spec) || null; }

  // ── Finding things on the page ──
  // Elements matching a selector whose text contains `text` (the first one shown wins in the spot).
  function withText(sel, text) {
    var want = String(text).toLowerCase();
    return Array.prototype.filter.call(document.querySelectorAll(sel), function (el) { return el.textContent.toLowerCase().indexOf(want) >= 0; });
  }
  function sentence(text) { return withText('#page .su', text)[0] || null; }
  function needs(title) { return withText('#page .spec-needs-card', title)[0] || null; }
  function field(label) { return withText('#inspector .field', label).filter(function (f) { var l = f.querySelector('.field-label, label'); return l && l.textContent.indexOf(label) === 0; })[0] || null; }
  function node(title) {
    return Array.prototype.filter.call(document.querySelectorAll('#page .spec-node:not(.ghost)'), function (g) { var t = g.querySelector('.spec-node-title'); return t && t.textContent === title; })[0] || null;
  }
  function handle(title) { var n = node(title); return n ? n.querySelector('.spec-handle') : null; }
  function secEl(title) { var a = A(), s = a && a.section(title); return s ? document.getElementById('spec-' + s.id) : null; }
  // The block the visitor added (Add a block), else a demo block the step falls back to.
  function mine() { var a = A(), s = a && a.newest(); return s ? s.title : ''; }
  function mineOr(fallback) { return mine() || fallback; }

  var CHAPTERS = [
    { title: 'Welcome', steps: [
      { title: 'The Description tab',
        text: 'A requirements list says what must be true; it rarely reads as what the firmware does. This tab is the other half: a written description of the firmware, from the product down to the drivers, tied sentence by sentence to the requirements. The same text draws a diagram, and the diagram can build the text.',
        do: 'This guide uses the demo thermostat firmware, so nothing real changes. Each step sets the page up and rings what it’s about. Use {Next} and {Back}, or {Contents} to jump around.',
        setup: function () { A().open('doc', 3); },
        spot: function () { return ['#view-seg [data-view="spec"]']; } },
      { title: 'Reading at any depth',
        text: 'Headings make the outline, down to four levels. The outline at the left jumps to any section. {Headings} shows just the structure, {Gists} adds each section’s one-line summary, and {Full text} shows everything.',
        do: 'Click {Gists}, then {Headings}, then {Full text}. Click {Control loop} in the outline to jump to it.',
        setup: function () { A().open('doc', 3); },
        spot: function () { return [['[data-act="spec-depth"][data-depth="1"]', '[data-act="spec-depth"][data-depth="3"]'], '.spec-outline']; } }
    ] },
    { title: 'Tied to requirements', steps: [
      { title: 'Four kinds of sentence',
        text: 'Every sentence is one of four kinds, told apart by line style, not color. Linked words have a thin outline and point at requirements. Standard text is greyed: background that needs no requirement. Flagged sentences have a dashed outline and an @req tag. Untraced ones have a dotted underline until you link, flag, or mark them.',
        do: 'Hover over the outlined words “Schedules and setpoints are kept through a power cut” to see the requirement they point at.',
        setup: function () { A().open('doc', 3); var m = $('#main'); if (m) m.scrollTop = 0; },
        spot: function () { return [sentence('Schedules and setpoints'), '.spec-doc']; } },
      { title: 'The sentence panel',
        text: 'Click any sentence to open its panel: its kind, the requirements it links to, a search to link more, and buttons to {Make requirement}, {Mark standard}, or {Flag @req}.',
        do: 'The hysteresis sentence is open; it’s untraced. Click {Make requirement}: it becomes a draft requirement, and the sentence now links to it.',
        setup: function () { A().open('doc', 3); A().unit('hysteresis') || A().unit('control loop runs'); },
        spot: function () { return ['#inspector [data-act="spec-make"]', '#inspector .insp-body']; } },
      { title: 'Linking just a phrase',
        text: 'A link can cover a few words instead of a whole sentence. Select the words; the panel opens saying {Linking just…}, and the next requirement you pick links only those. {Whole sentence} goes back.',
        do: 'In Sensor driver, select the words “counts as a sensor fault”. In the panel, search REQ-003 and pick it: a sensor fault has to turn the relays off.',
        setup: function () { A().open('doc', 3); A().unit('sensor fault', false); },
        spot: function () { return ['#inspector .spec-phrase', sentence('sensor fault')]; } },
      { title: 'To requirementify',
        text: 'New behavior often turns up in a meeting first. Type it where it belongs and add @req: it waits here until it becomes a requirement. {New requirement} makes a draft from it. When its section already links a requirement, {Change REQ-…} links that one instead and marks it Changed, which is what most meeting notes are.',
        do: 'Click {New requirement} on the LED note. The bootloader note offers {Change REQ-001}. If the list is empty, open any sentence and click {Flag @req} to put one here.',
        setup: function () { A().open('doc', 3); var m = $('#main'); if (m) m.scrollTop = 0; },
        spot: function () { return [needs('To requirementify'), '.spec-needs', '#page .page-sub']; } },
      { title: 'Not described',
        text: 'The other direction: requirements no sentence describes. {Describe in…} adds the requirement’s text to a section you pick, as a linked sentence, ready to rewrite in your own words.',
        do: 'Click {Describe in…} beside REQ-005 and pick Cloud link. If nothing is listed, every requirement is already described somewhere.',
        setup: function () { A().open('doc', 3); var m = $('#main'); if (m) m.scrollTop = 0; },
        spot: function () { return [needs('Not described'), '.spec-needs', '#page .page-sub']; } },
      { title: 'From the requirement’s side',
        text: 'A requirement’s panel in the Requirements tab now has {Described in}: every sentence that links to it, with its section. Click one to jump back into the description.',
        do: 'This is REQ-001. Click a row under {Described in}.',
        setup: function () { A().open('doc', 3); A().req('REQ-001') || A().req('REQ-003'); },
        spot: function () { return [field('Described in'), '#inspector']; } }
    ] },
    { title: 'Writing', steps: [
      { title: 'Editing a section',
        text: 'The pencil beside a heading edits that section as text. Links show as requirement numbers, {[words]{REQ-006}}, and are stored by id, so renumbering a requirement never breaks them. Typing a new heading inside makes a new section right after it.',
        do: 'Rewrite the blink sentence to say the LED pulses, then press {k:Ctrl+Enter} to save. {k:Esc} cancels. {Writing guide}, at the bottom left, lists every mark.',
        setup: function () { A().open('doc', 3); var s = A().section('Status LED') || A().section('Wi-Fi driver'); if (s) A().edit(s.id); },
        spot: function () { return ['#spec-editor']; } },
      { title: 'Heading kinds',
        text: 'A heading’s kind places it in the diagram’s layers: product, task, module, driver, hardware, or interface. The {Heading kind} bar shows the kind of the heading the cursor is under and sets it with a click. Typed, a kind follows an asterisk, {## Control loop * task}, or sits in brackets, {(task)}.',
        do: 'With the cursor in the text, click {Module}, then {Driver} to put it back. Press {k:Esc} when you’re done.',
        setup: function () { A().open('doc', 3); var s = A().section('Status LED') || A().section('Wi-Fi driver'); if (s) A().edit(s.id); },
        spot: function () { return ['.spec-kindbar']; } },
      { title: 'What Uses does',
        text: 'A {Uses:} line names the sections this one relies on, by heading. It shows as chips under the section, and it draws the diagram’s solid lines: Touch UI uses its drivers. Rename a heading and every Uses line that names it follows.',
        do: 'Click {Add to Uses…} and pick Sensor driver (the UI shows the room temperature), then press {k:Ctrl+Enter}.',
        setup: function () { A().open('doc', 3); var s = A().section('Touch UI') || A().section('Control loop'); if (s) A().edit(s.id); },
        spot: function () { return ['.spec-kindbar [data-act="spec-uses-add"]', '#spec-editor']; } },
      { title: 'Edit all',
        text: '{Edit all} opens the whole description as one text, with its outline read live beside it. Saving keeps each section’s identity, so renaming, moving, or adding headings never breaks a link to them. Taking a heading out asks before it deletes that section.',
        do: 'Rename {### Wi-Fi driver * driver} to {### Wi-Fi stack * driver} and save. Cloud link’s Uses line follows the new name.',
        setup: function () { A().open('doc', 3); A().editAll(); },
        spot: function () { return ['#spec-live-outline', '#spec-editor']; } }
    ] },
    { title: 'The diagram', steps: [
      { title: 'The diagram',
        text: 'The same description, drawn in layers from the product to the hardware. Solid lines come from Uses lines; dotted ones hang a block from the section above it in the outline; dashed lines are interfaces. Dotted blocks have untraced or flagged sentences, with the count under the name.',
        do: 'Hover a block to read its gist.',
        setup: function () { A().open('map'); },
        spot: function () { return ['.spec-map-card']; } },
      { title: 'Add a block',
        text: 'The {+} beside each layer adds a block, which is a new section in the text, placed with the others of its kind. {Used by} adds it to that block’s Uses line, so it arrives connected.',
        do: 'Click {+} beside Modules. Name it Scheduler, give it the gist “Changes the setpoint on schedule”, pick Control loop under {Used by}, and click {Add}.',
        setup: function () { A().open('map'); },
        spot: function () { return ['#sheet .sheet', '.spec-row-add[data-kind="module"]']; } },
      { title: 'Write it up, then its requirement',
        text: 'A block is a section: what you draw, you then describe. A gist alone isn’t traced, so a new block’s behavior starts as text, and the text then gets its requirement.',
        do: 'Click {Edit its text}, add a sentence such as “The scheduler changes the setpoint at each scheduled time.”, and press {k:Ctrl+Enter}. Then click that sentence and {Make requirement}. (No new block? Use Status LED.)',
        setup: function () { var a = A(); a.open('map'); var s = a.section(mineOr('Status LED')); if (s) a.block(s.id); },
        spot: function () { return ['#spec-editor', '#inspector [data-act="spec-make"]', '#inspector [data-act="spec-edit"]']; } },
      { title: 'Connect blocks',
        text: 'Each block has a dot on its bottom edge. Drag from it to another block, in any layer, and the first block now uses the second; its Uses line gains the name. Click a solid line to remove that link.',
        do: 'Drag from the dot under Cloud link to your Scheduler (or to Status LED): Cloud link hands it new schedules. Then click the new line and remove it if you like.',
        phone: 'On a touch screen the dots always show; drag from one to another block.',
        setup: function () { A().open('map'); },
        spot: function () { return [handle('Cloud link'), node('Cloud link')]; } },
      { title: 'Move blocks',
        text: 'Drag a block itself to another layer to change its kind, or beside other blocks to move its section there in the outline, taking the sections under it along. A bar shows where it will land.',
        do: 'Drag Scheduler (or Status LED) up into Tasks, beside Control loop, then drag it back down.',
        phone: 'On a touch screen, change a block’s layer with {Kind} in its panel instead.',
        setup: function () { A().open('map'); },
        spot: function () { return [node(mineOr('Status LED')), node('Status LED')]; } },
      { title: 'The block panel',
        text: 'Click a block for its panel: its name (a rename follows into every Uses line), kind, gist, what it uses (add from the list, remove with ×), what uses it, and a button to add a block one layer down that it uses.',
        do: 'Control loop is open. Remove Relay driver from {Uses} with ×, see the line go, then add it back from the list.',
        setup: function () { var a = A(); a.open('map'); var s = a.section('Control loop'); if (s) a.block(s.id); },
        spot: function () { return [field('Uses'), '#inspector']; } },
      { title: 'Interfaces',
        text: 'An interface section is a contract between two parts: here the status frame the cloud link publishes, as a table of fields with types and units. Pointing at it from a sentence, {[the status frame]{#Status frame}}, counts that sentence as traced.',
        do: 'Read the status frame’s fields, then find the dashed interface in the diagram.',
        setup: function () { var a = A(); a.open('doc', 3); var s = a.section('Status frame'); if (s) a.goto(s.id); },
        spot: function () { return [secEl('Status frame')]; } }
    ] },
    { title: 'Sharing', steps: [
      { title: '@req in comments',
        text: 'A comment anywhere in the review that ends in @req joins To requirementify too, with who wrote it and what it’s on. {New requirement} traces the draft to the check the comment was on. The comment’s words are left as written.',
        do: 'Open any check in a checklist tab, comment “Log every relay change @req”, post it, and come back to {Description}.',
        setup: function () { A().open('doc', 3); },
        spot: function () { return ['#view-seg [data-view="spec"]']; } },
      { title: 'Export and print',
        text: '{Export} writes the description as Markdown (requirement links become “words [REQ-004]”, with a table of where each requirement is described) or opens it on paper to print or save as a PDF.',
        do: 'Click {Export}, then {Print or save as PDF}. {Close} returns here.',
        setup: function () { A().open('doc', 3); },
        spot: function () { return ['[data-act="spec-export"]']; } },
      { title: 'Working together',
        text: 'Signed in, the description syncs with the review. Sections merge one by one; when two people edit the same section at once, the newer edit wins and the other is kept as a conflict copy under {Edited in two places}. Signoff PL shows the top-level gists as {What it does} on the firmware Part.',
        setup: function () { A().open('doc', 1); } }
    ] },
    { title: 'Done', steps: [
      { title: 'You’re set',
        text: 'In the editors: {k:Ctrl+Enter} saves, {k:Esc} cancels, {Heading kind} sets a kind, {Add to Uses…} adds a link, and {Writing guide} lists every mark. In the document, select words to link just those.',
        do: 'Open this guide again from {Guide} in the tab, or from the {Writing guide}. {Reset demo}, in the banner, puts the demo back.',
        setup: function () { A().open('doc', 3); },
        last: true }
    ] }
  ];
  var STEPS = [];
  CHAPTERS.forEach(function (c, ci) { c.steps.forEach(function (s) { s.chapter = ci; STEPS.push(s); }); });
  // {Edit all} names something on screen (a chip) and {k:Esc} a key, so a button's name doesn't read
  // as part of the sentence. Inner braces ({[words]{REQ-006}}) are kept as typed.
  function marks(t) {
    return esc(t).replace(/\{(k:)?((?:[^{}]|\{[^{}]*\})+)\}/g, function (m, k, x) { return k ? '<kbd class="sg-key">' + x + '</kbd>' : '<span class="sg-ui">' + x + '</span>'; });
  }

  function get() { try { var s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return s && s.step >= 0 && s.step < STEPS.length ? s : null; } catch (e) { return null; } }
  function put(s) { try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } }

  // Start: in the demo, here (offering to rebuild the demo review if it was changed); from a real
  // review, the demo in this tab, remembering to offer the way back at the end.
  function start(at) {
    var a = A(); if (!a || !a.available()) return;
    try { localStorage.setItem('signoff.demo.welcomed', '1'); } catch (e) { /* storage blocked */ }
    var st = { step: at || 0, mine: !DEMO || !!(get() || {}).mine };
    if (!DEMO) { put(st); location.href = location.pathname + '?demo&project=' + encodeURIComponent(a.demoId()) + '&guide'; return; }
    if (a.stale() && confirm('The demo firmware has changed since it was built. Start the guide from a fresh copy of it?\n\nYour changes to the demo firmware in this browser are replaced. Cancel to keep them; some steps may then not find what they describe.')) a.fresh();
    put(st);
    show(true);
  }
  function end() {
    var st = get();
    put(null);
    show();
    if (st && st.mine) location.href = location.pathname;
  }
  function go(i) { var st = get(); if (!st) return; st.step = Math.max(0, Math.min(STEPS.length - 1, i)); st.contents = false; put(st); show(true); }

  // ── The card ──
  function show(enter) {
    var st = get(), el = $('#sg-guide');
    document.body.classList.toggle('sg-guide-on', !!st);
    if (!st) { if (el) el.remove(); spotStop(); return; }
    var s = STEPS[st.step];
    if (enter && s.setup) { try { s.setup(); } catch (e) { /* a step's setup is a convenience */ } }
    if (!el) { el = document.createElement('div'); el.id = 'sg-guide'; el.className = 'sg-guide'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Description guide'); document.body.appendChild(el); }
    var ch = CHAPTERS[s.chapter], narrow = A() && A().narrow();
    var head = '<div class="sg-top" data-g="drag"><span>Guide · ' + esc(ch.title) + '</span><span class="sg-n">' + (st.step + 1) + ' / ' + STEPS.length + '</span>' +
      '<button class="sg-x' + (st.contents ? ' on' : '') + '" data-g="contents" title="Contents" aria-label="Contents" aria-expanded="' + !!st.contents + '"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h7"/></svg></button>' +
      '<button class="sg-x" data-g="end" title="Close the guide" aria-label="Close the guide"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>';
    var bar = '<div class="sg-bar">' + CHAPTERS.map(function (c, ci) { return '<i class="' + (ci < s.chapter ? 'done' : ci === s.chapter ? 'on' : '') + '" style="flex:' + c.steps.length + '"></i>'; }).join('') + '</div>';
    var body;
    if (st.contents) {
      var k = 0;
      body = '<div class="sg-toc">' + CHAPTERS.map(function (c) {
        return '<div class="sg-ch">' + esc(c.title) + '</div>' + c.steps.map(function (x) { var i = k++; return '<button class="sg-li' + (i === st.step ? ' on' : '') + '" data-g="to" data-i="' + i + '">' + esc(x.title) + '</button>'; }).join('');
      }).join('') + '</div>';
    } else {
      var tryIt = s.phone && narrow ? s.phone : s.do;
      body = '<h3>' + esc(s.title) + '</h3><p>' + marks(s.text) + '</p>' + (tryIt ? '<p class="sg-do"><b>Try it.</b> ' + marks(tryIt) + '</p>' : '');
    }
    var acts = '<div class="sg-act">' + (st.step > 0 ? '<button class="btn" data-g="back">Back</button>' : '') + '<span class="sg-sp"></span>' +
      (s.last ? (st.mine ? '<button class="btn" data-g="restart">Start over</button><button class="btn btn-primary" data-g="end">Back to my reviews</button>' : '<button class="btn" data-g="restart">Start over</button><button class="btn btn-primary" data-g="end">Finish</button>')
        : '<button class="btn btn-primary" data-g="next">Next</button>') + '</div>';
    el.innerHTML = head + bar + body + acts;
    place(el, st);
    spotStart();
    if (enter) { var b = el.querySelector('[data-g="next"], [data-g="end"].btn-primary'); if (b) b.focus({ preventScroll: true }); }
  }

  // Where the card sits: where it was dragged to, else the corner of the page covering least: never
  // the ring if it can help it, and not the details pane when it's open. On a narrow screen the details
  // pane covers the page, so the card docks at the top. Kept on screen.
  function place(el, st) {
    if (!el) return;
    var W = el.offsetWidth, H = el.offsetHeight, m = 12, x, y;
    if (st.x != null) { x = st.x; y = st.y; }
    else if (A() && A().narrow()) { x = m; y = m; }
    else {
      var main = ($('#main') || document.body).getBoundingClientRect(), ins = $('#inspector.open');
      var right = ins ? ins.getBoundingClientRect().left - 16 : main.right - 16;
      var spots = [{ x: right - W, y: innerHeight - H - 16 }, { x: main.left + 16, y: innerHeight - H - 16 }, { x: right - W, y: main.top + 64 }, { x: main.left + 16, y: main.top + 64 }];
      var t = spotRect(), keep = [];
      if (ins) { var q = ins.getBoundingClientRect(); keep.push({ x0: q.left, y0: q.top, x1: q.right, y1: q.bottom }); }
      var ed = $('#spec-editor'); if (ed) { var e2 = ed.getBoundingClientRect(); keep.push({ x0: e2.left, y0: Math.max(0, e2.top), x1: e2.right, y1: Math.min(innerHeight, e2.bottom) }); }
      var over = function (p, b) { return Math.max(0, Math.min(p.x + W, b.x1) - Math.max(p.x, b.x0)) * Math.max(0, Math.min(p.y + H, b.y1) - Math.max(p.y, b.y0)); };
      var cost = function (p) { return (t ? 100 * over(p, t) : 0) + keep.reduce(function (acc, b) { return acc + 3 * over(p, b); }, 0); };
      var p = spots.reduce(function (acc, q2) { return cost(q2) < cost(acc) ? q2 : acc; }, spots[0]);
      x = p.x; y = p.y;
    }
    x = Math.max(m, Math.min(innerWidth - W - m, x));
    y = Math.max(m, Math.min(innerHeight - H - m, y));
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }

  // ── The spot ──
  var raf = 0, was = null, lastKey = '';
  // What the step rings: the first of its spots that's showing, as { el, r }. A spot that is a list
  // rings its items as one box, and shows when its first one does. Items are selectors or elements.
  // While a sheet is open, only what's in it counts.
  function target() {
    var st = get(), s = st && !st.contents && STEPS[st.step];
    if (!s || !s.spot) return null;
    var sheetEl = $('#sheet .sheet');
    function shown(q) {
      var els = typeof q === 'string' ? document.querySelectorAll(q) : q ? [q] : [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], r = el.getBoundingClientRect();
        if (r.width && r.height && !(sheetEl && !sheetEl.contains(el)) && !el.closest('#sg-guide')) return { el: el, r: r };
      }
      return null;
    }
    var list = s.spot() || [];
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q) continue;
      if (!Array.isArray(q)) { var t1 = shown(q); if (t1) return t1; continue; }
      var ts = q.map(shown);
      if (!ts[0]) continue;
      var ok = ts.filter(Boolean);
      var r = { left: Math.min.apply(null, ok.map(function (t) { return t.r.left; })), top: Math.min.apply(null, ok.map(function (t) { return t.r.top; })),
        right: Math.max.apply(null, ok.map(function (t) { return t.r.right; })), bottom: Math.max.apply(null, ok.map(function (t) { return t.r.bottom; })) };
      r.width = r.right - r.left; r.height = r.bottom - r.top;
      return { el: ts[0].el, r: r };
    }
    return null;
  }
  // The part of the window an element can be seen in: the window, cut by any scrolling pane it's in.
  function viewOf(el) {
    var top = 0, bottom = innerHeight;
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      var oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) { var q = p.getBoundingClientRect(); top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); }
    }
    return { top: top, bottom: bottom };
  }
  function spotRect() { var t = target(); if (!t) return null; var r = t.r; return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }; }
  function tick() {
    raf = 0;
    var st = get();
    if (!st) { spotStop(); return; }
    var t = target(), el = t && t.el, ring = $('#sg-guide-spot');
    if (!el) { if (ring) ring.remove(); was = null; }
    else {
      if (!ring) { ring = document.createElement('div'); ring.id = 'sg-guide-spot'; ring.className = 'sg-guide-spot'; ring.setAttribute('aria-hidden', 'true'); document.body.appendChild(ring); }
      var r = t.r, pad = 5;
      ring.style.left = (r.left - pad) + 'px'; ring.style.top = (r.top - pad) + 'px';
      ring.style.width = (r.width + pad * 2) + 'px'; ring.style.height = (r.height + pad * 2) + 'px';
      // A new target off screen, or scrolled out of its pane, comes into view (the diagram too: it
      // scrolls with the page).
      if (was !== el) { was = el; var v = viewOf(el); if (r.top < v.top || r.bottom > v.bottom) el.scrollIntoView({ block: r.height > (v.bottom - v.top) * 0.6 ? 'start' : 'center' }); }
    }
    // The card moves again when the details pane opens, closes, or finishes sliding in, an editor or a
    // sheet appears, or the ring moves to another element, unless the card was dragged.
    var insEl = $('#inspector.open'), key = (insEl ? Math.round(insEl.getBoundingClientRect().left / 24) : 'shut') + '|' + !!$('#spec-editor') + '|' + !!$('#sheet') + '|' + (el ? el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className : '');
    if (key !== lastKey) { lastKey = key; var g = $('#sg-guide'); if (g && st.x == null && !st.contents) place(g, st); }
    raf = requestAnimationFrame(tick);
  }
  function spotStart() { was = null; if (!raf) raf = requestAnimationFrame(tick); }
  function spotStop() { cancelAnimationFrame(raf); raf = 0; var r = $('#sg-guide-spot'); if (r) r.remove(); }

  // ── Events ──
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#sg-guide [data-g]');
    if (!b) return;
    var st = get(), g = b.dataset.g;
    if (!st) return;
    if (g === 'next') go(st.step + 1);
    else if (g === 'back') go(st.step - 1);
    else if (g === 'to') go(+b.dataset.i);
    else if (g === 'restart') go(0);
    else if (g === 'end') end();
    else if (g === 'contents') { st.contents = !st.contents; put(st); show(); }
  });
  // Drag the card by its top line; where it's left is kept for the rest of the guide.
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    var t = e.target.closest && e.target.closest('#sg-guide [data-g="drag"]');
    if (!t || e.target.closest('button') || e.button) return;
    var r = $('#sg-guide').getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { t.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
    e.preventDefault();
  });
  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var st = get(); if (!st) { drag = null; return; }
    st.x = e.clientX - drag.dx; st.y = e.clientY - drag.dy; put(st);
    place($('#sg-guide'), st);
  });
  document.addEventListener('pointerup', function () { drag = null; });
  window.addEventListener('resize', function () { var st = get(); if (st) place($('#sg-guide'), st); });

  // ── Start ──
  // Arriving with ?guide (from a real review): drop it from the address, so a reload doesn't restart,
  // and carry on where the guide is. Outside the demo a leftover guide ends.
  function init() {
    var a = A();
    if (/[?&]guide\b/.test(location.search)) {
      if (!get()) put({ step: 0, mine: false });
      try { history.replaceState(null, '', location.pathname + '?demo' + (a ? '&project=' + encodeURIComponent(a.demoId()) : '') + location.hash); } catch (e) { /* not allowed */ }
    }
    if (S.app && S.app.render) S.app.render();   // the tab's Guide button needs this script loaded
    if (!DEMO || !a || !a.available()) { if (get()) put(null); return; }
    if (get()) setTimeout(function () { show(true); }, 50);
  }
  window.SignoffSpecGuide = { start: start, end: end, steps: STEPS.length, go: go, target: target };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.Signoff = window.Signoff || {});
