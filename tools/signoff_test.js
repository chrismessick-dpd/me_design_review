/* Shared Signoff engine (EE, ME, and FW). Edit it in ee_design_review only; me_design_review and
   fw_design_review vendor it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Tests for tools/signoff.js, against a fake GitHub holding this tool's demo reviews and a made-up
   fixture. Runs with this tool's own assets:

     node tools/signoff_test.js

   Prints each failure and a PASS or FAIL line, and exits non-zero on failure. Nothing here is real. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const cli = require('./signoff.js');

const eng = cli.loadEngine(process.env.SIGNOFF_ASSETS);
const { M, C, T } = eng;
vm.runInThisContext(fs.readFileSync(path.join(eng.dir, 'demo.js'), 'utf8'), { filename: 'demo.js' });
const S = globalThis.Signoff;

// ── A fake GitHub ──────────────────────────────────────────
// repos: { 'owner/name': { files: { path: text } } }; reach: the repos this token opens.
// It takes commits as GitHub does (trees, commits, a ref update that refuses a non-fast-forward).
// beforeRef(full): called before each ref update, so a test can push something first.
// edit(full, path, text): someone else's commit, straight to the branch.
function fakeGitHub(repos, reach, user) {
  const blobs = {}, trees = {}, commits = {}, heads = {}, calls = [];
  let n = 0;
  const fake = { calls, beforeRef: null };
  function blobSha(text) { return crypto.createHash('sha1').update('blob ' + Buffer.byteLength(text) + '\0').update(text).digest('hex'); }
  function newTree(files) { const sha = 't' + (++n); trees[sha] = files; return sha; }
  function newCommit(tree, parents, message) { const sha = 'c' + (++n); commits[sha] = { tree, parents, message }; return sha; }
  Object.keys(repos).forEach((full) => { heads[full] = newCommit(newTree(Object.assign({}, repos[full].files)), [], 'first'); });
  const files = (full) => trees[commits[heads[full]].tree];
  fake.files = files;
  fake.edit = (full, p, text) => { heads[full] = newCommit(newTree(Object.assign({}, files(full), { [p]: text })), [heads[full]], 'someone else'); };
  fake.commitMessages = (full) => { const out = []; for (let c = heads[full]; c; c = commits[c].parents[0]) out.push(commits[c].message); return out; };
  const reply = (status, body) => Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
  fake.fetch = async function (url, init) {
    const u = new URL(url), p = u.pathname, method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push(method + ' ' + p);
    if (p === '/user') return reply(200, user);
    if (p === '/user/repos') {
      if (u.searchParams.get('page') !== '1') return reply(200, []);
      return reply(200, reach.map((full) => ({ name: full.split('/')[1], owner: { login: full.split('/')[0] } })));
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(.+)$/.exec(p);
    if (!m) return reply(404, { message: 'Not Found' });
    const full = m[1] + '/' + m[2], rest = m[3];
    if (!repos[full] || reach.indexOf(full) < 0) return reply(404, { message: 'Not Found' });
    if (method === 'GET' && rest === 'ref/heads/main') return reply(200, { object: { sha: heads[full] } });
    if (method === 'PATCH' && rest === 'refs/heads/main') {
      if (fake.beforeRef) fake.beforeRef(full);
      const c = commits[body.sha];
      if (!c) return reply(422, { message: 'Object does not exist' });
      if (!body.force && c.parents[0] !== heads[full]) return reply(422, { message: 'Update is not a fast forward' });
      heads[full] = body.sha;
      return reply(200, { object: { sha: body.sha } });
    }
    let mm;
    if (method === 'POST' && rest === 'trees') {
      const next = Object.assign({}, trees[body.base_tree] || {});
      body.tree.forEach((t) => { if (t.sha === null) delete next[t.path]; else next[t.path] = t.content; });
      return reply(201, { sha: newTree(next) });
    }
    if (method === 'POST' && rest === 'commits') {
      const sha = newCommit(body.tree, body.parents, body.message);
      return reply(201, { sha, html_url: 'https://github.test/' + full + '/commit/' + sha });
    }
    if (method === 'GET' && (mm = /^commits\/(\w+)$/.exec(rest))) return commits[mm[1]] ? reply(200, { sha: mm[1], tree: { sha: commits[mm[1]].tree } }) : reply(404, { message: 'Not Found' });
    if (method === 'GET' && (mm = /^trees\/(\w+)$/.exec(rest))) {
      const t = trees[mm[1]];
      if (!t) return reply(404, { message: 'Not Found' });
      return reply(200, { sha: mm[1], tree: Object.keys(t).map((path) => { const sha = blobSha(t[path]); blobs[sha] = t[path]; return { path, mode: '100644', type: 'blob', sha, size: Buffer.byteLength(t[path]) }; }) });
    }
    if (method === 'GET' && (mm = /^blobs\/(\w+)$/.exec(rest))) {
      const text = blobs[mm[1]];
      return text == null ? reply(404, { message: 'Not Found' }) : reply(200, { sha: mm[1], content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' });
    }
    return reply(404, { message: 'Not Found' });
  };
  return fake;
}

// ── Fixtures ───────────────────────────────────────────────
const OWNER = C.repos.owner, DATA = OWNER + '/' + C.repos.dataRepo, SHARED = OWNER + '/' + C.repos.prefix + 'test-shared';
const TOKEN = 'tok-never-printed-0123456789';
const summarize = (d) => M.projectSummary(d, T);
const fileText = (doc) => M.stableStringify(M.withSummary(doc, summarize));
const clone = (o) => JSON.parse(JSON.stringify(o));
// A heading's title as this tool reads it (EE has no kinds, so "* module" stays in its title).
const titleOf = (line) => M.specHeading(line).title;

const demos = S.demo.projects(T);
if (!demos.length) throw new Error('This tool has no demo reviews to test with');

// A made-up review with a description and requirements, in every tool (the demo may have none).
const FIXTURE_REQS = [
  'ID,Requirement,Type,Discipline,Category,Source,Verification method,Status',
  'REQ-001,The firmware shall read the room temperature every 1 s.,shall,,Control,,test,approved',
  'REQ-002,"The relay shall open within 50 ms, measured from the ""stop"" command.",shall,,Outputs,Bench notes,test,draft',
  'REQ-003,"Line one of a long requirement.',
  'Line two of it.",should,,,,analysis,draft',
  'REQ-004,An old requirement.,shall,,,,inspection,deprecated'
].join('\n') + '\n';
const FIXTURE_TEXT = [
  '# Test firmware * product',
  'The firmware runs a made-up wall unit. [It replaces a mechanical thermostat.]{std}',
  '',
  '## Control loop * task',
  'Every 1 s the [control loop reads the room temperature]{REQ-001} and switches the relay.',
  'Uses: Relay driver',
  '',
  '## Relay driver * driver',
  'The [relay opens within 50 ms of a stop command]{REQ-002}.',
  '',
  '## Status LED * driver',
  'The LED blinks at 1 Hz while heating.',
  'Make the LED pulse instead of blink @req',
  ''
].join('\n');
function makeFixture() {
  const doc = clone(demos[0]);
  doc.id = C.ids.project + 'clitest1';
  doc.slug = 'cli-test-firmware';
  doc.meta = Object.assign({}, doc.meta, { name: 'CLI Test Firmware', project: 'Test Project', archived: false });
  doc.meta.checklists = doc.meta.checklists.filter((x) => x !== 'reqs' && x !== 'spec').concat(['reqs', 'spec']);
  doc.reqs = {};
  doc.spec = {};
  M.importReqs(doc, M.parseTable(FIXTURE_REQS), 'Ari Chen').records.forEach((q) => { doc.reqs[q.id] = q; });
  M.specSaveAll(doc, FIXTURE_TEXT, 'Ari Chen').forEach((s) => { doc.spec[s.id] = s; });
  // Orders that aren't 1, 2, 3…, as edits in the browser leave them.
  Object.keys(doc.spec).forEach((k, i) => { doc.spec[k].order = i * 2 + 0.5; });
  return doc;
}
const fixture = makeFixture();
const archived = Object.assign(clone(demos[demos.length - 1]), { id: C.ids.project + 'clitest2', slug: 'cli-archived' });
archived.meta = Object.assign({}, archived.meta, { name: 'CLI Archived Firmware', archived: true });
const sharedDoc = Object.assign(clone(demos[0]), { id: C.ids.project + 'clitest3', slug: 'cli-shared' });
// Two requirements with one ID, as two people adding offline can make: the text forms can't hold it.
const dupDoc = Object.assign(clone(fixture), { id: C.ids.project + 'clitest4', slug: 'cli-duplicate' });
dupDoc.meta = Object.assign({}, dupDoc.meta, { name: 'CLI Duplicate Firmware' });
dupDoc.reqs = Object.assign({}, dupDoc.reqs, { qclidup: M.newReq(dupDoc, { ref: 'REQ-002', text: 'Another requirement given the same ID.' }, 'Sam Patel') });
dupDoc.reqs.qclidup.id = 'qclidup';
sharedDoc.meta = Object.assign({}, sharedDoc.meta, { name: 'CLI Shared Firmware', project: 'Shared Project' });

function repos() {
  const data = { files: {} }, shared = { files: {} };
  demos.concat([fixture, archived, dupDoc]).forEach((d) => { data.files['projects/' + d.id + '.json'] = fileText(d); });
  data.files['users.json'] = M.stableStringify({ users: {}, shared: { [sharedDoc.id]: { repo: SHARED, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'Ari Chen' } } });
  data.files['README.md'] = 'test\n';
  shared.files['projects/' + sharedDoc.id + '.json'] = fileText(sharedDoc);
  return { [DATA]: data, [SHARED]: shared };
}

// ── Running the CLI ────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-cli-test-'));
let gh = fakeGitHub(repos(), [DATA, SHARED], { login: 'aric', name: 'Ari Chen' });
async function sh(argv, opts) {
  opts = opts || {};
  let o = '', e = '';
  const code = await cli.run(argv, { env: Object.assign({ SIGNOFF_TOKEN: TOKEN }, opts.env || {}), cwd: opts.cwd || TMP, home: TMP,
    out: (s) => { o += s; }, err: (s) => { e += s; }, fetch: (opts.gh || gh).fetch, gh: false });
  return { code, out: o, err: e, json: () => JSON.parse(o) };
}

// ── Tests ──────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function ok(v, msg) { if (!v) throw new Error(msg || 'expected true'); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || 'not equal') + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); }

test('whoami names the login and data access, and never prints the token', async () => {
  const r = await sh(['whoami']);
  eq(r.code, 0, r.err);
  ok(/aric/.test(r.out) && /yes \(FTE\)/.test(r.out), r.out);
  ok(r.out.indexOf(TOKEN) < 0 && r.err.indexOf(TOKEN) < 0, 'token printed');
});

test('whoami: a token that can’t open the data repo is a contractor’s', async () => {
  const r = await sh(['whoami', '--json'], { gh: fakeGitHub(repos(), [SHARED], { login: 'sam', name: 'Sam Patel' }) });
  eq(r.code, 0, r.err);
  eq(r.json().dataAccess, false);
});

test('list: every review in the data repo and the shared repos, archived ones only with --all', async () => {
  let r = await sh(['list', '--json']);
  eq(r.code, 0, r.err);
  const ids = r.json().reviews.map((x) => x.id);
  ok(ids.indexOf(fixture.id) >= 0 && ids.indexOf(sharedDoc.id) >= 0, 'missing reviews: ' + ids);
  ok(ids.indexOf(archived.id) < 0, 'archived listed');
  demos.filter((d) => !d.meta.archived).forEach((d) => ok(ids.indexOf(d.id) >= 0, 'demo ' + d.id + ' missing'));
  r = await sh(['list', '--all', '--json']);
  ok(r.json().reviews.some((x) => x.id === archived.id), 'archived not listed with --all');
  r = await sh(['list', '--project', 'shared project', '--json']);
  eq(r.json().reviews.map((x) => x.id), [sharedDoc.id]);
});

test('list: a contractor sees only the shared repos named with this tool’s prefix', async () => {
  const r = await sh(['list', '--json'], { gh: fakeGitHub(repos(), [SHARED], { login: 'sam', name: 'Sam Patel' }) });
  eq(r.code, 0, r.err);
  eq(r.json().fte, false);
  eq(r.json().reviews.map((x) => x.id), [sharedDoc.id]);
});

test('every demo review round-trips: its files as pulled change nothing', async () => {
  demos.concat([fixture, sharedDoc]).forEach((d) => {
    const stored = JSON.parse(fileText(d)), b = cli.buildLocal(eng, stored, cli.pristine(eng, stored), 'Ari Chen');
    eq([b.records.reqs.length, b.records.spec.length], [0, 0], d.meta.name + ' changed: ' + JSON.stringify(b.changes));
  });
});

let CO = '';
test('pull writes the checkout, with review.json exactly as stored', async () => {
  CO = path.join(TMP, 'co');
  const r = await sh(['pull', 'cli test firmware', CO]);
  eq(r.code, 0, r.err);
  ['review.json', 'scribe.md', 'reqs.csv', 'status.md', '.signoff.json'].forEach((f) => ok(fs.existsSync(path.join(CO, f)), f + ' missing'));
  eq(fs.readFileSync(path.join(CO, 'review.json'), 'utf8'), fileText(fixture), 'review.json differs from the stored file');
  const meta = JSON.parse(fs.readFileSync(path.join(CO, '.signoff.json'), 'utf8'));
  eq([meta.id, meta.repo, meta.path, meta.tool], [fixture.id, DATA, 'projects/' + fixture.id + '.json', eng.key]);
  ok(/Status LED/.test(fs.readFileSync(path.join(CO, 'scribe.md'), 'utf8')), 'scribe.md lacks a heading');
  ok(/REQ-002,"The relay shall open within 50 ms, measured from the ""stop"" command\."/.test(fs.readFileSync(path.join(CO, 'reqs.csv'), 'utf8')), 'reqs.csv quoting');
});

test('status on a fresh checkout: no local edits, and the gaps the tab shows', async () => {
  const r = await sh(['status', CO, '--json']);
  eq(r.code, 0, r.err);
  const st = r.json();
  eq(st.edited, []);
  eq(st.warning, '');
  eq([st.changes.reqs.added.length, st.changes.reqs.changed.length, st.changes.spec.added.length, st.changes.spec.changed.length, st.changes.spec.deleted.length], [0, 0, 0, 0, 0]);
  ok(st.now.scribe.lists.flagged.some((x) => /LED pulse/.test(x.text)), 'the @req sentence');
  ok(st.now.scribe.lists.undescribed.some((x) => x.ref === 'REQ-003'), 'REQ-003 not described');
  ok(!st.now.scribe.lists.undescribed.some((x) => x.ref === 'REQ-004'), 'a deprecated requirement needs no description');
  ok(/None: scribe\.md and reqs\.csv are as pulled/.test(fs.readFileSync(path.join(CO, 'status.md'), 'utf8')), 'status.md');
});

test('status: a new requirement and a new section that links it, by ref', async () => {
  fs.appendFileSync(path.join(CO, 'reqs.csv'), 'REQ-900,"The firmware shall reset within 2 s of a hang.",shall,,Safety,,test,draft\n');
  fs.appendFileSync(path.join(CO, 'scribe.md'), '\n## Watchdog * module\nThe watchdog is fed by the main loop. [It resets the processor within 2 s of a hang.]{REQ-900}\n');
  const st = (await sh(['status', CO, '--json'])).json();
  eq(st.edited.sort(), ['reqs.csv', 'scribe.md']);
  eq(st.changes.reqs.added.map((q) => q.ref), ['REQ-900']);
  eq(st.changes.spec.added, [titleOf('## Watchdog * module')]);
  eq([st.changes.spec.changed.length, st.changes.spec.deleted.length], [0, 0], 'other sections changed: ' + JSON.stringify(st.changes.spec));
  eq(st.now.scribe.lists.broken, []);
  ok(st.now.scribe.lists.untraced.some((x) => x.section === titleOf('## Watchdog * module') && /fed by the main loop/.test(x.text)), 'untraced sentence');
  ok(!st.now.scribe.lists.undescribed.some((x) => x.ref === 'REQ-900'), 'REQ-900 described');
});

test('status: an edited approved requirement becomes Changed; a missing row is kept', async () => {
  const f = path.join(CO, 'reqs.csv');
  const text = fs.readFileSync(f, 'utf8').replace('every 1 s.', 'every 2 s.').replace(/^REQ-004,.*\n/m, '');
  fs.writeFileSync(f, text);
  const st = (await sh(['status', CO, '--json'])).json();
  eq(st.changes.reqs.changed, [{ ref: 'REQ-001', fields: ['text', 'status'] }]);
  eq(st.changes.reqs.notInFile, ['REQ-004']);
});

test('status: a broken link and a Uses name with no section', async () => {
  const f = path.join(CO, 'scribe.md');
  fs.appendFileSync(f, '\n## Display\nThe [screen wakes on touch]{REQ-777}.\nUses: Touch driver\n');
  const st = (await sh(['status', CO, '--json'])).json();
  ok(st.now.scribe.lists.broken.some((x) => x.links.indexOf('REQ-777') >= 0), 'broken link');
  if (C.spec && (C.spec.links || ['Uses']).some((w) => /^uses$/i.test(w))) ok(st.now.scribe.lists.unknownUses.some((x) => x.name === 'Touch driver'), 'unknown Uses name');
});

test('status: deleting a heading deletes its section; moving one changes only it', async () => {
  const f = path.join(CO, 'scribe.md');
  fs.writeFileSync(f, cli.pristine(eng, JSON.parse(fs.readFileSync(path.join(CO, 'review.json'), 'utf8')))['scribe.md']);
  let text = fs.readFileSync(f, 'utf8');
  const led = text.slice(text.indexOf('## Status LED'));
  fs.writeFileSync(f, text.replace(led, '').trimEnd() + '\n');
  let st = (await sh(['status', CO, '--json'])).json();
  eq(st.changes.spec.deleted, [titleOf('## Status LED * driver')]);
  eq(st.changes.spec.changed, []);
  text = text.replace(led, '').trimEnd() + '\n';
  const relay = text.slice(text.indexOf('## Relay driver'));
  fs.writeFileSync(f, text.replace(relay, '').replace('## Control loop', relay.trimEnd() + '\n\n## Control loop') + led);
  st = (await sh(['status', CO, '--json'])).json();
  eq(st.changes.spec.deleted, []);
  eq(st.changes.spec.changed.length, 1, JSON.stringify(st.changes.spec.changed));
  eq(st.changes.spec.changed[0].what, ['moved']);
});

test('status: a missing file is unedited, never "delete everything"', async () => {
  fs.unlinkSync(path.join(CO, 'scribe.md'));
  const st = (await sh(['status', CO, '--json'])).json();
  eq(st.missing, ['scribe.md']);
  eq(st.changes.spec.deleted, []);
});

test('pull keeps local edits unless --force', async () => {
  let r = await sh(['pull', fixture.id, CO]);
  eq(r.code, 2, 'pulled over edits');
  ok(/has edits/.test(r.err), r.err);
  r = await sh(['pull', fixture.id, CO, '--force']);
  eq(r.code, 0, r.err);
  eq((await sh(['status', CO, '--json'])).json().edited, []);
});

test('review.json edited by hand: status refuses, and pull --force starts over', async () => {
  const f = path.join(CO, 'review.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('CLI Test Firmware', 'CLI Test Firmware (edited)'));
  let r = await sh(['status', CO]);
  eq(r.code, 2);
  ok(/isn’t the file that was pulled/.test(r.err), r.err);
  r = await sh(['pull', fixture.id, CO, '--force']);
  eq(r.code, 0, r.err);
  eq((await sh(['status', CO])).code, 0);
});

test('status warns when the files as pulled would already change something (one ID twice)', async () => {
  const dir = path.join(TMP, 'dup');
  eq((await sh(['pull', dupDoc.id, dir])).code, 0);
  const st = (await sh(['status', dir, '--json'])).json();
  ok(/REQ-002/.test(st.warning) && /don’t push/.test(st.warning), st.warning);
  ok(st.now.reqs.duplicates.indexOf('REQ-002') >= 0, 'duplicate not reported');
  ok(/Warning/.test(fs.readFileSync(path.join(dir, 'status.md'), 'utf8')), 'status.md lacks the warning');
});

test('pull won’t write inside a Signoff tool folder or a tool repo, or into a full folder', async () => {
  let r = await sh(['pull', fixture.id, path.join(cli.TOOL_ROOT, 'tmp-checkout')]);
  eq(r.code, 1);
  ok(/public/.test(r.err), r.err);
  ok(!fs.existsSync(path.join(cli.TOOL_ROOT, 'tmp-checkout')), 'wrote inside the tool');
  const repo = path.join(TMP, 'fake-tool-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/someone/' + C.repos.toolRepo + '.git\n');
  r = await sh(['pull', fixture.id, path.join(repo, 'x')]);
  eq(r.code, 1);
  ok(/repo/.test(r.err), r.err);
  const full = path.join(TMP, 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'notes.txt'), 'mine');
  r = await sh(['pull', fixture.id, full]);
  eq(r.code, 2);
});

test('pull: an ambiguous or unknown name says so', async () => {
  let r = await sh(['pull', 'cli', path.join(TMP, 'amb')]);
  eq(r.code, 2);
  ok(/matches \d+ reviews/.test(r.err), r.err);
  r = await sh(['pull', 'no such thing', path.join(TMP, 'none')]);
  eq(r.code, 2);
});

test('pull into the configured checkouts folder', async () => {
  const cfg = path.join(TMP, 'config.json'), where = path.join(TMP, 'checkouts');
  fs.writeFileSync(cfg, JSON.stringify({ checkouts: where, name: 'Ari Chen' }));
  const r = await sh(['pull', sharedDoc.id, '--config', cfg]);
  eq(r.code, 0, r.err);
  ok(fs.existsSync(path.join(where, eng.key, 'cli-shared', '.signoff.json')), 'not in the checkouts folder');
  eq(JSON.parse(fs.readFileSync(path.join(where, eng.key, 'cli-shared', '.signoff.json'), 'utf8')).repo, SHARED);
});

test('open prints the hosted link, with a requirement by its ref', async () => {
  const q = M.liveReqs(fixture).find((x) => x.ref === 'REQ-002');
  const r = await sh(['open', CO, '--req', 'req-002']);
  eq(r.code, 0, r.err);
  eq(r.out.trim(), String(C.hostedBase).replace(/\/$/, '') + '/' + C.repos.toolRepo + '/index.html?project=' + fixture.id + '&req=' + q.id);
  eq((await sh(['open', CO, '--req', 'REQ-999'])).code, 2);
});

test('export: the description as Markdown, with local edits', async () => {
  fs.appendFileSync(path.join(CO, 'scribe.md'), '\n## Fan output\nThe fan runs after a heat call ends.\n');
  const file = path.join(TMP, 'out.md');
  const r = await sh(['export', CO, '--out', file]);
  eq(r.code, 0, r.err);
  const md = fs.readFileSync(file, 'utf8');
  ok(/Fan output/.test(md) && /Control loop/.test(md), md.slice(0, 200));
});

test('everything but push --confirm only reads GitHub', async () => {
  ok(gh.calls.length > 0 && gh.calls.every((c) => c.indexOf('GET ') === 0), gh.calls.filter((c) => c.indexOf('GET ') !== 0).join(', '));
});

// ── Push ───────────────────────────────────────────────────
const writes = () => gh.calls.filter((c) => c.indexOf('GET ') !== 0).length;
const remoteDoc = (id) => JSON.parse(gh.files(DATA)['projects/' + id + '.json']);
const codeOf = (r) => (/--confirm (\w+)/.exec(r.out) || [])[1];
let PD = '';

test('push: nothing to push, and no push without a dry run', async () => {
  PD = path.join(TMP, 'push');
  eq((await sh(['pull', fixture.id, PD])).code, 0);
  let r = await sh(['push', PD, '--dry-run']);
  eq(r.code, 0, r.err);
  ok(/Nothing to push/.test(r.out), r.out);
  r = await sh(['push', PD]);
  eq(r.code, 2);
  ok(/--dry-run/.test(r.err), r.err);
  eq(writes(), 0);
});

test('push --dry-run shows every change and a code, and writes nothing', async () => {
  fs.appendFileSync(path.join(PD, 'reqs.csv'), 'REQ-010,"The firmware shall log each fault with its time.",shall,,Faults,,test,draft\n');
  const f = path.join(PD, 'scribe.md');
  const text = fs.readFileSync(f, 'utf8');
  // Status LED goes; Fault log comes in earlier, so Edit all can't take it for a rename of Status LED.
  const relay = text.indexOf('## Relay driver');
  fs.writeFileSync(f, (text.slice(0, relay) + '## Fault log * module\nThe [firmware logs each fault with its time]{REQ-010}.\n\n' + text.slice(relay, text.indexOf('## Status LED'))).trimEnd() + '\n');
  const r = await sh(['push', PD, '--dry-run']);
  eq(r.code, 0, r.err);
  ok(/Requirements added \(1\): REQ-010/.test(r.out), r.out);
  ok(r.out.indexOf('Sections added (1): ' + titleOf('## Fault log * module')) >= 0, r.out);
  ok(r.out.indexOf('Sections deleted (1): ' + titleOf('## Status LED * driver')) >= 0, r.out);
  ok(/Changed on GitHub since the pull: no/.test(r.out), r.out);
  ok(/stamped Ari Chen/.test(r.out), 'stamped with the GitHub name when the config has none');
  ok(codeOf(r), 'no code');
  eq(writes(), 0, 'the dry run wrote');
});

test('push --confirm with a wrong code pushes nothing', async () => {
  const r = await sh(['push', PD, '--confirm', '0000000000']);
  eq(r.code, 2);
  ok(/another change/.test(r.err), r.err);
  eq(writes(), 0);
});

test('push --confirm commits exactly the change, reads it back, and refreshes the checkout', async () => {
  const before = remoteDoc(fixture.id), code = codeOf(await sh(['push', PD, '--dry-run']));
  const r = await sh(['push', PD, '--confirm', code]);
  eq(r.code, 0, r.err);
  ok(/read back: it matches/.test(r.out), r.out);
  const after = remoteDoc(fixture.id);
  const q = M.liveReqs(after).find((x) => x.ref === 'REQ-010');
  ok(q && q.updatedBy === 'Ari Chen' && q.status === 'draft', 'REQ-010 stored');
  const secs = M.liveSpec(after).map((x) => x.title);
  ok(secs.indexOf(titleOf('## Fault log * module')) >= 0 && secs.indexOf(titleOf('## Status LED * driver')) < 0, secs.join(', '));
  const led = Object.keys(after.spec).map((k) => after.spec[k]).find((x) => x.title === titleOf('## Status LED * driver'));
  ok(led && led.deleted, 'a deleted section is a tombstone, never removed');
  ok(M.specAnalysis(after).sections.some((x) => x.links.indexOf(q.id) >= 0), 'the new section links REQ-010');
  // Nothing else changed: every other record is as it was.
  Object.keys(before.reqs).forEach((id) => eq(after.reqs[id], before.reqs[id], 'requirement ' + id));
  eq(after.items, before.items); eq(after.comments, before.comments); eq(after.meta, before.meta);
  // The summary is what the browser would write, so its next sync writes nothing new.
  eq(M.stableStringify(M.withSummary(after, summarize)), gh.files(DATA)['projects/' + fixture.id + '.json'], 'summary');
  ok((!C.spec || after.summary.spec) && after.summary.reqs.total === M.liveReqs(after).filter((x) => x.status !== 'deprecated').length, 'summary counts');
  // One commit, saying what it did.
  ok(/^Signoff \w+ \(command line\): CLI Test Firmware: 1 requirement added, 1 section added, and 1 section deleted/.test(gh.commitMessages(DATA)[0]), gh.commitMessages(DATA)[0]);
  // The checkout starts from what was pushed.
  const st = (await sh(['status', PD, '--json'])).json();
  eq([st.edited, st.warning], [[], '']);
  eq(JSON.parse(fs.readFileSync(path.join(PD, '.signoff.json'), 'utf8')).blob, cli.gitBlobSha(Buffer.from(gh.files(DATA)['projects/' + fixture.id + '.json'])));
  eq((await sh(['push', PD, '--dry-run'])).out.trim(), 'Nothing to push: scribe.md and reqs.csv change nothing in the review.');
});

test('push: someone else’s push to another file first is retried on top of it', async () => {
  fs.appendFileSync(path.join(PD, 'scribe.md'), '\n## Fan output\nThe fan runs after a heat call ends.\n');
  const code = codeOf(await sh(['push', PD, '--dry-run']));
  let once = true;
  gh.beforeRef = (full) => { if (once) { once = false; gh.edit(full, 'README.md', 'someone else\n'); } };
  const r = await sh(['push', PD, '--confirm', code]);
  gh.beforeRef = null;
  eq(r.code, 0, r.err);
  eq(gh.files(DATA)['README.md'], 'someone else\n', 'their commit kept');
  ok(M.liveSpec(remoteDoc(fixture.id)).some((x) => x.title === 'Fan output'), 'ours on top');
});

test('push: the review changed on GitHub after the dry run, so the code no longer matches; a new dry run merges it', async () => {
  fs.appendFileSync(path.join(PD, 'reqs.csv'), 'REQ-011,"The fan shall stop within 1 s of a stop command.",shall,,Outputs,,test,draft\n');
  const code = codeOf(await sh(['push', PD, '--dry-run']));
  // Meanwhile, someone changes a requirement in the browser and syncs.
  const theirs = remoteDoc(fixture.id), q1 = M.liveReqs(theirs).find((x) => x.ref === 'REQ-002');
  theirs.reqs[q1.id] = Object.assign({}, q1, { text: 'Changed in the browser.', updatedAt: new Date().toISOString(), updatedBy: 'Sam Patel' });
  gh.edit(DATA, 'projects/' + fixture.id + '.json', fileText(theirs));
  let r = await sh(['push', PD, '--confirm', code]);
  eq(r.code, 2, r.err);
  ok(/another change/.test(r.err), r.err);
  r = await sh(['push', PD, '--dry-run']);
  ok(/Changed on GitHub since the pull: yes/.test(r.out), r.out + r.err);
  r = await sh(['push', PD, '--confirm', codeOf(r)]);
  eq(r.code, 0, r.err);
  const after = remoteDoc(fixture.id);
  eq(M.liveReqs(after).find((x) => x.ref === 'REQ-002').text, 'Changed in the browser.', 'their edit kept');
  ok(M.liveReqs(after).some((x) => x.ref === 'REQ-011'), 'ours added');
  ok(/Changed in the browser/.test(fs.readFileSync(path.join(PD, 'reqs.csv'), 'utf8')), 'the checkout has their edit');
});

test('push: a section edited here and in the browser keeps both, as a conflict copy', async () => {
  const f = path.join(PD, 'scribe.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('The fan runs after a heat call ends.', 'The fan runs for 90 s after a heat call ends.'));
  const theirs = remoteDoc(fixture.id), sec = M.liveSpec(theirs).find((x) => x.title === 'Fan output');
  theirs.spec[sec.id] = M.specStamp(Object.assign({}, theirs.spec[sec.id], { body: 'The fan runs until the coil cools.' }), 'Sam Patel');
  gh.edit(DATA, 'projects/' + fixture.id + '.json', fileText(theirs));
  let r = await sh(['push', PD, '--dry-run']);
  ok(/Conflict copies .*Fan output \(conflict copy\)/.test(r.out), r.out);
  r = await sh(['push', PD, '--confirm', codeOf(r)]);
  eq(r.code, 0, r.err);
  const bodies = M.liveSpec(remoteDoc(fixture.id)).filter((x) => /^Fan output/.test(x.title)).map((x) => x.body).sort();
  eq(bodies, ['The fan runs for 90 s after a heat call ends.', 'The fan runs until the coil cools.']);
});

test('push refuses to undo an edit made on GitHub to a requirement it changes', async () => {
  const f = path.join(PD, 'reqs.csv'), mine = fs.readFileSync(f, 'utf8');
  ok(mine.indexOf('every 1 s.') >= 0, 'fixture text');
  fs.writeFileSync(f, mine.replace('every 1 s.', 'every 3 s.'));
  const was = gh.files(DATA)['projects/' + fixture.id + '.json'], theirs = remoteDoc(fixture.id);
  const q1 = M.liveReqs(theirs).find((x) => x.ref === 'REQ-001');
  theirs.reqs[q1.id] = Object.assign({}, q1, { evidence: 'Bench log 12', updatedAt: new Date().toISOString(), updatedBy: 'Sam Patel' });
  gh.edit(DATA, 'projects/' + fixture.id + '.json', fileText(theirs));
  const before = writes(), r = await sh(['push', PD, '--dry-run']);
  eq(r.code, 2, r.out);
  ok(/REQ-001 was edited on GitHub since the pull/.test(r.err), r.err);
  eq(writes(), before);
  gh.edit(DATA, 'projects/' + fixture.id + '.json', was);
  fs.writeFileSync(f, mine);
});

test('push refuses when the merge would give two requirements one ID', async () => {
  const f = path.join(PD, 'reqs.csv'), mine = fs.readFileSync(f, 'utf8');
  fs.appendFileSync(f, 'REQ-050,"Ours.",shall,,,,test,draft\n');
  const was = gh.files(DATA)['projects/' + fixture.id + '.json'], theirs = remoteDoc(fixture.id);
  const q = M.newReq(theirs, { ref: 'REQ-050', text: 'Theirs.' }, 'Sam Patel');
  theirs.reqs[q.id] = q;
  gh.edit(DATA, 'projects/' + fixture.id + '.json', fileText(theirs));
  const before = writes(), r = await sh(['push', PD, '--dry-run']);
  eq(r.code, 2, r.out);
  ok(/round-trip/.test(r.err) && /REQ-050/.test(r.err), r.err);
  eq(writes(), before);
  gh.edit(DATA, 'projects/' + fixture.id + '.json', was);
  fs.writeFileSync(f, mine);
  ok(/Nothing to push/.test((await sh(['push', PD, '--dry-run'])).out), 'checkout restored');
});

test('push refuses to roll back a record that is older on GitHub than in the checkout', async () => {
  const f = path.join(PD, 'scribe.md'), mine = fs.readFileSync(f, 'utf8');
  fs.appendFileSync(f, '\n## Rollback check\nSome text.\n');
  const theirs = remoteDoc(fixture.id), q1 = M.liveReqs(theirs).find((x) => x.ref === 'REQ-001');
  theirs.reqs[q1.id] = Object.assign({}, q1, { text: 'Restored from an old copy.', updatedAt: '2000-01-01T00:00:00.000Z' });
  const was = gh.files(DATA)['projects/' + fixture.id + '.json'];
  gh.edit(DATA, 'projects/' + fixture.id + '.json', fileText(theirs));
  const before = writes(), r = await sh(['push', PD, '--dry-run']);
  eq(r.code, 1, r.out);
  ok(r.err.indexOf('reqs.' + q1.id) >= 0 && /Nothing was pushed/.test(r.err), r.err);
  eq(writes(), before);
  gh.edit(DATA, 'projects/' + fixture.id + '.json', was);
  fs.writeFileSync(f, mine);
  ok(/Nothing to push/.test((await sh(['push', PD, '--dry-run'])).out), 'checkout restored');
});

test('push refuses a review that doesn’t round-trip (one ID twice)', async () => {
  const dir = path.join(TMP, 'dup-push');
  eq((await sh(['pull', dupDoc.id, dir])).code, 0);
  fs.appendFileSync(path.join(dir, 'scribe.md'), '\n## More\nMore text.\n');
  const r = await sh(['push', dir, '--dry-run']);
  eq(r.code, 2);
  ok(/don’t push/.test(r.err), r.err);
});

test('push refuses when the merge would drop something this tool doesn’t know', async () => {
  const dir = path.join(TMP, 'future');
  eq((await sh(['pull', sharedDoc.id, dir])).code, 0);
  const theirs = JSON.parse(gh.files(SHARED)['projects/' + sharedDoc.id + '.json']);
  theirs.futureField = { from: 'a newer engine' };
  gh.edit(SHARED, 'projects/' + sharedDoc.id + '.json', M.stableStringify(theirs));
  fs.appendFileSync(path.join(dir, 'scribe.md'), '\n## New part\nSome text.\n');
  const before = writes(), r = await sh(['push', dir, '--dry-run']);
  eq(r.code, 1);
  ok(/futureField/.test(r.err) && /Nothing was pushed/.test(r.err), r.err);
  eq(writes(), before);
});

test('push refuses a review that was shared away since the pull', async () => {
  const dir = path.join(TMP, 'moved');
  eq((await sh(['pull', archived.id, dir])).code, 0);
  const users = JSON.parse(gh.files(DATA)['users.json']);
  users.shared[archived.id] = { repo: SHARED, updatedAt: new Date().toISOString(), updatedBy: 'Ari Chen' };
  gh.edit(DATA, 'users.json', M.stableStringify(users));
  fs.appendFileSync(path.join(dir, 'scribe.md'), '\n## New part\nSome text.\n');
  const r = await sh(['push', dir, '--dry-run']);
  eq(r.code, 2);
  ok(/now lives in/.test(r.err), r.err);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); } catch (err) { failed++; console.log('FAIL ' + t.name + '\n     ' + (err && err.message)); }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log((failed ? 'FAIL' : 'PASS') + ' ' + (tests.length - failed) + '/' + tests.length + ' (' + C.product + ')');
  process.exitCode = failed ? 1 : 0;
})();
