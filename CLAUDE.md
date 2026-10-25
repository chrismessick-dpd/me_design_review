# Signoff ME (me_design_review): notes for Claude

Signoff ME is the mechanical design review tool. It runs the **same engine as Signoff EE**,
copied byte for byte from `../ee_design_review`. When the suite folder is checked out, also read
`../CLAUDE.md` and `../ee_design_review/CLAUDE.md`. This repo is public: no client data, tokens
or commit messages naming clients.

## Rules

- **Never edit the engine files here.** These are `assets/model.js`, `github.js`,
  `workspace.js`, `app.js`, `demo.js`, `styles.css` and `tools/build.py`, `package.py`,
  `validate_templates.py`. Fix them in EE, then run `python tools/sync_engine.py` here.
  `build.py` fails while the copies differ.
- **What belongs to ME:**
  - `assets/config.js`: names, repos, the `review-me-` prefix, 21 profile tags, stages, demo data
  - `index.html`
  - `templates/`: check-ID prefixes per checklist are in `templatePrefixes`
  - `tests/`
  - the docs
- **Check IDs** are never renumbered or reused.
- **The demo** is the Smart Thermostat's Enclosure (`mdemo5`) and Wall Bracket (`mdemo13`).
  - Each project lists its own `findings` and `comments` in `config.demo`.
  - The enclosure's mass requirement evidence (205 g) matches Signoff PL's demo.
  - If you change the demo, follow the demo-suite steps in `../CLAUDE.md` (bump `VERSION` in
    EE's `demo.js`, then regenerate PL's snapshot).
- **Editing `config.js` by script.** The top of the file is hand-formatted. Replace only the
  `demo` block, so the diff stays small.

## Before committing

1. Run `python tools/sync_engine.py --check`, then `python tools/build.py`.
2. Open `tests/test.html` over http. It should show PASS (62 tests as of 2026-10-25).
