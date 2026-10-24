# Signoff ME — mechanical design review

Signoff ME is Dovetail's checklist tool for mechanical design reviews: requirements, part
design and DFM, tolerancing, assembly, materials, analysis, enclosures, drawings and
validation. Each project is a review of one product, assembly or part. Reviewers mark checks
Pass / Issue / N/A, discuss them in comment threads, track issues to Fixed or Waived, and print
a review report. Reviews sync through private GitHub repositories, so everyone works on the
same copy.

It runs on the same engine as [Signoff EE](https://github.com/chrismessick-dpd/ee_design_review),
the electrical tool, and both sit under the Dovetail Signoff hub. Day-to-day use, keyboard
shortcuts and how sync works are the same as in Signoff EE; its README covers them in full.

- **845 checks in 9 checklists:** Requirements & Concept, Part Design & DFM, Tolerancing &
  GD&T, Assembly, Fastening & DFA, Materials & Finishes, Thermal & Structural Analysis,
  Enclosures, Sealing & IP, Drawings & Release, and Prototype, Test & Validation.
- **Product profile:** tag a project by process (injection molded, sheet metal, machined, cast,
  3D printed, extrusions, elastomers) and by feature (sealed / IP rated, outdoor, medical,
  mechanisms, thermal, battery, electronics, handheld, structural, fluids, cosmetic,
  certification, wearable, volume production). Checks for processes and features the product
  doesn't have are set aside as N/A. You can still bring any of them back.
- **Findings:** each issue has a severity, owner, reference and resolution. You can export
  findings to CSV or print a signed-off review report (Print → Save as PDF).
- **Demo mode:** open `index.html?demo` for a self-contained sample with no sync. Use it to
  show the tool to people outside the team.

## Using it

Open `index.html` in a browser, straight from a clone or served with `python -m http.server`.
The first time, enter your name. Then open **Settings** (the gear, bottom left), enter a GitHub
token, and **Save & sync**. Next to `ee_design_review`, the sidebar switches between Signoff ME
and Signoff EE and links back to the hub (FTEs only; hidden in demo mode and in contractor
copies).

The token is stored under `signoff.token`, which every Signoff tool shares, so signing in once
covers Signoff ME and Signoff EE in the same browser (from disk, or on one hosted origin).
Light/dark mode is shared too (`theme` in `signoff.v1.settings`). Everything else lives under
this tool's own namespace, `signoff-me.v1.`.

Which token you need:

- **The account owner** (today `chrismessick-dpd`): a fine-grained token with Repository
  access set to **All repositories**, and **Contents** and **Administration** both set to read
  and write. Sharing a project creates a new repository, which a token limited to *selected*
  repositories can't reach. Add FTE also invites people to the EE and hub repos.
- **Everyone else** (the other FTEs and contractors): a *classic* token with the **repo** scope.
  A fine-grained token can only target repositories owned by its holder or by an organization
  they belong to.

## Repositories, people and access

| Repository | Holds | Who's on it |
| --- | --- | --- |
| `me_design_review` (tool) | The tool and the checklists | FTEs |
| `me_design_review_data` (data) | Internal ME reviews (`projects/<id>.json`) and People (`users.json`) | FTEs |
| `review-me-<project>` (one per shared project) | That one review | FTEs and that project's contractors |
| `ee_design_review`, `ee_design_review_data`, `signoff`, `pcb_dfm` | Signoff EE, the hub and Fabcheck | FTEs |

**People & access** (FTEs only) works as in Signoff EE:

- **Adding an FTE** invites them to this tool's repo, its data repo, every ME shared repo, and
  the rest of the suite: Signoff EE's tool and data repos, the hub repo and Fabcheck (`pcb_dfm`). That list is
  `repos.suite` in `assets/config.js`. Each tool keeps its own People list, so add FTEs in
  Signoff EE too. Its People page grants the `review-ee-…` repos.
- **Adding a contractor to a project** moves it out of the data repo into a new private
  `review-me-<project>` repo and invites them to that repo only. A contractor's copy of Signoff
  ME lists only `review-me-…` repos, so it never picks up EE projects. A contractor on an EE
  project is added in Signoff EE.
- **Contractor copies:** `python tools/package.py` makes `dist/Signoff-ME-<build>.zip`. It
  holds the tool and checklists only, with no data, no token and no links to the internal
  tools, plus a START HERE note.

## Layout

| Path | Contents |
| --- | --- |
| `index.html`, `assets/` | The tool (no build step, no dependencies) |
| `assets/config.js` | Everything ME-specific: name, repos, storage namespace, profile tags, stages, default checklists, ID prefixes, demo data |
| `assets/model.js`, `github.js`, `workspace.js`, `app.js`, `demo.js`, `styles.css` | The shared engine, vendored from `ee_design_review` (don't edit here) |
| `assets/templates.js`, `assets/version.js` | Generated by `tools/build.py` |
| `templates/*.json` | The checklists — see [docs/templates.md](docs/templates.md) |
| `tools/sync_engine.py` | Copies the engine from `../ee_design_review`; `--check` fails if it differs |
| `tools/build.py`, `package.py`, `validate_templates.py` | Shared engine tools (vendored) |
| `tests/test.html` | Model and sync tests against a fake GitHub API (open it over http) |

## Changing the tool or the checklists

- **Checklists, `config.js`, `index.html`, tests, docs:** edit here.
- **The engine:** fix it in `ee_design_review`, then run `python tools/sync_engine.py` here.
  `tools/build.py` refuses to build while the copy is stale, so the two tools can't drift
  apart.

Then:

1. Run `python tools/build.py`. It checks the engine copy, validates the templates, rebuilds
   `assets/templates.js`, and stamps `assets/version.js` plus the `?v=` cache-busters. Use
   `--check` in CI.
2. Open `tests/test.html` over http. For example, serve `C:\Dovetail\tools` with
   `python -m http.server` and open `http://localhost:8000/me_design_review/tests/test.html`.
   It should say PASS.
3. Open a pull request. Review data syncs straight to `main`; tool and checklist changes go
   through pull requests.

Never reuse or renumber a check ID. Reviews store their state by ID.
