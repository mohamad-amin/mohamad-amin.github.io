"""Step 1: extract every Track 3 record from a modded-nanogpt checkout.

For each row of the README results table: the canonical script (taken from the official log),
seed statistics at the claimed step, the mean validation curve, hardware info and the record's
own README/PR docs. Also computes the pairwise code-distance matrix used to flag the textually
nearest earlier script. Writes records_raw.json, pairdist.json and nearest.json next to this file.

    MODDED_NANOGPT=/path/to/modded-nanogpt python3 extract.py
"""
import difflib, os, re, json, hashlib, statistics, glob

WORK = os.path.dirname(os.path.abspath(__file__))
MODDED = os.path.abspath(os.environ.get("MODDED_NANOGPT", os.path.join(WORK, "modded-nanogpt")))
T3 = os.path.join(MODDED, "records", "track_3_optimization")
RES = os.path.join(T3, "results")
VAL_RE = re.compile(r"step:(\d+)/(\d+)\s+val_loss:([0-9.]+)((?:[ \t]+[a-z_]+:[-0-9.]+[a-z]*)*)")
KV_RE = re.compile(r"([a-z_]+):([-0-9.]+)([a-z]*)")
HW_RE = re.compile(r"Running PyTorch (\S+) compiled for CUDA (\S+)(?: on (.+?)\s+with world_size (\d+))?")

readme = open(os.path.join(T3, "README.md"), encoding="utf-8").read()

# ---------------------------------------------------------------- README table
rows = []
for line in readme.split("\n"):
    m = re.match(r"^\| (\d+) \|", line)
    if not m:
        continue
    parts = line.split("|")[1:-1]
    parts = [p.strip() for p in parts]
    if len(parts) > 7:  # merge extra pipes into description
        parts = parts[:3] + ["|".join(parts[3:len(parts) - 3])] + parts[-3:]
    num, steps_s, ev, desc, date, log, contrib = parts
    wr = "(!)" in steps_s
    steps = int(re.sub(r"\D", "", steps_s.replace("(!)", "")))
    em = re.match(r"([0-9.]+) \(n=(\d+)\)(.*)", ev)
    mean, n, mark = float(em.group(1)), int(em.group(2)), em.group(3).strip()
    lm = re.search(r"\]\(([^)]+)\)", log)
    log_path = lm.group(1)
    rows.append(dict(id=int(num), steps=steps, wr=wr, readme_mean=mean, readme_n=n,
                     valid=(mark == "✓"), desc_md=desc, date=date, log_md=log, log_path=log_path,
                     contrib_md=contrib))
assert [r["id"] for r in rows] == list(range(1, len(rows) + 1)), [r["id"] for r in rows]
print(len(rows), "records")


def split_code(text):
    lines = text.split("\n")
    sep = next((i for i, l in enumerate(lines) if l.startswith("=" * 100)), None)
    if sep is None:
        return None, text
    code = "\n".join(lines[:sep])
    if "import torch" not in code:
        return None, text
    return code, "\n".join(lines[sep:])


def parse_trials(text):
    """Split val-loss lines into trials (a new trial starts at step 0 or when total steps changes)."""
    trials, cur, cur_total = [], None, None
    for m in VAL_RE.finditer(text):
        step, total, loss = int(m.group(1)), int(m.group(2)), float(m.group(3))
        kv = {k: (float(v), u) for k, v, u in KV_RE.findall(m.group(4) or "")}
        if "val_ema_loss" in kv:  # tail-EMA readout is the reported metric (#46)
            loss = kv["val_ema_loss"][0]
        tsec = None
        if "train_time" in kv:
            v, u = kv["train_time"]
            tsec = v / 1000 if u == "ms" else v
        if cur is None or step == 0 or total != cur_total or (cur and step <= cur[-1][0]):
            cur = []
            trials.append(cur)
            cur_total = total
        cur.append((step, loss, tsec))
    return [t for t in trials if len(t) >= 1]


def hw_info(text):
    m = HW_RE.search(text.split("=" * 100, 2)[1] if text.count("=" * 100) >= 1 else text)
    if not m:
        m = HW_RE.search(text)
    if not m:
        return None
    return dict(torch=m.group(1), cuda=m.group(2), gpu=(m.group(3) or "").strip() or None,
                world=int(m.group(4)) if m.group(4) else None)


def total_steps_of(text):
    m = VAL_RE.search(text)
    return int(m.group(2)) if m else None


out = []
for r in rows:
    lp = os.path.join(T3, r["log_path"])
    folder = os.path.dirname(lp)
    canon = lp
    if lp.endswith("README.md"):
        # pick first log with code in folder (or in code_logs/ subfolder)
        cands = sorted(glob.glob(os.path.join(folder, "*.txt")) + glob.glob(os.path.join(folder, "code_logs", "*.txt")))
        cands = [c for c in cands if split_code(open(c, encoding="utf-8", errors="replace").read())[0]]
        canon = cands[0]
    text = open(canon, encoding="utf-8", errors="replace").read()
    code, logpart = split_code(text)
    assert code, (r["id"], canon)
    canon_total = total_steps_of(logpart)
    hw = hw_info(text)
    # ------------------------------------------------ official group of logs
    cdir = os.path.dirname(canon)
    if os.path.abspath(cdir) == os.path.abspath(RES):
        group = [canon]
    else:
        group = sorted(glob.glob(os.path.join(cdir, "*.txt")))
        if r["id"] == 44:  # README: H100 n=20 is the official set; A40 n=8 is a side check
            group = [g for g in group if os.path.basename(g).startswith("H100_")]
        if r["id"] == 16:
            group = sorted(glob.glob(os.path.join(cdir, "idea_10e_attnproj_bounded_trust_floor_soapish", "seed_*", "stdout.txt")))
        with_code, without_code = [], []
        for g in group:
            s = open(g, encoding="utf-8", errors="replace").read()
            c, lpart = split_code(s)
            if total_steps_of(lpart if c else s) != canon_total:
                continue
            (with_code if c else without_code).append(g)
        group = with_code if (with_code and r["id"] != 16) else without_code or with_code
    trials = []
    for g in group:
        s = open(g, encoding="utf-8", errors="replace").read()
        c, lpart = split_code(s)
        for t in parse_trials(lpart if c else s):
            if t[-1][0] >= r["steps"] or any(st == r["steps"] for st, _, _ in t):
                trials.append(dict(file=os.path.relpath(g, T3), points=t))
    at = []
    for t in trials:
        v = [l for st, l, _ in t["points"] if st == r["steps"]]
        if v:
            at.append(v[0])
    comp_mean = statistics.mean(at) if at else None
    comp_std = statistics.stdev(at) if len(at) > 1 else None
    # mean curve across trials over the union of steps (only steps present in all trials)
    step_sets = [set(st for st, _, _ in t["points"]) for t in trials]
    common = sorted(set.intersection(*step_sets)) if step_sets else []
    curve = []
    for st in common:
        vals = [next(l for s2, l, _ in t["points"] if s2 == st) for t in trials]
        curve.append([st, round(statistics.mean(vals), 5), round(min(vals), 5), round(max(vals), 5)])
    # train time at claimed step (first trial) for info
    ttime = None
    for t in trials[:1]:
        for st, l, ts in t["points"]:
            if st == r["steps"]:
                ttime = ts
    rec = dict(r)
    rec.update(canon=os.path.relpath(canon, T3), code=code, code_lines=code.count("\n") + 1,
               code_md5=hashlib.md5(code.encode()).hexdigest(), total_steps=canon_total, hw=hw,
               n_trials=len(trials), n_at=len(at), comp_mean=comp_mean, comp_std=comp_std,
               seeds_at=at, curve=curve, train_time_at=ttime,
               group_files=sorted(set(t["file"] for t in trials)))
    out.append(rec)
    flag = "" if (comp_mean is not None and abs(comp_mean - r["readme_mean"]) < 6e-5 and len(at) == r["readme_n"]) else "  <-- CHECK"
    print(f"#{r['id']:2d} steps={r['steps']} total={canon_total} lines={rec['code_lines']:5d} "
          f"readme={r['readme_mean']:.4f}(n={r['readme_n']}) computed={comp_mean if comp_mean is None else round(comp_mean,5)}(n={len(at)}) "
          f"files={len(group)} hw={(hw or {}).get('gpu')}{flag}")

# ------------------------------------------------ per-record docs (README / PR summary)
for rec in out:
    folder = os.path.dirname(os.path.join(T3, rec["canon"]))
    if os.path.basename(folder) == "code_logs":
        folder = os.path.dirname(folder)
    texts = []
    if os.path.abspath(folder) != os.path.abspath(RES):
        for d in (folder, os.path.dirname(folder)):
            if os.path.abspath(d) == os.path.abspath(RES) or texts:
                break
            for name in ["README.md", "PR_SUMMARY.md", "summary.md"]:
                f = os.path.join(d, name)
                if os.path.exists(f):
                    texts.append((name, open(f, encoding="utf-8").read()))
    rec["folder"] = os.path.relpath(folder, T3)
    rec["docs"] = texts

json.dump(out, open(os.path.join(WORK, "records_raw.json"), "w"), indent=1)

# ------------------------------------------------ code distance between every pair of scripts
code = {r["id"]: r["code"].split("\n") for r in out}
ids = sorted(code)
dist = {}
for i in ids:
    for j in ids:
        if j < i:
            sm = difflib.SequenceMatcher(None, code[i], code[j], autojunk=False)
            same = sum(b.size for b in sm.get_matching_blocks())
            dist[f"{i},{j}"] = (len(code[i]) - same) + (len(code[j]) - same)
json.dump(dist, open(os.path.join(WORK, "pairdist.json"), "w"))
nearest = {i: min((j for j in ids if j < i), key=lambda j: dist[f"{i},{j}"]) for i in ids if i > ids[0]}
json.dump(nearest, open(os.path.join(WORK, "nearest.json"), "w"))
print("wrote records_raw.json, pairdist.json, nearest.json")
