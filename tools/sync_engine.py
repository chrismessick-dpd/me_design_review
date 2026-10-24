"""Copy the shared Signoff engine from ../ee_design_review into this tool, unchanged.

    python tools/sync_engine.py           # copy any engine file that differs
    python tools/sync_engine.py --check   # exit 1 if any copy is stale (build.py runs this)

Signoff EE (ee_design_review) is the source of the engine. Fix engine bugs there, then run
this. Never edit the copies here: build.py fails while they differ, so nothing drifts.
What is specific to Signoff ME lives in assets/config.js, index.html, templates/, tests/ and
the docs, which this script never touches.

When ../ee_design_review isn't next to this folder (a fresh clone on its own), --check says
so and passes: there is nothing to compare against.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "ee_design_review"
ENGINE = [
    "assets/model.js", "assets/github.js", "assets/workspace.js", "assets/app.js", "assets/demo.js",
    "assets/styles.css", "tools/build.py", "tools/package.py", "tools/validate_templates.py",
]


def main(argv):
    check = "--check" in argv
    if not (SOURCE / "assets" / "model.js").exists():
        print(f"engine source {SOURCE} not found; skipping the engine check")
        return 0
    stale = []
    for rel in ENGINE:
        src, dst = SOURCE / rel, ROOT / rel
        data = src.read_bytes()
        if dst.exists() and dst.read_bytes() == data:
            continue
        stale.append(rel)
        if not check:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
    if check:
        print("engine stale - run python tools/sync_engine.py: " + ", ".join(stale) if stale else "engine up to date")
        return 1 if stale else 0
    print("copied " + ", ".join(stale) if stale else "engine already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
