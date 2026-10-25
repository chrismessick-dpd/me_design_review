/* Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
   vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js. */
/* GitHub storage for Signoff.

   Every repository Signoff writes to has the same layout: projects/<id>.json, plus
   users.json in the FTE-only data repo. A sync of one repository = pull, merge, push one
   commit. Review data is committed straight to the branch (no pull requests): every record
   merges key by key (see model.mergeProjects), so two reviewers syncing the same project
   don't overwrite each other. The ref update uses force:false, so if someone else pushed
   in between, GitHub refuses it (422) and we pull, merge and try again.

   assets/workspace.js decides which repositories to sync; this file talks to one.
   The fetch function is injected so tests/test.html can run this against a fake GitHub. */
(function (S) {
  'use strict';
  var M = S.model;

  var API = 'https://api.github.com';
  var MAX_ATTEMPTS = 4;

  function b64Encode(text) {
    var bytes = new TextEncoder().encode(text), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64Decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Git's blob id: sha1("blob <byte length>\0" + content). Lets us know the sha of a
  // file we just pushed without asking GitHub.
  function gitBlobSha(text) {
    var body = new TextEncoder().encode(text);
    var head = new TextEncoder().encode('blob ' + body.length + '\0');
    var all = new Uint8Array(head.length + body.length);
    all.set(head, 0); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // Binary-safe versions, for files such as fab packages (assets: docs/fabcheck-link.md).
  function bytesToB64(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    var bin = atob(String(b64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function gitBlobShaBytes(body) {
    var head = new TextEncoder().encode('blob ' + body.length + '\0');
    var all = new Uint8Array(head.length + body.length);
    all.set(head, 0); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function apiCall(fetchImpl, token, url, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetchImpl(url, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!res.ok) {
            var err = new Error((data && data.message) || ('HTTP ' + res.status));
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  // ── Calls about the signed-in user rather than one repository ──
  function GitHubAccount(token, fetchImpl) {
    this.token = token;
    this.fetch = fetchImpl || window.fetch.bind(window);
  }
  GitHubAccount.prototype.api = function (path, opts) { return apiCall(this.fetch, this.token, API + path, opts); };
  GitHubAccount.prototype.user = function () { return this.api('/user'); };
  // 'User' or 'Organization': decides where new project repositories are created.
  GitHubAccount.prototype.ownerType = function (owner) {
    return this.api('/users/' + encodeURIComponent(owner)).then(function (u) { return u.type; });
  };
  // Repositories of `owner` whose name starts with `prefix` that this token can open.
  GitHubAccount.prototype.listRepos = function (owner, prefix) {
    var self = this, out = [];
    function page(n) {
      return self.api('/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=' + n).then(function (list) {
        (list || []).forEach(function (r) {
          if (r.owner && r.owner.login.toLowerCase() === owner.toLowerCase() && r.name.indexOf(prefix) === 0) out.push(r.name);
        });
        return list && list.length === 100 && n < 20 ? page(n + 1) : out;
      });
    }
    return page(1);
  };
  GitHubAccount.prototype.createRepo = function (owner, name, isOrg, description) {
    var body = { name: name, private: true, auto_init: true, description: description || '' };
    return this.api(isOrg ? '/orgs/' + encodeURIComponent(owner) + '/repos' : '/user/repos', { method: 'POST', body: body });
  };
  // Invitations waiting for this user to accept (the email step people miss).
  GitHubAccount.prototype.invitations = function () {
    return this.api('/user/repository_invitations?per_page=100').then(function (list) {
      return (list || []).map(function (i) { return { id: i.id, repo: i.repository && i.repository.full_name, owner: i.repository && i.repository.owner && i.repository.owner.login }; });
    });
  };
  GitHubAccount.prototype.acceptInvitation = function (id) {
    return this.api('/user/repository_invitations/' + id, { method: 'PATCH' });
  };

  // ── One repository ──
  function GitHubStore(cfg, fetchImpl) {
    this.cfg = cfg;               // { owner, repo, branch, dataPath, templatePath, token, summarize }
    this.fetch = fetchImpl || window.fetch.bind(window);
  }

  GitHubStore.prototype.base = function () {
    return API + '/repos/' + encodeURIComponent(this.cfg.owner) + '/' + encodeURIComponent(this.cfg.repo);
  };
  GitHubStore.prototype.full = function () { return this.cfg.owner + '/' + this.cfg.repo; };

  GitHubStore.prototype.api = function (path, opts) {
    return apiCall(this.fetch, this.cfg.token, path.indexOf('http') === 0 ? path : this.base() + path, opts);
  };

  GitHubStore.prototype.dataDir = function () {
    return this.cfg.dataPath ? this.cfg.dataPath.replace(/\/+$/, '') + '/' : '';
  };
  GitHubStore.prototype.projectsDir = function () { return this.dataDir() + 'projects/'; };

  GitHubStore.prototype.user = function () { return this.api(API + '/user'); };

  // Head commit, its tree, and the files in it.
  GitHubStore.prototype.snapshot = function () {
    var self = this, head, branch = this.cfg.branch || 'main';
    return this.api('/git/ref/heads/' + encodeURIComponent(branch)).then(function (ref) {
      head = ref.object.sha;
      return self.api('/git/commits/' + head);
    }).then(function (commit) {
      return self.api('/git/trees/' + commit.tree.sha + '?recursive=1').then(function (tree) {
        return { head: head, tree: commit.tree.sha, entries: tree.tree || [] };
      });
    }).catch(function (err) {
      if (err.status === 409) err.message = self.full() + ' is empty. It needs a first commit before Signoff can sync it.';
      if (err.status === 404) err.message = self.full() + ' not found, or your token can’t open it.';
      throw err;
    });
  };

  GitHubStore.prototype.blob = function (sha) {
    return this.api('/git/blobs/' + sha).then(function (b) { return b64Decode(b.content); });
  };

  /* Sync this repository.
     local:  { projectId: doc }    working copies that live here, including unsynced edits
     roster: { users, shared }     the local People list (data repo only; pass null otherwise)
     cache:  { path: { sha } }     blob shas as of the last sync of this repo. A project whose
                                   sha hasn't changed since is already merged into the local
                                   copy, so it isn't downloaded again.
     opts.belongsHere(id, roster): projects it rejects (moved to their own repository) are
                                   not downloaded or pushed; local copies come back in `moved`,
                                   and with opts.deleteStrays their files here are deleted.
     opts.tool:                    also read checklists (templates/) and the tool version.
     cfg.summarize(doc):           builds the summary written into each project file
                                   (model.withSummary); without it files carry none.
     Resolves { projects, roster, moved, cache, templates, version, pushed, commitUrl };
     templates is null when they haven't changed since the last sync. */
  GitHubStore.prototype.sync = function (local, roster, cache, opts) {
    var self = this;
    opts = opts || {};
    local = local || {};
    var belongsHere = opts.belongsHere || function () { return true; };
    var attempt = 0;
    cache = cache || {};

    function fetchText(e) {
      return self.blob(e.sha).then(function (text) { return { path: e.path, sha: e.sha, text: text }; });
    }
    function idOf(path, dir) { return path.slice(dir.length).replace(/\.json$/, ''); }
    // Small files (roster, version) keep their text in the cache.
    function cachedText(e) {
      if (!e) return Promise.resolve(null);
      var c = cache[e.path];
      if (c && c.sha === e.sha && c.text != null) return Promise.resolve({ path: e.path, sha: e.sha, text: c.text });
      return fetchText(e);
    }

    function once() {
      attempt++;
      var snap, blobs, projectEntries, strays = [], rosterEntry, mergedRoster = null, templates = null, version = null;
      var nextCache = Object.assign({}, cache);   // only returned once the sync succeeds
      var dir = self.projectsDir();
      var rosterPath = self.dataDir() + 'users.json';
      var tplDir = (self.cfg.templatePath || 'templates').replace(/\/+$/, '') + '/';
      var direct = function (e, base) { return e.path.indexOf(base) === 0 && /\.json$/.test(e.path) && e.path.slice(base.length).indexOf('/') < 0; };
      var fresh = function (e) { return !(cache[e.path] && cache[e.path].sha === e.sha); };
      return self.snapshot().then(function (s) {
        snap = s;
        blobs = s.entries.filter(function (e) { return e.type === 'blob'; });
        rosterEntry = roster ? blobs.filter(function (e) { return e.path === rosterPath; })[0] : null;
        // The roster comes first: it says which projects have moved to their own repository.
        return cachedText(rosterEntry);
      }).then(function (rf) {
        if (roster) {
          var remoteRoster = null;
          if (rf) {
            nextCache[rf.path] = { sha: rf.sha, text: rf.text };
            try { remoteRoster = JSON.parse(rf.text); } catch (e) { remoteRoster = null; }
          }
          mergedRoster = M.mergeRosters(roster, remoteRoster);
        }
        projectEntries = [];
        blobs.forEach(function (e) {
          if (!direct(e, dir)) return;
          (belongsHere(idOf(e.path, dir), mergedRoster) ? projectEntries : strays).push(e);
        });
        // Projects: fetch only what changed, or what we have no local copy of.
        var projectReads = projectEntries.map(function (e) {
          return fresh(e) || !local[idOf(e.path, dir)] ? fetchText(e) : Promise.resolve({ path: e.path, sha: e.sha, unchanged: true });
        });
        var tplReads = Promise.resolve(null), versionRead = Promise.resolve(null);
        if (opts.tool) {
          var tplEntries = blobs.filter(function (e) { return direct(e, tplDir); });
          var versionEntry = blobs.filter(function (e) { return e.path === 'assets/version.js'; })[0];
          // Templates: all of them again if any changed, otherwise nothing.
          tplReads = tplEntries.some(fresh) || tplEntries.length !== Object.keys(cache).filter(function (k) { return k.indexOf(tplDir) === 0; }).length
            ? Promise.all(tplEntries.map(fetchText)) : Promise.resolve(null);
          tplEntries.forEach(function (e) { nextCache[e.path] = { sha: e.sha }; });
          versionRead = cachedText(versionEntry);
        }
        return Promise.all([Promise.all(projectReads), tplReads, versionRead]);
      }).then(function (got) {
        if (got[1]) {
          templates = [];
          got[1].forEach(function (f) {
            try { templates.push(JSON.parse(f.text)); } catch (e) { /* a broken template file is skipped */ }
          });
        }
        if (got[2]) {
          nextCache[got[2].path] = { sha: got[2].sha, text: got[2].text };
          var m = /hash:\s*'([0-9a-f]+)'[\s\S]*?date:\s*'([^']*)'/.exec(got[2].text);
          if (m) version = { hash: m[1], date: m[2] };
        }

        var remote = {};
        got[0].forEach(function (f) {
          var id = idOf(f.path, dir);
          if (f.unchanged) { remote[id] = { path: f.path, sha: f.sha, unchanged: true }; return; }
          try { remote[id] = { doc: JSON.parse(f.text), path: f.path, sha: f.sha }; } catch (e) { /* unreadable project file: leave it alone */ }
        });

        // Local copies of projects that now live elsewhere are handed back, never pushed here.
        var moved = Object.keys(local).filter(function (id) { return !belongsHere(id, mergedRoster); });
        var merged = {}, candidates = [];
        var ids = Object.keys(remote).concat(Object.keys(local).filter(function (id) { return !remote[id] && moved.indexOf(id) < 0; }));
        ids.forEach(function (id) {
          var r = remote[id];
          var doc = r && r.unchanged ? local[id] : M.mergeProjects(local[id], r && r.doc);
          if (!doc) return;
          merged[id] = doc;
          var written = M.withSummary(doc, self.cfg.summarize);
          candidates.push({ path: r ? r.path : dir + id + '.json', text: M.stableStringify(written), label: doc.meta.name, sha: r && r.sha });
        });
        projectEntries.forEach(function (e) { nextCache[e.path] = { sha: e.sha }; });
        if (mergedRoster && (Object.keys(mergedRoster.users).length || Object.keys(mergedRoster.shared).length)) {
          candidates.push({ path: rosterPath, text: M.stableStringify(mergedRoster), label: 'people', sha: rosterEntry && rosterEntry.sha, roster: true });
        }

        return Promise.all(candidates.map(function (c) {
          return gitBlobSha(c.text).then(function (sha) { c.newSha = sha; return c; });
        })).then(function (all) {
          var changes = all.filter(function (c) { return c.newSha !== c.sha; });
          if (opts.deleteStrays) {
            strays.forEach(function (e) { changes.push({ path: e.path, remove: true, label: 'move ' + idOf(e.path, dir) }); });
          }
          var result = { projects: merged, roster: mergedRoster, moved: moved, cache: nextCache, templates: templates, version: version, pushed: 0 };
          if (!changes.length || opts.pullOnly) return result;
          return self.commit(snap, changes, opts.message).then(function (commit) {
            changes.forEach(function (c) {
              if (c.remove) delete nextCache[c.path];
              else nextCache[c.path] = c.roster ? { sha: c.newSha, text: c.text } : { sha: c.newSha };
            });
            result.pushed = changes.length;
            result.commitUrl = commit.html_url;
            return result;
          });
        }).catch(function (err) {
          // 422 "not a fast forward" (or 409): someone pushed first. Pull, merge, retry.
          if ((err.status === 422 || err.status === 409) && attempt < MAX_ATTEMPTS) {
            if (opts.onRetry) opts.onRetry(attempt);
            return once();
          }
          throw err;
        });
      });
    }
    return once();
  };

  GitHubStore.prototype.commit = function (snap, changes, message) {
    var self = this;
    return this.api('/git/trees', { method: 'POST', body: {
      base_tree: snap.tree,
      tree: changes.map(function (c) {
        if (c.remove) return { path: c.path, mode: '100644', type: 'blob', sha: null };
        if (c.blobSha) return { path: c.path, mode: '100644', type: 'blob', sha: c.blobSha };
        return { path: c.path, mode: '100644', type: 'blob', content: c.text };
      })
    } }).then(function (tree) {
      return self.api('/git/commits', { method: 'POST', body: {
        message: message || ('Signoff: update ' + changes.map(function (c) { return c.label; }).join(', ')),
        tree: tree.sha,
        parents: [snap.head]
      } });
    }).then(function (commit) {
      return self.api('/git/refs/heads/' + encodeURIComponent(self.cfg.branch || 'main'), { method: 'PATCH', body: { sha: commit.sha, force: false } })
        .then(function () { return commit; });
    });
  };

  // ── Files outside the review documents (Fabcheck packages and runs) ──

  // Blob files under `prefix` on the branch: [{ path, sha, size }].
  GitHubStore.prototype.listTree = function (prefix) {
    return this.snapshot().then(function (s) {
      return s.entries.filter(function (e) { return e.type === 'blob' && e.path.indexOf(prefix || '') === 0; })
        .map(function (e) { return { path: e.path, sha: e.sha, size: e.size }; });
    });
  };
  GitHubStore.prototype.blobBytes = function (sha) {
    return this.api('/git/blobs/' + sha).then(function (b) { return b64ToBytes(b.content); });
  };
  // One file's bytes, or null if it isn't there. Pass `entries` from listTree to save a call.
  GitHubStore.prototype.readBytes = function (path, entries) {
    var self = this;
    return (entries ? Promise.resolve(entries) : this.listTree(path)).then(function (list) {
      var e = list.filter(function (x) { return x.path === path; })[0];
      return e ? self.blobBytes(e.sha) : null;
    });
  };

  /* Write several files in one commit.
     files: [{ path, bytes: Uint8Array } | { path, text } | { path, remove: true }]
     opts:  { message, onRetry(attempt), onProgress(done, total) }
     Files whose content already matches are skipped, so writing the same package twice
     uploads nothing. Binary content goes up as blobs first; the commit then uses
     force:false and is retried on a non-fast-forward, like sync.
     Resolves { pushed, skipped, commitUrl }. */
  GitHubStore.prototype.putFiles = function (files, opts) {
    var self = this, attempt = 0, uploaded = {};
    opts = opts || {};
    var items = files.map(function (f) {
      return f.remove ? { path: f.path, remove: true } : { path: f.path, bytes: f.bytes || new TextEncoder().encode(f.text || '') };
    });
    return Promise.all(items.map(function (it) {
      return it.remove ? it : gitBlobShaBytes(it.bytes).then(function (sha) { it.sha = sha; return it; });
    })).then(function once() {
      attempt++;
      return self.snapshot().then(function (snap) {
        var have = {};
        snap.entries.forEach(function (e) { if (e.type === 'blob') have[e.path] = e.sha; });
        var changes = items.filter(function (it) { return it.remove ? !!have[it.path] : have[it.path] !== it.sha; });
        var skipped = items.length - changes.length;
        if (!changes.length) return { pushed: 0, skipped: skipped };
        var toUpload = changes.filter(function (it) { return !it.remove && !uploaded[it.sha]; });
        var done = 0, next = 0;
        function worker() {
          if (next >= toUpload.length) return Promise.resolve();
          var it = toUpload[next++];
          return self.api('/git/blobs', { method: 'POST', body: { content: bytesToB64(it.bytes), encoding: 'base64' } }).then(function (b) {
            if (b.sha !== it.sha) throw new Error('GitHub stored ' + it.path + ' with a different checksum');
            uploaded[it.sha] = true;
            done++;
            if (opts.onProgress) opts.onProgress(done, toUpload.length);
            return worker();
          });
        }
        return Promise.all([worker(), worker(), worker(), worker()]).then(function () {
          return self.commit(snap, changes.map(function (it) {
            return it.remove ? { path: it.path, remove: true } : { path: it.path, blobSha: it.sha };
          }), opts.message || 'Signoff: update files');
        }).then(function (commit) {
          return { pushed: changes.length, skipped: skipped, commitUrl: commit.html_url };
        });
      }).catch(function (err) {
        if ((err.status === 422 || err.status === 409) && attempt < MAX_ATTEMPTS) {
          if (opts.onRetry) opts.onRetry(attempt);
          return once();
        }
        throw err;
      });
    });
  };

  // ── Who can open this repository. On a personal account only the owner can change it;
  // in an organization, its admins can. Needs Administration access on the token.
  GitHubStore.prototype.collaborators = function () {
    return this.api('/collaborators?per_page=100').then(function (list) { return (list || []).map(function (u) { return u.login.toLowerCase(); }); });
  };
  GitHubStore.prototype.invitations = function () {
    return this.api('/invitations?per_page=100').then(function (list) {
      return (list || []).map(function (i) { return { id: i.id, login: ((i.invitee && i.invitee.login) || '').toLowerCase() }; });
    });
  };
  GitHubStore.prototype.invite = function (login) {
    return this.api('/collaborators/' + encodeURIComponent(login), { method: 'PUT', body: { permission: 'push' } });
  };
  // Takes away access, including an invitation not yet accepted.
  GitHubStore.prototype.revoke = function (login) {
    var self = this;
    login = login.toLowerCase();
    return this.invitations().then(function (inv) {
      return Promise.all(inv.filter(function (i) { return i.login === login; }).map(function (i) {
        return self.api('/invitations/' + i.id, { method: 'DELETE' });
      }));
    }).then(function () {
      return self.api('/collaborators/' + encodeURIComponent(login), { method: 'DELETE' }).catch(function (err) { if (err.status !== 404) throw err; });
    });
  };

  S.GitHubStore = GitHubStore;
  S.GitHubAccount = GitHubAccount;
  S.github = { b64Encode: b64Encode, b64Decode: b64Decode, gitBlobSha: gitBlobSha,
    bytesToB64: bytesToB64, b64ToBytes: b64ToBytes, gitBlobShaBytes: gitBlobShaBytes };
})(window.Signoff = window.Signoff || {});
