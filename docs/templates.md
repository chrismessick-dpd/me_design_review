# Checklist templates

Each checklist is one JSON file in `templates/`. `tools/build.py` bundles them into
`assets/templates.js` so the tool works when opened from disk. After a Git Sync, the
templates pulled from the repo are used instead of the bundled copy.

## Shape

```json
{
  "id": "part-design",
  "title": "Part Design & DFM",
  "short": "Part DFM",
  "version": 1,
  "description": "One sentence on what this checklist covers.",
  "sections": [
    {
      "id": "pd-im",
      "title": "Injection-Molded Parts",
      "tags": ["injection-molded"],
      "items": [
        {
          "id": "pd-im-1",
          "text": "Nominal wall thickness is uniform across the part",
          "hint": "How to check it, or why it matters. One to three sentences.",
          "tags": [],
          "severity": "major"
        }
      ]
    }
  ]
}
```

- `id` (template, section, item): lowercase letters, digits and `-`. Unique across **all**
  templates. Never reuse or renumber an ID: reviews store their state by item ID.
  If an item is removed, its ID is retired; reviews keep its state and show it as retired.
- Each checklist owns an ID prefix, and its section and item IDs start with it:

  | Checklist (`id`) | Prefix | Section IDs | Item IDs |
  | --- | --- | --- | --- |
  | Concept (`requirements`) | `rq` | `rq-<sec>` | `rq-<sec>-<n>` |
  | Part Design & DFM (`part-design`) | `pd` | `pd-<sec>` | `pd-<sec>-<n>` |
  | Tolerancing & GD&T (`tolerancing`) | `tol` | `tol-<sec>` | `tol-<sec>-<n>` |
  | Assembly, Fastening & DFA (`dfa`) | `asm` | `asm-<sec>` | `asm-<sec>-<n>` |
  | Materials & Finishes (`materials`) | `mat` | `mat-<sec>` | `mat-<sec>-<n>` |
  | Thermal & Structural Analysis (`analysis`) | `fea` | `fea-<sec>` | `fea-<sec>-<n>` |
  | Enclosures, Sealing & IP (`enclosure`) | `enc` | `enc-<sec>` | `enc-<sec>-<n>` |
  | Drawings & Release (`drawings`) | `drw` | `drw-<sec>` | `drw-<sec>-<n>` |
  | Prototype, Test & Validation (`validation`) | `val` | `val-<sec>` | `val-<sec>-<n>` |

  `<sec>` is a short code (2–6 letters) for the section, e.g. `pd-im` for injection molding.
  `<n>` counts from 1 within the section. `tools/validate_templates.py` enforces the prefix.
- `text`: the check, phrased as the condition that should be true. Required.
- `hint`: optional guidance. Say how to check it or what goes wrong if missed.
- `severity`: `critical` (the part won't function, is unsafe, or tooling must be recut),
  `major` (likely defect, field failure, yield or cost problem), or `minor` (quality,
  documentation, cosmetic).
- `tags`: when the item applies. An untagged item applies to every product. A tagged item
  (or section) applies only when the project profile has **at least one** of its tags.
  Items that don't apply count as N/A, and the reviewer can still bring them back.
- Bump `version` when the content of a template changes.

## Tags

Use only these. `tools/validate_templates.py` rejects anything else (the list lives in
`assets/config.js`).

| Tag | Applies when the product… |
| --- | --- |
| `injection-molded` | has injection-molded plastic parts (including overmolds and insert molds) |
| `sheet-metal` | has formed or laser/punched sheet-metal parts |
| `machined` | has CNC-machined or turned parts |
| `cast` | has die-cast, investment-cast or sand-cast parts |
| `additive` | uses 3D-printed parts beyond early prototypes (SLS, MJF, SLA, FDM, DMLS) |
| `extruded` | uses aluminum or plastic extrusions |
| `elastomer` | has elastomer parts: gaskets, keypads, LSR/TPE overmolds, O-rings |
| `sealed-ip` | must meet an IP / ingress rating or is otherwise sealed against water and dust |
| `outdoor` | is used outdoors: UV, rain, wide temperature range, corrosion |
| `medical` | is a medical device (ISO 13485 / IEC 60601 / ISO 10993 style requirements) |
| `high-volume` | is going to volume production (tooling, cycle time, cost, fixtures) |
| `moving-parts` | has mechanisms: hinges, slides, gears, bearings, springs, latches |
| `thermal` | dissipates significant heat or has active cooling |
| `battery-pack` | contains a battery or battery pack |
| `electronics` | houses PCBAs, cables, displays or antennas |
| `handheld` | is handheld or portable: drop, grip, ergonomics |
| `structural` | carries significant loads or has safety-critical load paths |
| `fluidic` | handles liquids or gases: tubing, pressure, pumps, seals against fluids |
| `cosmetic` | has customer-facing cosmetic (Class A) surfaces |
| `regulatory` | needs safety or compliance certification (e.g. UL / IEC 62368-1, CE, RoHS / REACH) |
| `wearable` | is worn, or is in prolonged skin contact |

## Writing guidance

- Metric first: mm, N, N·m, MPa, °C, g. Give inches or lbf in parentheses only where
  the industry habitually quotes them.
- Don't invent standard clause numbers or precise thresholds. Name a standard only when
  you're sure it is the right one (ISO 286, ISO 1101 / ASME Y14.5, ISO 2768, IEC 60529,
  ISO 10993 and UL 94 are fine), and phrase numeric limits as "per material datasheet",
  "per supplier / molder capability", "per spec", or as a clearly labeled rule of thumb.
- One check per item. Avoid "and also…" items that can half pass.
- Make checks something a reviewer can actually verify in CAD, on a drawing, in a report
  or on a part, and say how in the hint.
- American English spelling throughout (color, aluminum, mold, behavior, labeled, modeling,
  fiber, center, gray, -ize / -ization).
