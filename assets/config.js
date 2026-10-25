/* Signoff ME: everything that differs between the Signoff tools (EE, ME). The shared engine
   (model.js, github.js, workspace.js, app.js, demo.js, styles.css and tools/*.py, vendored
   from ee_design_review by tools/sync_engine.py) reads this. Keep the part after "=" strict
   JSON: tools/build.py, validate_templates.py and package.py parse it too.

   storage.ns:     localStorage namespace for this tool. The GitHub token (signoff.token) and
                   the theme (signoff.v1.settings -> theme) are shared by every Signoff tool.
   repos:          defaults for Settings -> Repositories. prefix must not be a prefix of
                   another tool's (contractors find their repos by name prefix).
   repos.suite:    other repositories every FTE is invited to, next to this tool's own:
                   the other discipline's tool and data repos, and the hub.
   ids:            prefixes for new project, comment and custom-check IDs.
   templatePrefixes: checklist id -> required prefix of its section and item IDs. */
window.SIGNOFF_CONFIG = {
  "product": "Signoff ME",
  "discipline": "ME",
  "tagline": "Mechanical design review",
  "storage": { "ns": "signoff-me.v1.", "demoNs": "signoff-me.demo." },
  "hostedBase": "https://chrismessick-dpd.github.io",
  "repos": {
    "owner": "chrismessick-dpd",
    "toolRepo": "me_design_review",
    "dataRepo": "me_design_review_data",
    "prefix": "review-me-",
    "suite": ["ee_design_review", "ee_design_review_data", "signoff", "pcb_dfm", "signoff_pl", "signoff_pl_data"]
  },
  "ids": { "project": "m", "comment": "mc", "custom": "mx" },
  "templateOrder": ["requirements", "part-design", "tolerancing", "dfa", "materials", "analysis", "enclosure", "drawings", "validation"],
  "templatePrefixes": {
    "requirements": "rq", "part-design": "pd", "tolerancing": "tol", "dfa": "asm", "materials": "mat",
    "analysis": "fea", "enclosure": "enc", "drawings": "drw", "validation": "val"
  },
  "defaultChecklists": ["requirements", "part-design", "tolerancing", "dfa", "materials", "drawings"],
  "stages": ["Concept", "Detailed design", "Prototype (EVT)", "Validation (DVT)", "Pilot (PVT)", "Released"],
  "defaultStage": "Detailed design",
  "legacyTabs": [],
  "words": {
    "thing": "product",
    "general": "General product",
    "profile": "Product profile",
    "number": "Part / assembly number",
    "numberPlaceholder": "e.g. 2100410-001",
    "namePlaceholder": "e.g. Handheld enclosure assembly"
  },
  "tags": [
    { "id": "injection-molded", "label": "Injection molded", "desc": "Molded plastic, overmolds, inserts" },
    { "id": "sheet-metal", "label": "Sheet metal", "desc": "Formed, laser-cut or punched sheet" },
    { "id": "machined", "label": "Machined", "desc": "CNC-milled or turned parts" },
    { "id": "cast", "label": "Cast", "desc": "Die, investment or sand castings" },
    { "id": "additive", "label": "3D printed", "desc": "SLS, MJF, SLA, FDM, DMLS parts" },
    { "id": "extruded", "label": "Extrusions", "desc": "Aluminum or plastic extrusions" },
    { "id": "elastomer", "label": "Elastomers", "desc": "Gaskets, keypads, LSR / TPE, O-rings" },
    { "id": "sealed-ip", "label": "Sealed / IP rated", "desc": "Ingress rating, water and dust" },
    { "id": "outdoor", "label": "Outdoor", "desc": "UV, rain, wide temperature, corrosion" },
    { "id": "medical", "label": "Medical", "desc": "ISO 13485 / IEC 60601 style" },
    { "id": "high-volume", "label": "Volume production", "desc": "Tooling, cycle time, cost" },
    { "id": "moving-parts", "label": "Mechanisms", "desc": "Hinges, slides, gears, springs" },
    { "id": "thermal", "label": "Thermal", "desc": "Significant heat or active cooling" },
    { "id": "battery-pack", "label": "Battery", "desc": "Contains a battery or pack" },
    { "id": "electronics", "label": "Electronics", "desc": "Houses PCBAs, cables, antennas" },
    { "id": "handheld", "label": "Handheld", "desc": "Portable: drop, grip, ergonomics" },
    { "id": "structural", "label": "Structural", "desc": "Significant or safety-critical loads" },
    { "id": "fluidic", "label": "Fluids", "desc": "Liquids or gases, pressure, tubing" },
    { "id": "cosmetic", "label": "Cosmetic", "desc": "Class A customer-facing surfaces" },
    { "id": "regulatory", "label": "Certification", "desc": "Safety / compliance (UL, CE, RoHS)" },
    { "id": "wearable", "label": "Wearable", "desc": "Worn or in prolonged skin contact" }
  ],
  "demo": {
    "findings": [
      {
        "id": "pd-im-6",
        "sev": "major",
        "who": "R. Okafor",
        "by": "Dana Kim",
        "ref": "Top housing, ribs R3–R7",
        "notes": [
          "Ribs under the display window are 100% of the 2.0 mm (79 mil) wall. Mold-flow shows sink on the Class A face above them.",
          "Thinned to 1.2 mm (47 mil) with a 0.5° draft per side. Will re-run mold-flow."
        ],
        "res": "fixed"
      },
      {
        "id": "pd-tool-3",
        "sev": "critical",
        "who": "R. Okafor",
        "by": "Lee Alvarez",
        "ref": "Snap S2",
        "notes": [
          "Knit line from the two gates meets right at the root of snap S2. Expect it to crack at assembly.",
          "Molder suggests moving gate G2 about 15 mm (591 mil) toward the hinge side."
        ],
        "res": ""
      },
      {
        "id": "tol-stk-6",
        "sev": "major",
        "who": "Dana Kim",
        "by": "Lee Alvarez",
        "ref": "Stack 04, lid-to-base gap",
        "notes": [
          "Gap stack uses drawing tolerances only. PC/ABS shrink variation on the 180 mm (7.09 in) lid is missing."
        ],
        "res": ""
      },
      {
        "id": "pd-im-12",
        "sev": "major",
        "who": "",
        "by": "Dana Kim",
        "ref": "Bosses B1–B6",
        "notes": [
          "Boss OD is 5.0 mm (197 mil) for an M2.5 thread-forming screw. The screw supplier's guide asks for about 2.5× the screw diameter.",
          "Increased to 6.3 mm (248 mil) and added gussets."
        ],
        "res": "fixed"
      },
      {
        "id": "enc-ip-3",
        "sev": "critical",
        "who": "R. Okafor",
        "by": "Lee Alvarez",
        "ref": "Main gasket",
        "notes": [
          "At max groove depth and min gasket height, compression drops below the supplier's minimum. IP67 at risk.",
          "Proposal: raise the tongue 0.3 mm (11.8 mil) and re-check the stack."
        ],
        "res": ""
      },
      {
        "id": "enc-drop-5",
        "sev": "major",
        "who": "Dana Kim",
        "by": "Lee Alvarez",
        "ref": "Battery bay rib",
        "notes": [
          "Rib tip is 0.4 mm (15.7 mil) from the pouch cell. A 1.2 m drop simulation shows contact."
        ],
        "res": ""
      },
      {
        "id": "drw-tb-4",
        "sev": "minor",
        "who": "",
        "by": "Dana Kim",
        "ref": "2100410-001",
        "notes": [
          "Finish block is empty. Texture (MT-11010) is only in the CMF deck."
        ],
        "res": "waived"
      },
      {
        "id": "mat-pl-4",
        "sev": "major",
        "who": "R. Okafor",
        "by": "Lee Alvarez",
        "ref": "Lid, PC/ABS",
        "notes": [
          "The customer's cleaning wipes contain an alcohol-based agent. PC/ABS near the screw bosses is under hoop stress.",
          "Ordered ESC test coupons from the resin supplier."
        ],
        "res": ""
      }
    ],
    "comments": [
      {
        "id": "pd-im-3",
        "by": "Lee Alvarez",
        "text": "Draft analysis run on all faces: 1° minimum on everything except the snap catches, which are on slides."
      },
      {
        "id": "tol-fit-5",
        "by": "Dana Kim",
        "text": "Checked the hinge pin clearance from −20 °C to 60 °C with the aluminum pin in the PC/ABS bore. Still positive."
      },
      {
        "id": "asm-cbl-3",
        "by": "Lee Alvarez",
        "text": "Should the display FPC get a foam pad where it folds over the boss? It looks tight in section B-B."
      }
    ],
    "projects": [
      {
        "seed": 5,
        "users": [
          "Dana Kim",
          "Lee Alvarez"
        ],
        "requirements": [{"ref": "REQ-001", "text": "The enclosure shall meet IP67 with the cable gland and vent installed.", "category": "Sealing", "source": "Client PRD SH-200 §3.2", "method": "test", "status": "approved", "verify": "open", "links": ["enc-ip-1", "enc-ip-4", "enc-ip-17"], "by": "Dana Kim"}, {"ref": "REQ-002", "text": "Exterior plastics shall show no cracking or chalking after 1,000 h of UV exposure.", "category": "Environment", "source": "Client PRD SH-200 §3.5", "method": "test", "status": "approved", "verify": "open", "links": ["enc-env-1"], "by": "Lee Alvarez"}, {"ref": "REQ-003", "text": "The installed unit shall weigh no more than 450 g.", "category": "Mass", "source": "Client PRD SH-200 §2.1", "method": "analysis", "status": "approved", "verify": "pass", "evidence": "CAD mass report rev C: 412 g including the bracket.", "links": ["mat-sel-11"], "by": "Dana Kim"}, {"ref": "REQ-004", "text": "The lid should open with a standard tool and no special fasteners.", "kind": "should", "category": "Service", "source": "Field service workshop 2026-09-15", "method": "demonstration", "status": "draft", "verify": "open", "links": [], "by": "Lee Alvarez"}],
        "ratios": {
          "requirements": 0.95,
          "part-design": 0.7,
          "tolerancing": 0.55,
          "dfa": 0.5,
          "materials": 0.6,
          "enclosure": 0.65,
          "drawings": 0.2
        },
        "fields": {
          "name": "Outdoor Sensor Hub — Enclosure",
          "client": "Acme Climate",
          "board": "2100410-001",
          "revision": "B",
          "stage": "Prototype (EVT)",
          "description": "Rev B enclosure review before tooling kickoff. Two-part PC/ABS housing, IP67 gasket, wall mount, solar-exposed.",
          "profile": [
            "injection-molded",
            "sealed-ip",
            "outdoor",
            "electronics",
            "high-volume",
            "cosmetic"
          ],
          "checklists": [
            "requirements",
            "part-design",
            "tolerancing",
            "dfa",
            "materials",
            "enclosure",
            "drawings"
          ]
        }
      },
      {
        "seed": 13,
        "users": [
          "Lee Alvarez",
          "Dana Kim"
        ],
        "requirements": [{"ref": "REQ-001", "text": "The scanner shall survive 26 drops from 1.2 m onto concrete, on every face, edge and corner, and still work.", "category": "Durability", "source": "Northwind PRD v2 §5.1", "method": "test", "status": "approved", "verify": "open", "links": ["enc-drop-1", "enc-drop-2"], "by": "Lee Alvarez"}, {"ref": "REQ-002", "text": "All fasteners shall be metric and use at most two drive types.", "category": "Assembly", "source": "Northwind design guide", "method": "inspection", "status": "approved", "verify": "pass", "evidence": "Fastener list rev B: M2 and M2.5, Torx T6 only.", "links": ["asm-thr-2"], "by": "Dana Kim"}],
        "ratios": {
          "part-design": 0.4,
          "tolerancing": 0.25,
          "dfa": 0.3
        },
        "fields": {
          "name": "Handheld Scanner — Housing & Trigger",
          "client": "Northwind Instruments",
          "board": "2200715-010",
          "revision": "A",
          "stage": "Detailed design",
          "description": "First design review of the housing, trigger mechanism and battery door. Li-ion pouch cell, TPE overmolded grip.",
          "profile": [
            "injection-molded",
            "handheld",
            "battery-pack",
            "moving-parts",
            "electronics",
            "elastomer"
          ],
          "checklists": [
            "part-design",
            "tolerancing",
            "dfa",
            "enclosure"
          ]
        }
      }
    ]
  }
};
