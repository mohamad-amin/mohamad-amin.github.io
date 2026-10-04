"""Step 2: normalize the per-record annotations in analysis/ into one consistent dataset.

Rules (applied in order):
  1. hyperparameter key synonyms are merged (also inside edge.hparams_changed);
  2. `split_cooldown` is active for every record whose PowerCool schedule uses per-group
     constants (the #20 lineage): Muon and the Adam groups start cooling at different steps;
  3. `early_stop` is recomputed from the logs: active iff the claimed step is earlier than the
     run's last logged step (the stat-sig step was picked from evals taken during the cooldown);
  4. every edge's techniques_added / techniques_removed is recomputed from the final genomes,
     and techniques_modified keeps only techniques present on both sides.
Writes analysis_final/rec_XX.json.
"""
import json
import os

from lineage import LINEAGE

WORK = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(WORK, "analysis")
DST = os.path.join(WORK, "analysis_final")
os.makedirs(DST, exist_ok=True)

RENAME = {
    "ema_nesterov.lookahead": "ema_nesterov.beta",
    "ema_nesterov.rest_steps": "ema_nesterov.rest_step",
    "aurora.pp_iterations": "aurora.K",
    "aurora.pp_beta": "aurora.beta",
}
SHORT = {35: "Shampoo (pinv root)"}
POWERCOOL_STACK = {20, 29, 30, 32, 34, 38, 40, 41, 42, 43, 44, 45, 46}

raw = {r["id"]: r for r in json.load(open(os.path.join(WORK, "records_raw.json")))}
A = {i: json.load(open(os.path.join(SRC, f"rec_{i:02d}.json"))) for i in range(1, 47)}

for i, a in A.items():
    a["parent"] = LINEAGE[i][0]
    if i in SHORT:
        a["short_name"] = SHORT[i]
    # 1. key synonyms
    hp = {}
    for k, v in a.get("hparams", {}).items():
        hp[RENAME.get(k, k)] = v
    if i == 41 and hp.get("aurora.K", "").startswith("3 ("):
        hp["aurora.K"], hp["aurora.beta"] = "3", "0.25"
    a["hparams"] = hp
    for h in a.get("edge", {}).get("hparams_changed", []):
        if h.get("key") in RENAME:
            h["key"] = RENAME[h["key"]]
    techs = {t["id"]: t for t in a.get("techniques", []) if t.get("id")}
    # 2. split cooldown under per-group PowerCool
    if i in POWERCOOL_STACK and "powercool" in techs and "split_cooldown" not in techs:
        techs["split_cooldown"] = {"id": "split_cooldown", "note": "implicit: per-group PowerCool constants start the Muon and Adam cooldowns at different steps"}
    # 3. early stop from the logs
    r = raw[i]
    early = r["steps"] < r["total_steps"]
    if early and "early_stop" not in techs:
        techs["early_stop"] = {"id": "early_stop", "note": f"claimed at step {r['steps']} of {r['total_steps']} logged steps"}
    if not early and "early_stop" in techs:
        del techs["early_stop"]
    a["techniques"] = list(techs.values())

for i, a in A.items():
    p = a["parent"]
    e = a.setdefault("edge", {})
    if not p:
        e["techniques_added"], e["techniques_removed"] = [], []
        continue
    ct = [t["id"] for t in a["techniques"]]
    pt = [t["id"] for t in A[p]["techniques"]]
    old_add, old_rem = set(e.get("techniques_added", [])), set(e.get("techniques_removed", []))
    e["techniques_added"] = [t for t in ct if t not in pt]
    e["techniques_removed"] = [t for t in pt if t not in ct]
    e["techniques_modified"] = [t for t in e.get("techniques_modified", []) if t in ct and t in pt]
    if set(e["techniques_added"]) != old_add or set(e["techniques_removed"]) != old_rem:
        print(f"#{i}<-#{p}: +{sorted(set(e['techniques_added']) - old_add)} -{sorted(set(e['techniques_removed']) - old_rem)} "
              f"(dropped +{sorted(old_add - set(e['techniques_added']))} -{sorted(old_rem - set(e['techniques_removed']))})")

for i, a in A.items():
    json.dump(a, open(os.path.join(DST, f"rec_{i:02d}.json"), "w"), indent=1, ensure_ascii=False)
print("wrote", len(A), "records")
