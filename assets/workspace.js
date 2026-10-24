/* Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
   vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* Signoff workspace: which repositories hold which projects, and who can open them.

   - Tool repo (settings.toolRepo): the tool and the checklists. FTEs only.
   - Data repo (settings.dataRepo): internal projects and users.json. FTEs only.
   - One private repo per shared project (settings.prefix + name, e.g. review-ee-sensor-hub):
     the FTEs plus the contractors on that project.
   - settings.suiteRepos: the rest of the Signoff suite (the other discipline's tool and data
     repos, the hub). FTEs are invited to these too.

   GitHub enforces access, so a contractor's token only reaches their projects' repos.
   An FTE is anyone whose token can open the data repo. No DOM here; app.js renders.

   state: { login, projects: { id: doc }, roster, homes: { id: 'owner/repo' },
            cache: { 'owner/repo': { path: { sha } } }, dataAccess: 'ok' | 'none' | '' } */
(function (S) {
  'use strict';
  var M = S.model;

  function Workspace(settings, token, fetchImpl) {
    this.s = settings;
    this.token = token;
    this.fetch = fetchImpl;
    this.account = new S.GitHubAccount(token, fetchImpl);
  }

  Workspace.prototype.full = function (repo) { return this.s.owner + '/' + repo; };
  Workspace.prototype.dataFull = function () { return this.full(this.s.dataRepo); };
  Workspace.prototype.toolFull = function () { return this.full(this.s.toolRepo); };
  Workspace.prototype.store = function (repoFull, extra) {
    var parts = repoFull.split('/');
    return new S.GitHubStore(Object.assign({ owner: parts[0], repo: parts[1], branch: this.s.branch || 'main', dataPath: '', token: this.token }, extra || {}), this.fetch);
  };
  Workspace.prototype.dataStore = function () { return this.store(this.dataFull(), { dataPath: this.s.dataPath || '' }); };

  // Where a project lives. The data repo's shared map is the authority.
  Workspace.prototype.homeOf = function (state, id) {
    return M.sharedRepo(state.roster, id) || state.homes[id] || this.dataFull();
  };

  function copyState(st) {
    return {
      login: st.login || '', dataAccess: st.dataAccess || '',
      projects: Object.assign({}, st.projects), roster: st.roster || M.emptyRoster(),
      homes: Object.assign({}, st.homes), cache: Object.assign({}, st.cache)
    };
  }
  function subset(state, ws, repoFull) {
    var out = {};
    Object.keys(state.projects).forEach(function (id) { if (ws.homeOf(state, id) === repoFull) out[id] = state.projects[id]; });
    return out;
  }
  function absorb(state, res, repoFull) {
    Object.keys(res.projects).forEach(function (id) { state.projects[id] = res.projects[id]; state.homes[id] = repoFull; });
    state.cache[repoFull] = res.cache;
  }
  function denied(err) { return err && (err.status === 404 || err.status === 403); }

  /* Sync everything this person can reach. Resolves { state, errors, invitations, templates,
     version, pushed, dropped }. A repository that fails is reported and skipped; the others
     still sync. Local work is only dropped when GitHub says a contractor lost access. */
  Workspace.prototype.sync = function (state0, opts) {
    var ws = this, st = copyState(state0), errors = [], out = { pushed: 0, dropped: [], templates: null, version: null };
    opts = opts || {};
    var msg = opts.message;
    var dataFull = ws.dataFull();

    return (st.login ? Promise.resolve() : ws.account.user().then(function (u) { st.login = u.login.toLowerCase(); out.userName = u.name || u.login; }))
      .then(function () {
        // 1. The data repo. Only FTEs can open it.
        var mine = subset(st, ws, dataFull);
        return ws.dataStore().sync(mine, st.roster, st.cache[dataFull], {
          roster: true, deleteStrays: true, message: msg, onRetry: opts.onRetry,
          belongsHere: function (id, r) { return !M.sharedRepo(r, id); }
        }).then(function (res) {
          st.dataAccess = 'ok';
          st.roster = res.roster;
          absorb(st, res, dataFull);
          // Projects shared since we last synced now live in their own repo; keep the local
          // copy (with any unsynced edits) and let step 3 merge it there.
          res.moved.forEach(function (id) { st.homes[id] = M.sharedRepo(st.roster, id); });
          out.pushed += res.pushed;
        }).catch(function (err) {
          if (!denied(err)) throw err;
          var ownsLocal = Object.keys(mine).length > 0;
          var isOwner = st.login === ws.s.owner.toLowerCase();
          if (isOwner || ownsLocal || st.dataAccess === 'ok') {
            // A settings or token problem, not a contractor: keep everything.
            errors.push({ repo: dataFull, message: 'Can’t open ' + dataFull + '. Check the repository name in Settings and that your token covers it.' });
          } else {
            st.dataAccess = 'none';
          }
        });
      })
      .then(function () {
        // 2. Checklists and the tool version, for FTEs.
        if (st.dataAccess !== 'ok') return;
        var toolFull = ws.toolFull();
        return ws.store(toolFull).sync({}, null, st.cache[toolFull], { tool: true, pullOnly: true, belongsHere: function () { return false; } })
          .then(function (res) { st.cache[toolFull] = res.cache; out.templates = res.templates; out.version = res.version; })
          .catch(function (err) { errors.push({ repo: toolFull, message: 'Couldn’t read checklists from ' + toolFull + ': ' + err.message }); });
      })
      .then(function () {
        // 3. Shared project repos: from the shared map for FTEs, from GitHub for contractors.
        if (st.dataAccess === 'ok') {
          var repos = {};
          Object.keys(st.roster.shared || {}).forEach(function (id) { var r = M.sharedRepo(st.roster, id); if (r) repos[r] = 1; });
          return Object.keys(repos);
        }
        return ws.account.listRepos(ws.s.owner, ws.s.prefix).then(function (names) {
          var reachable = names.map(function (n) { return ws.full(n); });
          // Access taken away: GitHub no longer lists the repo, so drop its projects here.
          Object.keys(st.projects).forEach(function (id) {
            if (reachable.indexOf(st.homes[id]) < 0) { out.dropped.push(id); delete st.projects[id]; delete st.homes[id]; }
          });
          return reachable;
        });
      })
      .then(function (repos) {
        return repos.reduce(function (chain, repoFull) {
          return chain.then(function () {
            return ws.store(repoFull).sync(subset(st, ws, repoFull), null, st.cache[repoFull], { message: msg, onRetry: opts.onRetry })
              .then(function (res) { absorb(st, res, repoFull); out.pushed += res.pushed; })
              .catch(function (err) {
                if (denied(err) && st.dataAccess !== 'ok') {
                  Object.keys(subset(st, ws, repoFull)).forEach(function (id) { out.dropped.push(id); delete st.projects[id]; delete st.homes[id]; });
                } else {
                  errors.push({ repo: repoFull, message: denied(err) ? 'No access to ' + repoFull + ' yet. The repo owner needs to invite you.' : repoFull + ': ' + err.message });
                }
              });
          });
        }, Promise.resolve());
      })
      .then(function () {
        // 4. Invitations from this owner waiting to be accepted.
        return ws.account.invitations().then(function (inv) {
          out.invitations = inv.filter(function (i) { return i.owner && i.owner.toLowerCase() === ws.s.owner.toLowerCase(); });
        }).catch(function () { out.invitations = []; });
      })
      .then(function () { out.state = st; out.errors = errors; return out; });
  };

  /* Throw away unsynced local changes: fetch what GitHub has now for each project in `ids`
     (and the People list when `roster` is true). Nothing is pushed. Resolves
     { projects: { id: doc | null }, roster: rosterOrNull }; a null project was never synced,
     so the caller removes it. Only cached blob shas are kept between syncs, so there's no
     local "last synced" copy to fall back on; this needs the network. */
  Workspace.prototype.discard = function (state, ids, roster) {
    var ws = this, out = { projects: {}, roster: null }, snaps = {};
    function snap(repoFull) {
      if (!snaps[repoFull]) {
        var store = repoFull === ws.dataFull() ? ws.dataStore() : ws.store(repoFull);
        snaps[repoFull] = store.snapshot().then(function (s) { return { store: store, entries: s.entries }; });
      }
      return snaps[repoFull];
    }
    function read(repoFull, path) {
      return snap(repoFull).then(function (s) {
        var e = s.entries.filter(function (x) { return x.path === s.store.dataDir() + path; })[0];
        return e ? s.store.blob(e.sha).then(function (t) { return JSON.parse(t); }) : null;
      });
    }
    // Synced at least once = the last sync recorded its file. Anything else only ever lived here.
    function everSynced(id) {
      var repo = ws.homeOf(state, id);
      var dir = repo === ws.dataFull() ? ws.dataStore().dataDir() : '';
      return !!((state.cache || {})[repo] || {})[dir + 'projects/' + id + '.json'];
    }
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        if (!everSynced(id)) { out.projects[id] = null; return; }
        return read(ws.homeOf(state, id), 'projects/' + id + '.json').then(function (doc) { out.projects[id] = doc; });
      });
    }, Promise.resolve()).then(function () {
      if (!roster) return;
      return read(ws.dataFull(), 'users.json').then(function (r) { out.roster = M.mergeRosters(M.emptyRoster(), r); });
    }).then(function () { return out; });
  };

  /* Move a project into its own private repository and invite people to it.
     Steps, each safe to repeat if a later one fails:
       1. create <prefix><name> (or adopt it if it already holds this project)
       2. write the project there
       3. record it in the shared map (the next sync commits that to the data repo and
          deletes the data repo's copy)
       4. invite the FTEs and the chosen contractors */
  Workspace.prototype.share = function (state0, projectId, contractors, log) {
    var ws = this, st = copyState(state0), doc = st.projects[projectId];
    log = log || function () {};
    if (!doc) return Promise.reject(new Error('Unknown project'));
    var existing = M.sharedRepo(st.roster, projectId);
    var base = ws.s.prefix + M.slugify(doc.meta.name).slice(0, 60), repoFull;

    function pickRepo() {
      if (existing) return Promise.resolve(existing);
      return ws.account.ownerType(ws.s.owner).then(function (type) {
        var isOrg = type === 'Organization';
        function attempt(n) {
          var name = n === 1 ? base : base + '-' + n;
          log('Creating private repository ' + ws.full(name) + '…');
          return ws.account.createRepo(ws.s.owner, name, isOrg, 'Signoff review: ' + doc.meta.name).then(function () { return ws.full(name); })
            .catch(function (err) {
              if (err.status !== 422 || n >= 9) throw err;
              // The name is taken. Adopt it if an earlier, interrupted share made it.
              return ws.store(ws.full(name)).snapshot().then(function (snap) {
                var mineThere = snap.entries.some(function (e) { return e.path === 'projects/' + projectId + '.json'; });
                var empty = snap.entries.every(function (e) { return e.path === 'README.md' || e.type === 'tree'; });
                if (mineThere || empty) { log('Using existing ' + ws.full(name)); return ws.full(name); }
                return attempt(n + 1);
              }, function () { return attempt(n + 1); });
            });
        }
        return attempt(1);
      });
    }

    return pickRepo().then(function (full) {
      repoFull = full;
      log('Copying the review into ' + repoFull + '…');
      // A brand-new repository can take a moment before its first commit is readable.
      function push(tries) {
        var one = {}; one[projectId] = doc;
        return ws.store(repoFull).sync(one, null, st.cache[repoFull], { message: 'Signoff: share ' + doc.meta.name })
          .catch(function (err) {
            if ((err.status === 409 || err.status === 404) && tries < 5) return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return push(tries + 1); });
            throw err;
          });
      }
      return push(1);
    }).then(function (res) {
      absorb(st, res, repoFull);
      // Fabcheck runs and packages for this project move with it (docs/fabcheck-link.md).
      return ws.moveFabcheck(projectId, ws.dataFull(), repoFull, log);
    }).then(function () {
      var shared = Object.assign({}, st.roster.shared);
      shared[projectId] = M.stamp({ id: projectId, repo: repoFull, name: doc.meta.name }, st.login);
      st.roster = Object.assign({}, st.roster, { shared: shared });
      var ftes = M.liveUsers(st.roster).filter(function (u) { return u.role === 'fte'; }).map(function (u) { return u.login; });
      var people = ftes.concat(contractors || []).filter(function (l, i, a) {
        return l && a.indexOf(l) === i && l !== st.login && l !== ws.s.owner.toLowerCase();
      });
      return ws.inviteTo(repoFull, people, log).then(function (failed) {
        return { state: st, repo: repoFull, failedInvites: failed };
      });
    });
  };

  /* Copy a project's Fabcheck files (fabcheck/<id>/) from one repo to another, then delete
     them from the first. Safe to repeat: files already there are skipped, and the source is
     only cleared once the copy has landed. */
  Workspace.prototype.moveFabcheck = function (projectId, fromFull, toFull, log) {
    var ws = this;
    log = log || function () {};
    var src = fromFull === ws.dataFull() ? ws.dataStore() : ws.store(fromFull);
    var dst = toFull === ws.dataFull() ? ws.dataStore() : ws.store(toFull);
    var fromDir = src.dataDir() + 'fabcheck/' + projectId + '/', toDir = dst.dataDir() + 'fabcheck/' + projectId + '/';
    return src.listTree(fromDir).then(function (list) {
      if (!list.length) return;
      log('Moving ' + list.length + ' Fabcheck file' + (list.length === 1 ? '' : 's') + ' to ' + toFull + '…');
      var files = [], next = 0;
      function worker() {
        if (next >= list.length) return Promise.resolve();
        var e = list[next++];
        return src.blobBytes(e.sha).then(function (bytes) {
          files.push({ path: toDir + e.path.slice(fromDir.length), bytes: bytes });
          return worker();
        });
      }
      return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
        return dst.putFiles(files, { message: 'Signoff: move Fabcheck runs for ' + projectId });
      }).then(function () {
        return src.putFiles(list.map(function (e) { return { path: e.path, remove: true }; }), { message: 'Signoff: Fabcheck runs for ' + projectId + ' moved to ' + toFull });
      });
    });
  };

  // Invite people to one repository. Resolves with the logins that failed.
  Workspace.prototype.inviteTo = function (repoFull, logins, log) {
    var ws = this, failed = [];
    log = log || function () {};
    return logins.reduce(function (chain, login) {
      return chain.then(function () {
        log('Inviting ' + login + ' to ' + repoFull + '…');
        return ws.store(repoFull).invite(login).catch(function (err) { failed.push({ login: login, repo: repoFull, message: err.message, status: err.status }); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  };

  Workspace.prototype.revokeFrom = function (repoFull, logins, log) {
    var ws = this, failed = [];
    log = log || function () {};
    return logins.reduce(function (chain, login) {
      return chain.then(function () {
        log('Removing ' + login + ' from ' + repoFull + '…');
        return ws.store(repoFull).revoke(login).catch(function (err) { failed.push({ login: login, repo: repoFull, message: err.message, status: err.status }); });
      });
    }, Promise.resolve()).then(function () { return failed; });
  };

  // The repositories only FTEs are on: this tool's tool and data repos, plus the rest of the
  // suite (settings.suiteRepos: the other discipline's tool and data repos, the hub).
  Workspace.prototype.internalRepos = function () {
    var ws = this, repos = [this.toolFull(), this.dataFull()];
    (this.s.suiteRepos || []).forEach(function (r) { var f = ws.full(r); if (repos.indexOf(f) < 0) repos.push(f); });
    return repos;
  };

  // Every repository an FTE needs: the internal ones and each shared project of this tool.
  // (The other discipline's shared projects are granted from that tool's People page.)
  Workspace.prototype.fteRepos = function (state) {
    var repos = this.internalRepos();
    Object.keys((state.roster && state.roster.shared) || {}).forEach(function (id) {
      var r = M.sharedRepo(state.roster, id);
      if (r && repos.indexOf(r) < 0) repos.push(r);
    });
    return repos;
  };

  // Collaborators and pending invitations of one repository.
  Workspace.prototype.access = function (repoFull) {
    var st = this.store(repoFull);
    return Promise.all([st.collaborators(), st.invitations().catch(function () { return []; })])
      .then(function (r) { return { collaborators: r[0], invited: r[1].map(function (i) { return i.login; }) }; });
  };

  S.Workspace = Workspace;
})(window.Signoff = window.Signoff || {});
