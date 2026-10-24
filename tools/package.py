# Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
# vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js.
"""Make a copy of this Signoff tool to send to a contractor.

    python tools/package.py        # writes dist/Signoff-EE-<build>.zip (or Signoff-ME-…)

The zip holds only the tool (index.html and assets/), with the checklists bundled, plus a
short START HERE note. It contains no review data and no token: the contractor signs in
with their own GitHub token and syncs only the projects they're assigned in People.
"""
import json
import pathlib
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

START_HERE = """{product} - Dovetail {tagline}
{rule}

1. Unzip this folder anywhere and open index.html in Chrome, Edge or Safari.
2. If you don't have one, create a free GitHub account at https://github.com/signup
   and send your username to your Dovetail contact.
3. In {product}, click the gear (bottom left) and follow "New to GitHub? Set up in four
   steps" to create a token. Paste it in and click Save & sync.
4. Click Accept on the invitation that appears in the sidebar.

Your projects then appear in the sidebar. Click Sync (or press Ctrl+S) to get the latest
changes and send yours. When the sidebar says "Newer tool available", ask for a new copy.
"""


def load_config():
    """assets/config.js: window.SIGNOFF_CONFIG = {strict JSON};"""
    text = (ROOT / "assets" / "config.js").read_text(encoding="utf-8")
    return json.loads(re.search(r"window\.SIGNOFF_CONFIG\s*=\s*(\{.*\})\s*;", text, re.S).group(1))


def main():
    if subprocess.call([sys.executable, str(ROOT / "tools" / "build.py"), "--check"]) != 0:
        print("Run python tools/build.py first.")
        return 1
    build = re.search(r"hash:\s*'([0-9a-f]+)'", (ROOT / "assets" / "version.js").read_text(encoding="utf-8")).group(1)
    config = load_config()
    name = config["product"].replace(" ", "-")
    title = f"{config['product']} - Dovetail {config['tagline'].lower()}"
    out = ROOT / "dist" / f"{name}-{build}.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        # Contractors don't get the rest of the suite, so the sidebar links to it go.
        html = re.sub(r"\s*<!-- tools-link:.*?<!-- /tools-link -->", "", (ROOT / "index.html").read_text(encoding="utf-8"), flags=re.S)
        z.writestr(f"{name}/index.html", html)
        for p in sorted((ROOT / "assets").rglob("*")):
            if p.is_file():
                z.write(p, f"{name}/" + p.relative_to(ROOT).as_posix())
        z.writestr(f"{name}/START HERE.txt", START_HERE.format(product=config["product"], tagline=config["tagline"].lower(), rule="=" * len(title)))
    print(f"wrote {out.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
