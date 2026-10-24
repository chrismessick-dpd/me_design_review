# Shared Signoff engine (EE and ME). Edit it in ee_design_review only; me_design_review
# vendors it unchanged with tools/sync_engine.py. Tool specifics go in assets/config.js.
"""Check every checklist template in templates/ against docs/templates.md.
Tags and ID prefixes come from assets/config.js.

    python tools/validate_templates.py            # all templates
    python tools/validate_templates.py pcb.json   # just these (IDs still checked against all)

Exits 1 and lists the problems if any template is invalid.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"

def load_config():
    """assets/config.js: window.SIGNOFF_CONFIG = {strict JSON};"""
    text = (ROOT / "assets" / "config.js").read_text(encoding="utf-8")
    return json.loads(re.search(r"window\.SIGNOFF_CONFIG\s*=\s*(\{.*\})\s*;", text, re.S).group(1))


CONFIG = load_config()
TAGS = {t["id"] for t in CONFIG["tags"]}
PREFIXES = CONFIG.get("templatePrefixes", {})   # checklist id -> prefix of its section / item IDs
SEVERITIES = {"critical", "major", "minor"}
ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def check(path, seen, errors):
    where = path.name
    try:
        t = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        errors.append(f"{where}: not valid JSON ({e})")
        return 0

    def err(msg):
        errors.append(f"{where}: {msg}")

    def check_id(i, what):
        if not isinstance(i, str) or not ID.match(i):
            err(f"{what} has a bad id {i!r}")
        elif i in seen:
            err(f"{what} id {i!r} is also used in {seen[i]}")
        else:
            seen[i] = where

    def check_tags(tags, what):
        if not isinstance(tags, list):
            err(f"{what}: tags must be a list")
            return
        for tag in tags:
            if tag not in TAGS:
                err(f"{what}: unknown tag {tag!r}")
        if len(set(tags)) != len(tags):
            err(f"{what}: repeated tag")

    check_id(t.get("id"), "template")
    prefix = PREFIXES.get(t.get("id"))
    for key in ("title", "short", "description"):
        if not isinstance(t.get(key), str) or not t[key].strip():
            err(f"missing {key}")
    if not isinstance(t.get("version"), int):
        err("version must be an integer")
    count = 0
    for s in t.get("sections") or []:
        sid = s.get("id")
        check_id(sid, "section")
        if prefix and not str(sid).startswith(prefix + "-"):
            err(f"section {sid}: id must start with {prefix}-")
        if not str(s.get("title", "")).strip():
            err(f"section {sid}: missing title")
        check_tags(s.get("tags", []), f"section {sid}")
        if not s.get("items"):
            err(f"section {sid}: no items")
        for it in s.get("items") or []:
            iid = it.get("id")
            check_id(iid, f"item in {sid}")
            if prefix and not str(iid).startswith(f"{sid}-"):
                err(f"item {iid}: id must start with {sid}-")
            if not str(it.get("text", "")).strip():
                err(f"item {iid}: empty text")
            if "hint" in it and not isinstance(it["hint"], str):
                err(f"item {iid}: hint must be a string")
            if it.get("severity") not in SEVERITIES:
                err(f"item {iid}: severity must be one of {sorted(SEVERITIES)}")
            check_tags(it.get("tags", []), f"item {iid}")
            extra = set(it) - {"id", "text", "hint", "tags", "severity"}
            if extra:
                err(f"item {iid}: unexpected keys {sorted(extra)}")
            count += 1
    if not t.get("sections"):
        err("no sections")
    return count


def main(argv):
    paths = sorted(TEMPLATES.glob("*.json"))
    only = set(argv)
    errors, seen = [], {}
    for p in paths:
        n = check(p, seen, errors if not only or p.name in only else [])
        if not only or p.name in only:
            print(f"{p.name}: {n} items")
    for e in errors:
        print("  " + e)
    if errors:
        print(f"{len(errors)} problem(s)")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
