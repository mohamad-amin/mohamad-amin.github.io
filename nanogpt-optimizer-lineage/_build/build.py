"""Step 3: assemble the explorer's data payload (data.json) from the extracted records and the reconciled analysis."""
import html
import json
import os
import re
import subprocess
import sys
from html.parser import HTMLParser

from lineage import LINEAGE
from structure import blocks_for

WORK = os.path.dirname(os.path.abspath(__file__))
MODDED = os.path.abspath(os.environ.get("MODDED_NANOGPT", os.path.join(WORK, "modded-nanogpt")))
try:
    COMMIT = subprocess.run(["git", "-C", MODDED, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
except Exception:
    COMMIT = "4ea6b937337a4889b8cfe3f38a93d120048d8f71"
GH_TREE = f"https://github.com/KellerJordan/modded-nanogpt/tree/{COMMIT}/records/track_3_optimization/"
GH_BLOB = f"https://github.com/KellerJordan/modded-nanogpt/blob/{COMMIT}/records/track_3_optimization/"

FAMILIES = [
    dict(id="baseline", label="Muon baseline", desc="Plain Muon + auxiliary AdamW, and hyperparameter or wrapper changes on it"),
    dict(id="stack", label="Record stack", desc="The community world-record lineage: NorMuon-lite + u/w floor, then Contra-Muon, SOAP-Muon, PowerCool, EMA-Nesterov, tail readouts…"),
    dict(id="hyperball", label="Hyperball (·H)", desc="Optimizers that keep hidden-matrix norms fixed on a hyperball (AdamH, MuonH, NorMuonH, KL-SOAP-H, SOAP-H)"),
    dict(id="second", label="Shampoo · SOAP · PSGD", desc="Kronecker-factored second-order preconditioners run as the main optimizer"),
    dict(id="variant", label="Muon variants", desc="New Muon-family update rules from papers (NorMuon, Muon², Newton-Muon, PMuon, Muown, DynMuon)"),
    dict(id="adam", label="Adam", desc="Adam on every parameter"),
]
FAMILY_OF = {}
for ids, fam in [((1, 3, 6, 12, 22, 36, 39), "baseline"),
                 ((9, 11, 14, 16, 17, 20, 24, 29, 30, 32, 34, 38, 40, 41, 42, 43, 44, 45, 46), "stack"),
                 ((4, 5, 8, 13, 19, 25, 27, 37), "hyperball"),
                 ((21, 26, 33, 35), "second"),
                 ((7, 10, 15, 18, 23, 28, 31), "variant"),
                 ((2,), "adam")]:
    for i in ids:
        FAMILY_OF[i] = fam
assert len(FAMILY_OF) == 46

TECH_CATS = [
    ("base", "Hidden-matrix optimizer"),
    ("precond", "Preconditioning on top of Muon"),
    ("geometry", "Update shaping & geometry"),
    ("wrapper", "Wrappers & outer loops"),
    ("schedule", "Schedules"),
    ("init", "Initialization"),
    ("readout", "Late-training readout"),
    ("aux", "Auxiliary Adam"),
]
TECH = [
    ("muon", "Muon", "base", "Momentum → Newton–Schulz orthogonalization → aspect-ratio scale"),
    ("adam_hidden", "Adam on hidden matrices", "base", "Adam/AdamW used for the hidden 2-D matrices"),
    ("spectral_descent", "Spectral descent", "base", "Muon with momentum 0"),
    ("muon_sq", "Muon²", "base", "Muon² (arXiv 2604.09967)"),
    ("normuon", "NorMuon", "base", "Per-neuron (row) second-moment EMA normalization of the orthogonalized update, NorMuon-paper style"),
    ("normuon_lite", "NorMuon-lite", "base", "The same one-axis second-moment normalization, as ported from track 1 in Skylight-001 (#9)"),
    ("newton_muon", "Newton-Muon", "base", "Activation-covariance right preconditioning before Newton–Schulz"),
    ("pmuon", "PMuon", "base", "Bilateral streaming covariance power preconditioning"),
    ("muown", "Muown", "base", "Muon with integrated row-norm control"),
    ("dynmuon", "DynMuon", "base", "DynMuon dynamic spectral power"),
    ("shampoo", "Shampoo", "base", "Two-sided Kronecker preconditioner with root power"),
    ("one_sided_shampoo", "One-sided Shampoo", "base", "One-sided Shampoo with pseudoinverse root"),
    ("soap", "SOAP", "base", "Adam in the Shampoo eigenbasis"),
    ("kl_soap", "KL-SOAP", "base", "KL-divergence derived SOAP variant"),
    ("sinksoap", "SinkSOAP", "base", "Gram–Sinkhorn SOAP-style preconditioning"),
    ("psgd_kron", "PSGD Kron", "base", "PSGD with Kronecker whitening preconditioners"),
    ("soap_muon_mlp", "SOAP-Muon (MLP)", "precond", "SOAP-style preconditioning of momentum before Newton–Schulz, MLP matrices"),
    ("soap_muon_attn", "SOAP-Muon (attention)", "precond", "SOAP-style preconditioning on attention matrices, with trust gate"),
    ("soap_muon_all", "SOAP-Muon (all hidden)", "precond", "SOAP-Muon on every hidden matrix"),
    ("hyperball", "Hyperball", "geometry", "Hidden-matrix norms held fixed on a sphere"),
    ("uw_floor", "u/w floor", "geometry", "Lift the update when ‖u‖/‖w‖ falls below a target"),
    ("row_floor", "RowUpdateFloor", "geometry", "Per-output-row u/w floor"),
    ("radial_brake", "Radial brake", "geometry", "Damp outward radial update component, then pin the norm"),
    ("cwd", "Cautious weight decay", "geometry", "Weight decay only where the update already shrinks the weight"),
    ("contra_muon", "Contra-Muon", "geometry", "Subtract a normalized raw-gradient component around the polar step"),
    ("soft_muon", "Soft-Muon", "geometry", "Soft (Schatten) orthogonalization"),
    ("tempered_polar", "Tempered-Polar", "geometry", "Tempered polar step"),
    ("aurora", "Aurora", "geometry", "Leverage-uniform / row-balanced polar"),
    ("circuit_muon", "Circuit-Muon", "geometry", "Per-head coupling of attention V/O pairs"),
    ("soda_anchor", "SODA anchor", "geometry", "Anchor correction toward initialization"),
    ("muloco", "MuLoCo outer Nesterov", "wrapper", "Outer Nesterov SGD over inner-optimizer displacement"),
    ("ema_nesterov", "EMA-Nesterov", "wrapper", "Lookahead along an EMA of parameter updates"),
    ("rre", "RRE extrapolation", "wrapper", "Reduced-rank vector extrapolation of iterates"),
    ("linear_cooldown", "Linear cooldown", "schedule", "Stable, then linear LR decay"),
    ("powercool", "PowerCool", "schedule", "Power-law LR cooldown"),
    ("split_cooldown", "Split cooldown", "schedule", "Different cooldown fractions for aux Adam and hidden matrices"),
    ("lr_warmup", "LR warmup", "schedule", "Learning-rate warmup"),
    ("mu_schedule", "Momentum schedule", "schedule", "Muon momentum warmup and/or cooldown"),
    ("early_stop", "Early stop", "schedule", "Claimed step is earlier than the run's last step: the stat-sig eval was taken during the cooldown"),
    ("zero_proj_init", "Zero-init projections", "init", "Output projections start at zero"),
    ("per_module_init_std", "Per-module init std", "init", "Separate init std per module type"),
    ("depth_scaled_fc_init", "Depth-scaled mlp.fc init", "init", "mlp.fc init scaled down with depth"),
    ("cgi_gain_init", "CGI gain init", "init", "Rademacher paired RMSNorm-gain init"),
    ("zero_bias_init", "Zero-init biases", "init", "All Linear biases start at zero"),
    ("tail_refinterp", "Tail ref-interp", "readout", "Final step moves weights back along an update EMA"),
    ("fixed_ref_interp", "Fixed reference interp", "readout", "Interpolate/extrapolate against a captured reference"),
    ("trail_delta", "TrailDelta / BroadDelta", "readout", "Endpoint pulses along recent trajectory deltas"),
    ("phase_readout", "Phase readout", "readout", "Normalized orthogonal phase readout"),
    ("anchor_readout", "Anchor readout", "readout", "Final readout toward an earlier anchor"),
    ("tail_ema", "Tail-EMA", "readout", "Evaluate a blend of weights and their tail EMA"),
    ("aux_adam", "Aux AdamW", "aux", "AdamW for embedding, LM head and 1-D params"),
    ("aux_beta2_split", "Aux β2 split", "aux", "Per-family β2 for auxiliary parameters"),
]


class Sanitizer(HTMLParser):
    ALLOWED = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "code", "pre", "strong", "em",
               "table", "thead", "tbody", "tr", "th", "td", "blockquote", "hr", "br", "del", "sup", "sub",
               "span", "details", "summary", "b", "i", "kbd"}
    DROP = {"script", "style", "iframe", "object", "embed", "svg", "math", "form", "input", "button", "textarea"}

    def __init__(self, base):
        super().__init__(convert_charrefs=False)
        self.base = base
        self.out = []
        self.drop_depth = 0

    def fix_url(self, u):
        u = (u or "").strip()
        if not u:
            return None
        if u.startswith(("http://", "https://")):
            return u
        if u.startswith("#") or u.startswith("mailto:") or ":" in u.split("/")[0]:
            return None
        if u.startswith("/"):
            return "https://github.com/KellerJordan/modded-nanogpt/blob/" + COMMIT + u
        # relative path inside the repo
        parts = (self.base + u).split("/")
        stack = []
        for p in parts:
            if p == "..":
                if stack:
                    stack.pop()
            elif p and p != ".":
                stack.append(p)
        return "https://github.com/KellerJordan/modded-nanogpt/blob/" + COMMIT + "/" + "/".join(stack)

    def handle_starttag(self, tag, attrs):
        if tag in self.DROP:
            self.drop_depth += 1
            return
        if self.drop_depth:
            return
        a = dict(attrs)
        if tag == "img":
            src = self.fix_url(a.get("src"))
            alt = a.get("alt") or "figure"
            if src:
                self.out.append(f'<a class="fig-link" href="{html.escape(src)}" target="_blank" rel="noopener">{html.escape(alt)} (figure)</a>')
            return
        if tag not in self.ALLOWED:
            return
        if tag == "a":
            href = self.fix_url(a.get("href"))
            if href:
                self.out.append(f'<a href="{html.escape(href)}" target="_blank" rel="noopener">')
            else:
                self.out.append("<a>")
            return
        if tag in ("th", "td") and a.get("align") in ("left", "right", "center"):
            self.out.append(f'<{tag} style="text-align:{a["align"]}">')
            return
        if tag == "code" and (a.get("class") or "").startswith("language-"):
            self.out.append(f'<code class="{html.escape(a["class"])}">')
            return
        self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag in self.DROP:
            self.drop_depth = max(0, self.drop_depth - 1)
            return
        if self.drop_depth or tag not in self.ALLOWED:
            return
        self.out.append(f"</{tag}>")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_data(self, data):
        if not self.drop_depth:
            self.out.append(html.escape(data, quote=False))

    def handle_entityref(self, name):
        if not self.drop_depth:
            self.out.append(f"&{name};")

    def handle_charref(self, name):
        if not self.drop_depth:
            self.out.append(f"&#{name};")


def sanitize(h, base):
    s = Sanitizer(base)
    s.feed(h)
    s.close()
    return "".join(s.out)


def clean_code(code):
    lines = code.split("\n")
    while lines and re.match(r"^(/|logs/)\S*\.txt\s*$", lines[-1]):
        lines.pop()
    return "\n".join(lines)


def main():
    R = {r["id"]: r for r in json.load(open(os.path.join(WORK, "records_raw.json")))}
    nearest = {int(k): v for k, v in json.load(open(os.path.join(WORK, "nearest.json"))).items()}
    pd = {tuple(map(int, k.split(","))): v for k, v in json.load(open(os.path.join(WORK, "pairdist.json"))).items()}
    dist = lambda a, b: 0 if a == b else pd[(max(a, b), min(a, b))]
    # ------------------------------------------------------------- markdown
    md_in = {}
    for i, r in R.items():
        md_in[f"inline:desc:{i}"] = r["desc_md"]
        md_in[f"inline:contrib:{i}"] = r["contrib_md"]
        for k, (name, text) in enumerate(r.get("docs", [])):
            md_in[f"doc:{i}:{k}"] = text
    json.dump(md_in, open(os.path.join(WORK, "_md_in.json"), "w"))
    subprocess.run(["node", os.path.join(WORK, "render_md.js"), os.path.join(WORK, "_md_in.json"), os.path.join(WORK, "_md_out.json")], check=True)
    md = json.load(open(os.path.join(WORK, "_md_out.json")))

    # ------------------------------------------------------------- code dictionary
    line_ix = {}
    lines = []
    analysis_dir = os.path.join(WORK, "analysis_final")
    techs = {t[0]: dict(id=t[0], label=t[1], cat=t[2], desc=t[3]) for t in TECH}
    records = []
    for i in sorted(R):
        r = R[i]
        code = clean_code(r["code"])
        ls = code.split("\n")
        idx = []
        for l in ls:
            if l not in line_ix:
                line_ix[l] = len(lines)
                lines.append(l)
            idx.append(line_ix[l])
        st = blocks_for(code)
        blocks = []
        for b in st["blocks"]:
            bb = dict(k=b["kind"], key=b["key"], name=b["name"], sec=b.get("section", ""), r=b["ranges"])
            if b.get("members"):
                bb["m"] = [[m["name"], m["start"], m["end"]] for m in b["members"]]
            blocks.append(bb)
        folder = r.get("folder", "results")
        base_folder = folder + "/" if folder != "results" else "results/"
        docs = []
        for k, (name, text) in enumerate(r.get("docs", [])):
            docs.append(dict(name=name, html=sanitize(md[f"doc:{i}:{k}"], "records/track_3_optimization/" + base_folder)))
        pr = re.search(r"\(https://github\.com/KellerJordan/modded-nanogpt/pull/(\d+)\)", r["contrib_md"])
        p, how, infl = LINEAGE[i]
        an = None
        ap = os.path.join(analysis_dir, f"rec_{i:02d}.json")
        if os.path.exists(ap):
            try:
                an = json.load(open(ap))
            except Exception as e:
                print("bad analysis json", ap, e, file=sys.stderr)
        if an:
            for t in an.get("techniques", []):
                if t.get("id") and t["id"] not in techs:
                    techs[t["id"]] = dict(id=t["id"], label=t["id"].replace("_", " "), cat="geometry", desc="")
        curve = [[c[0], c[1], c[2], c[3]] for c in r["curve"] if c[0] > 0]
        records.append(dict(
            id=i, steps=r["steps"], wr=r["wr"], valid=r["valid"], mean=r["readme_mean"], n=r["readme_n"],
            date=r["date"], desc=sanitize(md[f"inline:desc:{i}"], "records/track_3_optimization/"),
            contrib=sanitize(md[f"inline:contrib:{i}"], "records/track_3_optimization/"),
            pr=int(pr.group(1)) if pr else None,
            log=GH_BLOB + r["canon"], folder=(GH_TREE + folder) if folder != "results" else None,
            parent=p, how=how, infl=infl, nearest=nearest.get(i), family=FAMILY_OF[i],
            dParent=dist(i, p) if p else None, dNearest=dist(i, nearest[i]) if i in nearest else None,
            sched=r["total_steps"], hw=r["hw"],
            comp=dict(mean=r["comp_mean"], std=r["comp_std"], n=r["n_at"]),
            seeds=[round(x, 5) for x in r["seeds_at"]],
            curve=curve, code=idx, blocks=blocks,
            sections=[[s["line"], s["title"]] for s in st["sections"]],
            docs=docs, an=an,
        ))
    data = dict(
        meta=dict(commit=COMMIT, source="https://github.com/KellerJordan/modded-nanogpt/tree/master/records/track_3_optimization",
                  target=3.28, sigma=0.0013, need=0.004, slope=0.0045),
        families=FAMILIES, techCats=[dict(id=a, label=b) for a, b in TECH_CATS], techniques=list(techs.values()),
        lines=lines, records=records,
    )
    out = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    open(os.path.join(WORK, "data.json"), "w").write(out)
    print(f"data.json: {len(out)/1e6:.2f} MB, {len(lines)} unique lines, analysis for {sum(1 for r in records if r['an'])} records")


if __name__ == "__main__":
    main()
