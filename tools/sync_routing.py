"""Copy Loom's routing engine (route.js and connect.js) and Signoff PL's 3D models (model3d.js and
occt-worker.js) into assets/vendor/, unchanged.

    python tools/sync_routing.py           # copy any file that differs
    python tools/sync_routing.py --check   # exit 1 if a copy is stale

Loom (../loom) is the source of the routing engine (Chris, 2026-11-18: Loom owns it). Scribe's
block diagram routes its lines with it (app.js, specFlowHtml). Never edit the copies here: change
the engine in Loom, check its tests/golden.js, then run this, then sync_engine.py in ME and FW.

Signoff PL (../signoff_pl) owns model3d.js, the PLM1 mesh format, the STEP reader's worker, and the part-model
writer (signoff_pl/docs/part-models.md). Signoff ME loads them for its overview's 3D view and Attach a model
(config.previews.models); change them in PL, then run this, then sync_engine.py in ME and FW.

When ../loom or ../signoff_pl isn't next to this folder (a fresh clone on its own), --check says so and passes.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = [(ROOT.parent / "loom" / "assets", ["route.js", "connect.js"]),
           (ROOT.parent / "signoff_pl" / "assets", ["model3d.js", "occt-worker.js"])]


def main(argv):
    check = "--check" in argv
    stale = []
    for source, files in SOURCES:
        if not (source / files[0]).exists():
            print(f"source {source} not found; skipping its check")
            continue
        for name in files:
            src, dst = source / name, ROOT / "assets" / "vendor" / name
            data = src.read_bytes()
            # Compare with LF endings: a checkout may hold either (git normalizes them), so a copy
            # that differs only by CRLF is not stale.
            if dst.exists() and dst.read_bytes().replace(b"\r\n", b"\n") == data.replace(b"\r\n", b"\n"):
                continue
            stale.append(name)
            if not check:
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_bytes(data)
    if check:
        print("stale: " + ", ".join(stale) + " - run python tools/sync_routing.py" if stale else "vendored engines up to date")
        return 1 if stale else 0
    print("copied " + ", ".join(stale) if stale else "vendored engines already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
