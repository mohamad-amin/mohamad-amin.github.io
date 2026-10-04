"""Split a training script into named blocks for structure-aware diffing.

A block is a contiguous line range with an identity that is stable across records:
  - kind "def"/"class": a function or class (module level, or inside a module-level
    compound statement such as the `for _ in range(num_trials):` loop), keyed by name;
  - kind "code": the remaining statements of one banner section ("Optimizer", "Setup", ...),
    keyed by the normalized section name.
Comment lines directly above a def/class are attached to it. Line numbers are 0-based,
end-exclusive.
"""
import ast
import re

BANNER_RULE = re.compile(r"^\s*#{8,}\s*$")
BANNER_TITLE = re.compile(r"^\s*#\s+(.+?)\s+#\s*$")


def find_sections(lines):
    """Return list of (start_line, title). A banner is ### / # Title # / ###."""
    secs = []
    for i in range(len(lines) - 2):
        if BANNER_RULE.match(lines[i]) and BANNER_TITLE.match(lines[i + 1]) and BANNER_RULE.match(lines[i + 2]):
            secs.append((i, BANNER_TITLE.match(lines[i + 1]).group(1).strip()))
    return secs


def norm_section(title):
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def collect_defs(tree):
    """Defs/classes at module level or nested inside module-level compound statements
    (but not inside other defs/classes). Returns (name, kind, start0, end0, qual)."""
    out = []

    def visit(stmts, prefix=""):
        for node in stmts:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = min([node.lineno] + [d.lineno for d in node.decorator_list]) - 1
                kind = "class" if isinstance(node, ast.ClassDef) else "def"
                out.append((node.name, kind, start, node.end_lineno, prefix + node.name))
            else:
                for field in ("body", "orelse", "finalbody", "handlers"):
                    sub = getattr(node, field, None)
                    if isinstance(sub, list) and sub and isinstance(sub[0], (ast.stmt, ast.excepthandler)):
                        visit(sub if field != "handlers" else [s for h in sub for s in h.body], prefix)

    visit(tree.body)
    return out


def class_members(tree, lines):
    """For each class, its methods (name, start0, end0) for outline display."""
    res = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            ms = []
            for b in node.body:
                if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    s = min([b.lineno] + [d.lineno for d in b.decorator_list]) - 1
                    ms.append((b.name, s, b.end_lineno))
            res[node.name] = ms
    return res


def blocks_for(code):
    lines = code.split("\n")
    n = len(lines)
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return dict(ok=False, error=str(e), sections=[], blocks=[dict(kind="code", key="all", name="(entire file)", section="", start=0, end=n)])
    secs = find_sections(lines)
    defs = collect_defs(tree)
    members = class_members(tree, lines)
    # attach leading comment lines to defs
    owned = [None] * n
    blocks = []
    seen = {}
    for name, kind, s, e, qual in sorted(defs, key=lambda d: d[2]):
        s2 = s
        while s2 > 0 and lines[s2 - 1].strip().startswith("#") and not BANNER_RULE.match(lines[s2 - 1]) and not BANNER_TITLE.match(lines[s2 - 1]):
            s2 -= 1
        # do not steal lines already owned
        while s2 < s and owned[s2] is not None:
            s2 += 1
        key = f"{kind}:{name}"
        if key in seen:  # duplicate names (redefinitions): disambiguate by order
            seen[key] += 1
            key = f"{key}#{seen[key]}"
        else:
            seen[key] = 1
        b = dict(kind=kind, key=key, name=name, start=s2, end=e)
        if kind == "class":
            b["members"] = [dict(name=m, start=ms, end=me) for (m, ms, me) in members.get(name, [])]
        for i in range(s2, e):
            owned[i] = b
        blocks.append(b)
    # section of each line
    sec_of = [""] * n
    cur = "(preamble)"
    si = 0
    for i in range(n):
        while si < len(secs) and secs[si][0] == i:
            cur = secs[si][1]
            si += 1
        sec_of[i] = cur
    for b in blocks:
        b["section"] = sec_of[b["start"]]
    # code blocks: maximal runs of unowned lines grouped per section; merge all runs of
    # the same section into one logical block made of several ranges
    code_blocks = {}
    order = []
    i = 0
    while i < n:
        if owned[i] is None:
            j = i
            while j < n and owned[j] is None and sec_of[j] == sec_of[i]:
                j += 1
            sec = sec_of[i]
            # skip runs that are only blank lines
            if any(lines[k].strip() for k in range(i, j)):
                key = "code:" + norm_section(sec)
                if key not in code_blocks:
                    code_blocks[key] = dict(kind="code", key=key, name=sec, section=sec, ranges=[])
                    order.append(key)
                code_blocks[key]["ranges"].append([i, j])
            i = j
        else:
            i += 1
    for k in order:
        cb = code_blocks[k]
        cb["start"] = cb["ranges"][0][0]
        cb["end"] = cb["ranges"][-1][1]
        blocks.append(cb)
    blocks.sort(key=lambda b: b["start"])
    for b in blocks:
        if "ranges" not in b:
            b["ranges"] = [[b["start"], b["end"]]]
    return dict(ok=True, sections=[dict(line=l, title=t) for l, t in secs], blocks=blocks)


if __name__ == "__main__":
    import json, sys
    R = json.load(open("records_raw.json"))
    for r in R:
        st = blocks_for(r["code"])
        nb = len(st["blocks"])
        kinds = {}
        for b in st["blocks"]:
            kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
        print(f"#{r['id']:2d} ok={st['ok']} sections={[s['title'] for s in st['sections']]} blocks={nb} {kinds}")
        if not st["ok"]:
            print("   ", st["error"])
