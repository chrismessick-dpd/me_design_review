/* Signoff engine: the MCU pin planner (2026-11-20, Chris: "a CubeMX type functionality in the MCU block").
   Edit it in ee_design_review only. Pure (no page, no storage), so tests and the command line can run it.
   The plan and decisions are in ../../pincheck/docs/pin-planner.md; the lab that draws it is
   ../../pincheck/lab/pinmap.html.

   window.SignoffPinmap reads an MCU's part file (Pincheck's pincheck.part/1: pins with `functions` such as
   "I2C1_SCL AF6", "ADC1_IN5", "USB_DM", an optional `bond` for a pad's second GPIO, and `peripherals`) and the
   MCU block's connections as Scribe writes them (`IMU (I2C1)`, `Wi-Fi module (UART)`, `Probe (2 ADC + 4 drive)`,
   `Header (PB8–PB15)`), and plans them: which peripheral instance each connection uses, and on which pads.
   It knows nothing of ST: only the generic function strings, so another family needs only an importer.

     part(file)                     → the part, read for planning ({ meta, pads, insts, byName, byNum })
     parseLabel(label)              → { dir, items: [{ type, inst, sig, count, pins, guessed, extra, text }] }
     plan(part, conns, map, types)  → { reqs, used, stray, counts }
         conns: [{ id, block, label, dir? }]   one per Scribe connection into or out of the MCU block
         map:   { "<pad num>": { req, sig, fn } }   the person's picks (locks), as stored on the section
         types: { "<conn id>#<item>": "I2C" | "I2C2" | "GPIO" | … }   a type set in the pin map, over the label's
                (Chris, 2026-11-21: "Sense1_I2C" set to I2C); the label stays as written
     typeOptions(part)              → [{ type, insts }]   what the pin map's Type list offers: the part's own
     candidates(part, req, used)    → { "<pad num>": { f, taken } }   pads that could serve a requirement
     choices(part, result, pad)     → [{ fn, req }]   what a pad could do, and for which requirement
     pick(map, result, part, pad, fn, reqId) → a new map with that pick (and the bus's other picks kept in step)
     sevOf(req)                     → 'issue' | 'warn' | 'ok'

   A requirement is one interface a connection asks for. Its id is stable across edits: a bus label shared by
   several blocks (six `I2C1`s) is one requirement, `bus:I2C|I2C1`; anything else is `<connection id>#<item>`.
*/
(function (root) {
  'use strict';

  const FIXED = new Set(['power-in', 'power-out', 'ground', 'nc', 'dnc', 'pad']);
  const nat = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
  const baseName = n => String(n).split(/[-\s[(]/)[0];           // "PA14-BOOT0" → PA14, "PA11 [PA9]" → PA11
  const portOf = n => { const m = /^P([A-Z])(\d+)$/.exec(baseName(n)); return m ? { port: m[1], bit: +m[2] } : null; };

  // ── The part ──

  function parseFn(s, gpio, remap) {
    const m = /^([A-Z][A-Z0-9]*?)(\d*)_(.+?)(?:\s+AF(\d+))?$/.exec(String(s).trim());
    if (!m) return null;                                        // EXTI0, CEC AF0: properties, not signals
    return { full: String(s).trim().replace(/\s+AF\d+$/, ''), fam: m[1], inst: m[1] + m[2], sig: m[3], af: m[4] == null ? null : +m[4], gpio, remap: remap || null };
  }

  function part(file) {
    const pads = (file.pins || []).map(p => {
      const bond = Array.isArray(p.bond) ? p.bond : [];
      const names = [baseName(p.name)].concat(bond.map(b => baseName(b.name)));
      const fns = [];
      (p.functions || []).forEach(f => { const x = parseFn(f, names[0]); if (x) fns.push(x); });
      bond.forEach(b => (b.functions || []).forEach(f => { const x = parseFn(f, baseName(b.name), b.remap || 'remap'); if (x) fns.push(x); }));
      const also = String(p.name).replace(/\s*[[(].*$/, '').split('-').slice(1).join('-');
      return { num: String(p.num), name: p.name, names, role: p.role || 'io', fns, also, bonded: names.length > 1,
        gpio: !FIXED.has(p.role) && !!portOf(names[0]) };
    });
    const insts = new Set(Array.isArray(file.peripherals) ? file.peripherals : []);
    pads.forEach(p => p.fns.forEach(f => insts.add(f.inst)));
    const byName = {}, byNum = {};
    pads.forEach(p => { byNum[p.num] = p; p.names.forEach(n => { if (!byName[n]) byName[n] = p; }); });
    return { meta: file, pads, insts: [...insts].sort(nat), byName, byNum };
  }

  // ── Reading a connection label ──

  const TYPES = {
    I2C: { fams: ['I2C'], sigs: ['SCL', 'SDA'], bus: true, words: ['i2c', 'iic', 'smbus', 'twi'] },
    SPI: { fams: ['SPI'], sigs: ['SCK', 'MOSI', 'MISO'], bus: true, words: ['spi'] },
    UART: { fams: ['USART', 'UART', 'LPUART'], sigs: ['TX', 'RX'], bus: true, words: ['uart', 'usart', 'lpuart', 'serial'] },
    USB: { fams: ['USB'], sigs: ['DM', 'DP'], bus: true, words: ['usb'] },
    CAN: { fams: ['FDCAN', 'CAN'], sigs: ['RX', 'TX'], bus: true, words: ['can', 'fdcan'] },
    SWD: { fams: ['SYS'], sigs: ['SWDIO', 'SWCLK'], bus: true, words: ['swd'] },
    I2S: { fams: ['I2S'], sigs: ['CK', 'SD', 'WS'], bus: true, words: ['i2s'] },
    ADC: { fams: ['ADC'], pat: /^IN\d+$/, words: ['adc', 'analog'], one: 'channel' },
    DAC: { fams: ['DAC'], pat: /^OUT\d+$/, words: ['dac'], one: 'output' },
    TIM: { fams: ['TIM', 'LPTIM'], pat: /^CH\d+$/, words: ['pwm', 'tim', 'timer'], one: 'channel' },
    TSC: { fams: ['TSC'], pat: /^G\d+_IO\d+$/, words: ['touch', 'tsc', 'capsense'], one: 'touch channel', name: 'touch controller (TSC)' },
    PINS: { words: [] },
    GPIO: { words: ['gpio', 'drive', 'io', 'digital', 'led', 'relay', 'enable', 'irq', 'interrupt', 'input', 'output'] },
  };
  const KNOWN = new Set([].concat(...Object.values(TYPES).map(t => t.words)));
  const INST_RE = /\b(I2C|SPI|LPUART|USART|UART|DAC|ADC|LPTIM|TIM|FDCAN|CAN|I2S)(\d+)\b/i;
  const SIG_RE = /\b(OUT|CH|IN)(\d+)\b/i;

  function parseLabel(raw) {
    const parts = String(raw || '').split(',').map(s => s.trim());
    const main = parts.shift() || '';
    const dirWord = parts.find(p => /^(in|out|both ways)$/i.test(p));
    const dir = dirWord ? dirWord.toLowerCase() : 'out';
    const pins = [];
    const pinRe = /\bP([A-Z])(\d+)\s*[–—-]\s*P?([A-Z])?(\d+)\b|\bP[A-Z]\d+\b/g;
    let m;
    while ((m = pinRe.exec(main))) {
      if (m[2] != null) { for (let b = +m[2]; b <= +m[4] && b - +m[2] < 64; b++) pins.push('P' + m[1] + b); }
      else pins.push(m[0]);
    }
    if (pins.length) return { dir, items: [{ type: 'PINS', pins, count: pins.length, text: main, extra: [], guessed: false, inst: null, sig: null }] };
    const items = main.split('+').map(chunk => {
      chunk = chunk.trim();
      const cm = /^(\d+)\s*[x×]?\s+(.*)$/.exec(chunk);
      const count = cm ? +cm[1] : 1;
      const body = cm ? cm[2] : chunk;
      const im = INST_RE.exec(body), sm = SIG_RE.exec(body);
      const words = body.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      // A net name (USB_LDO_EN, SPI_CS, I2C_INT) is one signal, not the interface a word in it names (Chris,
      // 2026-11-20: USB_LDO_EN, an LDO's enable, was read as a second USB port).
      if (!im && /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(body.trim()))
        return { type: 'GPIO', guessed: false, signal: true, inst: null, sig: null, count, extra: [], text: chunk, pins: null };
      let type = null;
      if (im) type = Object.keys(TYPES).find(t => (TYPES[t].fams || []).includes(im[1].toUpperCase()));
      if (!type) type = Object.keys(TYPES).find(t => TYPES[t].words.some(w => words.includes(w)));
      const extra = words.filter(w => !KNOWN.has(w) && !(im && w === im[0].toLowerCase()) && !(sm && w === sm[0].toLowerCase()) && !/^\d+$/.test(w));
      return { type: type || 'GPIO', guessed: !type, inst: im ? im[1].toUpperCase() + im[2] : null,
        sig: sm ? sm[1].toUpperCase() + sm[2] : null, count, extra, text: chunk, pins: null };
    }).filter(it => it.text);
    return { dir, items: items.length ? items : [{ type: 'GPIO', guessed: true, inst: null, sig: null, count: 1, extra: [], text: '', pins: null }] };
  }

  // A type set in the pin map: a TYPES name ("I2C", "GPIO") or one of its instances ("I2C2", "TIM14").
  function typeOf(v) {
    v = String(v || '').toUpperCase();
    if (TYPES[v] && v !== 'PINS') return { type: v, inst: null };
    const fam = /\d$/.test(v) ? famOf(v) : '';                     // I2C1 → I2C, TIM14 → TIM
    const t = fam && Object.keys(TYPES).find(k => (TYPES[k].fams || []).includes(fam));
    return t ? { type: t, inst: v } : null;
  }
  function setType(it, v) {
    const t = typeOf(v);
    if (!t || it.type === 'PINS') return it;
    return Object.assign({}, it, { type: t.type, inst: t.inst, sig: TYPES[t.type].bus ? null : it.sig, guessed: false, signal: false, extra: [], set: v,
      count: TYPES[t.type].bus ? 1 : it.count });
  }

  // One requirement per interface; a bus label on several blocks is one requirement.
  function requirements(conns, types) {
    const reqs = [], byKey = {};
    (conns || []).forEach(c => {
      const parsed = parseLabel(c.label);
      const dir = c.dir || parsed.dir;
      parsed.items.forEach((it0, ii) => {
        const ikey = String(c.id) + '#' + ii;
        const it = types && types[ikey] ? setType(it0, types[ikey]) : it0;
        const T = TYPES[it.type];
        const key = T.bus ? it.type + '|' + (it.inst || it.text.toLowerCase()) : null;
        const user = { block: c.block, id: c.id, conn: c, key: ikey, item: it };
        if (key && byKey[key]) { byKey[key].users.push(user); return; }
        const r = { id: key ? 'bus:' + key : String(c.id) + '#' + ii, key, type: it.type, item: it, label: c.label, dir,
          users: [user], slots: [], problems: [], notes: [], inst: null, fix: null, dead: false };
        if (key) byKey[key] = r;
        reqs.push(r);
      });
    });
    return reqs;
  }

  // ── Placing ──

  const famOf = inst => inst.replace(/\d+$/, '');
  const instsOf = (part, T) => part.insts.filter(i => T.fams.includes(famOf(i)))
    .sort((a, b) => T.fams.indexOf(famOf(a)) - T.fams.indexOf(famOf(b)) || nat(a, b));
  // Which free pad to spend: the one with the fewest other uses, a shared pad later, and an oscillator, boot,
  // or reset pin only when nothing else will do.
  const cost = p => p.fns.length + (p.bonded ? 3 : 0) + (p.role === 'io' ? 0 : 100);
  const who = u => (u && u.req ? u.req.users[0].block : 'a pick of yours');

  // The instance a label names, as the part spells it (UART4 vs USART4).
  function resolveInst(part, T, inst) {
    if (!inst) return null;
    if (part.insts.includes(inst)) return inst;
    const n = inst.replace(/^\D+/, '');
    const uart = s => /^(USART|UART)\d/.test(s);                // USART4 and UART4 are one name to a reader
    const alt = uart(inst) ? T.fams.map(f => f + n).find(x => part.insts.includes(x) && uart(x)) : null;
    return alt || null;
  }

  function check(part, r) {
    const T = TYPES[r.type];
    const it = r.item;
    if (it.set) r.notes.push({ sev: 'info', code: 'set', text: `Type set in the pin map: ${it.set}.` });
    if (it.signal) r.notes.push({ sev: 'info', code: 'signal', text: `“${it.text}” is a signal name: planned as ${it.count > 1 ? it.count + ' GPIOs' : 'one GPIO'}.` });
    if (it.guessed) r.notes.push({ sev: 'warn', code: 'guessed', text: `“${it.text}” names no interface; planned as ${it.count > 1 ? it.count + ' GPIOs' : 'one GPIO'}.` });
    else if (it.extra.length) r.notes.push({ sev: 'info', code: 'extra', text: `Read past: ${it.extra.join(' ')}.` });
    if (r.users.length > 1) r.notes.push({ sev: 'info', code: 'shared', text: `One bus for ${r.users.length} blocks.` });
    if (!T.fams) return;
    const have = instsOf(part, T);
    if (!have.length) { r.problems.push({ code: 'no-type', text: `This part has no ${T.name || r.type}.` }); r.dead = true; return; }
    if (!it.inst) return;
    const inst = resolveInst(part, T, it.inst);
    if (inst) { r.want = inst; return; }
    r.dead = true;
    const n = +it.inst.replace(/^\D+/, '');
    // DACn for a part with one DAC means its nth output (DAC2 → DAC1_OUT2); an ADCn or TIMn means an instance.
    const chans = r.type === 'DAC' && have.length === 1 ? [...new Set(part.pads.flatMap(p => p.fns.filter(f => f.inst === have[0] && T.pat.test(f.sig)).map(f => f.sig)))].sort(nat) : [];
    if (chans[n - 1]) {
      r.problems.push({ code: 'no-instance', text: `No ${it.inst} on this part. It has one ${r.type}, ${have[0]}, with ${chans.join(' and ')}: did you mean ${have[0]}_${chans[n - 1]}?` });
      r.fix = { from: it.inst, to: have[0] + ' ' + chans[n - 1] };
    } else r.problems.push({ code: 'no-instance', text: `No ${it.inst} on this part. It has ${have.join(', ')}.` });
  }

  function plan(part, conns, map, types) {
    const reqs = requirements(conns, types);
    const used = {}, claimed = {};
    const take = (pad, r, sig, fn, lock) => {
      used[pad.num] = { req: r, sig, fn, lock: !!lock };
      r.slots.push({ pad: pad.num, sig, fn, gpio: fn ? fn.gpio : pad.names.find(n => n === sig) || pad.names[0], lock: !!lock });
      if (fn && fn.remap) r.notes.push({ sev: 'info', code: 'remap', text: `${fn.gpio} on pad ${pad.num} needs its remap (${fn.remap}).` });
    };
    reqs.forEach(r => check(part, r));

    // The person's picks first, then explicit pins, then the most constrained.
    Object.keys(map || {}).sort(nat).forEach(num => {
      const l = map[num], pad = part.byNum[num];
      if (!pad || !l) return;
      const r = reqs.find(q => q.id === l.req);
      const fn = l.fn ? pad.fns.find(f => f.full === l.fn && (!l.gpio || f.gpio === l.gpio)) || null : null;
      if (r && !r.dead && !used[num]) {
        take(pad, r, l.sig || (fn ? fn.sig : 'GPIO'), fn, true);
        if (fn && TYPES[r.type].bus) { r.inst = fn.inst; claimed[fn.inst] = r; }
      } else if (!used[num]) used[num] = { req: null, sig: l.fn || l.sig || 'GPIO', fn, lock: true, stray: true };
    });
    const order = reqs.filter(r => !r.dead)
      .map(r => ({ r, n: r.type === 'PINS' ? -1 : r.slots.length ? 0 : options(part, r) }))
      .sort((a, b) => a.n - b.n).map(x => x.r);
    order.forEach(r => place(part, r, used, claimed, take));

    const io = part.pads.filter(p => p.gpio);
    const stray = Object.keys(used).filter(n => used[n].stray).map(n => ({ pad: n, fn: used[n].sig }));
    return { reqs, used, stray, counts: {
      io: io.length, used: io.filter(p => used[p.num]).length,
      problems: reqs.filter(r => sevOf(r) === 'issue').length, warnings: reqs.filter(r => sevOf(r) === 'warn').length + stray.length } };
  }

  function options(part, r) {
    if (r.type === 'GPIO') return 1e4;
    return part.pads.reduce((n, p) => n + p.fns.filter(f => serves(r, f)).length, 0);
  }

  function place(part, r, used, claimed, take) {
    const T = TYPES[r.type], it = r.item;
    if (r.type === 'PINS') {
      it.pins.forEach(n => {
        const pad = part.byName[n];
        if (!pad) { r.problems.push({ code: 'pin-missing', text: `${n} isn’t bonded in ${part.meta.package || 'this package'}.` }); return; }
        const u = used[pad.num];
        if (u && u.req !== r) { r.problems.push({ code: 'pin-taken', text: `${n} is taken by ${who(u)}.` }); return; }
        if (!u) take(pad, r, n, null);
        if (pad.also && !r.notes.some(x => x.code === 'also' && x.pin === n)) r.notes.push({ sev: 'info', code: 'also', pin: n, text: `${n} is also ${pad.also}.` });
      });
      return;
    }
    if (r.type === 'GPIO') {
      const need = Math.max(0, it.count - r.slots.length);   // never negative: slice(0, -1) would take every free pin
      over(r);
      const pads = part.pads.filter(p => p.gpio && p.role === 'io' && !used[p.num]).sort((a, b) => cost(a) - cost(b) || nat(a.num, b.num));
      pads.slice(0, need).forEach(p => take(p, r, 'GPIO', null));
      if (pads.length < need) r.problems.push({ code: 'short', text: `Only ${pads.length} free GPIO left for ${need}.` });
      return;
    }
    if (T.bus) {
      const insts = instsOf(part, T).filter(i => (!r.want || i === r.want) && (!r.inst || i === r.inst) && (!claimed[i] || claimed[i] === r));
      for (const inst of insts) {
        const have = new Set(r.slots.map(s => s.sig));
        const sigs = T.sigs.filter(s => !have.has(s));
        const fnOf = (p, s) => p.fns.find(f => f.inst === inst && f.sig === s);
        const cands = sigs.map(s => part.pads.filter(p => (!used[p.num] || used[p.num].req === r) && fnOf(p, s)).sort((a, b) => cost(a) - cost(b) || nat(a.num, b.num)));
        const pick = [];
        const taken = new Set(r.slots.map(s => s.pad));
        const go = k => {
          if (k === sigs.length) return true;
          for (const p of cands[k]) {
            if (taken.has(p.num)) continue;
            pick[k] = p; taken.add(p.num);
            if (go(k + 1)) return true;
            taken.delete(p.num);
          }
          return false;
        };
        if (go(0)) {
          sigs.forEach((s, k) => take(pick[k], r, s, fnOf(pick[k], s)));
          r.inst = inst; claimed[inst] = r; return;
        }
      }
      const all = instsOf(part, T).filter(i => !r.want || i === r.want);
      const held = all.filter(i => claimed[i] && claimed[i] !== r).map(i => `${i} (${claimed[i].users[0].block})`);
      const blockers = new Set();
      part.pads.forEach(p => p.fns.forEach(f => { if (all.includes(f.inst) && T.sigs.includes(f.sig) && used[p.num] && used[p.num].req !== r) blockers.add(`${p.names[0]} (${who(used[p.num])})`); }));
      r.problems.push({ code: 'no-room', text: `No room for ${r.want || r.type}.` + (held.length ? ` In use: ${held.join(', ')}.` : '') + (blockers.size ? ` Its pads are taken: ${[...blockers].slice(0, 5).join(', ')}.` : '') });
      return;
    }
    // Channels (ADC, DAC, timer, touch): any instance unless named, distinct pads.
    const need = Math.max(0, it.count - r.slots.length);
    over(r);
    const okFn = f => T.fams.includes(f.fam) && T.pat.test(f.sig) && (!r.want || f.inst === r.want) && (!it.sig || f.sig === it.sig);
    const pads = part.pads.filter(p => !used[p.num] && p.fns.some(okFn)).sort((a, b) => cost(a) - cost(b) || nat(a.num, b.num));
    pads.slice(0, need).forEach(p => { const f = p.fns.find(okFn); take(p, r, f.sig, f); });
    if (pads.length < need) r.problems.push({ code: 'short', text: `Only ${pads.length} free ${r.type} ${T.one}${pads.length === 1 ? '' : 's'} for ${need}.` });
  }

  // More picks than the label asks for (a pin picked to move one, before the old pick came off): keep them, and say so.
  function over(r) {
    const n = r.slots.length, want = r.item.count;
    if (n > want) r.notes.push({ sev: 'warn', code: 'over', text: `${n} pins picked, but “${r.item.text || r.label}” asks for ${want}. Remove a pick (click the pin, then Let the planner choose), or Clear picks.` });
  }

  function sevOf(r) { return r.problems.length ? 'issue' : r.notes.some(n => n.sev === 'warn') ? 'warn' : 'ok'; }

  // Does a function serve a requirement?
  function serves(r, f) {
    const T = TYPES[r.type];
    if (r.dead || !T.fams || !T.fams.includes(f.fam)) return false;
    if (r.want && f.inst !== r.want) return false;
    return T.bus ? T.sigs.includes(f.sig) : T.pat.test(f.sig) && (!r.item.sig || f.sig === r.item.sig);
  }

  function candidates(part, r, used) {
    const out = {};
    if (!r || r.dead) return out;
    part.pads.forEach(p => {
      const taken = !!(used[p.num] && used[p.num].req !== r);
      if (r.type === 'PINS') { if (r.item.pins.some(n => p.names.includes(n))) out[p.num] = { f: null, taken }; return; }
      if (r.type === 'GPIO') { if (p.gpio && p.role === 'io' && !taken) out[p.num] = { f: null, taken }; return; }
      const f = p.fns.find(x => serves(r, x));
      if (f) out[p.num] = { f, taken };
    });
    return out;
  }

  // What a pad could do: each function, with the requirement it would serve (the selected one first).
  function choices(part, result, num, selected) {
    const pad = part.byNum[num];
    if (!pad) return [];
    return pad.fns.map(fn => {
      const qs = result.reqs.filter(q => serves(q, fn));
      const sel = qs.find(q => q.id === selected);
      return { fn, req: sel || qs[0] || null };
    });
  }

  // A pick: the pad takes that function for that requirement (or for none: a function no connection asks for). A bus pick
  // moves the bus onto that instance, so its picks on other instances go; one pick per signal.
  function pick(map, result, part, num, fnFull, reqId, gpio) {
    const out = Object.assign({}, map);
    const pad = part.byNum[num];
    if (!pad) return out;
    const r = result.reqs.find(q => q.id === reqId) || null;
    const f = fnFull ? pad.fns.find(x => x.full === fnFull && (!gpio || x.gpio === gpio)) || null : null;
    Object.keys(out).forEach(k => {
      const l = out[k];
      if (!r || l.req !== r.id || k === String(num)) return;
      if (f && TYPES[r.type].bus && l.fn && !l.fn.startsWith(f.inst + '_')) delete out[k];
      else if (f && l.sig === f.sig) delete out[k];
    });
    const sig = r && r.type === 'PINS' ? (pad.names.find(n => r.item.pins.includes(n)) || pad.names[0]) : r && r.type === 'GPIO' ? 'GPIO' : f ? f.sig : pad.names[0];
    out[num] = { req: r ? r.id : null, sig, fn: f ? f.full : null };
    if (f && f.gpio !== pad.names[0]) out[num].gpio = f.gpio;
    return out;
  }
  // The Type list: GPIO, then each kind of peripheral the part has, with its instances.
  function typeOptions(part) {
    // SWD's block is SYS, and USB's instance is USB itself: those list the type alone.
    return Object.keys(TYPES).filter(k => TYPES[k].fams).map(k => ({ type: k, all: instsOf(part, TYPES[k]) })).filter(g => g.all.length)
      .map(g => ({ type: g.type, insts: g.type === 'SWD' ? [] : g.all.filter(i => i !== g.type) }));
  }
  function unpick(map, num) { const out = Object.assign({}, map); delete out[num]; return out; }

  root.SignoffPinmap = { TYPES, FIXED, part, parseFn, parseLabel, requirements, plan, typeOptions, typeOf, candidates, choices, pick, unpick, sevOf, serves, portOf, baseName, nat };
})(typeof window !== 'undefined' ? window : globalThis);
