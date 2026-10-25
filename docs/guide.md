# Signoff ME: user guide

**Part 1** can be shared with customers. **Part 2** is for Dovetail FTEs.

---

## Part 1: Signoff ME at a glance

Signoff ME is Dovetail's mechanical design review tool. A project is a review of one part or
product. It walks reviewers through 845 checks in nine checklists and records every decision,
comment and issue. At the end it produces a signed-off review report.

| Checklist | Covers |
| --- | --- |
| Concept | Requirements, use cases, envelope, loads, regulatory scope, cost targets, risks |
| Part DFM | Injection molding, machining, sheet metal, casting, additive, by process |
| Tolerancing | GD&T, datums, fits, stack-ups |
| Assembly | DFA, fastening, sequence, serviceability |
| Materials | Selection, grades, finishes, compatibility |
| Analysis | FEA and hand calcs: load cases, modeling, results, thermal |
| Enclosure | Sealing and IP rating, environment, drop, thermal management |
| Drawings | Title block, views, dimensioning, notes, release |
| Validation | Prototype builds, test plans, DVT/PVT, results |

**How a review works**

1. **Describe the product.** Pick the checklists and the product's profile (injection molded,
   sheet metal, sealed, outdoor, handheld, battery, medical…). Checks for features it doesn't have
   are set aside, so the list fits the product.
2. **Review.** Mark each check **Pass**, **Issue** or **N/A**. Keyboard: `j`/`k` to move, `p`/`i`/`n`
   to mark, `c` to comment. Each check carries guidance on what to look for.
3. **Track issues.** Every issue has a severity, an owner, a reference, a discussion, and an
   outcome: open, fixed or waived. The **Findings** tab lists them all.
4. **Requirements (optional).** List what the product must do (IP rating, mass, drop height…),
   how each requirement is verified, and which checks show it's met. You can paste requirements
   from Excel and export the compliance matrix.
5. **Report.** Print or save a PDF with the summary, findings and requirements matrix, plus
   sign-off lines.

**Working together.** Several reviewers can work on the same project at once. Their changes
merge record by record, so no one overwrites anyone. Reviews are kept in private, access-controlled
storage. Each person sees only the projects they've been given.

**Try it:** the demo (`?demo`) stays entirely in your browser. It reviews the enclosure and wall
bracket of a made-up Smart Thermostat, the same product the Signoff EE and PL demos show.

---

## Part 2: for Dovetail FTEs

Signoff ME is the same tool as Signoff EE, with mechanical checklists. **Read Signoff EE's guide**
(`ee_design_review/docs/guide.md`) for the architecture, everyday use and troubleshooting. All of it
applies here. For the suite-wide picture, see the hub's guide: `signoff/docs/guide.md`.

What differs:

| | Signoff ME |
| --- | --- |
| Tool and checklists | `me_design_review` (this repo) |
| Internal reviews and People | `me_design_review_data` (FTEs only) |
| Shared project repos | `review-me-<project>`. The separate prefix keeps EE contractors out of ME projects. |
| Browser storage | `signoff-me.v1.`. Sign-in, your name and light/dark are shared with Signoff EE. |
| Tool specifics | `assets/config.js`: names, repos, the 21 ME profile tags, stages (Concept → EVT/DVT/PVT → Released), demo data |

**Never edit the engine files here.** These are `assets/model.js`, `github.js`, `workspace.js`,
`app.js`, `demo.js`, `styles.css` and `tools/build.py`, `package.py` and `validate_templates.py`.
They come from Signoff EE through `python tools/sync_engine.py`, and `build.py` refuses to build
while they differ.

**People are listed per tool.** Add each FTE in both tools' People pages. Adding an FTE in either
tool invites them to every suite repo. Projects shared from ME are granted from ME's People page.

**Checklists** are JSON in `templates/`, with ME's own tag list. The rules in
`docs/templates.md` apply: never change an ID, and bump `version` when the wording changes. After
editing, run `python tools/build.py` and open `tests/test.html`.
