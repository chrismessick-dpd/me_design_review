"""Copy Loom's routing engine (route.js and connect.js) into assets/vendor/, unchanged.

    python tools/sync_routing.py           # copy any file that differs
    python tools/sync_routing.py --check   # exit 1 if a copy is stale

Loom (../loom) is the source of the routing engine (Chris, 2026-11-18: Loom owns it). Scribe's
block diagram routes its lines with it (app.js, specFlowHtml). Never edit the copies here: change
the engine in Loom, check its tests/golden.js, then run this, then sync_engine.py in ME and FW.

When ../loom isn't next to this folder (a fresh clone on its own), --check says so and passes.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "loom" / "assets"
FILES = ["route.js", "connect.js"]


def main(argv):
    check = "--check" in argv
    if not (SOURCE / "route.js").exists():
        print(f"routing source {SOURCE} not found; skipping the routing check")
        return 0
    stale = []
    for name in FILES:
        src, dst = SOURCE / name, ROOT / "assets" / "vendor" / name
        data = src.read_bytes()
        if dst.exists() and dst.read_bytes() == data:
            continue
        stale.append(name)
        if not check:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
    if check:
        print("stale: " + ", ".join(stale) + " - run python tools/sync_routing.py" if stale else "routing up to date")
        return 1 if stale else 0
    print("copied " + ", ".join(stale) if stale else "routing already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
