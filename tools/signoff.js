/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* signoff: this Signoff tool from the command line (design: docs/cli.md).

   For people, and assistants such as Claude, who work in a terminal. It runs this tool's own engine
   (assets/config.js, templates.js, model.js, github.js), so it reads a review exactly as the browser
   does, and turns it into plain files to read and edit. Node 20 or later; no packages.

     node tools/signoff.js login                    sign in with GitHub: a code to enter at github.com/login/device
     node tools/signoff.js logout                   forget that sign-in on this computer
     node tools/signoff.js whoami                   the token's login, and whether it opens the data repo
     node tools/signoff.js list [--project P] [--all]
     node tools/signoff.js pull <review> [dir]      a checkout: scribe.md, reqs.csv, status.md, review.json
     node tools/signoff.js status [dir]             offline: local edits, Scribe gaps, and requirements
     node tools/signoff.js push [dir] --dry-run     what a push would change, and a code for:
     node tools/signoff.js push [dir] --confirm <code>
     node tools/signoff.js open [dir|review] [--req REQ-004] [--item <check id>]
     node tools/signoff.js export [dir|review] [--out file.md]
     node tools/signoff.js skill [--install <folder>]  the Claude Code skill for this command line:
                                                    printed, or written to <folder>/.claude/skills/signoff/

   <review> is a review's id, slug, or name (or enough of it to be unique). Options: --json for
   machine-readable output, --config <file>, --token-file <file>, and --force (pull over local edits).

   Only push writes. It merges with the review on GitHub as the browser's sync does, rebuilds the
   summary, proves that nothing but its own records (and the summary) changes, commits with
   force: false, and reads the file back. It commits only what a dry run showed: --confirm takes
   the code the dry run printed, which stops matching once the files or the review change.

   The token comes from SIGNOFF_TOKEN, --token-file, `signoff login` (kept in ~/.signoff/auth.json, and
   renewed by itself), the config's tokenFile, ee_tools_token.txt beside the tool folders, or
   `gh auth token`, in that order. It is never printed. The config is
   ~/.signoff/config.json (or the file SIGNOFF_CONFIG names):
     { "name": "Name to stamp edits with", "tokenFile": "path", "checkouts": "folder for checkouts" }

   Checkouts hold review data, which is private. pull refuses to write one inside a Signoff tool
   folder or repo, since those are public. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const childProcess = require('child_process');

const TOOL_ROOT = path.resolve(__dirname, '..');
// The suite's public tool repos: no checkout goes inside one.
const TOOL_REPOS = ['ee_design_review', 'me_design_review', 'fw_design_review', 'signoff', 'signoff_pl', 'pcb_dfm', 'partcheck', 'loom'];
const CHECKOUT_FILE = '.signoff.json';
const REQ_HEAD = ['ID', 'Requirement', 'Type', 'Discipline', 'Category', 'Source', 'Verification method', 'Status'];
const REQ_FIELD = { id: 'ref', requirement: 'text', type: 'kind', discipline: 'discipline', category: 'category', source: 'source', 'verification method': 'method', status: 'status' };
const REQ_EDITABLE = ['text', 'kind', 'discipline', 'category', 'source', 'method', 'status'];
const LIST_CAP = 40;   // lines per list in the terminal; status.md has them all

const USAGE = [
  'signoff: this Signoff tool from the command line (docs/cli.md)',
  '',
  '  node tools/signoff.js login, logout',
  '  node tools/signoff.js whoami',
  '  node tools/signoff.js list [--project P] [--all]',
  '  node tools/signoff.js pull <review> [dir] [--force]',
  '  node tools/signoff.js status [dir]',
  '  node tools/signoff.js push [dir] --dry-run, then push [dir] --confirm <code>',
  '  node tools/signoff.js open [dir|review] [--req REQ-004] [--item <check id>]',
  '  node tools/signoff.js export [dir|review] [--out file.md]',
  '  node tools/signoff.js skill [--install <folder>]',
  '',
  'Options: --json, --config <file>, --token-file <file>.',
  ''
].join('\n');

class CliError extends Error {
  constructor(message, code) { super(message); this.code = code || 1; }
}

// ── The engine ─────────────────────────────────────────────
// Loaded once per process, into the global scope (window = globalThis), exactly as the page
// loads it. One process runs one tool: model.js reads the tool's config when it loads.
let ENGINE = null;
function loadEngine(assetsDir) {
  if (ENGINE) return ENGINE;
  const dir = path.resolve(assetsDir || path.join(TOOL_ROOT, 'assets'));
  globalThis.window = globalThis;
  ['config.js', 'templates.js', 'model.js', 'github.js', 'workspace.js'].forEach((f) => {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) throw new CliError('Missing ' + file + '. Run this from a Signoff tool folder (EE, ME, or FW).');
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  });
  const S = globalThis.Signoff, C = globalThis.SIGNOFF_CONFIG || {}, M = S.model;
  ENGINE = { S, C, M, T: M.resolveTemplates(globalThis.SIGNOFF_TEMPLATES || [], []), dir, key: String(C.discipline || 'tool').toLowerCase() };
  return ENGINE;
}

// Node's fetch, without the browser-only cache option the engine passes.
function nodeFetch(url, opts) {
  const o = Object.assign({}, opts);
  delete o.cache;
  return fetch(url, o);
}

// ── Settings ───────────────────────────────────────────────
function readConfig(io, opts) {
  const file = opts.config || io.env.SIGNOFF_CONFIG || path.join(io.home, '.signoff', 'config.json');
  if (!fs.existsSync(file)) {
    if (opts.config) throw new CliError('No config at ' + file);
    return {};
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { throw new CliError('Can’t read ' + file + ': ' + e.message); }
}

function findToken(io, opts, config) {
  if (io.env.SIGNOFF_TOKEN && io.env.SIGNOFF_TOKEN.trim()) return { token: io.env.SIGNOFF_TOKEN.trim(), source: 'SIGNOFF_TOKEN' };
  const files = [];
  if (opts['token-file']) files.push([opts['token-file'], '--token-file']);
  if (!opts['token-file']) {
    const a = readSignIn(io);
    if (a && a.expiresAt > Date.now()) return { token: a.access, source: 'signoff login (@' + a.login + ')' };
  }
  if (config.tokenFile) files.push([config.tokenFile, 'tokenFile in the config']);
  files.push([path.join(path.dirname(TOOL_ROOT), 'ee_tools_token.txt'), 'ee_tools_token.txt beside the tool folders']);
  for (const [file, source] of files) {
    const f = path.resolve(io.cwd, file);
    if (fs.existsSync(f)) {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t) return { token: t, source };
    }
  }
  if (io.gh !== false) {
    try {
      const t = childProcess.execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (t) return { token: t, source: 'gh auth token' };
    } catch (e) { /* no gh, or not signed in */ }
  }
  throw new CliError('No GitHub token. Run `signoff login`, or set SIGNOFF_TOKEN, pass --token-file, put tokenFile in ~/.signoff/config.json, or sign in with `gh auth login`.');
}

// ── Sign in with GitHub (device flow) ──────────────────────
// The suite's GitHub App (signoff/docs/sign-in.md). A device-flow sign-in needs no client secret, even
// to renew, so the command line talks to GitHub directly, with no Worker. Its tokens last 8 hours and
// renew from a refresh token that lasts 6 months and is replaced at every renewal.
const SIGNIN_CLIENT_ID = 'Iv23li2MtbpspvneopRN';   // the production app, Dovetail Signoff
const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
function signInFile(io) { return path.join(io.home, '.signoff', 'auth.json'); }
function signInClient(config) { return config.signinClientId || SIGNIN_CLIENT_ID; }
function readSignIn(io) {
  try {
    const a = JSON.parse(fs.readFileSync(signInFile(io), 'utf8'));
    return a && a.v === 1 && a.access && a.refresh ? a : null;
  } catch (e) { return null; }
}
function writeSignIn(io, t, at, login) {
  const file = signInFile(io);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const a = { v: 1, login, access: t.access_token, refresh: t.refresh_token,
    expiresAt: at + (Number(t.expires_in) || 28800) * 1000, refreshExpiresAt: at + (Number(t.refresh_token_expires_in) || 15897600) * 1000 };
  fs.writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 });
  return a;
}
async function oauthPost(io, url, params) {
  const res = await (io.fetch || nodeFetch)(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'signoff-cli' },
    body: new URLSearchParams(params).toString() });
  let d = {};
  try { d = JSON.parse(await res.text()) || {}; } catch (e) { d = {}; }
  if (!res.ok && !d.error) d.error = 'http_' + res.status;
  return d;
}
// Renew the sign-in when less than an hour is left. Unreachable GitHub isn't fatal here: a command
// that needs GitHub fails on its own, and status works offline.
async function renewSignIn(io, config) {
  const a = readSignIn(io);
  if (!a || a.expiresAt - Date.now() > 3600e3) return a;
  if (a.refreshExpiresAt <= Date.now()) { fs.rmSync(signInFile(io), { force: true }); throw new CliError('Your GitHub sign-in has expired. Run `signoff login` again.'); }
  const at = Date.now();
  let d;
  try { d = await oauthPost(io, TOKEN_URL, { client_id: signInClient(config), grant_type: 'refresh_token', refresh_token: a.refresh }); } catch (e) { return a; }
  if (d.error === 'bad_refresh_token') { fs.rmSync(signInFile(io), { force: true }); throw new CliError('GitHub ended this sign-in. Run `signoff login` again.'); }
  if (d.error || !d.access_token) return a;
  return writeSignIn(io, d, at, a.login);
}

async function cmdLogin(ctx) {
  const io = ctx.io, cid = signInClient(ctx.config), sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const d = await oauthPost(io, DEVICE_URL, { client_id: cid });
  if (d.error || !d.device_code) throw new CliError('GitHub didn’t start a sign-in: ' + (d.error_description || d.error || 'no device code') + '.');
  if (ctx.opts.json) io.out(JSON.stringify({ url: d.verification_uri, code: d.user_code }) + '\n');
  else io.out('To sign in, open ' + d.verification_uri + ' and enter the code ' + d.user_code + '.\nWaiting for you to finish on GitHub…\n');
  let wait = (Number(d.interval) || 5) * 1000;
  const until = Date.now() + (Number(d.expires_in) || 900) * 1000;
  while (Date.now() < until) {
    await sleep(wait);
    const at = Date.now();
    const t = await oauthPost(io, TOKEN_URL, { client_id: cid, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.error === 'authorization_pending') continue;
    if (t.error === 'slow_down') { wait += 5000; continue; }
    if (t.error === 'expired_token') break;
    if (t.error === 'access_denied') throw new CliError('Sign-in was cancelled on GitHub.');
    if (t.error || !t.access_token) throw new CliError('GitHub refused the sign-in: ' + (t.error_description || t.error || 'no token') + '.');
    const u = await new ctx.eng.S.GitHubAccount(t.access_token, io.fetch || nodeFetch).user();
    writeSignIn(io, t, at, u.login);
    if (ctx.opts.json) return out(ctx, { login: u.login });
    return out(ctx, 'Signed in as @' + u.login + '. The command line uses this sign-in now and renews it by itself; it lasts until it goes 6 months unused. `signoff logout` forgets it.');
  }
  throw new CliError('The code expired before the sign-in finished. Run `signoff login` again.');
}

async function cmdLogout(ctx) {
  const had = readSignIn(ctx.io);
  fs.rmSync(signInFile(ctx.io), { force: true });
  out(ctx, ctx.opts.json ? { signedOut: !!had } : had
    ? 'Signed out @' + had.login + ' on this computer. To end the sign-in on GitHub too, revoke it at https://github.com/settings/apps/authorizations.'
    : 'Not signed in with `signoff login` on this computer.');
}

// The name edits are stamped with, as the browser's Settings → Your name.
function userName(ctx, ghUser) {
  return ctx.config.name || (ghUser && (ghUser.name || ghUser.login)) || 'signoff CLI';
}

// ── GitHub (reads only) ────────────────────────────────────
function github(ctx) {
  if (ctx.gh) return ctx.gh;
  const { S } = ctx.eng, tok = findToken(ctx.io, ctx.opts, ctx.config), fetchImpl = ctx.io.fetch || nodeFetch;
  ctx.gh = {
    tokenSource: tok.source,
    account: new S.GitHubAccount(tok.token, fetchImpl),
    store(full) {
      const [owner, repo] = full.split('/');
      return new S.GitHubStore({ owner, repo, branch: 'main', dataPath: '', token: tok.token, summarize: null }, fetchImpl);
    }
  };
  return ctx.gh;
}

const denied = (err) => err && (err.status === 404 || err.status === 403);
const isProjectFile = (e) => e.type === 'blob' && /^projects\/[^/]+\.json$/.test(e.path);
const idOfPath = (p) => p.slice('projects/'.length).replace(/\.json$/, '');

// Every review this token reaches, the way workspace.js finds them: the data repo (FTEs) and its
// shared map, or, for a contractor, the repos named with this tool's prefix. A file whose id
// doesn't match its name is skipped, as sync does.
async function gather(ctx) {
  const { C, M } = ctx.eng, gh = github(ctx), owner = C.repos.owner;
  const dataFull = owner + '/' + C.repos.dataRepo;
  const out = { fte: false, dataRepo: dataFull, reviews: [], errors: [] };
  let roster = null;

  async function readRepo(full, store, snap, keep) {
    for (const e of snap.entries.filter(isProjectFile)) {
      const id = idOfPath(e.path);
      if (!keep(id)) continue;
      const text = await store.blob(e.sha);
      let doc = null;
      try { doc = JSON.parse(text); } catch (err) { /* unreadable: skipped */ }
      if (!doc || typeof doc !== 'object' || doc.id !== id || !doc.meta) { out.errors.push({ repo: full, message: e.path + ' isn’t a readable review, so it was skipped' }); continue; }
      out.reviews.push({ repo: full, path: e.path, sha: e.sha, head: snap.head, text, doc });
    }
  }

  const data = gh.store(dataFull);
  try {
    const snap = await data.snapshot();
    out.fte = true;
    const rosterEntry = snap.entries.find((e) => e.type === 'blob' && e.path === 'users.json');
    if (rosterEntry) { try { roster = JSON.parse(await data.blob(rosterEntry.sha)); } catch (e) { roster = null; } }
    await readRepo(dataFull, data, snap, (id) => !M.sharedRepo(roster, id));
  } catch (err) {
    if (!denied(err)) throw err;
  }

  let repos;
  if (out.fte) {
    repos = [];
    Object.keys((roster && roster.shared) || {}).forEach((id) => { const r = M.sharedRepo(roster, id); if (r && repos.indexOf(r) < 0) repos.push(r); });
  } else {
    repos = (await gh.account.listRepos(owner, C.repos.prefix)).map((n) => owner + '/' + n);
  }
  for (const full of repos) {
    try {
      const store = gh.store(full), snap = await store.snapshot();
      await readRepo(full, store, snap, (id) => !out.fte || M.sharedRepo(roster, id).toLowerCase() === full.toLowerCase());
    } catch (err) {
      out.errors.push({ repo: full, message: denied(err) ? 'no access' : err.message });
    }
  }
  return out;
}

// One review from an id, slug, or name (exact first, then a unique part of the name).
function pick(reviews, q) {
  const low = String(q).toLowerCase();
  const tries = [
    (r) => r.doc.id === q,
    (r) => String(r.doc.slug || '').toLowerCase() === low,
    (r) => String(r.doc.meta.name || '').toLowerCase() === low,
    (r) => String(r.doc.meta.name || '').toLowerCase().includes(low) || String(r.doc.slug || '').includes(low)
  ];
  for (const t of tries) {
    const hits = reviews.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new CliError('“' + q + '” matches ' + hits.length + ' reviews: ' + hits.map((r) => r.doc.meta.name + ' (' + r.doc.id + ')').join(', ') + '. Use the id.', 2);
  }
  throw new CliError('No review matches “' + q + '”. `list` shows them.', 2);
}

// ── Text forms of a review ─────────────────────────────────
function csvCell(v) {
  v = String(v == null ? '' : v);
  return /[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
// The requirements as the CSV that model.importReqs reads back (only the columns it reads).
function reqsCsvText(eng, doc) {
  const rows = [REQ_HEAD].concat(eng.M.liveReqs(doc).map((q) => [q.ref, q.text, q.kind, q.discipline, q.category, q.source, q.method, q.status]));
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
// What pull writes, from the stored document. The engine is deterministic, so these are
// regenerated from review.json whenever we need to know whether a file was edited.
function pristine(eng, doc) {
  return { 'scribe.md': eng.M.specToText(doc), 'reqs.csv': reqsCsvText(eng, doc) };
}
const sameText = (a, b) => String(a).replace(/\r\n?/g, '\n').replace(/\s+$/, '') === String(b).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const norm = (v) => String(v == null ? '' : v).trim();
const clone = (o) => JSON.parse(JSON.stringify(o));

// The longest run of strictly increasing numbers (nulls skipped), as a set of indexes.
function increasing(vals) {
  const idx = [];
  vals.forEach((v, i) => { if (v != null) idx.push(i); });
  const len = idx.map(() => 1), prev = idx.map(() => -1);
  for (let i = 0; i < idx.length; i++) {
    for (let j = 0; j < i; j++) {
      if (vals[idx[j]] < vals[idx[i]] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
  }
  let best = -1;
  len.forEach((l, i) => { if (best < 0 || l > len[best]) best = i; });
  const keep = new Set();
  for (let k = best; k >= 0; k = prev[k]) keep.add(idx[k]);
  return keep;
}

// specSaveAll numbers every section 1, 2, 3… in the order of the text, so sections whose stored
// order is anything else come back changed though nothing moved. Keep each section's stored order
// wherever the sequence allows (the longest increasing run), give the rest orders between their
// neighbors, and drop records that end up unchanged. Fewer re-stamped sections also means fewer
// conflict copies against edits made in the browser meanwhile.
function keepOrders(M, doc, recs, user) {
  const stored = doc.spec || {}, byId = {};
  recs.forEach((r) => { byId[r.id] = r; });
  const seq = M.liveSpec({ spec: Object.assign({}, stored, byId) });
  const old = seq.map((s) => { const o = stored[s.id]; return o && !o.deleted && typeof o.order === 'number' && isFinite(o.order) ? o.order : null; });
  const keep = increasing(old), orders = new Array(seq.length);
  for (let i = 0; i < seq.length;) {
    if (keep.has(i)) { orders[i] = old[i]; i++; continue; }
    let j = i;
    while (j < seq.length && !keep.has(j)) j++;
    const m = j - i, lo = i > 0 ? orders[i - 1] : null, hi = j < seq.length ? old[j] : null;
    for (let k = 0; k < m; k++) {
      orders[i + k] = lo == null && hi == null ? k + 1 : lo == null ? hi - 1 + (k + 1) / (m + 1) : hi == null ? lo + k + 1 : lo + (hi - lo) * (k + 1) / (m + 1);
    }
    i = j;
  }
  seq.forEach((s, i) => {
    if (byId[s.id]) byId[s.id].order = orders[i];
    else if (stored[s.id].order !== orders[i]) byId[s.id] = M.specStamp(Object.assign({}, stored[s.id], { order: orders[i] }), user);
  });
  const cleanOf = (r) => M.liveSpec({ spec: { x: Object.assign({}, r, { deleted: false }) } })[0];
  return Object.keys(byId).map((k) => byId[k]).filter((r) => {
    const o = stored[r.id];
    if (!o || o.deleted || r.deleted) return true;
    const a = cleanOf(o), b = cleanOf(r);
    return !(a.order === b.order && a.level === b.level && a.title === b.title && a.kind === b.kind && a.body === b.body);
  });
}

// The document as the checkout's edits make it: requirements first (so a new {REQ-049} in
// scribe.md resolves), then the description, exactly as Import and Edit all do in the browser.
// Records are stamped with `user` but nothing is written. Also says what changed.
function buildLocal(eng, base, files, user) {
  const { M } = eng;
  const doc = clone(base);
  const reqRecords = [], reqs = { added: [], changed: [], notInFile: [] };

  const rows = M.parseTable(files['reqs.csv'] || '');
  if (rows.length) {
    const head = rows[0].map((h) => REQ_FIELD[String(h).trim().toLowerCase()]);
    const cellsByRef = {};
    rows.slice(1).forEach((r) => {
      const cells = {};
      head.forEach((f, i) => { if (f) cells[f] = r[i] == null ? '' : String(r[i]); });
      if (norm(cells.ref)) cellsByRef[norm(cells.ref).toUpperCase()] = cells;
    });
    const res = rows.length > 1 ? M.importReqs(doc, rows, user) : { records: [] };
    res.records.forEach((rec) => {
      const prev = base.reqs && base.reqs[rec.id];
      if (!prev || prev.deleted) { reqRecords.push(rec); reqs.added.push({ ref: rec.ref, text: rec.text }); return; }
      const cells = cellsByRef[norm(rec.ref).toUpperCase()] || {};
      const next = Object.assign({}, prev), changed = [];
      REQ_EDITABLE.forEach((f) => {
        if (norm(prev[f]) === norm(rec[f])) return;
        // An empty cell for an empty field stays empty (importReqs fills in defaults for blanks).
        if (cells[f] !== undefined && norm(cells[f]) === '' && norm(prev[f]) === '') return;
        next[f] = rec[f];
        changed.push(f);
      });
      // Editing an approved requirement's words makes it Changed, as in the browser.
      if (changed.indexOf('text') >= 0 && prev.status === 'approved' && changed.indexOf('status') < 0) { next.status = 'changed'; changed.push('status'); }
      if (!changed.length) return;
      reqRecords.push(M.stamp(next, user));
      reqs.changed.push({ ref: prev.ref, fields: changed });
    });
    M.liveReqs(base).forEach((q) => { if (!cellsByRef[norm(q.ref).toUpperCase()]) reqs.notInFile.push(q.ref || q.id); });
  }
  if (reqRecords.length) doc.reqs = Object.assign({}, doc.reqs || {});
  reqRecords.forEach((r) => { doc.reqs[r.id] = r; });

  const specRecords = keepOrders(M, doc, M.specSaveAll(doc, files['scribe.md'] || '', user), user);
  const spec = { added: [], changed: [], deleted: [] };
  const was = {};
  M.liveSpec(base).forEach((s) => { was[s.id] = s; });
  specRecords.forEach((r) => {
    const o = was[r.id];
    if (r.deleted) { if (o) spec.deleted.push(o.title || 'Untitled'); return; }
    const now = M.liveSpec({ spec: { x: r } })[0];
    if (!o) { spec.added.push(now.title || 'Untitled'); return; }
    const what = [];
    if (o.title !== now.title) what.push('renamed from “' + o.title + '”');
    if (o.body !== now.body) what.push('text');
    if (o.kind !== now.kind) what.push('kind');
    if (o.level !== now.level) what.push('level');
    if (o.order !== now.order) what.push('moved');
    spec.changed.push({ title: now.title || 'Untitled', what });
  });
  if (specRecords.length) doc.spec = Object.assign({}, doc.spec || {});
  specRecords.forEach((r) => { doc.spec[r.id] = r; });
  return { doc, records: { reqs: reqRecords, spec: specRecords }, changes: { reqs, spec } };
}

// What the Scribe tab and Requirements tab would show for `doc`. `text`, the checkout's scribe.md,
// adds the marks that don't parse, by line. Data keys say untraced; the tab says Unlinked.
function analyze(eng, doc, text) {
  const { M, T } = eng;
  const a = M.specAnalysis(doc), lists = { untraced: [], flagged: [], notes: [], broken: [], unknownUses: [], marks: [] };
  a.sections.forEach((x) => {
    const section = x.sec.title || 'Untitled';
    x.blocks.forEach((bk) => {
      if (bk.type === 'uses') (bk.items || []).forEach((it) => { if (!a.ctx.titles[String(it.name).toLowerCase()]) lists.unknownUses.push({ section, name: it.name }); });
      (bk.units || []).forEach((u) => {
        if (u.state === 'untraced') lists.untraced.push({ section, text: u.text });
        if (u.state === 'tag') lists.flagged.push({ section, text: u.text });
        if (u.state === 'note') lists.notes.push({ section, text: u.text });
        if (u.missing && u.missing.length) lists.broken.push({ section, text: u.text, links: u.missing.slice() });
      });
    });
  });
  if (text != null && M.specBrokenMarks) lists.marks = M.specBrokenMarks(text).map((b) => ({ line: b.line, section: b.heading || '', text: b.text }));
  const reqStats = M.reqStats(doc);
  let summary = null;
  try { summary = M.projectSummary(doc, T); } catch (e) { summary = null; }
  return {
    scribe: {
      on: M.specEnabled(doc), sections: a.totals.sections, sentences: a.totals.units, linked: a.totals.linked,
      standard: a.totals.std, flagged: a.totals.tag, untraced: a.totals.untraced, notes: a.totals.note || 0,
      lists: Object.assign(lists, { undescribed: a.undescribed.map((id) => ({ ref: a.ctx.reqs[id].ref || id, text: a.ctx.reqs[id].text })) })
    },
    reqs: { on: M.reqsEnabled(doc), total: reqStats.total, deprecated: reqStats.deprecated, draft: reqStats.draft || 0, approved: reqStats.approved || 0,
      changed: reqStats.changed || 0, duplicates: reqStats.duplicates },
    checks: summary ? { total: summary.total, reviewed: summary.reviewed, pct: summary.pct, open: summary.open.length } : null
  };
}

// ── Checkouts ──────────────────────────────────────────────
// Git's blob id of a file's bytes, as GitHub reports it.
function gitBlobSha(bytes) {
  return require('crypto').createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}

const inside =(child, parent) => { const rel = path.relative(parent, child); return !rel.startsWith('..') && !path.isAbsolute(rel); };

function gitRemoteNames(dir) {
  const dot = path.join(dir, '.git');
  let gitdir = dot;
  try {
    if (fs.statSync(dot).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dot, 'utf8'));
      if (!m) return [];
      gitdir = path.resolve(dir, m[1].trim());
      const common = path.join(gitdir, 'commondir');
      if (fs.existsSync(common)) gitdir = path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim());
    }
    const cfg = fs.readFileSync(path.join(gitdir, 'config'), 'utf8'), names = [];
    cfg.replace(/^\s*url\s*=\s*(.+)$/gm, (all, url) => { const m = /[/:]([^/:]+?)(\.git)?\/?\s*$/.exec(url.trim()); if (m) names.push(m[1]); return all; });
    return names;
  } catch (e) { return []; }
}

// Review data is private, and the tool repos are public: no checkout inside a tool folder, a
// Signoff tool repo, or the folder the tool repos sit in.
function checkoutAllowed(eng, dir) {
  const target = path.resolve(dir), names = new Set(TOOL_REPOS.concat([eng.C.repos.toolRepo], (eng.C.repos.suite || []).filter((n) => !/_data$/.test(n))));
  const why = 'Checkouts hold private review data and the Signoff tool repos are public, so ';
  if (inside(target, TOOL_ROOT)) throw new CliError(why + 'pull won’t write inside ' + TOOL_ROOT + '. Name a folder elsewhere, or set "checkouts" in ~/.signoff/config.json.');
  const suite = path.dirname(TOOL_ROOT);
  if (fs.existsSync(path.join(suite, 'ee_design_review')) && inside(target, suite)) {
    throw new CliError(why + 'pull won’t write inside ' + suite + ', where they sit. Name a folder elsewhere, or set "checkouts" in ~/.signoff/config.json.');
  }
  for (let d = target; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      const hit = gitRemoteNames(d).find((n) => names.has(n));
      if (hit) throw new CliError(why + 'pull won’t write inside ' + d + ' (the ' + hit + ' repo).');
      break;
    }
    if (path.dirname(d) === d) break;
  }
}

function defaultDir(ctx, doc) {
  const slug = doc.slug || ctx.eng.M.slugify(doc.meta.name) || doc.id;
  return ctx.config.checkouts ? path.resolve(ctx.config.checkouts, ctx.eng.key, slug) : path.resolve(ctx.io.cwd, slug);
}

function readCheckout(ctx, dir) {
  const file = path.join(dir, CHECKOUT_FILE);
  if (!fs.existsSync(file)) throw new CliError('Not a checkout: ' + dir + ' (no ' + CHECKOUT_FILE + '). Make one with `pull <review>`.', 2);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (meta.tool !== ctx.eng.key) throw new CliError('That checkout is from Signoff ' + String(meta.tool).toUpperCase() + '. Run that tool’s tools/signoff.js.', 2);
  const bytes = fs.readFileSync(path.join(dir, 'review.json'));
  // review.json is the base every comparison starts from: it must be the file as pulled.
  if (meta.blob && gitBlobSha(bytes) !== meta.blob) {
    throw new CliError('review.json in ' + dir + ' isn’t the file that was pulled (it was edited or replaced). Edit scribe.md and reqs.csv instead; to start over, pull into a new folder, or pull here with --force.', 2);
  }
  const text = bytes.toString('utf8');
  const base = JSON.parse(text), clean = pristine(ctx.eng, base), files = {}, edited = [], missing = [];
  Object.keys(clean).forEach((f) => {
    const p = path.join(dir, f);
    // A missing file counts as unedited, never as "delete everything in it".
    if (!fs.existsSync(p)) { files[f] = clean[f]; missing.push(f); return; }
    files[f] = fs.readFileSync(p, 'utf8');
    if (!sameText(files[f], clean[f])) edited.push(f);
  });
  return { dir, meta, text, base, files, edited, missing };
}

// ── Reports ────────────────────────────────────────────────
function statusData(ctx, co) {
  const built = buildLocal(ctx.eng, co.base, co.files, userName(ctx));
  const m = co.base.meta || {};
  // Files as pulled must change nothing. If they do, the text forms can't hold this review
  // exactly (two requirements with one ID do that), and a push would change what nobody edited.
  const roundTrip = buildLocal(ctx.eng, co.base, pristine(ctx.eng, co.base), userName(ctx)).records;
  const drift = roundTrip.reqs.length + roundTrip.spec.length;
  return {
    review: { id: co.base.id, name: m.name || '', project: m.project || '', stage: m.stage || '', repo: co.meta.repo, pulledAt: co.meta.pulledAt, blob: co.meta.blob },
    warning: drift ? 'The files as pulled would already change ' + plural(drift, 'record') + ' (' +
      roundTrip.reqs.map((q) => q.ref || q.id).concat(roundTrip.spec.map((s) => s.title || s.id)).join(', ') +
      '). This review doesn’t round-trip through scribe.md and reqs.csv, so don’t push it; fix the cause in the browser first (for example, two requirements with one ID).' : '',
    edited: co.edited, missing: co.missing,
    changes: built.changes,
    now: analyze(ctx.eng, built.doc, co.files['scribe.md'])
  };
}

function shortList(items, fmt, cap) {
  const lines = items.slice(0, cap).map(fmt);
  if (items.length > cap) lines.push('… and ' + (items.length - cap) + ' more (status.md lists them all)');
  return lines;
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
function joinAnd(list) { return list.length < 3 ? list.join(' and ') : list.slice(0, -1).join(', ') + ', and ' + list[list.length - 1]; }

// The status as lines. markdown: headings and bullets for status.md; else terminal text.
function statusLines(ctx, st, markdown, cap) {
  const L = [], c = st.changes, sc = st.now.scribe, rq = st.now.reqs;
  const h = (t) => L.push(markdown ? '\n## ' + t + '\n' : '\n' + t);
  const li = (t) => L.push(markdown ? '- ' + t : '  ' + t);
  const sub = (t) => L.push(markdown ? '  - ' + t : '    ' + t);
  if (markdown) L.push('# ' + st.review.name + '\n\nGenerated by `node tools/signoff.js status`. Don’t edit: it’s rewritten on every status and pull.\n');
  else L.push(st.review.name);
  li([ctx.eng.C.product, st.review.project, st.review.stage].filter(Boolean).join(' · '));
  li('From ' + st.review.repo + ', pulled ' + String(st.review.pulledAt || '').replace('T', ' ').slice(0, 16) + ' UTC');

  if (st.warning) L.push((markdown ? '\n**Warning:** ' : '\nWarning: ') + st.warning);
  h('Local edits');
  if (!st.edited.length) li('None: scribe.md and reqs.csv are as pulled.');
  else {
    li('Edited: ' + st.edited.join(', '));
    if (c.reqs.added.length) li('Requirements added: ' + c.reqs.added.map((q) => q.ref).join(', '));
    if (c.reqs.changed.length) li('Requirements changed: ' + c.reqs.changed.map((q) => q.ref + ' (' + q.fields.join(', ') + ')').join('; '));
    if (c.spec.added.length) li('Sections added: ' + c.spec.added.join('; '));
    if (c.spec.changed.length) li('Sections changed: ' + c.spec.changed.map((s) => s.title + ' (' + s.what.join(', ') + ')').join('; '));
    if (c.spec.deleted.length) li('Sections deleted: ' + c.spec.deleted.join('; '));
    if (!c.reqs.added.length && !c.reqs.changed.length && !c.spec.added.length && !c.spec.changed.length && !c.spec.deleted.length) li('The edits change nothing in the review.');
  }
  if (c.reqs.notInFile.length) li('Not in reqs.csv, so kept as they are: ' + c.reqs.notInFile.join(', ') + '. (Retire one with Status deprecated.)');
  if (st.missing.length) li('Missing, so treated as unedited: ' + st.missing.join(', '));

  h(ctx.eng.C.spec && ctx.eng.C.spec.label || 'Scribe');
  if (!sc.on) li('Not ticked for this review, so the browser hides it.');
  li(plural(sc.sections, 'section') + ', ' + plural(sc.sentences, 'sentence') + ': ' + sc.linked + ' linked, ' + sc.standard + ' standard, ' + sc.flagged + ' @req, ' +
    plural(sc.notes, 'review note') + ', ' + sc.untraced + ' unlinked');
  const lst = sc.lists;
  [['Marks that don’t parse', lst.marks, (x) => 'line ' + x.line + (x.section ? ' (' + x.section + ')' : '') + ': ' + x.text],
    ['Broken links', lst.broken, (x) => x.section + ': {' + x.links.join(', ') + '} in “' + x.text + '”'],
    [ctx.eng.M.specLinkWords().join(' or ') + ' names with no section', lst.unknownUses, (x) => x.section + ': ' + x.name],
    ['Unlinked', lst.untraced, (x) => x.section + ': ' + x.text],
    ['Flagged @req', lst.flagged, (x) => x.section + ': ' + x.text],
    ['Review notes (Check:)', lst.notes, (x) => x.section + ': ' + x.text],
    ['Requirements not described', lst.undescribed, (x) => x.ref + ': ' + x.text]].forEach(([title, items, fmt]) => {
    if (!items.length) return;
    li(title + ' (' + items.length + '):');
    shortList(items, fmt, cap).forEach(sub);
  });

  h('Requirements');
  if (!rq.on) li('Not ticked for this review, so the browser hides them.');
  const by = [['draft', rq.draft], ['approved', rq.approved], ['changed', rq.changed], ['deprecated', rq.deprecated]].filter((x) => x[1]).map((x) => x[1] + ' ' + x[0]);
  li(plural(rq.total, 'requirement') + (by.length ? ' (' + joinAnd(by) + ')' : ''));
  if (rq.duplicates.length) li('The same ID twice: ' + rq.duplicates.join(', ') + '. Links to them don’t resolve.');

  if (st.now.checks) {
    h('Checks');
    li(st.now.checks.reviewed + ' of ' + st.now.checks.total + ' reviewed (' + st.now.checks.pct + '%), ' + plural(st.now.checks.open, 'open issue'));
  }
  return L;
}

function writeStatusFile(ctx, dir, st) {
  fs.writeFileSync(path.join(dir, 'status.md'), statusLines(ctx, st, true, Infinity).join('\n') + '\n');
}

// ── Commands ───────────────────────────────────────────────
async function cmdWhoami(ctx) {
  const gh = github(ctx), C = ctx.eng.C;
  const u = await gh.account.user();
  let data = 'yes (FTE)';
  try { await gh.store(C.repos.owner + '/' + C.repos.dataRepo).snapshot(); } catch (err) { if (denied(err)) data = 'no (a contractor’s token: only shared reviews)'; else throw err; }
  const info = { login: u.login, name: userName(ctx, u), tool: C.product, dataRepo: C.repos.owner + '/' + C.repos.dataRepo, dataAccess: data.startsWith('yes'), tokenFrom: gh.tokenSource };
  if (ctx.opts.json) return out(ctx, info);
  out(ctx, [
    'GitHub login: ' + info.login,
    'Edits will be stamped: ' + info.name + (ctx.config.name ? '' : ' (set "name" in ~/.signoff/config.json to change it)'),
    'Tool: ' + info.tool,
    'Data repo ' + info.dataRepo + ': ' + data,
    'Token from: ' + info.tokenFrom
  ].join('\n'));
}

async function cmdList(ctx) {
  const { M, T, C } = ctx.eng;
  const g = await gather(ctx), want = ctx.opts.project ? String(ctx.opts.project).toLowerCase() : '';
  const rows = g.reviews.filter((r) => (ctx.opts.all || !r.doc.meta.archived) && (!want || String(r.doc.meta.project || '').toLowerCase().includes(want))).map((r) => {
    let s = null;
    try { s = M.projectSummary(r.doc, T); } catch (e) { s = null; }
    const a = analyze(ctx.eng, r.doc);
    return { id: r.doc.id, slug: r.doc.slug || '', name: r.doc.meta.name || '', project: r.doc.meta.project || '', stage: r.doc.meta.stage || '',
      archived: !!r.doc.meta.archived, repo: r.repo, checks: s && s.total ? s.pct + '%' : '–', reqs: a.reqs.total,
      scribe: !a.scribe.on ? 'off' : !a.scribe.sections ? 'empty' : plural(a.scribe.sections, 'section') + ', ' + a.scribe.untraced + ' unlinked, ' + a.scribe.flagged + ' @req, ' + a.scribe.notes + ' notes, ' + a.scribe.lists.undescribed.length + ' not described' };
  }).sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  if (ctx.opts.json) return out(ctx, { fte: g.fte, reviews: rows, errors: g.errors });
  const units = (C.words && C.words.units) || 'reviews';
  const lines = [C.product + ': ' + plural(rows.length, units.replace(/s$/, ''), units) + (g.fte ? '' : ' shared with you')];
  const cols = [['id', 'id'], ['name', 'name'], ['project', 'project'], ['stage', 'stage'], ['checks', 'checks'], ['reqs', 'reqs'], ['scribe', (C.spec && C.spec.label) || 'Scribe']];
  const width = cols.map(([k, label]) => Math.max(label.length, ...rows.map((r) => String(r[k]).length)));
  lines.push(cols.map(([, label], i) => label.padEnd(width[i])).join('  ').trimEnd());
  rows.forEach((r) => lines.push(cols.map(([k], i) => String(r[k]).padEnd(width[i])).join('  ').trimEnd() + (r.archived ? '  (archived)' : '')));
  g.errors.forEach((e) => lines.push('! ' + e.repo + ': ' + e.message));
  out(ctx, lines.join('\n'));
}

async function cmdPull(ctx, args) {
  const q = args[0];
  if (!q) throw new CliError('Which review? `pull <id, slug, or name> [dir]`', 2);
  const g = await gather(ctx), r = pick(g.reviews, q);
  const dir = args[1] ? path.resolve(ctx.io.cwd, args[1]) : defaultDir(ctx, r.doc);
  checkoutAllowed(ctx.eng, dir);
  if (fs.existsSync(path.join(dir, CHECKOUT_FILE))) {
    const old = JSON.parse(fs.readFileSync(path.join(dir, CHECKOUT_FILE), 'utf8'));
    if (old.id !== r.doc.id) throw new CliError(dir + ' is the checkout of another review (' + old.name + '). Name another folder.', 2);
    if (old.tool === ctx.eng.key && !ctx.opts.force) {
      const co = readCheckout(ctx, dir);
      if (co.edited.length && !ctx.opts.force) throw new CliError(dir + ' has edits that aren’t in the review (' + co.edited.join(', ') + '). Keep them: move them aside first, or pass --force to overwrite them.', 2);
    }
  } else if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    throw new CliError(dir + ' isn’t empty. Name an empty or new folder.', 2);
  }
  fs.mkdirSync(dir, { recursive: true });
  const files = pristine(ctx.eng, r.doc);
  fs.writeFileSync(path.join(dir, 'review.json'), r.text);
  Object.keys(files).forEach((f) => fs.writeFileSync(path.join(dir, f), files[f]));
  const meta = { signoff: 1, tool: ctx.eng.key, toolRepo: ctx.eng.C.repos.toolRepo, repo: r.repo, path: r.path, id: r.doc.id, name: r.doc.meta.name || '',
    blob: r.sha, head: r.head, pulledAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, CHECKOUT_FILE), JSON.stringify(meta, null, 2) + '\n');
  const st = statusData(ctx, readCheckout(ctx, dir));
  writeStatusFile(ctx, dir, st);
  if (ctx.opts.json) return out(ctx, { dir, review: st.review, files: ['review.json', 'scribe.md', 'reqs.csv', 'status.md', CHECKOUT_FILE] });
  const sc = st.now.scribe;
  out(ctx, [
    'Pulled ' + st.review.name + ' into ' + dir,
    '  scribe.md   ' + plural(sc.sections, 'section') + ' (' + sc.untraced + ' unlinked sentences, ' + plural(sc.notes, 'review note') + ')',
    '  reqs.csv    ' + plural(st.now.reqs.total, 'requirement'),
    '  status.md   what the tabs would show; `status` refreshes it',
    '  review.json the review as stored: the base for status and push. Don’t edit it.'
  ].join('\n'));
}

async function cmdStatus(ctx, args) {
  const dir = path.resolve(ctx.io.cwd, args[0] || '.');
  const co = readCheckout(ctx, dir), st = statusData(ctx, co);
  writeStatusFile(ctx, dir, st);
  if (ctx.opts.json) return out(ctx, st);
  out(ctx, statusLines(ctx, st, false, LIST_CAP).join('\n'));
}

// A review's document: from a checkout (with its edits when `local`), else from GitHub.
async function docFor(ctx, arg, local) {
  const dir = path.resolve(ctx.io.cwd, arg || '.');
  if (fs.existsSync(path.join(dir, CHECKOUT_FILE))) {
    const co = readCheckout(ctx, dir);
    return local ? buildLocal(ctx.eng, co.base, co.files, userName(ctx)).doc : co.base;
  }
  if (!arg) throw new CliError('Not in a checkout. Name a checkout folder or a review.', 2);
  return pick((await gather(ctx)).reviews, arg).doc;
}

async function cmdOpen(ctx, args) {
  const { C, M } = ctx.eng, doc = await docFor(ctx, args[0], false);
  let url = String(C.hostedBase || '').replace(/\/$/, '') + '/' + C.repos.toolRepo + '/index.html?project=' + encodeURIComponent(doc.id);
  if (ctx.opts.req) {
    const want = String(ctx.opts.req).toLowerCase();
    const q = M.liveReqs(doc).find((x) => x.id === ctx.opts.req || String(x.ref || '').toLowerCase() === want);
    if (!q) throw new CliError('No requirement ' + ctx.opts.req + ' in ' + doc.meta.name + ' as stored (a new one appears once pushed).', 2);
    url += '&req=' + encodeURIComponent(q.id);
  }
  if (ctx.opts.item) url += '&item=' + encodeURIComponent(ctx.opts.item);
  if (ctx.opts.json) return out(ctx, { url });
  out(ctx, url);
}

async function cmdExport(ctx, args) {
  const doc = await docFor(ctx, args[0], true), md = ctx.eng.M.specMarkdown(doc);
  if (ctx.opts.out) {
    const file = path.resolve(ctx.io.cwd, ctx.opts.out);
    fs.writeFileSync(file, md);
    return out(ctx, ctx.opts.json ? { file } : 'Wrote ' + file);
  }
  ctx.io.out(md.endsWith('\n') ? md : md + '\n');
}

// ── Push ───────────────────────────────────────────────────
// A push is planned the same way twice: once for --dry-run, which prints the plan and a code,
// and again for --confirm <code>, which commits only if the code still matches. The code covers
// the checkout's files, the stored file they were pulled from, the file on GitHub now, and the
// name edits are stamped with, so what is committed is what the dry run showed.

const MAP_KEYS = ['items', 'sections', 'comments', 'custom', 'reqs', 'revisions', 'spec'];

function pushCode(co, remoteSha, user) {
  const h = require('crypto').createHash('sha256');
  [co.meta.repo, co.meta.path, co.meta.blob, remoteSha, co.files['scribe.md'], co.files['reqs.csv'], user].forEach((v) => h.update(String(v) + '\0'));
  return h.digest('hex').slice(0, 10);
}

// The checklists the browser would summarize with: the tool repo's, over the ones bundled here.
async function currentTemplates(ctx) {
  const { C, M, T } = ctx.eng;
  try {
    const res = await github(ctx).store(C.repos.owner + '/' + C.repos.toolRepo).sync({}, null, {}, { tool: true, pullOnly: true, belongsHere: () => false });
    return res.templates && res.templates.length ? M.resolveTemplates(globalThis.SIGNOFF_TEMPLATES || [], res.templates) : T;
  } catch (e) {
    return T;
  }
}

// Where two documents differ, apart from the given records and the summary: ['reqs.<id>', 'meta', …].
// A map that's empty on one side and missing on the other is no difference.
function differences(M, a, b, touched) {
  const out = [], keys = new Set(Object.keys(a).concat(Object.keys(b)));
  keys.forEach((k) => {
    if (k === 'summary') return;
    const x = a[k], y = b[k];
    if (MAP_KEYS.indexOf(k) >= 0) {
      new Set(Object.keys(x || {}).concat(Object.keys(y || {}))).forEach((id) => {
        if (touched[k] && touched[k].has(id)) return;
        if (M.stableStringify((x || {})[id]) !== M.stableStringify((y || {})[id])) out.push(k + '.' + id);
      });
    } else if (M.stableStringify(x) !== M.stableStringify(y)) out.push(k);
  });
  return out;
}

async function planPush(ctx, co) {
  const { M, C } = ctx.eng, gh = github(ctx);
  const user = userName(ctx, await gh.account.user());
  const st = statusData(ctx, co);
  if (st.warning) throw new CliError(st.warning, 2);
  const built = buildLocal(ctx.eng, co.base, co.files, user);
  const plan = { user, changes: built.changes, records: built.records.reqs.length + built.records.spec.length };
  if (!plan.records) return plan;

  const store = gh.store(co.meta.repo), snap = await store.snapshot();
  const entry = snap.entries.find((e) => e.type === 'blob' && e.path === co.meta.path);
  if (!entry) throw new CliError(co.meta.path + ' is no longer in ' + co.meta.repo + ' (deleted, or moved when the review was shared). Nothing was pushed; pull it again.', 2);
  if (co.meta.repo.toLowerCase() === (C.repos.owner + '/' + C.repos.dataRepo).toLowerCase()) {
    const rosterEntry = snap.entries.find((e) => e.type === 'blob' && e.path === 'users.json');
    let roster = null;
    if (rosterEntry) { try { roster = JSON.parse(await store.blob(rosterEntry.sha)); } catch (e) { roster = null; } }
    const moved = M.sharedRepo(roster, co.meta.id);
    if (moved) throw new CliError('This review now lives in ' + moved + ' (it was shared). Nothing was pushed; pull it again.', 2);
  }
  const remoteText = await store.blob(entry.sha);
  const remote = JSON.parse(remoteText);
  if (!remote || remote.id !== co.meta.id) throw new CliError(co.meta.path + ' on GitHub isn’t this review any more. Nothing was pushed.', 2);
  if (M.stableStringify(remote) !== remoteText) throw new CliError(co.meta.path + ' on GitHub wasn’t written by Signoff, so it isn’t changed.', 2);
  // A requirement changed here is the whole record as pulled, stamped now: newer wins would undo
  // any edit made to it on GitHub since the pull (sections get a conflict copy; requirements
  // don't). So it must still be as pulled there, as patchRecords' bases check does.
  const stale = built.records.reqs.filter((r) => {
    const was = (co.base.reqs || {})[r.id];
    return was && M.stableStringify((remote.reqs || {})[r.id]) !== M.stableStringify(was);
  }).map((r) => r.ref || r.id);
  if (stale.length) {
    throw new CliError(joinAnd(stale) + (stale.length === 1 ? ' was' : ' were') + ' edited on GitHub since the pull, and this push would undo that. Nothing was pushed. ' +
      'Copy scribe.md and reqs.csv aside, pull again with --force, and make the change to ' + (stale.length === 1 ? 'it' : 'them') + ' again.', 2);
  }

  // The browser's merge: per record, newer wins; a section edited on both sides keeps a conflict copy.
  // Three ways against review.json, the review as pulled: only a section edited in this checkout can
  // be one side of a conflict (model.mergeSpec, base).
  const merged = M.mergeProjects(built.doc, remote, { base: M.specBase(co.base) });
  const T = await currentTemplates(ctx);
  const written = M.withSummary(merged, (d) => M.projectSummary(d, T));
  const text = M.stableStringify(written);
  // What's pushed must round-trip too, or the next pull can't be pushed (a requirement added here
  // and another on GitHub with the same ID, say).
  const again = buildLocal(ctx.eng, written, pristine(ctx.eng, written), user).records;
  if (again.reqs.length + again.spec.length) {
    throw new CliError('Merged with GitHub, the review wouldn’t round-trip through scribe.md and reqs.csv (' +
      again.reqs.map((q) => q.ref || q.id).concat(again.spec.map((s) => s.title || s.id)).join(', ') +
      '); two requirements with one ID do that. Nothing was pushed. Pull again, give each requirement its own ID, and push.', 2);
  }

  // The proof: apart from the records this push writes, the conflict copies the merge makes, and
  // the derived summary, the file must stay exactly as it is on GitHub.
  const touched = { reqs: new Set(built.records.reqs.map((r) => r.id)), spec: new Set(built.records.spec.map((r) => r.id)) };
  const conflicts = [];
  Object.keys(merged.spec || {}).forEach((id) => {
    if (!(remote.spec || {})[id] && !(built.doc.spec || {})[id]) { touched.spec.add(id); conflicts.push(merged.spec[id].title || id); }
  });
  const extra = differences(M, remote, written, touched);
  if (extra.length) {
    throw new CliError('Pushing would change more than these edits (' + extra.slice(0, 10).join(', ') + (extra.length > 10 ? ', …' : '') +
      '). Nothing was pushed. The review on GitHub may hold something this copy of the tool doesn’t know: update the tool and pull again.', 1);
  }
  // Records of ours that lost to a newer edit on GitHub (one made after this push was stamped).
  const lost = [];
  ['reqs', 'spec'].forEach((k) => built.records[k].forEach((r) => {
    if (M.stableStringify((written[k] || {})[r.id]) !== M.stableStringify(r)) lost.push(k === 'reqs' ? (r.ref || r.id) : (r.title || r.id));
  }));
  return Object.assign(plan, {
    store, snap, remoteSha: entry.sha, remoteChanged: entry.sha !== co.meta.blob, text, conflicts, lost,
    summary: { before: summaryLine(remote.summary || {}), after: summaryLine(written.summary || {}) },
    code: pushCode(co, entry.sha, user)
  });
}

function summaryLine(s) {
  const parts = [];
  if (s.reqs) parts.push(plural(s.reqs.total, 'requirement'));
  if (s.spec) parts.push('Scribe ' + plural(s.spec.sections, 'section') + ', ' + s.spec.untraced + ' unlinked, ' + s.spec.flagged + ' @req, ' + (s.spec.notes || 0) + ' notes, ' + s.spec.undescribed + ' not described');
  if (s.total) parts.push(s.pct + '% of checks reviewed');
  return parts.join('; ') || 'nothing';
}

function planLines(ctx, co, p, dir) {
  const c = p.changes, L = [];
  L.push((ctx.opts.confirm ? 'Pushing ' : 'Dry run: push ') + co.base.meta.name + ' to ' + co.meta.repo + ' (' + co.meta.path + '), stamped ' + p.user);
  if (c.reqs.added.length) L.push('  Requirements added (' + c.reqs.added.length + '): ' + c.reqs.added.map((q) => q.ref).join(', '));
  if (c.reqs.changed.length) L.push('  Requirements changed (' + c.reqs.changed.length + '): ' + c.reqs.changed.map((q) => q.ref + ' (' + q.fields.join(', ') + ')').join('; '));
  if (c.spec.added.length) L.push('  Sections added (' + c.spec.added.length + '): ' + c.spec.added.join('; '));
  if (c.spec.changed.length) L.push('  Sections changed (' + c.spec.changed.length + '): ' + c.spec.changed.map((s) => s.title + ' (' + s.what.join(', ') + ')').join('; '));
  if (c.spec.deleted.length) L.push('  Sections deleted (' + c.spec.deleted.length + '): ' + c.spec.deleted.join('; '));
  if (c.reqs.notInFile.length) L.push('  Kept, though not in reqs.csv: ' + c.reqs.notInFile.join(', '));
  L.push('  Changed on GitHub since the pull: ' + (p.remoteChanged ? 'yes. Those edits are merged in, record by record, newer wins' : 'no'));
  if (p.conflicts.length) L.push('  Conflict copies (a section edited here and on GitHub): ' + p.conflicts.join('; '));
  if (p.lost.length) L.push('  Kept the newer version on GitHub of: ' + p.lost.join(', '));
  L.push('  Summary, which Signoff PL reads: ' + p.summary.before + ' → ' + p.summary.after);
  L.push('  Everything else in the file stays exactly as it is on GitHub.');
  if (!ctx.opts.confirm) {
    L.push('Nothing was pushed. To push exactly this, run:');
    L.push('  "' + slash(ctx.io.nodePath || process.execPath) + '" "' + slash(__filename) + '" push "' + slash(dir) + '" --confirm ' + p.code);
  }
  return L;
}

function commitMessage(ctx, co, p) {
  const c = p.changes, parts = [];
  const n = (list, what, verb) => { if (list.length) parts.push(plural(list.length, what) + ' ' + verb); };
  n(c.reqs.added, 'requirement', 'added'); n(c.reqs.changed, 'requirement', 'changed');
  n(c.spec.added, 'section', 'added'); n(c.spec.changed, 'section', 'changed'); n(c.spec.deleted, 'section', 'deleted');
  return ctx.eng.C.product + ' (command line): ' + co.base.meta.name + ': ' + joinAnd(parts) + '\n\nPushed by ' + p.user + ' with tools/signoff.js.';
}

async function cmdPush(ctx, args) {
  const dir = path.resolve(ctx.io.cwd, args[0] || '.');
  const co = readCheckout(ctx, dir);
  if (!ctx.opts['dry-run'] && !ctx.opts.confirm) throw new CliError('Run `push --dry-run` first: it shows the change and gives the code that `push --confirm <code>` needs.', 2);
  const p = await planPush(ctx, co);
  if (!p.records) return out(ctx, ctx.opts.json ? { pushed: false, records: 0 } : 'Nothing to push: scribe.md and reqs.csv change nothing in the review.');
  if (ctx.opts['dry-run']) {
    if (ctx.opts.json) return out(ctx, { pushed: false, code: p.code, changes: p.changes, remoteChanged: p.remoteChanged, conflicts: p.conflicts, lost: p.lost, summary: p.summary });
    return out(ctx, planLines(ctx, co, p, dir).join('\n'));
  }
  if (String(ctx.opts.confirm) !== p.code) {
    throw new CliError('That code is for another change: scribe.md, reqs.csv, or the review on GitHub changed since that dry run. Nothing was pushed. Run `push --dry-run` again.', 2);
  }
  // One commit with force: false. If someone pushed first, try again on top of theirs, but only
  // while this file is still the one the dry run read.
  let snap = p.snap, commit = null;
  for (let attempt = 1; !commit; attempt++) {
    try {
      commit = await p.store.commit(snap, [{ path: co.meta.path, text: p.text, label: co.base.meta.name }], commitMessage(ctx, co, p));
    } catch (err) {
      if (!(err.status === 422 || err.status === 409) || attempt >= 4) throw err;
      snap = await p.store.snapshot();
      const e = snap.entries.find((x) => x.type === 'blob' && x.path === co.meta.path);
      if (!e || e.sha !== p.remoteSha) throw new CliError('The review changed on GitHub while pushing. Nothing was pushed. Run `push --dry-run` again.', 2);
    }
  }
  // Read it back.
  const after = await p.store.snapshot();
  const e = after.entries.find((x) => x.type === 'blob' && x.path === co.meta.path);
  const back = e ? await p.store.blob(e.sha) : null;
  if (back !== p.text) throw new CliError('Pushed (' + (commit.html_url || commit.sha) + '), but reading it back gave something else. Pull into a new folder and check it before going on.', 1);
  // The checkout now starts from what was pushed.
  const doc = JSON.parse(p.text), files = pristine(ctx.eng, doc);
  fs.writeFileSync(path.join(dir, 'review.json'), p.text);
  Object.keys(files).forEach((f) => fs.writeFileSync(path.join(dir, f), files[f]));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, CHECKOUT_FILE), JSON.stringify(Object.assign({}, co.meta, { blob: e.sha, head: commit.sha, pulledAt: at, pushedAt: at }), null, 2) + '\n');
  writeStatusFile(ctx, dir, statusData(ctx, readCheckout(ctx, dir)));
  const C = ctx.eng.C, link = String(C.hostedBase || '').replace(/\/$/, '') + '/' + C.repos.toolRepo + '/index.html?project=' + encodeURIComponent(doc.id);
  if (ctx.opts.json) return out(ctx, { pushed: true, commit: commit.sha, url: commit.html_url || '', link, changes: p.changes, conflicts: p.conflicts, lost: p.lost });
  out(ctx, planLines(ctx, co, p, dir).concat([
    'Pushed: ' + (commit.html_url || commit.sha) + ' (read back: it matches)',
    'The checkout now starts from what was pushed. In the browser: ' + link
  ]).join('\n'));
}

// ── The Claude Code skill ──────────────────────────────────
// `skill` writes the guide an assistant (Claude Code) needs to use this command line well: the
// loop, the file formats in each tool's own words, and the rules. It's generated, so its paths are
// this machine's (node, and each Signoff tool beside this one) and its marks are each tool's.

// The Signoff review tools next to this one that have this command line, with their config.
function siblingTools() {
  const suite = path.dirname(TOOL_ROOT), out = [];
  ['fw_design_review', 'ee_design_review', 'me_design_review'].forEach((name) => {
    const root = name === path.basename(TOOL_ROOT) ? TOOL_ROOT : path.join(suite, name);
    const cli = path.join(root, 'tools', 'signoff.js'), cfgFile = path.join(root, 'assets', 'config.js');
    if (!fs.existsSync(cli) || !fs.existsSync(cfgFile)) return;
    let cfg = null;
    try {
      const text = fs.readFileSync(cfgFile, 'utf8');
      cfg = JSON.parse(text.slice(text.indexOf('=', text.indexOf('SIGNOFF_CONFIG')) + 1).trim().replace(/;\s*$/, ''));
    } catch (e) { return; }
    out.push({ root, cli, cfg });
  });
  if (!out.some((t) => t.root === TOOL_ROOT)) out.unshift({ root: TOOL_ROOT, cli: path.join(TOOL_ROOT, 'tools', 'signoff.js'), cfg: ENGINE.C });
  return out;
}

const slash = (p) => String(p).replace(/\\/g, '/');

function skillText(ctx) {
  const tools = siblingTools(), node = slash(ctx.io.nodePath || process.execPath);
  const run = (t) => '"' + node + '" "' + slash(t.cli) + '"';
  const checkouts = ctx.config.checkouts ? slash(path.resolve(ctx.config.checkouts)) : '';
  const L = [];
  L.push('---');
  L.push('name: signoff');
  L.push('description: Work with Signoff design reviews (' + joinAnd(tools.map((t) => t.cfg.product)) + ') from the terminal. List reviews, pull a review\'s Scribe description and requirements into plain files, see what is unlinked or broken, and push edits back after the user approves a dry run. Use whenever a task reads or changes a Signoff review\'s Scribe text or requirements, such as describing firmware from its code or keeping requirements in step with it.');
  L.push('---');
  L.push('');
  L.push('# Signoff reviews from the terminal');
  L.push('');
  L.push('Each Signoff review (a board in Signoff EE, a part in Signoff ME, a firmware target in Signoff FW) is a JSON file in a private GitHub repo, merged record by record whenever anyone syncs. Never read or write those files, or call the GitHub API for review data, any other way than this command line. It runs the tools\' own code, so what it writes is exactly what the browser would write, and it checks every write.');
  L.push('');
  L.push('## Running it');
  L.push('');
  L.push('Node may not be on PATH, so use the full commands below (in PowerShell, start the line with `& `). Use the tool the review belongs to: a checkout works only with the tool it came from.');
  L.push('');
  L.push('| Tool | A review is | Command |');
  L.push('| --- | --- | --- |');
  tools.forEach((t) => L.push('| ' + t.cfg.product + ' | a ' + ((t.cfg.words && t.cfg.words.unit) || 'review') + ' | `' + run(t) + '` |'));
  L.push('');
  L.push('Below, `signoff` stands for the command in that table.');
  L.push('');
  L.push('| Command | Does |');
  L.push('| --- | --- |');
  L.push('| `signoff login` | Sign in with GitHub: prints a code to enter at github.com/login/device, then waits. The user runs it in their own terminal, since it waits on them |');
  L.push('| `signoff whoami` | The GitHub login, the name edits are stamped with, and whether the token opens the data repo |');
  L.push('| `signoff list [--project P] [--all]` | Every review the token reaches: id, name, project, stage, progress, and Scribe gaps |');
  L.push('| `signoff pull <review> [dir]` | A checkout of one review' + (checkouts ? ' (by default in `' + checkouts + '/<tool>/<review>`)' : '') + '. `<review>` is an id, a slug, or a name |');
  L.push('| `signoff status [dir]` | Offline: what the edits would change, and every gap. Rewrites `status.md` |');
  L.push('| `signoff push [dir] --dry-run` | Exactly what a push would change, and a confirm code |');
  L.push('| `signoff push [dir] --confirm <code>` | Commits that change. Only after the user approves the dry run |');
  L.push('| `signoff open [dir or review] [--req REQ-004]` | A link to the review, or one requirement, in the browser |');
  L.push('| `signoff export [dir or review] [--out file.md]` | The description as Markdown, with the checkout\'s edits |');
  L.push('');
  L.push('Every command takes `--json`. `[dir]` defaults to the current folder. The tab and the text output say *unlinked*; `--json` and the stored data say `untraced` for the same thing.');
  L.push('');
  L.push('## The loop');
  L.push('');
  L.push('1. `signoff list`, then `signoff pull <review>`. Note the checkout folder it prints.');
  L.push('2. Read `status.md`, `scribe.md`, and `reqs.csv` there.');
  L.push('3. Edit only `scribe.md` and `reqs.csv`. Never edit `review.json` or `.signoff.json`.');
  L.push('4. Run `signoff status` after each round of edits. It counts what the Scribe tab shows (sections, linked, standard, `@req`, review notes, and unlinked sentences) and lists every gap. Before going on, fix every broken link, mark that doesn\'t parse, and link name with no section. If it prints a line starting `Warning:` (two requirements with one ID cause one), stop and tell the user: that review can\'t be pushed from a checkout.');
  L.push('5. Run `signoff push --dry-run` and show the user its whole output. Its Summary line is the summary stored on GitHub, then the one the push writes. After a tool update the counts can differ in places nobody edited, because they\'re recomputed; that\'s expected, but say so.');
  L.push('6. Only after the user approves that dry run, run the confirm command it printed (`push … --confirm <code>`). An edit after the dry run makes the code stale: dry-run again and show the user again.');
  L.push('7. Give the user the `signoff open` link, so they can look at it in the browser.');
  L.push('8. When the work is pushed, or dropped, delete the checkout folder: it holds a client\'s design. Ask first if it has edits that weren\'t pushed.');
  L.push('');
  L.push('If a push refuses, report what it said. Never work around it.');
  L.push('');
  L.push('## scribe.md: the description');
  L.push('');
  L.push('It\'s the same text as the browser\'s Edit all: one document, cut into sections at its headings. Put each heading on its own line, with a blank line before it. Within a section:');
  L.push('');
  L.push('| Write | Means |');
  L.push('| --- | --- |');
  L.push('| `# Title`, `## Title`, `### Title`, `#### Title` | A section, levels 1 to 4. Sections keep their identity by title, so rename a heading only on purpose |');
  L.push('| `[words]{REQ-004}` | Links those words, and so their sentence, to a requirement by its ID. Several: `{REQ-004, REQ-007}`. A run: `{REQ-044..REQ-063}`, written out as each ID when saved |');
  L.push('| `[words]{std}` | Standard text: background that needs no requirement |');
  L.push('| `[words]{#Section title}` | Points at another section |');
  L.push('| `@req` in a sentence | Flags it to become a requirement (the user\'s inbox, Write as requirements) |');
  L.push('| `Check: …` starting a sentence or list item | A review note: a question or doubt for the review. Not a gap; the user resolves it |');
  L.push('| `> words` under a heading | The section\'s gist (else its first sentence) |');
  L.push('| `- item`; lines starting with a vertical bar; three backticks | A list (each item counts like a sentence); a table (a row with a mark counts like a sentence); code |');
  L.push('');
  tools.filter((t) => t.cfg.spec).forEach((t) => {
    const sp = t.cfg.spec, kinds = Array.isArray(sp.kinds) ? sp.kinds : ['product', 'task', 'module', 'driver', 'hardware', 'interface'];
    const links = Array.isArray(sp.links) && sp.links.length ? sp.links : ['Uses'];
    const or = (list) => list.length < 3 ? list.join(' or ') : list.slice(0, -1).join(', ') + ', or ' + list[list.length - 1];
    L.push('In ' + t.cfg.product + ':');
    L.push('');
    if (kinds.length) L.push('- A heading can end with its kind, as in `## Name * ' + (kinds[1] || kinds[0]) + '`: ' + or(kinds.map((k) => '`' + k + '`')) + '. The kind places the section in the diagram.');
    else L.push('- Headings have no kinds. The diagram is drawn from the outline.');
    L.push('- ' + or(links.map((w) => '`' + w + ':`')) + ' starts a line naming other sections by their titles, as in `' + links[0] + ': Name A, Name B`. A name can carry a label: `Name (label)`.');
    if (sp.parts) L.push('- `Parts: U7, L1, C1–C3` names the reference designators a section covers.');
    L.push('');
  });
  L.push('Every sentence and list item is linked, standard, flagged (`@req`), a review note (`Check:`), or unlinked, and `status` lists the unlinked ones. The aim: every statement of what the design does is linked to a requirement, background is standard, and every doubt is a `Check:` note.');
  L.push('');
  L.push('## reqs.csv: the requirements');
  L.push('');
  L.push('CSV with this header, one row per requirement. Quote a cell that holds a comma, a quote (doubled: `""`), or a line break.');
  L.push('');
  L.push('```');
  L.push(REQ_HEAD.join(','));
  L.push('```');
  L.push('');
  L.push('- **ID** is unique: `REQ-001`, `REQ-002`, and on. Give a new requirement the next free ID yourself, so `scribe.md` can link it before it\'s pushed. Never reuse or renumber an ID.');
  L.push('- **Requirement** is one testable statement: "The firmware shall …".');
  L.push('- **Type** is `shall` or `should`. **Verification method** is `inspection`, `analysis`, `demonstration`, or `test`.');
  L.push('- **Status** is `draft`, `approved`, `changed`, or `deprecated`. New ones are `draft`; the user approves them. Changing the words of an approved one makes it `changed`.');
  L.push('- **Discipline** is `sys`, `ee`, `me`, `fw`, or `other` (blank means the tool\'s own). **Category** groups them. **Source** says where it came from: a file and line, a document, or a meeting.');
  L.push('- A row left out is kept, never deleted. Retire a requirement with Status `deprecated`. Deleting one, and its Verified state and evidence, are done in the browser.');
  L.push('');
  L.push('## Rules');
  L.push('');
  L.push('- **Review data is private.** A checkout holds a client\'s design. Never copy it, or text from it, into a public repo, a commit message, an issue, or anything sent outside this machine, and never create a checkout inside a Signoff tool folder (`pull` refuses).');
  L.push('- **Never handle the token.** Don’t read, print, or pass the GitHub token; the command line finds it, and `whoami` says where.');
  L.push('- **Nothing is pushed without the user.** Never run `push --confirm` unless the user approved that dry run in this conversation. Never pass `--force` to `pull` without asking: it discards the checkout\'s edits.');
  L.push('- **One writer per review.** If someone may be editing the same review in the browser, say so before pushing. The dry run says whether the review changed on GitHub since the pull, and push merges such changes, but it refuses to overwrite a requirement edited there.');
  L.push('- **Say what is uncertain.** When describing existing code or a design, write what it does, not what it should do. Put doubts and contradictions in `Check:` notes, with file and line, rather than guessing.');
  L.push('');
  L.push('## If something goes wrong');
  L.push('');
  L.push('- "No GitHub token": run `signoff whoami`, and ask the user to run `signoff login` in their own terminal (it shows a code to enter on GitHub), or to set `SIGNOFF_TOKEN`, sign in with `gh auth login`, or set `tokenFile` in `~/.signoff/config.json`.');
  L.push('- "Not a checkout": pass the checkout folder, or `cd` into it.');
  L.push('- "review.json isn\'t the file that was pulled": it was edited. Ask the user before pulling again with `--force`.');
  L.push('- A dry run that would change sections nobody edited: stop and tell the user.');
  return L.join('\n') + '\n';
}

async function cmdSkill(ctx) {
  const text = skillText(ctx);
  if (!ctx.opts.install) { ctx.io.out(text); return; }
  const file = path.join(path.resolve(ctx.io.cwd, ctx.opts.install), '.claude', 'skills', 'signoff', 'SKILL.md');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== text && !ctx.opts.force) {
    throw new CliError(file + ' is already there and differs. Pass --force to replace it.', 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  out(ctx, ctx.opts.json ? { file } : 'Wrote ' + file + '. Claude Code sessions started in ' + path.resolve(ctx.io.cwd, ctx.opts.install) + ' (or under it) can now use it.');
}

// ── Main ───────────────────────────────────────────────────
function out(ctx, v) { ctx.io.out((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n'); }

const VALUE_OPTS = ['project', 'req', 'item', 'out', 'config', 'token-file', 'assets', 'confirm', 'install'];
function parseArgs(argv) {
  const args = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { opts.help = true; continue; }
    if (!a.startsWith('--')) { args.push(a); continue; }
    const eq = a.indexOf('='), name = a.slice(2, eq > 0 ? eq : undefined);
    if (VALUE_OPTS.indexOf(name) >= 0) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new CliError('--' + name + ' needs a value', 2);
      opts[name] = v;
    } else opts[name] = true;
  }
  return { cmd: args.shift(), args, opts };
}

const COMMANDS = { login: cmdLogin, logout: cmdLogout, whoami: cmdWhoami, list: cmdList, pull: cmdPull, status: cmdStatus, push: cmdPush, open: cmdOpen, export: cmdExport, skill: cmdSkill };

// io: { env, cwd, home, out(text), err(text), fetch, gh: false to skip `gh auth token`, sleep(ms) } (tests pass their own).
async function run(argv, io) {
  io = Object.assign({ env: process.env, cwd: process.cwd(), home: os.homedir(), out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), fetch: null }, io || {});
  try {
    const { cmd, args, opts } = parseArgs(argv);
    if (!cmd || opts.help || cmd === 'help') { io.out(USAGE); return 0; }
    const fn = COMMANDS[cmd];
    if (!fn) throw new CliError('Unknown command “' + cmd + '”.\n\n' + USAGE, 2);
    const eng = loadEngine(opts.assets || io.env.SIGNOFF_ASSETS);
    const ctx = { eng, io, opts, config: readConfig(io, opts) };
    if (cmd !== 'login' && cmd !== 'logout' && cmd !== 'skill' && !(io.env.SIGNOFF_TOKEN && io.env.SIGNOFF_TOKEN.trim()) && !opts['token-file']) await renewSignIn(io, ctx.config);
    await fn(ctx, args);
    return 0;
  } catch (err) {
    io.err('signoff: ' + (err instanceof CliError ? err.message : (err && err.status ? 'GitHub: ' + err.message + ' (HTTP ' + err.status + ')' : (err && err.stack) || String(err))) + '\n');
    return err instanceof CliError ? err.code : 1;
  }
}

module.exports = { run, loadEngine, buildLocal, analyze, pristine, keepOrders, checkoutAllowed, parseArgs, gitBlobSha, skillText, TOOL_ROOT };

if (require.main === module) run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
