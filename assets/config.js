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
          "Molder suggests moving gate G2 about 15 mm (591 mil) toward the display window."
        ],
        "res": ""
      },
      {
        "id": "tol-stk-6",
        "sev": "major",
        "who": "Dana Kim",
        "by": "Lee Alvarez",
        "ref": "Stack 04, cover-to-back gap",
        "notes": [
          "Gap stack uses drawing tolerances only. PC/ABS shrink variation on the 120 mm (4.72 in) front cover is missing."
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
        "ref": "Front cover, PC/ABS",
        "notes": [
          "The customer's cleaning wipes contain an alcohol-based agent. PC/ABS near the screw bosses is under hoop stress.",
          "Ordered ESC test coupons from the resin supplier."
        ],
        "res": ""
      },
      {
        "id": "enc-thm-4",
        "sev": "major",
        "who": "Dana Kim",
        "by": "Lee Alvarez",
        "ref": "Back cover vents",
        "notes": [
          "With the bracket's 6 mm (236 mil) standoff, the back-cover vents face the wall and airflow over the temperature sensor is about half the CFD model's.",
          "EE is moving the sensor to the bottom edge. Proposal: add intake slots on the bottom face to match."
        ],
        "res": ""
      },
      {
        "id": "pd-sm-4",
        "sev": "major",
        "who": "R. Okafor",
        "by": "Lee Alvarez",
        "ref": "Keyhole slots K1, K2",
        "notes": [
          "The keyhole slots are 1.2 mm (47 mil) from the 90° flange bend. The fabricator expects them to distort when formed."
        ],
        "res": ""
      },
      {
        "id": "pd-sm-5",
        "sev": "minor",
        "who": "R. Okafor",
        "by": "Dana Kim",
        "ref": "Catch tabs",
        "notes": [
          "No bend relief where the catch tabs meet the flange edge.",
          "Added 1 mm (39 mil) reliefs."
        ],
        "res": "fixed"
      },
      {
        "id": "tol-stk-7",
        "sev": "major",
        "who": "Dana Kim",
        "by": "Lee Alvarez",
        "ref": "Stack 07, catch tab to cover snaps",
        "notes": [
          "The catch-tab height stack leaves out bend-to-hole variation. At worst case the front cover rocks on the bracket."
        ],
        "res": ""
      },
      {
        "id": "mat-fin-4",
        "sev": "major",
        "who": "",
        "by": "Dana Kim",
        "ref": "2100410-020 finish",
        "notes": [
          "The finish note just says “zinc”. No process or thickness is given.",
          "Proposal: zinc plate after forming, 8 µm (315 µin) minimum, clear trivalent passivate."
        ],
        "res": ""
      },
      {
        "id": "drw-sm-6",
        "sev": "minor",
        "who": "",
        "by": "Lee Alvarez",
        "ref": "2100410-020",
        "notes": [
          "Burr direction isn't stated. The burr side faces the wall, so it's accepted as drawn."
        ],
        "res": "waived"
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
        "text": "Checked the front cover's snap engagement on the bracket catches from 0 °C to 50 °C. Still at least 0.4 mm (15.7 mil) of overlap."
      },
      {
        "id": "asm-cbl-3",
        "by": "Lee Alvarez",
        "text": "Should the display FPC get a foam pad where it folds over the boss? It looks tight in section B-B."
      },
      {
        "id": "pd-sm-3",
        "by": "Lee Alvarez",
        "text": "Flat pattern now uses the fabricator's bend deduction for 1.2 mm (47 mil) cold-rolled steel on their 1 mm punch."
      }
    ],
    "projects": [
      {
        "seed": 5,
        "users": [
          "Dana Kim",
          "Lee Alvarez"
        ],
        "findings": [
          "pd-im-6",
          "pd-tool-3",
          "tol-stk-6",
          "pd-im-12",
          "drw-tb-4",
          "mat-pl-4",
          "enc-thm-4"
        ],
        "comments": [
          "pd-im-3",
          "tol-fit-5",
          "asm-cbl-3"
        ],
        "requirements": [{"ref": "REQ-001", "text": "Every visible face of the front cover shall meet the client's Class A cosmetic standard.", "category": "Cosmetic", "source": "Acme DT-SPEC-12 §7.1", "method": "inspection", "status": "approved", "verify": "open", "links": ["rq-id-2", "pd-cos-6"], "by": "Dana Kim"}, {"ref": "REQ-002", "text": "Venting shall keep the temperature sensor within 0.3 °C of room air while the relays switch full load.", "category": "Thermal", "source": "Acme DT-SPEC-12 §2.3", "method": "test", "status": "approved", "verify": "open", "links": ["enc-thm-4", "fea-th-13"], "by": "Lee Alvarez"}, {"ref": "REQ-003", "text": "The installed thermostat shall weigh no more than 250 g.", "category": "Mass", "source": "Acme DT-SPEC-12 §2.1", "method": "analysis", "status": "approved", "verify": "pass", "evidence": "CAD mass report rev C: 205 g including the bracket, boards and display.", "links": ["mat-sel-11"], "by": "Dana Kim"}, {"ref": "REQ-004", "text": "The front cover should come off the bracket with a flat screwdriver and no special tools.", "kind": "should", "category": "Service", "source": "Installer workshop 2026-09-15", "method": "demonstration", "status": "draft", "verify": "open", "links": [], "by": "Lee Alvarez"}],
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
          "name": "Smart Thermostat — Enclosure",
          "client": "Acme Climate",
          "board": "2100410-001",
          "revision": "B",
          "stage": "Prototype (EVT)",
          "description": "Rev B enclosure review before tooling kickoff. Two-part PC/ABS housing: a front cover with the display window and touch area, and a vented back cover that snaps onto the wall bracket.",
          "profile": [
            "injection-molded",
            "electronics",
            "high-volume",
            "cosmetic",
            "thermal"
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
        "findings": [
          "pd-sm-4",
          "pd-sm-5",
          "tol-stk-7",
          "mat-fin-4",
          "drw-sm-6"
        ],
        "comments": [
          "pd-sm-3"
        ],
        "requirements": [{"ref": "REQ-001", "text": "The bracket shall mount to a single-gang electrical box and to drywall anchors using the same hole pattern.", "category": "Installation", "source": "Acme DT-SPEC-12 §8.2", "method": "inspection", "status": "approved", "verify": "open", "links": ["tol-dat-5"], "by": "Lee Alvarez"}, {"ref": "REQ-002", "text": "All fasteners supplied with the product shall be metric and use at most two drive types.", "category": "Assembly", "source": "Acme design guide", "method": "inspection", "status": "approved", "verify": "pass", "evidence": "Fastener list rev A: M3.5 and M4, Pozidriv PZ2 only.", "links": ["asm-thr-2"], "by": "Dana Kim"}],
        "ratios": {
          "part-design": 0.5,
          "tolerancing": 0.3,
          "dfa": 0.35,
          "materials": 0.4,
          "drawings": 0.1
        },
        "fields": {
          "name": "Smart Thermostat — Wall Bracket",
          "client": "Acme Climate",
          "board": "2100410-020",
          "revision": "A",
          "stage": "Detailed design",
          "description": "First review of the steel wall bracket. It mounts to an electrical box or drywall anchors, passes the HVAC wires through to the main PCBA's terminal block, and carries the catches the enclosure snaps onto.",
          "profile": [
            "sheet-metal",
            "high-volume"
          ],
          "checklists": [
            "part-design",
            "tolerancing",
            "dfa",
            "materials",
            "drawings"
          ]
        }
      }
    ]
  }
};
