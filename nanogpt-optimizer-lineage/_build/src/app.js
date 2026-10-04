(() => {
  "use strict";

  // =====================================================================
  // Basics
  // =====================================================================
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MINUS = "\u2212";
  const sgn = (v, d = 0) => (v > 0 ? "+" : v < 0 ? MINUS : "±") + Math.abs(v).toFixed(d);
  const fmt4 = (v) => (v == null ? "–" : v.toFixed(4));
  const plain = (html) => { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent || ""; };
  const store = {
    get(k, def) { try { const v = localStorage.getItem("t3lineage:" + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem("t3lineage:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const HAS_D3 = typeof window.d3 !== "undefined";
  const REDUCED = (() => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();

  // =====================================================================
  // Data
  // =====================================================================
  const DATA = JSON.parse(document.getElementById("lineage-data").textContent);
  const META = DATA.meta;
  const LINES = DATA.lines;
  const RECS = DATA.records;
  const byId = new Map(RECS.map((r) => [r.id, r]));
  const FAMS = DATA.families;
  const famById = new Map(FAMS.map((f) => [f.id, f]));
  const TECHS = new Map(DATA.techniques.map((t) => [t.id, t]));
  const CATS = DATA.techCats;
  const TARGET = META.target, NEED = META.need, SLOPE = META.slope / 100;
  const MAX_ID = Math.max(...RECS.map((r) => r.id));

  for (const r of RECS) {
    r.children = [];
    const techs = (r.an && Array.isArray(r.an.techniques)) ? r.an.techniques.filter((t) => t && t.id) : [];
    r.tech = new Map(techs.map((t) => [t.id, t]));
    r.hp = (r.an && r.an.hparams) || {};
    r.edge = (r.an && r.an.edge) || null;
    r.short = (r.an && r.an.short_name) || plain(r.desc).replace(/\s+/g, " ").slice(0, 26);
    r.plain = (r.pl && r.pl.plain) || null;
    r.bullets = (r.pl && r.pl.bullets) || null;
    r.descText = plain(r.desc);
    r.contribText = plain(r.contrib);
  }
  for (const r of RECS) if (r.parent) byId.get(r.parent).children.push(r.id);
  for (const r of RECS) r.children.sort((a, b) => a - b);
  const ROOT = byId.get(1);
  const PREORDER = [];
  (function walk(id, depth) {
    const r = byId.get(id);
    r.depth = depth;
    PREORDER.push(id);
    r.children.forEach((c) => walk(c, depth + 1));
  })(1, 0);
  const preIndex = new Map(PREORDER.map((id, i) => [id, i]));

  const pathFromRoot = (id) => { const out = []; let r = byId.get(id); while (r) { out.push(r.id); r = r.parent ? byId.get(r.parent) : null; } return out.reverse(); };
  function treePath(a, b) {
    const pa = pathFromRoot(a), pb = pathFromRoot(b);
    let k = 0;
    while (k < pa.length && k < pb.length && pa[k] === pb[k]) k++;
    const lca = pa[k - 1];
    return { lca, up: pa.slice(k - 1).reverse(), down: pb.slice(k - 1) };
  }
  const pathEdges = (a, b) => {
    const { up, down } = treePath(a, b);
    const set = new Set();
    for (let i = 0; i + 1 < up.length; i++) set.add(up[i]);
    for (let i = 1; i < down.length; i++) set.add(down[i]);
    return set; // child ids whose edge to parent lies on the path
  };
  // the child whose subtree reaches the fewest steps (follows the main line toward the best record)
  const bestOf = new Map();
  (function best(id) { const r = byId.get(id); let b = r.steps; for (const c of r.children) b = Math.min(b, best(c)); bestOf.set(id, b); return b; })(1);
  const bestChild = (r) => (r.children.length ? r.children.slice().sort((x, y) => bestOf.get(x) - bestOf.get(y) || x - y)[0] : null);
  const techOrigin = (r, tid) => { let cur = r; while (cur.parent && byId.get(cur.parent).tech.has(tid)) cur = byId.get(cur.parent); return cur.id; };
  const margin = (r) => (TARGET - r.mean) * Math.sqrt(r.n);
  // README rule: ((L_old - L_new) + (S_old - S_new) * 0.0045/100) / sqrt(1/n_old + 1/n_new)  (positive: "new" is better)
  const pairwise = (nw, old) => ((old.mean - nw.mean) + (old.steps - nw.steps) * SLOPE) / Math.sqrt(1 / old.n + 1 / nw.n);
  const effGain = (nw, old) => (old.steps - nw.steps) + (old.mean - nw.mean) / SLOPE;
  const techLabel = (id) => (TECHS.get(id) || { label: id.replace(/_/g, " ") }).label;
  const fam = (r) => famById.get(r.family);
  const famVar = (r) => `var(--fam-${r.family})`;

  // ---- optimizer-state memory (multiples of the hidden-matrix parameter count; vectors ignored)
  const MEM_KINDS = [["momentum", "Momentum"], ["second_moment", "Second moments"], ["preconditioner", "Preconditioner factors"], ["eigenbasis", "Eigenbases"], ["weight_copy", "Weight copies (EMAs, snapshots)"], ["other", "Other"]];
  const memX = (r) => (r.mem && typeof r.mem.hidden_x === "number" ? r.mem.hidden_x : null);
  const memCat = (x) => Math.max(0, Math.round(x));
  const memLevel = (x) => { const c = memCat(x); return c <= 1 ? 1 : c <= 2 ? 2 : c <= 3 ? 3 : c <= 5 ? 4 : c <= 7 ? 5 : 6; };
  const fmtX = (x) => (x == null ? "–" : (Math.abs(x - Math.round(x)) < 0.05 ? Math.round(x).toFixed(0) : x.toFixed(1)) + "×");
  const MEM_MAX = Math.max(2, ...RECS.map(memX).filter((x) => x != null));
  function memKinds(r) {
    const m = new Map();
    for (const c of (r.mem && r.mem.components) || []) {
      const k = MEM_KINDS.some(([id]) => id === c.kind) ? c.kind : "other";
      m.set(k, (m.get(k) || 0) + (+c.x || 0));
    }
    return m;
  }
  function memBar(r, max, cls) {
    if (!r.mem) return "";
    const by = memKinds(r);
    const segs = MEM_KINDS.filter(([k]) => by.get(k) > 0.005).map(([k, label]) => `<span class="mseg k-${k}" style="width:${Math.min(100, (by.get(k) / max) * 100)}%" title="${esc(label)}: ${by.get(k).toFixed(2)}×"></span>`).join("");
    return `<span class="mbar ${cls || ""}" role="img" aria-label="Optimizer memory ${fmtX(memX(r))}">${segs}</span>`;
  }
  const memKindsLegend = (kinds) => `<div class="mkinds">${MEM_KINDS.filter(([k]) => !kinds || kinds.has(k)).map(([k, label]) => `<span><i class="k-${k}"></i>${esc(label)}</span>`).join("")}</div>`;

  // Colours that must be resolved to hex (text-on-fill contrast for node numbers)
  let famHex = {};
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    famHex = {};
    for (const f of FAMS) famHex[f.id] = cs.getPropertyValue(`--fam-${f.id}`).trim() || "#888888";
  }
  function lum(hex) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    if (!m) return 0.5;
    const c = [m[1], m[2], m[3]].map((h) => { const v = parseInt(h, 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  const inkOn = (hex) => { const L = lum(hex); return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#0b0b0b"; };

  // =====================================================================
  // State
  // =====================================================================
  const state = {
    sel: MAX_ID,
    cmp: null,
    view: store.get("view", "tree"),
    lens: null, // {type:'tech'|'fam', id}
    picking: false,
    tlx: store.get("tlx", "order"),
  };
  if (!HAS_D3 && (state.view === "tree" || state.view === "timeline")) state.view = "outline";

  function parseHash() {
    const h = (location.hash || "").replace(/^#/, "");
    let m;
    if ((m = /^r(\d+)-r(\d+)$/.exec(h)) && byId.has(+m[1]) && byId.has(+m[2])) return { sel: +m[1], cmp: +m[2] };
    if ((m = /^r(\d+)$/.exec(h)) && byId.has(+m[1])) return { sel: +m[1], cmp: null };
    if ((m = /^d(\d+)-(\d+)$/.exec(h)) && byId.has(+m[1]) && byId.has(+m[2])) return { sel: +m[2], cmp: null, diff: [+m[1], +m[2]] };
    return null;
  }
  function writeHash() {
    let h = "#r" + state.sel + (state.cmp ? "-r" + state.cmp : "");
    if (DiffUI.isOpen()) h = "#d" + DiffUI.a + "-" + DiffUI.b;
    try { if (location.hash !== h) history.replaceState(null, "", h); } catch (e) { /* sandboxed */ }
  }

  function lensHas(r) {
    if (!state.lens) return true;
    if (state.lens.type === "tech") return r.tech.has(state.lens.id);
    if (state.lens.type === "fam") return r.family === state.lens.id;
    return true;
  }

  function select(id, opts = {}) {
    if (!byId.has(id)) return;
    if (state.picking && opts.fromClick) { state.picking = false; if (id !== state.sel) state.cmp = id; update(); return; }
    state.sel = id;
    if (state.cmp === id) state.cmp = null;
    update({ focus: opts.focus !== false });
  }
  function setCompare(id) {
    if (!byId.has(id) || id === state.sel) return;
    state.cmp = id;
    state.picking = false;
    update();
  }
  function clearCompare() { state.cmp = null; state.picking = false; update(); }
  function setLens(l) {
    if (l && state.lens && state.lens.type === l.type && state.lens.id === l.id) l = null;
    state.lens = l;
    update({ focus: false });
  }

  function update(opts = {}) {
    renderLensBar();
    Legend.sync();
    if (HAS_D3) { TreeView.sync(opts.focus); TimelineView.sync(); }
    OutlineView.sync(opts.focus);
    GenomeView.sync();
    MemoryView.sync();
    Inspector.render();
    writeHash();
  }

  // =====================================================================
  // Tooltip
  // =====================================================================
  const tip = $("#tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  function recTip(r) {
    const p = r.parent ? byId.get(r.parent) : null;
    const d = p ? r.steps - p.steps : null;
    return `<div class="tt-h"><span class="mono">#${r.id}</span><span>${esc(r.short)}</span>${r.wr ? '<span class="chip wr">WR</span>' : ""}</div>
      <div><span class="mono">${r.steps}</span> steps${p ? ` · <span class="mono">${sgn(d)}</span> vs #${p.id}` : ""} · <span class="tt-k">${fmt4(r.mean)} (n=${r.n})</span>${memX(r) != null ? ` · <span class="tt-k">memory ${fmtX(memX(r))}</span>` : ""}</div>
      <p>${esc(r.plain || (r.edge && r.edge.title) || r.descText.slice(0, 160))}</p>
      <p class="tt-k">${esc(fam(r).label)} · ${esc(r.date)}</p>`;
  }

  // =====================================================================
  // Lens bar and legend
  // =====================================================================
  function renderLensBar() {
    const bar = $("#lens-bar");
    if (state.picking) {
      bar.hidden = false;
      bar.innerHTML = `<span>Click any record to compare with <b>#${state.sel}</b></span><button type="button" data-act="cancel-pick">Cancel</button>`;
      return;
    }
    if (!state.lens) { bar.hidden = true; bar.innerHTML = ""; return; }
    const n = RECS.filter(lensHas).length;
    const label = state.lens.type === "tech" ? techLabel(state.lens.id) : famById.get(state.lens.id).label;
    bar.hidden = false;
    bar.innerHTML = `<span>Highlighting <b>${esc(label)}</b> · ${n} record${n === 1 ? "" : "s"}</span><button type="button" data-act="clear-lens">Clear</button>`;
  }
  $("#lens-bar").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "clear-lens") setLens(null);
    if (b.dataset.act === "cancel-pick") { state.picking = false; update({ focus: false }); }
  });

  const Legend = {
    init() {
      const el = $("#legend");
      el.innerHTML = FAMS.map((f) => `<button type="button" data-fam="${f.id}" aria-pressed="false" title="${esc(f.desc)}"><span class="swatch" style="background:var(--fam-${f.id})"></span>${esc(f.label)}</button>`).join("")
        + `<span class="wr-key" title="New world record when it was accepted"><i></i>World record</span>`;
      el.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-fam]");
        if (b) setLens({ type: "fam", id: b.dataset.fam });
      });
    },
    sync() {
      $$("#legend button[data-fam]").forEach((b) => b.setAttribute("aria-pressed", String(!!(state.lens && state.lens.type === "fam" && state.lens.id === b.dataset.fam))));
      $("#legend").hidden = state.view === "genome";
    },
  };

  // =====================================================================
  // Tree view (d3 tidy tree, horizontal, zoom + minimap)
  // =====================================================================
  const TreeView = {
    ROW: 48, COL: 200, LBL: 158,
    init() {
      const svg = d3.select("#tree-svg");
      this.svg = svg;
      this.g = svg.append("g");
      this.gLinks = this.g.append("g");
      this.gInfl = this.g.append("g");
      this.gNodes = this.g.append("g");
      const root = d3.hierarchy(ROOT, (r) => r.children.map((id) => byId.get(id)));
      d3.tree().nodeSize([this.ROW, this.COL]).separation((a, b) => (a.parent === b.parent ? 1 : 1.18))(root);
      this.root = root;
      this.pos = new Map();
      root.each((d) => this.pos.set(d.data.id, { x: d.y, y: d.x }));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of this.pos.values()) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      this.bounds = { x0: x0 - 30, x1: x1 + this.LBL + 30, y0: y0 - 34, y1: y1 + 34 };

      const R = 8; // elbow corner radius
      const elbow = (s, t) => {
        const xs = s.x + this.LBL + 18, ys = s.y, xt = t.x - 12, yt = t.y;
        if (Math.abs(yt - ys) < 1) return `M${s.x + 12},${ys}H${xt}`;
        const dir = yt > ys ? 1 : -1;
        return `M${s.x + 12},${ys}H${xs - R}Q${xs},${ys} ${xs},${ys + dir * R}V${yt - dir * R}Q${xs},${yt} ${xs + R},${yt}H${xt}`;
      };
      this.links = root.links().map((l) => ({ s: l.source.data.id, t: l.target.data.id }));
      this.linkSel = this.gLinks.selectAll("path").data(this.links).join("path")
        .attr("class", "link").attr("d", (l) => elbow(this.pos.get(l.s), this.pos.get(l.t)));

      const self = this;
      const ng = this.gNodes.selectAll("g.node").data(root.descendants().map((d) => d.data)).join("g")
        .attr("class", "node").attr("transform", (r) => `translate(${this.pos.get(r.id).x},${this.pos.get(r.id).y})`)
        .attr("tabindex", -1)
        .on("click", function (ev, r) { ev.stopPropagation(); if (ev.shiftKey || ev.altKey) setCompare(r.id); else select(r.id, { fromClick: true }); })
        .on("mouseenter", (ev, r) => showTip(recTip(r), ev))
        .on("mousemove", (ev, r) => showTip(recTip(r), ev))
        .on("mouseleave", hideTip);
      ng.append("rect").attr("class", "lbl-bg").attr("x", 14).attr("y", -15).attr("height", 31).attr("rx", 5).attr("width", this.LBL);
      ng.append("circle").attr("class", "halo").attr("r", 17);
      ng.filter((r) => r.wr).append("circle").attr("class", "wr-ring").attr("r", 13.6);
      ng.append("circle").attr("class", "dot").attr("r", 10.5).style("fill", (r) => famVar(r));
      ng.append("text").attr("class", "dot-num").attr("text-anchor", "middle").attr("dy", "0.36em").text((r) => r.id);
      ng.append("text").attr("class", "lbl").attr("x", 19).attr("y", -2).text((r) => r.short);
      ng.append("text").attr("class", "lbl-sub").attr("x", 19).attr("y", 12).text((r) => {
        const p = r.parent ? byId.get(r.parent) : null;
        return `${r.steps}` + (p ? `  ${sgn(r.steps - p.steps)}` : "  root");
      });
      const mb = ng.filter((r) => memX(r) != null).append("g").attr("class", (r) => `mem-b m${memLevel(memX(r))}`).attr("transform", `translate(${14 + this.LBL - 4}, 8)`);
      mb.append("title").text((r) => `Optimizer memory: ${fmtX(memX(r))} per hidden-matrix parameter`);
      mb.append("rect").attr("x", -36).attr("y", -7.5).attr("width", 36).attr("height", 15).attr("rx", 7.5);
      mb.append("text").attr("x", -18).attr("y", 0).attr("dy", "0.35em").attr("text-anchor", "middle").text((r) => fmtX(memX(r)));
      this.nodeSel = ng;
      this.truncate();
      try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.truncate()); } catch (e) { /* ignore */ }
      this.colorNumbers();

      this.zoom = d3.zoom().scaleExtent([0.18, 2.6]).on("zoom", (e) => {
        this.g.attr("transform", e.transform);
        this.t = e.transform;
        this.drawViewport();
        hideTip();
      });
      svg.call(this.zoom).on("dblclick.zoom", null);
      svg.on("click", () => { if (state.picking) { state.picking = false; update({ focus: false }); } });
      this.initMinimap();
      $$("#view-tree .zoom-ctl button").forEach((b) => b.addEventListener("click", () => {
        const z = b.dataset.z;
        if (z === "in") svg.transition().duration(250).call(this.zoom.scaleBy, 1.35);
        if (z === "out") svg.transition().duration(250).call(this.zoom.scaleBy, 1 / 1.35);
        if (z === "fit") this.fit(true);
        if (z === "sel") this.focus(state.sel, true, true);
      }));
      this.initialized = true;
    },
    truncate() {
      const max = this.LBL - 10;
      this.nodeSel.select("text.lbl").each(function (r) {
        const t = this; let s = r.short;
        t.textContent = s;
        while (t.getComputedTextLength() > max && s.length > 4) { s = s.slice(0, -1); t.textContent = s.trimEnd() + "…"; }
      });
    },
    colorNumbers() {
      if (!this.nodeSel) return;
      this.nodeSel.select("text.dot-num").style("fill", (r) => inkOn(famHex[r.family] || "#888888"));
    },
    size() { const el = $("#tree-svg"); return { w: el.clientWidth || 800, h: el.clientHeight || 600 }; },
    fit(animate) {
      const { w, h } = this.size();
      const b = this.bounds;
      const k = Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0)) * 0.96;
      const t = d3.zoomIdentity.translate(w / 2 - k * (b.x0 + b.x1) / 2, h / 2 - k * (b.y0 + b.y1) / 2).scale(k);
      (animate && !REDUCED ? this.svg.transition().duration(450) : this.svg).call(this.zoom.transform, t);
    },
    focus(id, animate, force) {
      const p = this.pos.get(id);
      if (!p) return;
      const { w, h } = this.size();
      const t = this.t || d3.zoomIdentity;
      const k = force ? Math.max(t.k, 0.78) : t.k;
      const sx = t.applyX(p.x), sy = t.applyY(p.y);
      const inside = sx > w * 0.08 && sx < w * 0.78 && sy > h * 0.1 && sy < h * 0.9;
      if (inside && !force) return;
      const r = byId.get(id);
      // leaves sit to the right so their ancestors are visible; inner nodes leave room for children
      const fx = r.children.length ? 0.38 : 0.74;
      const vx0 = p.x - (fx * w) / k, vx1 = vx0 + w / k;
      // vertically centre on the nodes that will be in view, keeping the focused node visible
      let y0 = Infinity, y1 = -Infinity;
      for (const q of this.pos.values()) if (q.x >= vx0 && q.x <= vx1) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      let cy = (y0 + y1) / 2;
      const half = (h / k) / 2 - 40;
      if (Math.abs(cy - p.y) > half) cy = p.y + Math.sign(cy - p.y) * half;
      const nt = d3.zoomIdentity.translate(fx * w - k * p.x, h / 2 - k * cy).scale(k);
      (animate && !REDUCED ? this.svg.transition().duration(500) : this.svg).call(this.zoom.transform, nt);
    },
    initialView(intro) {
      const { w, h } = this.size();
      const b = this.bounds;
      const kFit = Math.min(w / (b.x1 - b.x0), h / (b.y1 - b.y0)) * 0.96;
      if (kFit >= 0.62) { this.fit(false); return; }
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!intro || reduce) { this.focus(state.sel, false, true); return; }
      this.fit(false);
      let touched = false;
      const stop = () => { touched = true; };
      const el = $("#tree-svg");
      ["pointerdown", "wheel", "touchstart"].forEach((ev) => el.addEventListener(ev, stop, { once: true, passive: true }));
      setTimeout(() => {
        if (touched || state.view !== "tree") return;
        const p = this.pos.get(state.sel), k = 0.78;
        const r = byId.get(state.sel), fx = r.children.length ? 0.38 : 0.74;
        const nt = d3.zoomIdentity.translate(fx * w - k * p.x, h / 2 - k * p.y).scale(k);
        this.svg.transition().duration(1400).ease(d3.easeCubicInOut).call(this.zoom.transform, nt)
          .on("end", () => { if (!touched) this.focus(state.sel, true, true); });
      }, 1100);
    },
    sync(focus) {
      if (!this.initialized) return;
      const pe = state.cmp ? pathEdges(state.sel, state.cmp) : new Set();
      const pathNodes = state.cmp ? new Set([...treePath(state.sel, state.cmp).up, ...treePath(state.sel, state.cmp).down]) : new Set();
      this.nodeSel
        .classed("sel", (r) => r.id === state.sel)
        .classed("cmp", (r) => r.id === state.cmp)
        .classed("path", (r) => pathNodes.has(r.id) && r.id !== state.sel && r.id !== state.cmp)
        .classed("dim", (r) => !lensHas(r));
      this.linkSel.classed("on-path", (l) => pe.has(l.t)).classed("dim", (l) => !lensHas(byId.get(l.t)));
      // origin badges for a technique lens
      this.nodeSel.selectAll(".origin-badge, .origin-badge-t").remove();
      if (state.lens && state.lens.type === "tech") {
        const o = this.nodeSel.filter((r) => r.tech.has(state.lens.id) && techOrigin(r, state.lens.id) === r.id);
        o.append("circle").attr("class", "origin-badge").attr("cx", 8).attr("cy", -9).attr("r", 6);
        o.append("text").attr("class", "origin-badge-t").attr("x", 8).attr("y", -9).attr("dy", "0.35em").attr("text-anchor", "middle").text("+");
      }
      // influence links for selected / compared record
      const infl = [];
      for (const id of [state.sel, state.cmp]) {
        if (!id) continue;
        for (const src of byId.get(id).infl || []) infl.push({ s: src, t: id });
      }
      this.gInfl.selectAll("path").data(infl).join("path").attr("class", "infl-link").attr("d", (l) => {
        const a = this.pos.get(l.s), b = this.pos.get(l.t);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - Math.max(40, Math.abs(b.x - a.x) * 0.18);
        return `M${a.x},${a.y - 11}Q${mx},${my} ${b.x},${b.y - 11}`;
      });
      this.nodeSel.filter((r) => r.id === state.sel || r.id === state.cmp).raise();
      if (focus) this.focus(state.sel, true);
    },
    initMinimap() {
      const mm = d3.select("#minimap");
      const W = 180, H = 112, b = this.bounds;
      const k = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0));
      const ox = (W - k * (b.x1 - b.x0)) / 2 - k * b.x0, oy = (H - k * (b.y1 - b.y0)) / 2 - k * b.y0;
      this.mm = { k, ox, oy };
      mm.attr("viewBox", `0 0 ${W} ${H}`);
      mm.append("g").selectAll("path").data(this.links).join("path").attr("class", "mm-link")
        .attr("d", (l) => { const a = this.pos.get(l.s), c = this.pos.get(l.t); return `M${ox + k * a.x},${oy + k * a.y}L${ox + k * c.x},${oy + k * c.y}`; });
      mm.append("g").selectAll("circle").data(RECS).join("circle")
        .attr("cx", (r) => ox + k * this.pos.get(r.id).x).attr("cy", (r) => oy + k * this.pos.get(r.id).y).attr("r", 2.2)
        .style("fill", (r) => famVar(r));
      this.mmView = mm.append("rect").attr("class", "mm-view").attr("rx", 2);
      const move = (ev) => {
        const [mx, my] = d3.pointer(ev, mm.node());
        const x = (mx - ox) / k, y = (my - oy) / k;
        const { w, h } = this.size();
        const t = this.t || d3.zoomIdentity;
        this.svg.call(this.zoom.transform, d3.zoomIdentity.translate(w / 2 - t.k * x, h / 2 - t.k * y).scale(t.k));
      };
      mm.on("mousedown", (ev) => {
        move(ev);
        const mv = (e) => move(e);
        const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
        window.addEventListener("mousemove", mv);
        window.addEventListener("mouseup", up);
      });
    },
    drawViewport() {
      if (!this.mmView || !this.t) return;
      const { w, h } = this.size();
      const { k, ox, oy } = this.mm;
      const x0 = this.t.invertX(0), x1 = this.t.invertX(w), y0 = this.t.invertY(0), y1 = this.t.invertY(h);
      this.mmView.attr("x", ox + k * x0).attr("y", oy + k * y0).attr("width", Math.max(2, k * (x1 - x0))).attr("height", Math.max(2, k * (y1 - y0)));
    },
  };

  // =====================================================================
  // Outline view (indented tree with steps lollipops)
  // =====================================================================
  const OutlineView = {
    collapsed: new Set(store.get("collapsed", [])),
    visible: [],
    LO: 2600, HI: 3700,
    init() {
      const el = $("#view-outline");
      el.addEventListener("click", (e) => {
        const caret = e.target.closest(".ol-caret");
        if (caret) {
          const id = +caret.dataset.id;
          if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
          store.set("collapsed", Array.from(this.collapsed));
          this.render();
          return;
        }
        const row = e.target.closest(".ol-row");
        if (row) { const id = +row.dataset.id; if (e.shiftKey || e.altKey) setCompare(id); else select(id, { fromClick: true, focus: false }); }
      });
      this.render();
    },
    x(steps) { return Math.max(0, Math.min(1, (steps - this.LO) / (this.HI - this.LO))) * 100; },
    render() {
      const rows = [];
      const vis = [];
      const lastChild = (id) => { const r = byId.get(id); if (!r.parent) return true; const sib = byId.get(r.parent).children; return sib[sib.length - 1] === id; };
      const walk = (id, guides) => {
        const r = byId.get(id);
        vis.push(id);
        const p = r.parent ? byId.get(r.parent) : null;
        const has = r.children.length > 0;
        const col = this.collapsed.has(id);
        // guides: for each ancestor level, whether a vertical line continues
        const gl = guides.map((cont, k) => (cont ? `<i style="left:${k * 18 + 8}px"></i>` : "")).join("");
        const elbow = r.depth > 0 ? `<i class="${lastChild(id) ? "elbow" : ""}" style="left:${(r.depth - 1) * 18 + 8}px"></i>` : "";
        const ps = p ? p.steps : null;
        const xs = this.x(r.steps), xp = p ? this.x(ps) : null;
        const stem = p ? `<span class="stem" style="left:${Math.min(xs, xp)}%;width:${Math.abs(xs - xp)}%"></span>` : "";
        const over = r.steps > this.HI ? `<span class="over">${r.steps} →</span>` : "";
        rows.push(`<div class="ol-row" role="treeitem" data-id="${id}" style="--indent:${r.depth * 18}px" aria-level="${r.depth + 1}" ${has ? `aria-expanded="${!col}"` : ""}>
          <span class="ol-guides">${gl}${elbow}</span>
          <span></span>
          ${has ? `<button type="button" class="ol-caret" data-id="${id}" aria-expanded="${!col}" aria-label="${col ? "Expand" : "Collapse"} #${id}"><svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>` : "<span></span>"}
          <span class="ol-dot ${r.wr ? "wr" : ""}" style="background:${famVar(r)}"></span>
          <span class="ol-id">#${id}</span>
          <span class="ol-name"><b>${esc(r.short)}</b>${col && has ? ` <span class="chip">+${countDesc(id)} hidden</span>` : ""}<span class="ol-title">${esc((r.edge && r.edge.title) || r.descText)}</span></span>
          <span class="ol-bar" title="${r.steps} steps${p ? ` (parent #${p.id}: ${ps})` : ""}"><span class="track"></span>${stem}<span class="pip" style="left:${xs}%;background:${famVar(r)}"></span>${over}</span>
          <span class="ol-steps">${r.steps}<small>${p ? sgn(r.steps - ps) : "root"}</small></span>
          <span class="ol-mem" title="Optimizer state per hidden-matrix parameter">${memX(r) != null ? `${fmtX(memX(r))}${memBar(r, MEM_MAX, "mini")}` : ""}</span>
        </div>`);
        if (has && !col) {
          const kids = r.children;
          kids.forEach((c) => walk(c, r.depth > 0 ? guides.concat([!lastChild(id)]) : guides.concat([false])));
        }
      };
      const countDesc = (id) => { let n = 0; const st = [...byId.get(id).children]; while (st.length) { const c = st.pop(); n++; st.push(...byId.get(c).children); } return n; };
      walk(1, []);
      this.visible = vis;
      $("#view-outline").innerHTML = `<div class="outline" role="tree" aria-label="Record lineage outline">
        <div class="ol-head" style="--indent:0px"><span></span><span></span><span></span><span></span><span>Record · what it changed vs its parent</span><span style="display:flex;justify-content:space-between"><span>${this.LO}</span><span>steps</span><span>${this.HI}</span></span><span style="text-align:right">Steps</span><span style="text-align:right">Memory</span></div>
        ${rows.join("")}</div>`;
      this.sync(false);
    },
    sync(focus) {
      const el = $("#view-outline");
      $$(".ol-row", el).forEach((row) => {
        const id = +row.dataset.id;
        row.classList.toggle("sel", id === state.sel);
        row.classList.toggle("cmp", id === state.cmp);
        row.classList.toggle("dim", !lensHas(byId.get(id)));
      });
      if (!this.visible.includes(state.sel)) {
        // expand ancestors of the selection
        let changed = false;
        for (const a of pathFromRoot(state.sel)) if (a !== state.sel && this.collapsed.delete(a)) changed = true;
        if (changed) { store.set("collapsed", Array.from(this.collapsed)); this.render(); return; }
      }
      if (focus && state.view === "outline") {
        const row = $(`.ol-row[data-id="${state.sel}"]`, el);
        if (row) row.scrollIntoView({ block: "center" });
      }
    },
  };

  // =====================================================================
  // Timeline view (steps vs acceptance order / PR date, with lineage + WR frontier)
  // =====================================================================
  const TimelineView = {
    init() {
      this.svg = d3.select("#timeline-svg");
      $$("#tl-x button").forEach((b) => b.addEventListener("click", () => {
        state.tlx = b.dataset.x; store.set("tlx", state.tlx);
        $$("#tl-x button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        this.render();
      }));
      $$("#tl-x button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.x === state.tlx)));
      this.initialized = true;
    },
    render() {
      if (!this.initialized || state.view !== "timeline") return;
      const el = $("#timeline-svg");
      const W = el.clientWidth || 800, H = el.clientHeight || 600;
      const svg = this.svg;
      svg.selectAll("*").remove();
      svg.attr("viewBox", `0 0 ${W} ${H}`);
      const m = { l: 62, r: 30, t: 58, b: 44 };
      const MAIN_HI = 3700, LO = 2650;
      const outY = H - m.b - 22;
      const y = d3.scaleLinear().domain([LO, MAIN_HI]).range([m.t, outY - 44]);
      const parseDate = (s) => { const [Y, M, D] = s.split("/").map(Number); return new Date(Y, M - 1, D); };
      let x;
      const xs = new Map();
      if (state.tlx === "date") {
        const ds = RECS.map((r) => parseDate(r.date));
        x = d3.scaleTime().domain([d3.timeDay.offset(d3.min(ds), -2), d3.timeDay.offset(d3.max(ds), 2)]).range([m.l, W - m.r]);
        const byDate = d3.group(RECS, (r) => r.date);
        for (const [d, rs] of byDate) {
          rs.sort((a, b) => a.id - b.id);
          rs.forEach((r, i) => xs.set(r.id, x(parseDate(d)) + (i - (rs.length - 1) / 2) * 9));
        }
      } else {
        x = d3.scaleLinear().domain([0.3, MAX_ID + 0.7]).range([m.l, W - m.r]);
        RECS.forEach((r) => xs.set(r.id, x(r.id)));
      }
      const yOf = (s) => (s > MAIN_HI ? outY : y(s));
      // background band for outliers
      svg.append("rect").attr("class", "tl-band").attr("x", m.l).attr("width", W - m.l - m.r).attr("y", outY - 22).attr("height", 48).attr("rx", 6);
      svg.append("text").attr("class", "tl-note").attr("x", m.l + 8).attr("y", outY - 28).text("Off-scale: more than 3700 steps (value shown next to each point)");
      // grid + axes
      const g = svg.append("g").attr("class", "grid");
      const yt = d3.range(2700, MAIN_HI + 1, 100);
      g.selectAll("line").data(yt).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
      const ay = svg.append("g").attr("class", "axis");
      ay.selectAll("text").data(yt).join("text").attr("x", m.l - 8).attr("y", y).attr("dy", "0.32em").attr("text-anchor", "end").text((d) => d);
      svg.append("text").attr("class", "tl-note").attr("x", m.l).attr("y", 26).text("Steps to reach 3.28 val loss. Fewer is better, so better records sit higher.");
      if (state.tlx === "order") svg.append("text").attr("class", "tl-note").attr("x", m.l).attr("y", 42).text("The dark staircase is the world-record frontier; thin curves link each record to its parent.");
      const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b + 18})`);
      if (state.tlx === "date") {
        const ticks = x.ticks(d3.timeWeek.every(1));
        ax.selectAll("text").data(ticks).join("text").attr("x", x).attr("text-anchor", "middle").text(d3.timeFormat("%b %d"));
      } else {
        const ticks = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45].filter((t) => t <= MAX_ID);
        ax.selectAll("text").data(ticks).join("text").attr("x", x).attr("text-anchor", "middle").text((d) => "#" + d);
      }
      // WR frontier (acceptance order)
      if (state.tlx === "order") {
        const wr = RECS.filter((r) => r.wr).sort((a, b) => a.id - b.id);
        const pts = [];
        wr.forEach((r, i) => {
          if (i > 0) pts.push([xs.get(r.id), yOf(wr[i - 1].steps)]);
          pts.push([xs.get(r.id), yOf(r.steps)]);
        });
        pts.push([W - m.r, yOf(wr[wr.length - 1].steps)]);
        svg.append("path").attr("class", "tl-frontier").attr("d", "M" + pts.map((p) => p.join(",")).join("L"));

      }
      // lineage links
      const pe = state.cmp ? pathEdges(state.sel, state.cmp) : new Set();
      svg.append("g").selectAll("path").data(RECS.filter((r) => r.parent)).join("path")
        .attr("class", (r) => "tl-link" + (pe.has(r.id) ? " on-path" : ""))
        .attr("d", (r) => {
          const p = byId.get(r.parent);
          const x0 = xs.get(p.id), y0 = yOf(p.steps), x1 = xs.get(r.id), y1 = yOf(r.steps);
          const mx = (x0 + x1) / 2;
          return `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
        })
        .style("opacity", (r) => (lensHas(r) ? null : 0.2));
      const pts = svg.append("g").selectAll("g").data(RECS).join("g")
        .attr("class", (r) => "tl-pt" + (r.id === state.sel ? " sel" : "") + (r.id === state.cmp ? " cmp" : "") + (lensHas(r) ? "" : " dim"))
        .attr("transform", (r) => `translate(${xs.get(r.id)},${yOf(r.steps)})`)
        .on("click", (ev, r) => { if (ev.shiftKey || ev.altKey) setCompare(r.id); else select(r.id, { fromClick: true, focus: false }); })
        .on("mouseenter", (ev, r) => showTip(recTip(r), ev))
        .on("mousemove", (ev, r) => showTip(recTip(r), ev))
        .on("mouseleave", hideTip);
      pts.append("circle").attr("r", 13).style("fill", "transparent");
      pts.filter((r) => r.wr).append("circle").attr("class", "wr-ring").attr("r", 10.5);
      pts.append("circle").attr("class", "dot").attr("r", 7).style("fill", (r) => famVar(r));
      // off-scale points: alternate labels above/below so neighbours do not collide
      const offs = RECS.filter((r) => r.steps > MAIN_HI).sort((a, b) => xs.get(a.id) - xs.get(b.id));
      const offIdx = new Map(offs.map((r, i) => [r.id, i]));
      pts.append("text")
        .attr("x", (r) => (r.steps > MAIN_HI ? -4 : 11))
        .attr("y", (r) => (r.steps > MAIN_HI ? (offIdx.get(r.id) % 2 ? 22 : -10) : -8))
        .text((r) => (r.steps > MAIN_HI ? `#${r.id} · ${r.steps}` : `#${r.id}`));
      svg.on("click", (ev) => { if (ev.target === el && state.picking) { state.picking = false; update({ focus: false }); } });
    },
    sync() { this.render(); },
  };

  // =====================================================================
  // Genome view (technique presence matrix)
  // =====================================================================
  const GenomeView = {
    render() {
      const host = $("#view-genome");
      if (state.view !== "genome") return;
      const cols = PREORDER;
      const used = new Map();
      for (const id of cols) for (const t of byId.get(id).tech.keys()) if (!used.has(t)) used.set(t, preIndex.get(id));
      const rowsByCat = CATS.map((c) => ({ c, rows: Array.from(used.keys()).filter((t) => (TECHS.get(t) || { cat: "geometry" }).cat === c.id).sort((a, b) => used.get(a) - used.get(b)) })).filter((x) => x.rows.length);
      if (!used.size) { host.innerHTML = `<div class="genome"><p class="empty">Technique annotations are not available.</p></div>`; return; }
      const P = 17, CS = 13, LW = 196, TOP = 64;
      const W = LW + cols.length * P + 20;
      let yy = TOP + 6;
      const rowsY = [];
      for (const g of rowsByCat) { yy += 22; g.y = yy - 8; for (const t of g.rows) { rowsY.push({ t, y: yy, cat: g.c.id }); yy += P; } }
      const H = yy + 16;
      const A = byId.get(state.sel), B = state.cmp ? byId.get(state.cmp) : null;
      const cx = (i) => LW + i * P;
      let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Technique matrix">`;
      // column bands
      const si = cols.indexOf(state.sel);
      s += `<rect class="gm-colband" x="${cx(si) - 2}" y="${TOP - 50}" width="${P}" height="${H - TOP + 46}" rx="4"/>`;
      if (B) { const bi = cols.indexOf(B.id); s += `<rect class="gm-colband cmp" x="${cx(bi) - 2}" y="${TOP - 50}" width="${P}" height="${H - TOP + 46}" rx="4"/>`; }
      // diff rows
      if (B) for (const rw of rowsY) if (A.tech.has(rw.t) !== B.tech.has(rw.t)) s += `<rect class="gm-rowdiff" x="0" y="${rw.y - 2}" width="${W}" height="${P}" rx="3"/>`;
      // column headers
      cols.forEach((id, i) => {
        const r = byId.get(id);
        s += `<circle cx="${cx(i) + CS / 2}" cy="${TOP - 8}" r="4" style="fill:${famVar(r)}"/>`;
        s += `<text class="gm-col-lbl ${id === state.sel ? "sel" : ""}" data-col="${id}" transform="translate(${cx(i) + CS / 2 + 3},${TOP - 17}) rotate(-90)">${id}</text>`;
      });
      for (const g of rowsByCat) s += `<text class="gm-cat" x="4" y="${g.y}">${esc(g.c.label)}</text>`;
      for (const rw of rowsY) {
        s += `<text class="gm-row-lbl ${state.lens && state.lens.type === "tech" && state.lens.id === rw.t ? "on" : ""}" data-tech="${rw.t}" x="12" y="${rw.y + CS - 2}">${esc(techLabel(rw.t))}</text>`;
        cols.forEach((id, i) => {
          const r = byId.get(id);
          if (r.tech.has(rw.t)) {
            const origin = techOrigin(r, rw.t) === id;
            s += `<rect class="gm-cell ${origin ? "origin" : ""}" x="${cx(i)}" y="${rw.y}" width="${CS}" height="${CS}" rx="3"/>`;
          } else {
            s += `<rect class="gm-empty" x="${cx(i) + CS / 2 - 1.5}" y="${rw.y + CS / 2 - 1.5}" width="3" height="3" rx="1.5"/>`;
          }
        });
      }
      s += `<rect class="gm-hit" id="gm-hit" x="${LW}" y="${TOP}" width="${cols.length * P}" height="${H - TOP}"/>`;
      s += `</svg>`;
      host.innerHTML = `<div class="genome"><p class="genome-intro">Rows are techniques, columns are records in lineage order (each subtree is contiguous). A filled cell means the technique is active in that record's script; <span style="color:var(--accent);font-weight:600">violet</span> marks where it entered the lineage. Click a column to select a record, Shift-click to compare, or click a row name to highlight that technique everywhere.${B ? ` Rows shaded in violet differ between #${A.id} and #${B.id}.` : ""}</p>${s}</div>`;
      const svg = host.querySelector("svg");
      const hit = (ev) => {
        const pt = svg.getBoundingClientRect();
        const xx = ev.clientX - pt.left, yv = ev.clientY - pt.top;
        const i = Math.floor((xx - LW + 2) / P);
        const rw = rowsY.find((q) => yv >= q.y - 2 && yv < q.y - 2 + P);
        return { id: cols[i], rw };
      };
      svg.addEventListener("mousemove", (ev) => {
        if (ev.target.id !== "gm-hit") { hideTip(); return; }
        const { id, rw } = hit(ev);
        if (!id || !rw) { hideTip(); return; }
        const r = byId.get(id), t = r.tech.get(rw.t);
        const origin = t ? techOrigin(r, rw.t) : null;
        showTip(`<div class="tt-h"><span class="mono">#${id}</span><span>${esc(r.short)}</span></div><div><b>${esc(techLabel(rw.t))}</b>: ${t ? "active" : "not used"}</div>${t && t.note ? `<p>${esc(t.note)}</p>` : ""}${t ? `<p class="tt-k">${origin === id ? "Enters the lineage here" : `Inherited, present since #${origin}`}</p>` : ""}`, ev);
      });
      svg.addEventListener("mouseleave", hideTip);
      svg.addEventListener("click", (ev) => {
        const lbl = ev.target.closest("[data-tech]");
        if (lbl) { setLens({ type: "tech", id: lbl.dataset.tech }); return; }
        const col = ev.target.closest("[data-col]");
        if (col) { const id = +col.dataset.col; if (ev.shiftKey || ev.altKey) setCompare(id); else select(id, { fromClick: true, focus: false }); return; }
        if (ev.target.id === "gm-hit") { const { id } = hit(ev); if (id) { if (ev.shiftKey || ev.altKey) setCompare(id); else select(id, { fromClick: true, focus: false }); } }
      });
    },
    sync() { this.render(); },
  };

  // =====================================================================
  // Memory view: records grouped by optimizer-state category, plus memory vs steps
  // =====================================================================
  const MemoryView = {
    mode: store.get("memMode", "hidden"),
    val(r) { return this.mode === "total" ? (r.mem && typeof r.mem.total_x === "number" ? r.mem.total_x : null) : memX(r); },
    render() {
      if (state.view !== "memory") return;
      const host = $("#view-memory");
      const keep = host.scrollTop;
      const recs = RECS.filter((r) => this.val(r) != null);
      if (!recs.length) { host.innerHTML = `<div class="memv"><p class="empty">Memory measurements are not available.</p></div>`; return; }
      const bins = new Map();
      for (const r of recs) { const c = memCat(this.val(r)); if (!bins.has(c)) bins.set(c, []); bins.get(c).push(r); }
      const cats = Array.from(bins.keys()).sort((a, b) => a - b);
      const allKinds = new Set(); recs.forEach((r) => memKinds(r).forEach((v, k) => { if (v > 0.005) allKinds.add(k); }));
      const card = (r) => `<button type="button" class="mcard ${r.id === state.sel ? "sel" : ""} ${r.id === state.cmp ? "cmp" : ""} ${lensHas(r) ? "" : "dim"}" data-id="${r.id}">
          <span class="mc-top"><span class="swatch" style="background:${famVar(r)}"></span><span class="mono">#${r.id}</span>${r.wr ? '<span class="chip wr">WR</span>' : ""}<span class="mc-steps">${r.steps}</span></span>
          <span class="mc-name">${esc(r.short)}</span>
          <span class="mc-mem"><b>${fmtX(this.val(r))}</b>${memBar(r, MEM_MAX, "")}</span></button>`;
      const rows = cats.map((c) => {
        const rs = bins.get(c).slice().sort((a, b) => a.steps - b.steps || a.id - b.id);
        const best = rs[0];
        return `<section class="mrow"><div class="mrow-h"><span class="mcat m${memLevel(c)}">${c}×</span><div class="mrow-sub"><b>${rs.length}</b> record${rs.length === 1 ? "" : "s"}<br>best: #${best.id}, ${best.steps} steps</div></div><div class="mcards">${rs.map(card).join("")}</div></section>`;
      }).join("");
      host.innerHTML = `<div class="memv">
          <div class="memv-top">
            <p class="memv-intro"><b>Optimizer memory</b> counts the state an approach keeps for each hidden-matrix weight: Muon keeps one momentum buffer (<b>1×</b>), Adam keeps two (<b>2×</b>), Kronecker methods such as SOAP or Shampoo add factor and eigenbasis matrices, and wrappers add weight copies. Row or column statistics are ignored. Records are grouped by the rounded multiple.</p>
            <div class="seg" id="mem-mode" role="group" aria-label="What to count"><button type="button" data-mode="hidden" aria-pressed="${this.mode === "hidden"}">Per hidden weight</button><button type="button" data-mode="total" aria-pressed="${this.mode === "total"}">Whole model</button></div>
          </div>
          ${memKindsLegend(allKinds)}
          <div class="memv-chart" id="mem-chart"></div>
          ${rows}</div>`;
      this.chart(recs);
      host.scrollTop = keep;
      host.querySelector("#mem-mode").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-mode]"); if (!b) return;
        this.mode = b.dataset.mode; store.set("memMode", this.mode); this.render();
      });
      host.onclick = (e) => {
        const c = e.target.closest(".mcard"); if (!c) return;
        const id = +c.dataset.id;
        if (e.shiftKey || e.altKey) setCompare(id); else select(id, { fromClick: true, focus: false });
      };
    },
    chart(recs) {
      const el = $("#mem-chart");
      const W = Math.max(520, el.clientWidth - 28), H = 300, m = { l: 56, r: 24, t: 30, b: 40 };
      const HI = 3700, LO = 2650, outY = H - m.b - 14;
      const xmax = Math.ceil(Math.max(...recs.map((r) => this.val(r)))) + 0.5;
      const X = (v) => m.l + (v / xmax) * (W - m.l - m.r);
      const Y = (s) => (s > HI ? outY : m.t + ((s - LO) / (HI - LO)) * (outY - 28 - m.t));
      let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Steps to 3.28 against optimizer memory">`;
      s += `<rect class="tl-band" x="${m.l}" y="${outY - 12}" width="${W - m.l - m.r}" height="24" rx="5"/>`;
      for (let t = 2700; t <= HI; t += 100) s += `<line class="gridl" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axl" x="${m.l - 8}" y="${Y(t)}" dy="0.32em" text-anchor="end">${t}</text>`;
      s += `<text class="axl" x="${m.l - 8}" y="${outY}" dy="0.32em" text-anchor="end">&gt;3700</text>`;
      for (let t = 0; t <= Math.floor(xmax); t++) s += `<line class="gridl" x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${outY + 12}"/><text class="axl" x="${X(t)}" y="${H - m.b + 22}" text-anchor="middle">${t}×</text>`;
      s += `<text class="axt" x="${m.l}" y="16">Steps to 3.28 (better is higher) against optimizer memory (${this.mode === "total" ? "whole model" : "per hidden weight"})</text>`;
      // frontier: best steps achievable with at most this much memory
      const sorted = recs.slice().sort((a, b) => this.val(a) - this.val(b) || a.steps - b.steps);
      const pts = []; let best = Infinity;
      for (const r of sorted) if (r.steps < best) { if (pts.length) pts.push([X(this.val(r)), Y(best)]); best = r.steps; pts.push([X(this.val(r)), Y(best)]); }
      pts.push([W - m.r, Y(best)]);
      s += `<path class="mv-front" d="M${pts.map((p) => p.join(",")).join("L")}"/>`;
      const frontIds = new Set(); best = Infinity;
      for (const r of sorted) if (r.steps < best) { best = r.steps; frontIds.add(r.id); }
      const offLbl = new Map(); let lastX = -1e9, lift = 0;
      for (const r of recs.filter((q) => q.steps > HI).sort((a, b) => X(this.val(a)) - X(this.val(b)))) {
        const x = X(this.val(r)); lift = x - lastX < 78 ? lift + 1 : 0; lastX = x; offLbl.set(r.id, lift);
      }
      for (const r of recs) {
        const x = X(this.val(r)), y = Y(r.steps);
        const cls = ["mv-pt", r.id === state.sel ? "sel" : "", r.id === state.cmp ? "cmp" : "", lensHas(r) ? "" : "dim"].join(" ");
        s += `<g class="${cls}" data-id="${r.id}" transform="translate(${x},${y})"><circle r="12" fill="transparent"/>${r.wr ? '<circle class="wr-ring" r="9.5"/>' : ""}<circle class="dot" r="6.5" style="fill:${famVar(r)}"/>${r.steps > HI ? `<text x="9" y="${-8 - 12 * offLbl.get(r.id)}">#${r.id} · ${r.steps}</text>` : frontIds.has(r.id) || r.id === state.sel ? `<text x="10" y="-8">#${r.id}</text>` : ""}</g>`;
      }
      s += `</svg>`;
      el.innerHTML = `<div class="mv-key"><span><i class="front"></i>best steps reachable with at most this much memory</span></div>${s}`;
      const svg = el.querySelector("svg");
      svg.addEventListener("mousemove", (e) => { const g = e.target.closest(".mv-pt"); if (g) showTip(recTip(byId.get(+g.dataset.id)), e); else hideTip(); });
      svg.addEventListener("mouseleave", hideTip);
      svg.addEventListener("click", (e) => { const g = e.target.closest(".mv-pt"); if (!g) return; const id = +g.dataset.id; if (e.shiftKey || e.altKey) setCompare(id); else select(id, { fromClick: true, focus: false }); });
    },
    sync() { this.render(); },
  };

  // =====================================================================
  // Python syntax highlighting (line based, with triple-quote state)
  // =====================================================================
  const KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
  const TOK = /(#.*$)|([rRbBuUfF]{0,2}(?:'''|"""))|([rRbBuUfF]{0,2}(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"))|(@[A-Za-z_][\w.]*)|((?:0[xX][\da-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?j?|\.\d+(?:[eE][+-]?\d+)?))|([A-Za-z_]\w*)|(\s+)|([\s\S])/y;
  function tokenize(text, stateIn) {
    // returns {toks:[[cls, start, end]], state}
    const toks = [];
    let i = 0, st = stateIn;
    const n = text.length;
    if (st) {
      const e = text.indexOf(st);
      if (e < 0) return { toks: [["str", 0, n]], state: st };
      toks.push(["str", 0, e + 3]);
      i = e + 3; st = null;
    }
    let prevKw = null;
    while (i < n) {
      TOK.lastIndex = i;
      const m = TOK.exec(text);
      if (!m) break;
      const s = i, e = i + m[0].length;
      if (m[1] != null) { toks.push(["com", s, n]); i = n; break; }
      if (m[2] != null) {
        const q = m[2].slice(-3);
        const close = text.indexOf(q, e);
        if (close < 0) { toks.push(["str", s, n]); st = q; i = n; break; }
        toks.push(["str", s, close + 3]); i = close + 3; prevKw = null; continue;
      }
      if (m[3] != null) toks.push(["str", s, e]);
      else if (m[4] != null) toks.push(["dec", s, e]);
      else if (m[5] != null) toks.push(["num", s, e]);
      else if (m[6] != null) {
        const w = m[6];
        if (KW.has(w)) { toks.push(["kw", s, e]); prevKw = w; i = e; continue; }
        if (prevKw === "def" || prevKw === "class") toks.push(["fn", s, e]);
        else if (w === "self" || w === "cls") toks.push(["self", s, e]);
        else toks.push(["", s, e]);
      } else if (m[7] != null) { toks.push(["ws", s, e]); i = e; continue; }
      else toks.push(["", s, e]);
      prevKw = null;
      i = e;
    }
    return { toks, state: st };
  }
  const recCache = new Map();
  function recInfo(r) {
    let c = recCache.get(r.id);
    if (c) return c;
    const n = r.code.length;
    const startState = new Array(n);
    const toks = new Array(n);
    let st = null;
    for (let i = 0; i < n; i++) {
      startState[i] = st;
      const t = tokenize(LINES[r.code[i]], st);
      toks[i] = t.toks;
      st = t.state;
    }
    c = { startState, toks, norm: null };
    recCache.set(r.id, c);
    return c;
  }
  const normIds = new Map();
  function normKeys(r) {
    const info = recInfo(r);
    if (info.norm) return info.norm;
    const out = new Int32Array(r.code.length);
    for (let i = 0; i < r.code.length; i++) {
      const text = LINES[r.code[i]];
      const parts = [];
      for (const [cls, s, e] of info.toks[i]) {
        if (cls === "com" || cls === "ws") continue;
        if (cls === "str" && (info.startState[i] || /^[rRbBuUfF]{0,2}('''|""")/.test(text.slice(s, e)))) continue; // docstring / triple-quoted text
        parts.push(text.slice(s, e));
      }
      if (!parts.length) { out[i] = -1; continue; }
      const key = parts.join("\u0001");
      let id = normIds.get(key);
      if (id == null) { id = normIds.size; normIds.set(key, id); }
      out[i] = id;
    }
    info.norm = out;
    return out;
  }
  function lineHTML(r, i, marks) {
    const info = recInfo(r);
    const text = LINES[r.code[i]];
    const toks = info.toks[i];
    let out = "", mi = 0;
    const M = marks || [];
    for (const [cls, s, e] of toks) {
      // split the token by mark ranges
      let p = s;
      while (p < e) {
        while (mi < M.length && M[mi][1] <= p) mi++;
        let q = e, inMark = false;
        if (mi < M.length) {
          if (M[mi][0] <= p) { inMark = true; q = Math.min(e, M[mi][1]); }
          else q = Math.min(e, M[mi][0]);
        }
        const seg = esc(text.slice(p, q));
        const wrapped = cls && cls !== "ws" ? `<span class="tk-${cls}">${seg}</span>` : seg;
        out += inMark ? `<mark>${wrapped}</mark>` : wrapped;
        p = q;
      }
    }
    if (!toks.length) out = esc(text);
    return out || " ";
  }

  // =====================================================================
  // Diff engine: patience anchors + Myers, block matching, intraline marks
  // =====================================================================
  function myersOps(a, b, a0, a1, b0, b1, ops) {
    const N = a1 - a0, M = b1 - b0, MAX = N + M;
    if (!N) { for (let j = b0; j < b1; j++) ops.push([1, -1, j]); return; }
    if (!M) { for (let i = a0; i < a1; i++) ops.push([-1, i, -1]); return; }
    if (N * M > 9e6) { for (let i = a0; i < a1; i++) ops.push([-1, i, -1]); for (let j = b0; j < b1; j++) ops.push([1, -1, j]); return; }
    const off = MAX + 1;
    const V = new Int32Array(2 * MAX + 3);
    const trace = [];
    let D = -1;
    outer: for (let d = 0; d <= MAX; d++) {
      trace.push(V.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && a[a0 + x] === b[b0 + y]) { x++; y++; }
        V[off + k] = x;
        if (x >= N && y >= M) { D = d; break outer; }
      }
    }
    // backtrack
    const rev = [];
    let x = N, y = M;
    for (let d = D; d > 0; d--) {
      const Vd = trace[d]; // window [off-d-1, off+d+1] of V before step d
      const get = (k) => Vd[k + d + 1];
      const k = x - y;
      const prevK = (k === -d || (k !== d && get(k - 1) < get(k + 1))) ? k + 1 : k - 1;
      const prevX = get(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { rev.push([0, a0 + x - 1, b0 + y - 1]); x--; y--; }
      if (x === prevX) rev.push([1, -1, b0 + y - 1]); else rev.push([-1, a0 + x - 1, -1]);
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { rev.push([0, a0 + x - 1, b0 + y - 1]); x--; y--; }
    for (let i = rev.length - 1; i >= 0; i--) ops.push(rev[i]);
  }
  function uniqueAnchors(a, b, a0, a1, b0, b1) {
    const ca = new Map(), cb = new Map();
    for (let i = a0; i < a1; i++) { const v = a[i]; const e = ca.get(v); if (e) e.n++; else ca.set(v, { n: 1, i }); }
    for (let j = b0; j < b1; j++) { const v = b[j]; const e = cb.get(v); if (e) e.n++; else cb.set(v, { n: 1, j }); }
    const pairs = [];
    for (let i = a0; i < a1; i++) {
      const ea = ca.get(a[i]);
      if (ea.n !== 1) continue;
      const eb = cb.get(a[i]);
      if (eb && eb.n === 1) pairs.push([i, eb.j]);
    }
    if (!pairs.length) return pairs;
    // LIS on j
    const tails = [], prev = new Array(pairs.length);
    for (let p = 0; p < pairs.length; p++) {
      const j = pairs[p][1];
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
      prev[p] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = p;
    }
    const out = [];
    let p = tails[tails.length - 1];
    while (p >= 0) { out.push(pairs[p]); p = prev[p]; }
    return out.reverse();
  }
  function diffSeq(a, b) {
    const ops = [];
    const rec = (a0, a1, b0, b1, depth) => {
      while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { ops.push([0, a0, b0]); a0++; b0++; }
      let s = 0;
      while (a1 - s > a0 && b1 - s > b0 && a[a1 - 1 - s] === b[b1 - 1 - s]) s++;
      const ae = a1 - s, be = b1 - s;
      if (a0 === ae) { for (let j = b0; j < be; j++) ops.push([1, -1, j]); }
      else if (b0 === be) { for (let i = a0; i < ae; i++) ops.push([-1, i, -1]); }
      else {
        const anchors = depth < 60 ? uniqueAnchors(a, b, a0, ae, b0, be) : [];
        if (anchors.length) {
          let pa = a0, pb = b0;
          for (const [ia, ib] of anchors) { rec(pa, ia, pb, ib, depth + 1); ops.push([0, ia, ib]); pa = ia + 1; pb = ib + 1; }
          rec(pa, ae, pb, be, depth + 1);
        } else myersOps(a, b, a0, ae, b0, be, ops);
      }
      for (let k = 0; k < s; k++) ops.push([0, ae + k, be + k]);
    };
    rec(0, a.length, 0, b.length, 0);
    return ops;
  }
  const TOKRE = /\w+|\s+|[^\w\s]/g;
  function tokSplit(s) { const out = []; let m; TOKRE.lastIndex = 0; while ((m = TOKRE.exec(s))) out.push([m[0], m.index, m.index + m[0].length]); return out; }
  function intraline(ta, tb) {
    const A = tokSplit(ta), B = tokSplit(tb);
    if (A.length * B.length > 250000) return null;
    const ids = new Map();
    const id = (s) => { let v = ids.get(s); if (v == null) { v = ids.size; ids.set(s, v); } return v; };
    const a = A.map((t) => id(t[0])), b = B.map((t) => id(t[0]));
    const ops = [];
    myersOps(a, b, 0, a.length, 0, b.length, ops);
    let same = 0, ma = [], mb = [];
    for (const [t, i, j] of ops) {
      if (t === 0) { if (!/^\s+$/.test(A[i][0])) same += A[i][0].length; }
      else if (t < 0) { if (!/^\s+$/.test(A[i][0])) ma.push([A[i][1], A[i][2]]); }
      else if (!/^\s+$/.test(B[j][0])) mb.push([B[j][1], B[j][2]]);
    }
    const len = Math.max(1, Math.max(ta.replace(/\s+/g, "").length, tb.replace(/\s+/g, "").length));
    if (same / len < 0.35) return null;
    const merge = (r) => { const o = []; for (const x of r) { if (o.length && x[0] <= o[o.length - 1][1] + 1) o[o.length - 1][1] = Math.max(o[o.length - 1][1], x[1]); else o.push([x[0], x[1]]); } return o; };
    return { a: merge(ma), b: merge(mb) };
  }

  function blockLines(b) { const out = []; for (const [s, e] of b.r) for (let i = s; i < e; i++) out.push(i); return out; }
  const diffCache = new Map();
  function blockDiff(A, B, ignore) {
    const ck = `${A.id}>${B.id}>${ignore ? 1 : 0}`;
    if (diffCache.has(ck)) return diffCache.get(ck);
    const ka = ignore ? normKeys(A) : A.code, kb = ignore ? normKeys(B) : B.code;
    const seqOf = (rec, keys, blk) => {
      const lines = blockLines(blk).filter((i) => !ignore || keys[i] >= 0);
      return { lines, keys: lines.map((i) => keys[i]) };
    };
    const mapA = new Map(A.blocks.map((b) => [b.key, b])), mapB = new Map(B.blocks.map((b) => [b.key, b]));
    const pairs = [];
    const matchedA = new Set();
    for (const bb of B.blocks) {
      const ab = mapA.get(bb.key);
      if (ab) { pairs.push({ a: ab, b: bb }); matchedA.add(ab.key); } else pairs.push({ a: null, b: bb });
    }
    const removed = A.blocks.filter((b) => !matchedA.has(b.key));
    // rename detection
    const addedIdx = pairs.filter((p) => !p.a && p.b.k !== "code");
    for (const rb of removed.slice()) {
      if (rb.k === "code") continue;
      const la = blockLines(rb).map((i) => A.code[i]);
      const ma = new Map(); la.forEach((v) => ma.set(v, (ma.get(v) || 0) + 1));
      let best = null, bestS = 0;
      for (const p of addedIdx) {
        if (p.a || p.b.k !== rb.k) continue;
        const lb = blockLines(p.b).map((i) => B.code[i]);
        const mb = new Map(); lb.forEach((v) => mb.set(v, (mb.get(v) || 0) + 1));
        let common = 0; for (const [v, c] of ma) common += Math.min(c, mb.get(v) || 0);
        const sim = (2 * common) / (la.length + lb.length);
        if (sim > bestS) { bestS = sim; best = p; }
      }
      if (best && bestS >= 0.5) { best.a = rb; best.renamed = true; removed.splice(removed.indexOf(rb), 1); }
    }
    // order: B order, with removed A blocks placed after their predecessor in A
    const posA = new Map(A.blocks.map((b, i) => [b.key, i]));
    const entries = [];
    const placed = new Set();
    const flushBefore = (aIndex) => {
      for (const rb of removed) if (!placed.has(rb.key) && posA.get(rb.key) < aIndex) { entries.push({ a: rb, b: null }); placed.add(rb.key); }
    };
    for (const p of pairs) {
      if (p.a) flushBefore(posA.get(p.a.key));
      entries.push(p);
    }
    flushBefore(Infinity);
    let tAdd = 0, tDel = 0;
    const stats = { mod: 0, add: 0, del: 0, ren: 0, same: 0 };
    for (const e of entries) {
      const sa = e.a ? seqOf(A, ka, e.a) : { lines: [], keys: [] };
      const sb = e.b ? seqOf(B, kb, e.b) : { lines: [], keys: [] };
      const ops = diffSeq(sa.keys, sb.keys).map(([t, i, j]) => [t, i >= 0 ? sa.lines[i] : -1, j >= 0 ? sb.lines[j] : -1]);
      e.ops = ops;
      e.add = ops.filter((o) => o[0] > 0).length;
      e.del = ops.filter((o) => o[0] < 0).length;
      e.status = !e.a ? "add" : !e.b ? "del" : e.renamed ? "ren" : (e.add || e.del) ? "mod" : "same";
      if (!e.a && !e.b) continue;
      if (e.a && e.b && !sa.lines.length && !sb.lines.length) e.status = "same";
      stats[e.status]++;
      tAdd += e.add; tDel += e.del;
      const blk = e.b || e.a;
      e.kind = blk.k; e.name = blk.name; e.sec = blk.sec; e.key = (e.b || e.a).key;
      e.oldName = e.renamed ? e.a.name : null;
    }
    const res = { entries, stats, add: tAdd, del: tDel };
    diffCache.set(ck, res);
    return res;
  }
  const kindIcon = (k) => (k === "def" ? "ƒ" : k === "class" ? "C" : "≡");
  function entryLabel(e) {
    if (e.kind === "code") return `${esc(e.name)} <small>module code</small>`;
    return `${esc(e.name)}${e.oldName ? ` <small>was ${esc(e.oldName)}</small>` : ""}`;
  }
  function entryStat(e) {
    if (e.status === "add") return `<span class="tag add">new</span> <span class="a">+${e.add}</span>`;
    if (e.status === "del") return `<span class="tag del">removed</span> <span class="d">${MINUS}${e.del}</span>`;
    if (e.status === "same") return `<span style="color:var(--muted)">unchanged</span>`;
    return `${e.status === "ren" ? '<span class="tag ren">renamed</span> ' : ""}<span class="a">+${e.add}</span> <span class="d">${MINUS}${e.del}</span>`;
  }

  // =====================================================================
  // Diff overlay
  // =====================================================================
  const DiffUI = {
    a: null, b: null,
    mode: store.get("diffMode", "unified"),
    ignore: store.get("diffIgnore", true),
    showSame: store.get("diffSame", false),
    expanded: new Set(),
    isOpen() { return !$("#diff").hidden; },
    init() {
      const opts = RECS.map((r) => `<option value="${r.id}">#${r.id} · ${esc(r.short)} (${r.steps})</option>`).join("");
      $("#diff-a").innerHTML = opts; $("#diff-b").innerHTML = opts;
      $("#diff-a").addEventListener("change", (e) => { this.a = +e.target.value; this.expanded.clear(); this.render(); writeHash(); });
      $("#diff-b").addEventListener("change", (e) => { this.b = +e.target.value; this.expanded.clear(); this.render(); writeHash(); });
      $("#diff-swap").addEventListener("click", () => { [this.a, this.b] = [this.b, this.a]; this.expanded.clear(); this.render(); writeHash(); });
      $("#diff-close").addEventListener("click", () => this.close());
      $("#diff").addEventListener("click", (e) => { if (e.target.id === "diff") this.close(); });
      $$("#diff-mode button").forEach((b) => b.addEventListener("click", () => { this.mode = b.dataset.mode; store.set("diffMode", this.mode); this.render(true); }));
      const ig = $("#diff-ignore"); ig.checked = this.ignore;
      ig.addEventListener("change", () => { this.ignore = ig.checked; store.set("diffIgnore", this.ignore); this.expanded.clear(); this.render(); });
      const sm = $("#diff-same"); sm.checked = this.showSame;
      sm.addEventListener("change", () => { this.showSame = sm.checked; store.set("diffSame", this.showSame); this.render(true); });
      $("#diff-nav").addEventListener("click", (e) => {
        const it = e.target.closest(".dn-item");
        if (!it) return;
        const el = document.getElementById(it.dataset.target);
        if (el) { el.classList.remove("collapsed"); el.scrollIntoView({ block: "start", behavior: "smooth" }); }
      });
      $("#diff-main").addEventListener("click", (e) => {
        const gap = e.target.closest(".drow.gap");
        if (gap) { this.expanded.add(gap.dataset.key); this.render(true); return; }
        const h = e.target.closest(".dblock-h");
        if (h) h.parentElement.classList.toggle("collapsed");
      });
    },
    open(a, b, focusKey) {
      this.a = a; this.b = b; this.expanded.clear();
      $("#diff").hidden = false;
      document.body.style.overflow = "hidden";
      this.render();
      writeHash();
      if (focusKey) {
        const el = $(`.dblock[data-key="${CSS.escape(focusKey)}"]`);
        if (el) { el.classList.remove("collapsed"); setTimeout(() => el.scrollIntoView({ block: "start" }), 30); }
      }
      $("#diff-close").focus();
    },
    close() {
      $("#diff").hidden = true;
      document.body.style.overflow = "";
      writeHash();
    },
    render(keepScroll) {
      const A = byId.get(this.a), B = byId.get(this.b);
      $("#diff-a").value = String(this.a); $("#diff-b").value = String(this.b);
      $$("#diff-mode button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.mode === this.mode)));
      const main = $("#diff-main");
      const scroll = main.scrollTop;
      if (A.id === B.id) {
        $("#diff-sum").innerHTML = `<span>Pick two different records.</span>`;
        $("#diff-nav").innerHTML = ""; main.innerHTML = ""; return;
      }
      const d = blockDiff(A, B, this.ignore);
      const rel = (() => {
        if (B.parent === A.id) return `#${B.id} is a child of #${A.id}`;
        if (A.parent === B.id) return `#${A.id} is a child of #${B.id}`;
        const tp = treePath(A.id, B.id);
        return `tree distance ${tp.up.length + tp.down.length - 2} (common ancestor #${tp.lca})`;
      })();
      $("#diff-sum").innerHTML = `<span><b>#${A.id}</b> ${esc(A.short)} → <b>#${B.id}</b> ${esc(B.short)}</span>
        <span><span class="a">+${d.add}</span> <span class="d">${MINUS}${d.del}</span> lines</span>
        <span>${d.stats.mod + d.stats.ren} modified · ${d.stats.add} added · ${d.stats.del} removed · ${d.stats.same} unchanged blocks</span>
        <span class="note-inline">${rel}${this.ignore ? " · comments, docstrings and whitespace hidden" : ""}</span>`;
      // nav
      const groups = [];
      let cur = null;
      for (const e of d.entries) {
        if (!e.status) continue;
        if (!cur || cur.sec !== e.sec) { cur = { sec: e.sec, items: [] }; groups.push(cur); }
        cur.items.push(e);
      }
      $("#diff-nav").innerHTML = groups.map((g) => `<div class="dn-sec">${esc(g.sec || "Top")}</div>` + g.items.map((e) => {
        const i = d.entries.indexOf(e);
        return `<button type="button" class="dn-item ${e.status === "same" ? "same" : ""}" data-target="blk-${i}"><span class="fp-ic">${kindIcon(e.kind)}</span><span class="fp-name">${entryLabel(e)}</span><span class="fp-stat">${e.status === "same" ? "" : entryStat(e)}</span></button>`;
      }).join("")).join("");
      // blocks
      const html = [];
      d.entries.forEach((e, i) => {
        if (!e.status) return;
        if (e.status === "same" && !this.showSame) return;
        const collapsed = e.status === "same";
        html.push(`<section class="dblock ${collapsed ? "collapsed" : ""}" id="blk-${i}" data-key="${esc(e.key)}">
          <div class="dblock-h"><span class="fp-ic">${kindIcon(e.kind)}</span><span class="fp-name">${entryLabel(e)}</span><span class="sec-name">${esc(e.sec || "")}</span><span class="fp-stat">${entryStat(e)}</span></div>
          <div class="dtable ${this.mode === "split" ? "split" : ""}">${this.mode === "split" ? this.splitRows(A, B, e) : this.unifiedRows(A, B, e)}</div></section>`);
      });
      if (!html.length) html.push(`<p class="empty">No differences${this.ignore ? " in code (comments and whitespace ignored)" : ""}.</p>`);
      main.innerHTML = html.join("");
      if (keepScroll) main.scrollTop = scroll; else main.scrollTop = 0;
    },
    // pair deletions/insertions inside each change run for intraline marks
    marksFor(A, B, e) {
      const marks = new Map(); // "a:i" / "b:j" -> ranges
      const ops = e.ops;
      let k = 0;
      while (k < ops.length) {
        if (ops[k][0] === 0) { k++; continue; }
        const dels = [], ins = [];
        while (k < ops.length && ops[k][0] !== 0) { (ops[k][0] < 0 ? dels : ins).push(ops[k]); k++; }
        const n = Math.min(dels.length, ins.length);
        for (let q = 0; q < n; q++) {
          const ia = dels[q][1], jb = ins[q][2];
          const r = intraline(LINES[A.code[ia]], LINES[B.code[jb]]);
          if (r) { marks.set("a:" + ia, r.a); marks.set("b:" + jb, r.b); }
        }
      }
      return marks;
    },
    unifiedRows(A, B, e) {
      const ctx = 3;
      const ops = e.ops;
      const marks = this.marksFor(A, B, e);
      const full = this.expanded.has(e.key) || e.status === "add" || e.status === "del";
      const rows = [];
      const row = (o) => {
        const [t, ia, jb] = o;
        if (t === 0) return `<div class="drow"><span class="ln">${ia + 1}</span><span class="ln">${jb + 1}</span><span class="sg"> </span><span>${lineHTML(B, jb)}</span></div>`;
        if (t < 0) return `<div class="drow del"><span class="ln">${ia + 1}</span><span class="ln"></span><span class="sg">${MINUS}</span><span>${lineHTML(A, ia, marks.get("a:" + ia))}</span></div>`;
        return `<div class="drow add"><span class="ln"></span><span class="ln">${jb + 1}</span><span class="sg">+</span><span>${lineHTML(B, jb, marks.get("b:" + jb))}</span></div>`;
      };
      if (full) return ops.map(row).join("");
      // keep context around changes
      const keep = new Uint8Array(ops.length);
      ops.forEach((o, i) => { if (o[0] !== 0) for (let q = Math.max(0, i - ctx); q <= Math.min(ops.length - 1, i + ctx); q++) keep[q] = 1; });
      let i = 0;
      while (i < ops.length) {
        if (keep[i]) { rows.push(row(ops[i])); i++; continue; }
        let j = i; while (j < ops.length && !keep[j]) j++;
        rows.push(`<div class="drow gap" data-key="${esc(e.key)}"><span>⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"} (click to expand)</span></div>`);
        i = j;
      }
      return rows.join("");
    },
    splitRows(A, B, e) {
      const ops = e.ops;
      const marks = this.marksFor(A, B, e);
      const full = this.expanded.has(e.key) || e.status === "add" || e.status === "del";
      const items = []; // [left|null, right|null, changed]
      let k = 0;
      while (k < ops.length) {
        if (ops[k][0] === 0) { items.push([ops[k][1], ops[k][2], false]); k++; continue; }
        const dels = [], ins = [];
        while (k < ops.length && ops[k][0] !== 0) { (ops[k][0] < 0 ? dels : ins).push(ops[k]); k++; }
        const n = Math.max(dels.length, ins.length);
        for (let q = 0; q < n; q++) items.push([dels[q] ? dels[q][1] : null, ins[q] ? ins[q][2] : null, true]);
      }
      const ctx = 3;
      const keep = new Uint8Array(items.length);
      items.forEach((it, i) => { if (it[2]) for (let q = Math.max(0, i - ctx); q <= Math.min(items.length - 1, i + ctx); q++) keep[q] = 1; });
      const cell = (side, rec, i, changed) => {
        if (i == null) return `<span class="ln"></span><span class="sg"></span><span class="code blank"></span>`;
        const cls = changed ? (side === "a" ? "del" : "add") : "";
        const sg = changed ? (side === "a" ? MINUS : "+") : " ";
        return `<span class="ln">${i + 1}</span><span class="sg ${side === "a" ? "lhs" : "rhs"} ${cls}">${sg}</span><span class="code ${side === "a" ? "lhs" : "rhs"} ${cls}">${lineHTML(rec, i, changed ? marks.get(side + ":" + i) : null)}</span>`;
      };
      const rows = [];
      let i = 0;
      while (i < items.length) {
        if (full || keep[i]) { const [l, r, ch] = items[i]; rows.push(`<div class="drow">${cell("a", A, l, ch)}${cell("b", B, r, ch)}</div>`); i++; continue; }
        let j = i; while (j < items.length && !keep[j]) j++;
        rows.push(`<div class="drow gap" data-key="${esc(e.key)}"><span>⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"} (click to expand)</span></div>`);
        i = j;
      }
      return rows.join("");
    },
  };

  // =====================================================================
  // Charts (validation-loss curves, gap vs parent, seed strips)
  // =====================================================================
  function interp(curve, step) {
    if (!curve.length) return null;
    if (step <= curve[0][0]) return curve[0][0] === step ? curve[0][1] : null;
    for (let i = 1; i < curve.length; i++) {
      if (curve[i][0] >= step) {
        const [s0, v0] = curve[i - 1], [s1, v1] = curve[i];
        return v0 + (v1 - v0) * (step - s0) / (s1 - s0);
      }
    }
    return null;
  }
  function niceTicks(lo, hi, n) {
    const span = hi - lo, step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function curveChart(series, mode) {
    // series: [{rec, color, ref}]
    const W = 440, H = 220, m = { l: 46, r: 14, t: 12, b: 24 };
    const all = series.filter((s) => s.rec.curve.length);
    if (!all.length) return `<p class="empty">No validation curve in the logs.</p>`;
    const maxStep = Math.max(...all.map((s) => s.rec.curve[s.rec.curve.length - 1][0]));
    const minClaim = Math.min(...all.map((s) => s.rec.steps));
    let x0 = mode === "full" ? 0 : Math.floor((minClaim * 0.8) / 100) * 100;
    const x1 = maxStep;
    let ylo = Infinity, yhi = -Infinity;
    for (const s of all) for (const p of s.rec.curve) if (p[0] >= x0 && p[0] <= x1) { ylo = Math.min(ylo, p[2]); yhi = Math.max(yhi, p[3]); }
    ylo = Math.min(ylo, TARGET - 0.002) - 0.002;
    yhi = mode === "full" ? Math.min(yhi, 4.0) : Math.min(yhi + 0.002, 3.5);
    if (!(yhi > ylo)) yhi = ylo + 0.05;
    const X = (v) => m.l + (v - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
    const Y = (v) => m.t + (yhi - v) / (yhi - ylo) * (H - m.t - m.b);
    const clipId = "c" + Math.random().toString(36).slice(2, 8);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Validation loss curves"><defs><clipPath id="${clipId}"><rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/></clipPath></defs>`;
    for (const t of niceTicks(ylo, yhi, 4)) s += `<line class="gridl" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 6}" y="${Y(t)}" dy="0.32em" text-anchor="end">${t.toFixed(yhi - ylo < 0.2 ? 3 : 2)}</text>`;
    for (const t of niceTicks(x0, x1, 5)) s += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${t}</text>`;
    s += `<line class="basel" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
    s += `<line class="target" x1="${m.l}" x2="${W - m.r}" y1="${Y(TARGET)}" y2="${Y(TARGET)}"/><text class="lbl-ink" x="${m.l + 6}" y="${Y(TARGET) + 13}">3.28 target</text>`;
    s += `<g clip-path="url(#${clipId})">`;
    for (const sr of all) {
      const pts = sr.rec.curve.filter((p) => p[0] >= x0 - 200);
      if (sr.rec.n > 1 && !sr.ref && pts.length > 1) {
        const top = pts.map((p) => `${X(p[0])},${Y(p[3])}`).join("L");
        const bot = pts.slice().reverse().map((p) => `${X(p[0])},${Y(p[2])}`).join("L");
        s += `<path class="band" d="M${top}L${bot}Z" style="fill:${sr.color}"/>`;
      }
    }
    for (const sr of all) {
      const pts = sr.rec.curve.filter((p) => p[0] >= x0 - 200);
      if (pts.length > 1) s += `<path class="ln ${sr.ref ? "ref" : ""}" d="M${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join("L")}" style="stroke:${sr.color}"/>`;
    }
    s += `</g>`;
    for (const sr of all) {
      const v = interp(sr.rec.curve, sr.rec.steps);
      if (v == null) continue;
      s += `<circle class="endpt" cx="${X(sr.rec.steps)}" cy="${Y(v)}" r="4.5" style="fill:${sr.ref ? "var(--muted)" : sr.color}"/>`;
    }
    s += `<line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" style="display:none"/><rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
    return { svg: s, X, Y, x0, x1, W, H, m, all };
  }
  function mountCurve(container, series, mode) {
    const c = curveChart(series, mode);
    if (typeof c === "string") { container.innerHTML = c; return; }
    container.innerHTML = `<div class="chart-wrap">${c.svg}<div class="chart-tip" hidden></div></div>`;
    const svg = container.querySelector("svg"), tipEl = container.querySelector(".chart-tip"), xh = svg.querySelector(".xhair");
    const hit = svg.querySelector(".hit");
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = (ev.clientX - r.left) * (c.W / r.width);
      const step = c.x0 + (sx - c.m.l) / (c.W - c.m.l - c.m.r) * (c.x1 - c.x0);
      xh.setAttribute("x1", sx); xh.setAttribute("x2", sx); xh.style.display = "";
      const rows = c.all.map((s) => { const v = interp(s.rec.curve, step); return v == null ? "" : `<div><span style="display:inline-block;width:10px;height:2px;margin-right:6px;vertical-align:middle;background:${s.ref ? "var(--muted)" : s.color}"></span>#${s.rec.id} ${v.toFixed(4)}</div>`; }).join("");
      tipEl.innerHTML = `<div style="color:var(--muted)">step ${Math.round(step)}</div>${rows}`;
      tipEl.hidden = false;
      const px = (sx / c.W) * r.width;
      tipEl.style.left = Math.min(r.width - tipEl.offsetWidth - 4, px + 10) + "px";
      tipEl.style.top = "8px";
    });
    hit.addEventListener("mouseleave", () => { xh.style.display = "none"; tipEl.hidden = true; });
  }
  function gapChart(child, base) {
    const pts = [];
    const from = Math.max(500, 0.35 * Math.min(child.steps, base.steps));
    for (const p of child.curve) { const v = interp(base.curve, p[0]); if (v != null && p[0] >= from) pts.push([p[0], p[1] - v]); }
    if (pts.length < 2) return "";
    const W = 440, H = 120, m = { l: 46, r: 14, t: 10, b: 22 };
    const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
    let lo = Math.min(0, ...pts.map((p) => p[1])), hi = Math.max(0, ...pts.map((p) => p[1]));
    const padv = (hi - lo) * 0.12 || 0.002; lo -= padv; hi += padv;
    const X = (v) => m.l + (v - x0) / (x1 - x0 || 1) * (W - m.l - m.r);
    const Y = (v) => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Loss gap">`;
    for (const t of niceTicks(lo, hi, 3)) s += `<line class="gridl" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 6}" y="${Y(t)}" dy="0.32em" text-anchor="end">${t > 0 ? "+" : ""}${t.toFixed(3)}</text>`;
    s += `<line class="basel" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    for (const t of niceTicks(x0, x1, 5)) s += `<text x="${X(t)}" y="${H - 5}" text-anchor="middle">${t}</text>`;
    s += `<path class="ln" d="M${pts.map((p) => `${X(p[0])},${Y(p[1])}`).join("L")}" style="stroke:var(--accent)"/>`;
    const last = pts[pts.length - 1];
    s += `<circle class="endpt" cx="${X(last[0])}" cy="${Y(last[1])}" r="4" style="fill:var(--accent)"/><text class="lbl-ink" x="${X(last[0]) - 6}" y="${Y(last[1]) + (last[1] > 0 ? 14 : -8)}" text-anchor="end">${last[1] > 0 ? "+" : ""}${last[1].toFixed(4)} at ${last[0]}</text>`;
    s += `</svg>`;
    return s;
  }
  function seedStrip(rows) {
    // rows: [{rec, color}]
    const vals = rows.flatMap((r) => r.rec.seeds);
    if (!vals.length) return "";
    const W = 440, rowH = 26, m = { l: 46, r: 14, t: 8, b: 22 };
    const H = m.t + rows.length * rowH + m.b;
    let lo = Math.min(...vals, TARGET), hi = Math.max(...vals, TARGET);
    const pad = (hi - lo) * 0.08 || 0.001; lo -= pad; hi += pad;
    const X = (v) => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Per-seed validation loss at the claimed step">`;
    for (const t of niceTicks(lo, hi, 4)) s += `<line class="gridl" x1="${X(t)}" x2="${X(t)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(t)}" y="${H - 6}" text-anchor="middle">${t.toFixed(4)}</text>`;
    s += `<line class="target" x1="${X(TARGET)}" x2="${X(TARGET)}" y1="${m.t - 4}" y2="${H - m.b}"/>`;
    rows.forEach((row, i) => {
      const y = m.t + i * rowH + rowH / 2;
      s += `<text class="lbl-ink" x="${m.l - 8}" y="${y}" dy="0.32em" text-anchor="end">#${row.rec.id}</text>`;
      for (const v of row.rec.seeds) s += `<circle cx="${X(v)}" cy="${y}" r="4.5" style="fill:${row.color};opacity:.75" stroke="var(--panel)" stroke-width="1.5"><title>${v.toFixed(5)}</title></circle>`;
      const mu = row.rec.seeds.reduce((a, b) => a + b, 0) / row.rec.seeds.length;
      s += `<line x1="${X(mu)}" x2="${X(mu)}" y1="${y - 9}" y2="${y + 9}" style="stroke:var(--ink);stroke-width:2"/>`;
    });
    s += `</svg>`;
    return s;
  }

  // =====================================================================
  // Hyperparameters
  // =====================================================================
  const HP_GROUPS = [["steps", "Steps"], ["hidden", "Hidden matrices"], ["aux", "Auxiliary Adam"], ["schedule", "Schedule"], ["init", "Initialization"]];
  const HP_LABELS = {
    "steps.scheduled": "Scheduled steps", "steps.claimed": "Claimed step", "hidden.optimizer": "Optimizer", "hidden.lr": "Learning rate", "hidden.wd": "Weight decay",
    "hidden.momentum": "Momentum", "hidden.nesterov": "Nesterov", "hidden.ns_iters": "Newton–Schulz iterations", "hidden.beta2": "β₂", "hidden.eps": "ε",
    "aux.optimizer": "Optimizer", "aux.embed_lr": "Embedding lr", "aux.head_lr": "LM-head lr", "aux.scalar_lr": "1-D params lr", "aux.betas": "Betas", "aux.eps": "ε", "aux.wd": "Weight decay",
    "schedule.kind": "Schedule", "schedule.cooldown_frac": "Cooldown fraction", "schedule.hidden_cooldown_frac": "Hidden cooldown fraction", "schedule.aux_cooldown_frac": "Aux cooldown fraction",
    "schedule.warmup_steps": "Warmup steps", "schedule.power": "Power", "schedule.end_step": "Schedule end step",
    "init.hidden_std": "Hidden std", "init.embed_std": "Embedding std", "init.proj": "Projections", "init.bias": "Biases", "init.gains": "Norm gains",
  };
  function hpGroup(k) { const p = k.split(".")[0]; return HP_GROUPS.find((g) => g[0] === p) ? p : "tech"; }
  function hpLabel(k) {
    if (HP_LABELS[k]) return HP_LABELS[k];
    const [p, ...rest] = k.split(".");
    if (TECHS.has(p)) return `${techLabel(p)}: ${rest.join(".").replace(/_/g, " ")}`;
    return rest.length ? rest.join(".").replace(/_/g, " ") : k;
  }
  const hpNorm = (v) => String(v == null ? "" : v).replace(/\s+/g, "").toLowerCase();
  // core value: drop parenthetical remarks and blank markers so equal settings annotated differently compare equal
  function hpCore(v) {
    let t = String(v == null ? "" : v);
    for (let k = 0; k < 4; k++) t = t.replace(/\([^()]*\)/g, "");
    t = t.replace(/\s+/g, "").replace(/[.;,]+$/, "").toLowerCase();
    return /^(–|-|—|n\/a|none|absent|notset|)$/.test(t) ? "" : t;
  }
  function hpKeysSorted(keys) {
    const order = HP_GROUPS.map((g) => g[0]).concat(["tech"]);
    return keys.sort((a, b) => order.indexOf(hpGroup(a)) - order.indexOf(hpGroup(b)) || a.localeCompare(b));
  }

  // =====================================================================
  // Inspector (side panel): tabs, plain-language overview first, details on demand
  // =====================================================================
  const TABS_REC = [["overview", "Overview"], ["changes", "Changes"], ["memory", "Memory"], ["curves", "Curves"], ["techniques", "Techniques"], ["settings", "Settings"], ["docs", "Docs"]];
  const TABS_CMP = [["overview", "Overview"], ["diff", "Differences"], ["curves", "Curves"], ["code", "Code"]];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (s) => { const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s || ""); return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : esc(s); };
  // code-like tokens inside prose (snake_case names, calls, module paths) get a quiet code style
  const CODE_TOK = /(?<![\p{L}\p{N}_])(?:_?[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|_[A-Za-z0-9_]+|[A-Za-z_][\w.]*\(\)|(?:attn|mlp|embed|model|proj|blocks)\.[A-Za-z_][\w.]*)(?![\p{L}\p{N}_])/gu;
  function prose(text) {
    const s = String(text == null ? "" : text);
    let out = "", last = 0, m;
    CODE_TOK.lastIndex = 0;
    while ((m = CODE_TOK.exec(s))) { out += esc(s.slice(last, m.index)) + `<code class="tok">${esc(m[0])}</code>`; last = m.index + m[0].length; }
    return out + esc(s.slice(last));
  }
  function sentences(text) {
    const parts = String(text || "").trim().split(/(?<=[.!?])\s+(?=[A-Z(#"“0-9])/);
    const out = [];
    for (const p of parts) {
      if (out.length && /\b(?:e\.g|i\.e|vs|approx|etc|cf|al|no)\.$/i.test(out[out.length - 1])) out[out.length - 1] += " " + p;
      else if (p) out.push(p);
    }
    return out;
  }
  const typeName = { added: "Added", removed: "Removed", modified: "Changed", tuned: "Retuned", refactor: "Refactor" };
  const tabsHTML = (tabs, cur) => `<nav class="itabs" role="tablist" aria-label="Record details">${tabs.map(([id, label]) => `<button type="button" role="tab" data-act="tab" data-tab="${id}" aria-selected="${id === cur}">${label}</button>`).join("")}</nav>`;
  const recBtn = (r, extra) => `<button type="button" class="rec-link" data-act="go" data-id="${r.id}"><span class="swatch" style="background:${famVar(r)}"></span><span class="mono">#${r.id}</span><span class="rl-name">${esc(r.short)}</span>${extra ? `<small>${extra}</small>` : ""}</button>`;

  const Inspector = {
    curveMode: store.get("curveMode", "tail"),
    tabRec: store.get("tabRec", "overview"),
    tabCmp: store.get("tabCmp", "overview"),
    init() {
      const el = $("#inspector");
      el.addEventListener("click", (e) => {
        const t = e.target.closest("[data-act]");
        if (!t) return;
        const act = t.dataset.act, id = t.dataset.id ? +t.dataset.id : null;
        if (act === "go") select(id, { fromClick: true });
        else if (act === "parent") { const r = byId.get(state.sel); if (r.parent) select(r.parent); }
        else if (act === "child") { const c = bestChild(byId.get(state.sel)); if (c) select(c); }
        else if (act === "cmp-parent") { const r = byId.get(state.sel); if (r.parent) setCompare(r.parent); }
        else if (act === "pick") { state.picking = true; update({ focus: false }); }
        else if (act === "cmp") setCompare(id);
        else if (act === "exit-cmp") clearCompare();
        else if (act === "swap") { const a = state.sel; state.sel = state.cmp; state.cmp = a; update({ focus: true }); }
        else if (act === "diff") DiffUI.open(+t.dataset.a, +t.dataset.b, t.dataset.key || null);
        else if (act === "lens") setLens({ type: "tech", id: t.dataset.tech });
        else if (act === "curve") { this.curveMode = t.dataset.mode; store.set("curveMode", this.curveMode); this.render(); }
        else if (act === "hp-all") { this.hpAll = !this.hpAll; this.render(); }
        else if (act === "tab") {
          if (state.cmp) { this.tabCmp = t.dataset.tab; store.set("tabCmp", this.tabCmp); }
          else { this.tabRec = t.dataset.tab; store.set("tabRec", this.tabRec); }
          this.render(true);
          const b = $(`.itabs [data-tab="${t.dataset.tab}"]`); if (b) b.focus();
        }
      });
      el.addEventListener("keydown", (e) => {
        const t = e.target.closest(".itabs [data-tab]");
        if (!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
        const all = $$(".itabs [data-tab]");
        const i = all.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1);
        if (all[i]) { all[i].click(); e.preventDefault(); e.stopPropagation(); }
      });
    },
    render(tabChanged) {
      const el = $("#inspector");
      const keep = el.scrollTop;
      const key = `${state.sel}|${state.cmp}`;
      const sameView = this.lastKey === key && !tabChanged;
      this.lastKey = key;
      if (state.cmp) this.renderCompare(byId.get(state.sel), byId.get(state.cmp));
      else this.renderRecord(byId.get(state.sel));
      el.scrollTop = sameView ? keep : 0;
    },
    navButtons(r) {
      const p = r.parent ? byId.get(r.parent) : null;
      const c = bestChild(r);
      return `<div class="ih-nav">
        <button type="button" class="nav-btn" data-act="parent" ${p ? "" : "disabled"} title="Go to the parent (←)" aria-label="Go to the parent">← ${p ? "#" + p.id : ""}</button>
        <button type="button" class="nav-btn" data-act="child" ${c ? "" : "disabled"} title="Go to the child on the way to the best descendant (→)" aria-label="Go to a child">${c ? "#" + c : ""} →</button>
      </div>`;
    },
    renderRecord(r) {
      const p = r.parent ? byId.get(r.parent) : null;
      const an = r.an || {};
      const tabs = TABS_REC.filter(([id]) => (id !== "docs" || r.docs.length || (an.caveats && an.caveats.trim())) && (id !== "memory" || r.mem));
      const tab = tabs.some(([id]) => id === this.tabRec) ? this.tabRec : "overview";
      const links = [];
      if (r.pr) links.push(`<a href="https://github.com/KellerJordan/modded-nanogpt/pull/${r.pr}" target="_blank" rel="noopener">PR #${r.pr}</a>`);
      links.push(`<a href="${esc(r.log)}" target="_blank" rel="noopener">Log</a>`);
      if (r.folder) links.push(`<a href="${esc(r.folder)}" target="_blank" rel="noopener">Files</a>`);
      const who = r.contrib.replace(/^<a[^>]*>PR<\/a>\s*by\s*/i, "");
      const head = `<header class="insp-head">
        <div class="ih-top">
          <div class="ih-title">
            <div class="ih-kicker"><span class="ih-num">#${r.id}</span>${r.wr ? `<span class="chip wr" title="New world record when it was accepted">World record</span>` : ""}<span class="chip"><span class="swatch" style="background:${famVar(r)}"></span>${esc(fam(r).label)}</span>${!r.valid ? `<span class="chip warn" title="Submitted before the significance rule, single run">Pre-rules</span>` : ""}</div>
            <h2 class="ih-name">${esc(r.short)}</h2>
            <div class="ih-meta">${fmtDate(r.date)} · ${who}<span class="ih-links">${links.join("")}</span></div>
          </div>
          ${this.navButtons(r)}
        </div>
        ${tabsHTML(tabs, tab)}
      </header>`;
      const body = tab === "changes" ? this.recChanges(r, p) : tab === "memory" ? this.recMemory(r, p) : tab === "curves" ? this.recCurves(r, p) : tab === "techniques" ? this.recTechniques(r, p)
        : tab === "settings" ? this.recSettings(r, p) : tab === "docs" ? this.recDocs(r, p) : this.recOverview(r, p);
      $("#inspector").innerHTML = `<div class="insp">${head}<div class="insp-body" role="tabpanel">${body}</div></div>`;
      if (tab === "curves") mountCurve($("#curve-host"), p ? [{ rec: p, color: "var(--muted)", ref: true }, { rec: r, color: famVar(r) }] : [{ rec: r, color: famVar(r) }], this.curveMode);
    },
    techChips(edge) {
      const ta = edge.techniques_added || [], tr = edge.techniques_removed || [], tm = edge.techniques_modified || [];
      if (!(ta.length + tr.length + tm.length)) return "";
      const chip = (t, cls, sg, title) => `<button type="button" class="chip ${cls}" data-act="lens" data-tech="${esc(t)}" title="${title} — click to highlight it on the tree"><span class="sg">${sg}</span>${esc(techLabel(t))}</button>`;
      return `<div class="chips">${ta.map((t) => chip(t, "add", "+", "Added")).join("")}${tr.map((t) => chip(t, "del", MINUS, "Removed")).join("")}${tm.map((t) => chip(t, "mod", "~", "Changed")).join("")}</div>`;
    },
    recOverview(r, p) {
      const edge = r.edge || {};
      const plain = r.plain || sentences(edge.summary)[0] || r.descText;
      const bullets = r.bullets && r.bullets.length ? r.bullets : (edge.changes || []).filter((c) => c.type !== "refactor").slice(0, 4).map((c) => c.label);
      const dS = p ? r.steps - p.steps : null;
      const mg = margin(r);
      const comp = r.comp && r.comp.mean != null && (Math.abs(r.comp.mean - r.mean) > 6e-5 || r.comp.n !== r.n) ? ` · logs give ${r.comp.mean.toFixed(4)} over ${r.comp.n}` : "";
      let h = `<section class="blk"><p class="lede">${prose(plain)}</p></section>`;
      h += `<section class="blk"><div class="tiles">
          <div class="tile"><div class="t-l">Steps to 3.28</div><div class="t-v">${r.steps}</div><div class="t-d">${p ? `<span class="${dS < 0 ? "delta-good" : dS > 0 ? "delta-bad" : ""}">${sgn(dS)}</span> vs #${p.id}` : "the starting point"}</div></div>
          <div class="tile"><div class="t-l">Mean val loss</div><div class="t-v">${fmt4(r.mean)}</div><div class="t-d">over ${r.n} run${r.n === 1 ? "" : "s"}${comp}</div></div>
          ${memX(r) != null ? `<button type="button" class="tile tile-btn" data-act="tab" data-tab="memory" title="Optimizer state kept per hidden-matrix parameter; click for the breakdown"><div class="t-l">Optimizer memory</div><div class="t-v">${fmtX(memX(r))}</div><div class="t-d">per hidden weight${p && memX(p) != null && Math.abs(memX(r) - memX(p)) >= 0.05 ? ` · <span class="${memX(r) > memX(p) ? "delta-bad" : "delta-good"}">${memX(r) > memX(p) ? "+" : MINUS}${fmtX(Math.abs(memX(r) - memX(p)))}</span> vs #${p.id}` : ""}</div>${memBar(r, MEM_MAX, "tile-bar")}</button>` : ""}
          <div class="tile" title="(3.28 − mean) × √n must be at least 0.004"><div class="t-l">Passes the bar?</div><div class="t-v">${mg >= NEED ? "Yes" : "No"}</div><div class="t-d">margin ${mg.toFixed(4)} (needs 0.004)</div><div class="meter"><i class="${mg >= NEED ? "ok" : ""}" style="width:${Math.max(0, Math.min(100, mg / 0.012 * 100))}%"></i><b style="left:${NEED / 0.012 * 100}%"></b></div></div>
        </div>${r.sched !== r.steps ? `<p class="fine">The run was scheduled for ${r.sched} steps; the result is read at step ${r.steps}, the earliest eval that clears the bar.</p>` : ""}</section>`;
      if (p) {
        const eg = effGain(r, p), pw = pairwise(r, p);
        const dl = r.mean - p.mean;
        h += `<section class="blk"><div class="verdict">
            <div class="vnum ${eg >= 0 ? "pos" : "neg"}">${eg >= 0 ? "+" : MINUS}${Math.abs(eg).toFixed(0)}</div>
            <div class="vtxt">effective steps ${eg >= 0 ? "better" : "worse"} than its parent ${recBtn(p)}</div>
            <div class="vsub">It ${dS <= 0 ? `saves ${-dS} step${dS === -1 ? "" : "s"}` : `needs ${dS} more step${dS === 1 ? "" : "s"}`} and ends ${Math.abs(dl) < 5e-5 ? "at the same loss" : `${Math.abs(dl).toFixed(4)} ${dl < 0 ? "lower" : "higher"} in loss`}; at 0.0045 loss per 100 steps that totals ${Math.abs(eg).toFixed(0)} steps.
              <span class="pill ${pw >= NEED ? "ok" : "no"}">${pw >= NEED ? "✓ Statistically clear" : "Not yet statistically clear"}</span></div>
          </div></section>`;
      }
      h += `<section class="blk"><div class="blk-h"><h3>${p ? `What changed from #${p.id}` : "What the baseline does"}</h3></div>
          <ul class="bul">${bullets.map((b) => `<li>${prose(b)}</li>`).join("")}</ul>
          ${this.techChips(edge)}
          <div class="actions">
            ${p ? `<button type="button" class="nav-btn" data-act="tab" data-tab="changes">Read the details</button><button type="button" class="nav-btn primary" data-act="diff" data-a="${p.id}" data-b="${r.id}">Code diff vs #${p.id}</button>` : `<button type="button" class="nav-btn" data-act="tab" data-tab="changes">Read the details</button>`}
          </div></section>`;
      const kids = r.children.map((c) => byId.get(c));
      const bigGap = r.nearest && p && r.nearest !== p.id && r.dParent - r.dNearest >= 40 && r.dParent >= 1.4 * r.dNearest;
      h += `<section class="blk"><div class="blk-h"><h3>Family tree</h3><span class="aside">generation ${r.depth}</span></div>
          <div class="kin">
            <div class="kin-row"><span>Parent</span><div class="kin-list">${p ? `${recBtn(p, p.steps)}<span class="kin-note">${r.how === "declared" ? "as stated in the README" : "inferred from the code and dates"}</span>` : `<span class="kin-note">none, this is the original baseline</span>`}</div></div>
            <div class="kin-row"><span>Children</span><div class="kin-list">${kids.length ? kids.map((k) => recBtn(k, sgn(k.steps - r.steps))).join("") : `<span class="kin-note">none yet</span>`}</div></div>
            ${r.infl && r.infl.length ? `<div class="kin-row"><span>Borrows from</span><div class="kin-list">${r.infl.map((i) => recBtn(byId.get(i))).join("")}</div></div>` : ""}
          </div>
          ${bigGap ? `<p class="fine">Its code is closest to ${recBtn(byId.get(r.nearest))} (${r.dNearest} lines differ, versus ${r.dParent} against #${p.id}). <button type="button" class="linkish" data-act="diff" data-a="${r.nearest}" data-b="${r.id}">Diff against #${r.nearest}</button></p>` : ""}
          <div class="actions">${p ? `<button type="button" class="nav-btn" data-act="cmp-parent">Compare with #${p.id}</button>` : ""}<button type="button" class="nav-btn" data-act="pick">Compare with another record…</button></div>
        </section>`;
      return h;
    },
    recChanges(r, p) {
      const edge = r.edge || {};
      let h = `<section class="blk">${edge.title ? `<h3 class="big">${prose(edge.title)}</h3>` : ""}
          ${edge.summary ? `<ul class="bul">${sentences(edge.summary).map((s) => `<li>${prose(s)}</li>`).join("")}</ul>` : `<p class="fine">No curated summary for this record; the code diff shows every change.</p>`}
          ${this.techChips(edge)}</section>`;
      const changes = (edge.changes || []);
      if (changes.length) {
        h += `<section class="blk"><div class="blk-h"><h3>${p ? "Each change" : "Components"}</h3><span class="aside">${changes.length}</span></div><div class="cards">${changes.map((c) => {
          const syms = (c.symbols || []).filter(Boolean);
          const k = p && syms.length ? symKey(r, syms[0]) : "";
          return `<article class="card"><div class="card-h"><span class="type ${esc(c.type)}">${esc(typeName[c.type] || c.type)}</span><b>${prose(c.label)}</b></div>
            ${c.detail ? `<p>${prose(c.detail)}</p>` : ""}
            ${p && syms.length ? `<button type="button" class="codelink" data-act="diff" data-a="${p.id}" data-b="${r.id}" data-key="${esc(k)}">View in the code <span>${syms.slice(0, 3).map((s) => `<code class="tok">${esc(s)}</code>`).join(" ")}${syms.length > 3 ? ` +${syms.length - 3}` : ""}</span></button>` : ""}</article>`;
        }).join("")}</div></section>`;
      }
      if (p && edge.hparams_changed && edge.hparams_changed.length) {
        h += `<section class="blk"><div class="blk-h"><h3>Settings that changed</h3></div><div class="kv-wrap"><table class="kv"><thead><tr><th>Setting</th><th>#${p.id}</th><th>#${r.id}</th></tr></thead><tbody>${edge.hparams_changed.map((x) => `<tr><td class="k">${esc(x.label || hpLabel(x.key || ""))}</td><td class="v old">${esc(x.from == null ? "–" : x.from)}</td><td class="v new">${esc(x.to == null ? "–" : x.to)}</td></tr>`).join("")}</tbody></table></div></section>`;
      }
      if (p && edge.parent_check && !/^consistent\.?$/i.test(edge.parent_check.trim())) {
        h += `<section class="blk"><div class="blk-h"><h3>About the parent</h3></div><p class="prose-p">${prose(edge.parent_check)}</p></section>`;
      }
      if (p) {
        const fp = blockDiff(p, r, true);
        const changed = fp.entries.filter((e) => e.status && e.status !== "same");
        h += `<section class="blk"><div class="blk-h"><h3>Where the code changed</h3><span class="aside"><span class="a">+${fp.add}</span> <span class="d">${MINUS}${fp.del}</span> lines · comments ignored</span></div>
          <div class="footprint">${changed.slice(0, 16).map((e) => `<button type="button" class="fp-row" data-act="diff" data-a="${p.id}" data-b="${r.id}" data-key="${esc(e.key)}"><span class="fp-ic">${kindIcon(e.kind)}</span><span class="fp-name">${entryLabel(e)}</span><span class="fp-stat">${entryStat(e)}</span></button>`).join("")}${changed.length > 16 ? `<button type="button" class="fp-row" data-act="diff" data-a="${p.id}" data-b="${r.id}"><span></span><span class="fp-name">${changed.length - 16} more…</span><span></span></button>` : ""}</div>
          ${edge.noise ? `<p class="fine"><b>Safe to skip in the diff:</b> ${prose(edge.noise)}</p>` : ""}</section>`;
      }
      return h;
    },
    recMemory(r, p) {
      const m = r.mem;
      if (!m) return `<p class="fine">No memory measurement for this record.</p>`;
      const kinds = memKinds(r);
      const comps = (m.components || []).slice().sort((a, b) => (+b.x || 0) - (+a.x || 0));
      const pm = p && p.mem ? memX(p) : null;
      let h = `<section class="blk"><div class="mem-hero"><span class="mcat m${memLevel(m.hidden_x)}">${fmtX(m.hidden_x)}</span>
          <div><div class="mh-t">optimizer state per hidden-matrix parameter</div><div class="mh-s">Category ${memCat(m.hidden_x)}× · whole model ${fmtX(m.total_x)} of all ${"162M"} parameters${pm != null ? ` · parent #${p.id}: ${fmtX(pm)}` : ""}</div></div></div>
          ${memBar(r, Math.max(MEM_MAX, m.hidden_x), "big")}${memKindsLegend(kinds)}</section>`;
      h += `<section class="blk"><div class="blk-h"><h3>What takes the memory</h3><span class="aside">× hidden-matrix parameters (84.9M)</span></div>
          <div class="kv-wrap"><table class="kv mem-table"><tbody>${comps.map((c) => `<tr><td class="k"><span class="kdot k-${MEM_KINDS.some(([id]) => id === c.kind) ? c.kind : "other"}"></span>${prose(c.name)}${c.applies_to || (c.when && c.when !== "always") ? `<small>${prose([c.applies_to, c.when && c.when !== "always" ? c.when : ""].filter(Boolean).join(" · "))}</small>` : ""}</td><td class="v num">${(+c.x || 0).toFixed(2)}×</td></tr>`).join("")}
          <tr class="total"><td class="k">Total</td><td class="v num">${(+m.hidden_x).toFixed(2)}×</td></tr></tbody></table></div></section>`;
      h += `<section class="blk"><div class="blk-h"><h3>Embedding, LM head and 1-D parameters</h3><span class="aside">77.4M parameters</span></div>
          <p class="prose-p">${prose(m.aux_note || "")} → <b>${fmtX(m.aux_x)}</b> of those parameters. This part is the same in almost every record, so the memory category above leaves it out.</p></section>`;
      if (m.notes || (m.evidence && m.evidence.length)) {
        h += `<section class="blk"><details class="doc"><summary>How this was counted</summary><div class="md">${m.notes ? `<p>${prose(m.notes)}</p>` : ""}${m.evidence && m.evidence.length ? `<ul>${m.evidence.map((e) => `<li>${prose(e)}</li>`).join("")}</ul>` : ""}<p>Counted: every tensor kept across steps by the optimizer and its wrappers (momentum, second moments, Kronecker factors, eigenbases, EMAs and weight snapshots), in elements. Ignored: row or column vectors, scalars, and per-step temporaries.</p></div></details></section>`;
      }
      return h;
    },
    recCurves(r, p) {
      const famC = famVar(r);
      return `<section class="blk"><div class="blk-h"><h3>Validation loss</h3><div class="seg chart-tabs"><button type="button" data-act="curve" data-mode="tail" aria-pressed="${this.curveMode === "tail"}">End of run</button><button type="button" data-act="curve" data-mode="full" aria-pressed="${this.curveMode === "full"}">Full run</button></div></div>
          <div class="chart-key"><span><i style="background:${famC}"></i>#${r.id}, mean of ${r.comp.n || r.n} run${(r.comp.n || r.n) === 1 ? "" : "s"} (shaded: min to max)</span>${p ? `<span><i class="ref"></i>#${p.id}, its parent</span>` : ""}</div>
          <div id="curve-host"></div></section>
        ${p ? `<section class="blk"><div class="blk-h"><h3>Gap to the parent</h3><span class="aside">below zero means lower loss than #${p.id}</span></div>${gapChart(r, p)}</section>` : ""}
        <section class="blk"><div class="blk-h"><h3>Every run at the claimed step</h3><span class="aside">dots are runs, ticks are means, the line is 3.28</span></div>
          ${seedStrip(p ? [{ rec: r, color: famC }, { rec: p, color: "var(--muted)" }] : [{ rec: r, color: famC }])}
          ${r.hw && r.hw.gpu ? `<p class="fine">Logged on ${esc(r.hw.gpu)}${r.hw.world ? ` × ${r.hw.world}` : ""} with PyTorch ${esc(r.hw.torch)}.</p>` : ""}</section>`;
    },
    recTechniques(r, p) {
      const an = r.an || {};
      let h = "";
      if (an.mechanisms && an.mechanisms.length) {
        h += `<section class="blk"><div class="blk-h"><h3>New in this record</h3></div><div class="cards">${an.mechanisms.map((m) => {
          const syms = (m.symbols || []).filter(Boolean);
          return `<article class="card mech"><div class="card-h"><b>${esc(m.name || techLabel(m.id || ""))}</b></div><p>${prose(m.explain || "")}</p>${p && syms.length ? `<button type="button" class="codelink" data-act="diff" data-a="${p.id}" data-b="${r.id}" data-key="${esc(symKey(r, syms[0]))}">View in the code <span>${syms.slice(0, 3).map((s) => `<code class="tok">${esc(s)}</code>`).join(" ")}</span></button>` : ""}</article>`;
        }).join("")}</div></section>`;
      }
      if (r.tech.size) {
        const byCat = CATS.map((c) => ({ c, ts: Array.from(r.tech.values()).filter((t) => (TECHS.get(t.id) || { cat: "geometry" }).cat === c.id) })).filter((x) => x.ts.length);
        h += `<section class="blk"><div class="blk-h"><h3>Everything active in this record</h3><span class="aside">${r.tech.size} · click one to highlight it on the tree</span></div><div class="tech-list">${byCat.map((g) => `<div class="tech-cat">${esc(g.c.label)}</div>` + g.ts.map((t) => {
          const o = techOrigin(r, t.id);
          return `<button type="button" class="tech-row" data-act="lens" data-tech="${esc(t.id)}"><span class="tr-main"><span class="tn">${esc(techLabel(t.id))}</span>${t.note ? `<span class="tnote">${prose(t.note)}</span>` : ""}</span><span class="prov ${o === r.id ? "here" : ""}">${o === r.id ? "New here" : "Since #" + o}</span></button>`;
        }).join("")).join("")}</div></section>`;
      }
      return h || `<p class="fine">No technique annotations for this record.</p>`;
    },
    recSettings(r, p) {
      const keys = hpKeysSorted(Object.keys(r.hp));
      if (!keys.length) return `<p class="fine">No settings recorded.</p>`;
      const edge = r.edge || {};
      const curated = new Map(((edge && edge.hparams_changed) || []).filter((x) => x && x.key).map((x) => [x.key, x]));
      const blankV = (v) => v == null || /^(–|-|—|n\/a|none|absent|not set|)$/i.test(String(v).trim());
      let lastG = null;
      const rows = keys.map((k) => {
        const g = hpGroup(k);
        const gh = g !== lastG ? `<tr class="grp"><th colspan="2">${esc((HP_GROUPS.find((x) => x[0] === g) || [0, "Technique settings"])[1])}</th></tr>` : "";
        lastG = g;
        const ch = p ? curated.get(k) : null;
        const isNew = ch && blankV(ch.from);
        return `${gh}<tr class="${ch ? "changed" : ""}"><td class="k" title="${esc(k)}">${esc(hpLabel(k))}</td><td class="v">${ch && !isNew ? `<span class="from">${esc(ch.from)}</span><span class="arrow">→</span>` : ""}${esc(r.hp[k])}${isNew ? '<span class="new-tag">new</span>' : ""}</td></tr>`;
      }).join("");
      return `<section class="blk"><div class="blk-h"><h3>All settings</h3>${p ? `<span class="aside">highlighted rows changed from #${p.id}</span>` : ""}</div><div class="kv-wrap"><table class="kv two"><tbody>${rows}</tbody></table></div></section>`;
    },
    recDocs(r) {
      const an = r.an || {};
      return `<section class="blk"><div class="blk-h"><h3>Benchmark README entry</h3></div><p class="prose-p">${r.desc}</p></section>
        ${an.caveats && an.caveats.trim() ? `<section class="blk"><div class="blk-h"><h3>Caveats from reading the code</h3></div><ul class="bul">${sentences(an.caveats).map((s) => `<li>${prose(s)}</li>`).join("")}</ul></section>` : ""}
        ${r.docs.map((d, i) => `<section class="blk"><details class="doc" ${i === 0 ? "open" : ""}><summary>${esc(d.name)} from the submission</summary><div class="md">${d.html}</div></details></section>`).join("")}`;
    },
    renderCompare(a, b) {
      // a = selected, b = compare target
      const tp = treePath(a.id, b.id);
      const tabs = TABS_CMP;
      const tab = tabs.some(([id]) => id === this.tabCmp) ? this.tabCmp : "overview";
      const dist = tp.up.length + tp.down.length - 2;
      const head = `<header class="insp-head">
          <div class="ih-top"><div class="ih-title">
            <div class="ih-kicker"><span class="ih-num">Comparing</span></div>
            <h2 class="ih-name">#${a.id} ${esc(a.short)} <span class="vs">vs</span> #${b.id} ${esc(b.short)}</h2>
            <div class="ih-meta">${dist} generation${dist === 1 ? "" : "s"} apart · common ancestor #${tp.lca}</div></div>
            <div class="ih-nav"><button type="button" class="nav-btn" data-act="swap" title="Swap the two records">⇄ Swap</button><button type="button" class="nav-btn primary" data-act="exit-cmp">Done</button></div>
          </div>
          ${tabsHTML(tabs, tab)}
        </header>`;
      let body = "";
      if (tab === "overview") {
        const older = a.steps >= b.steps ? a : b, newer = older === a ? b : a;
        const pw = pairwise(newer, older), eg = effGain(newer, older);
        const card = (r, tag) => `<div class="cmp-card"><div class="cc-h"><span class="swatch" style="background:${famVar(r)}"></span><span class="cc-id">#${r.id}</span>${r.wr ? '<span class="chip wr">WR</span>' : ""}<span class="cc-tag">${tag}</span></div><div class="cc-n">${esc(r.short)}</div><div class="cc-s"><b>${r.steps}</b> steps · loss ${fmt4(r.mean)} · ${r.n} run${r.n === 1 ? "" : "s"}</div>${memX(r) != null ? `<div class="cc-s">optimizer memory <b>${fmtX(memX(r))}</b></div>${memBar(r, MEM_MAX, "")}` : ""}</div>`;
        const storyItem = (id, dir) => {
          const r = byId.get(id);
          const t = r.plain || (r.edge && r.edge.title) || r.descText.slice(0, 90);
          const p = r.parent ? byId.get(r.parent) : null;
          return `<li${id === tp.lca ? ' class="lca"' : ""}><span class="sd" style="background:${famVar(r)}"></span><div class="st"><button type="button" class="linkish" data-act="go" data-id="${id}">#${id} ${esc(r.short)}</button>${dir && p ? `<em>${dir === "up" ? "Undo: " : ""}${prose(t)}</em>` : ""}</div><span class="sx">${p && dir ? (dir === "up" ? sgn(p.steps - r.steps) : sgn(r.steps - p.steps)) : r.steps}</span></li>`;
        };
        let story = "";
        if (tp.up.length > 1) story += `<li class="dir">From #${a.id} back up to #${tp.lca}: these changes are undone</li>` + tp.up.slice(0, -1).map((id) => storyItem(id, "up")).join("");
        story += storyItem(tp.lca, null);
        if (tp.down.length > 1) story += `<li class="dir">From #${tp.lca} down to #${b.id}: these changes are applied</li>` + tp.down.slice(1).map((id) => storyItem(id, "down")).join("");
        body = `<section class="blk"><div class="cmp-grid">${card(a, "selected")}${card(b, "compared")}</div></section>
          <section class="blk"><div class="verdict"><div class="vnum ${eg >= 0 ? "pos" : "neg"}">${Math.abs(eg).toFixed(0)}</div>
            <div class="vtxt">effective steps separate them, in favour of <b>#${eg >= 0 ? newer.id : older.id}</b></div>
            <div class="vsub">#${newer.id} uses ${older.steps - newer.steps} fewer steps and ends ${Math.abs(newer.mean - older.mean).toFixed(4)} ${newer.mean <= older.mean ? "lower" : "higher"} in loss. <span class="pill ${pw >= NEED ? "ok" : "no"}">${pw >= NEED ? "✓ Statistically clear" : "Not statistically clear"}</span></div></div></section>
          <section class="blk"><div class="blk-h"><h3>Path through the tree</h3><span class="aside">each step is one record's change</span></div><ul class="story">${story}</ul></section>`;
      } else if (tab === "diff") {
        const onlyA = Array.from(a.tech.keys()).filter((t) => !b.tech.has(t));
        const onlyB = Array.from(b.tech.keys()).filter((t) => !a.tech.has(t));
        const shared = Array.from(a.tech.keys()).filter((t) => b.tech.has(t));
        const chipsOf = (ts, cls) => ts.map((t) => `<button type="button" class="chip ${cls}" data-act="lens" data-tech="${esc(t)}">${esc(techLabel(t))}</button>`).join("");
        const keys = hpKeysSorted(Array.from(new Set([...Object.keys(a.hp), ...Object.keys(b.hp)])));
        const diffKeys = keys.filter((k) => hpCore(a.hp[k]) !== hpCore(b.hp[k]));
        const showKeys = this.hpAll ? keys : diffKeys;
        const memBlock = a.mem && b.mem ? (() => {
          const mx = Math.max(memX(a), memX(b), 1);
          const kinds = new Set([...memKinds(a).keys(), ...memKinds(b).keys()]);
          const row = (r) => `<div class="mcmp-row"><span class="mono">#${r.id}</span><span class="mcmp-v">${fmtX(memX(r))}</span>${memBar(r, mx, "")}</div>`;
          const d = memX(a) - memX(b);
          return `<section class="blk"><div class="blk-h"><h3>Optimizer memory</h3><span class="aside">per hidden-matrix weight</span></div>
            <div class="mcmp">${row(a)}${row(b)}</div>${memKindsLegend(kinds)}
            <p class="fine">${Math.abs(d) < 0.05 ? "Both keep the same amount of optimizer state." : `#${a.id} keeps ${fmtX(Math.abs(d))} ${d > 0 ? "more" : "less"} state per hidden weight than #${b.id}.`} The Memory tab of each record lists what takes the space.</p></section>`;
        })() : "";
        body = memBlock + `<section class="blk"><div class="blk-h"><h3>Techniques</h3><span class="aside">${shared.length} shared</span></div>
            <div class="kin"><div class="kin-row"><span>Only #${a.id}</span><div class="kin-list">${onlyA.length ? chipsOf(onlyA, "add") : '<span class="kin-note">none</span>'}</div></div>
            <div class="kin-row"><span>Only #${b.id}</span><div class="kin-list">${onlyB.length ? chipsOf(onlyB, "del") : '<span class="kin-note">none</span>'}</div></div>
            <div class="kin-row"><span>Both</span><div class="kin-list">${shared.length ? chipsOf(shared, "") : '<span class="kin-note">none</span>'}</div></div></div></section>
          ${keys.length ? `<section class="blk"><div class="blk-h"><h3>${this.hpAll ? "All settings" : "Settings that differ"}</h3><span class="aside">${diffKeys.length} of ${keys.length} · <button type="button" class="linkish" data-act="hp-all">${this.hpAll ? "differences only" : "show all"}</button></span></div><div class="kv-wrap"><table class="kv"><thead><tr><th>Setting</th><th>#${a.id}</th><th>#${b.id}</th></tr></thead><tbody>${showKeys.map((k) => `<tr class="${this.hpAll && diffKeys.includes(k) ? "changed" : ""}"><td class="k" title="${esc(k)}">${esc(hpLabel(k))}</td><td class="v">${esc(a.hp[k] == null ? "–" : a.hp[k])}</td><td class="v">${esc(b.hp[k] == null ? "–" : b.hp[k])}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
      } else if (tab === "curves") {
        const famA = famVar(a), famB = famVar(b);
        body = `<section class="blk"><div class="blk-h"><h3>Validation loss</h3><div class="seg chart-tabs"><button type="button" data-act="curve" data-mode="tail" aria-pressed="${this.curveMode === "tail"}">End of run</button><button type="button" data-act="curve" data-mode="full" aria-pressed="${this.curveMode === "full"}">Full run</button></div></div>
            <div class="chart-key"><span><i style="background:${famA}"></i>#${a.id}</span><span><i class="ref"></i>#${b.id}</span></div><div id="curve-host"></div></section>
          <section class="blk"><div class="blk-h"><h3>Gap</h3><span class="aside">below zero means #${a.id} has lower loss</span></div>${gapChart(a, b)}</section>
          <section class="blk"><div class="blk-h"><h3>Every run at the claimed step</h3></div>${seedStrip([{ rec: a, color: famA }, { rec: b, color: famB }])}</section>`;
      } else {
        const fp = blockDiff(b, a, true);
        const changed = fp.entries.filter((e) => e.status && e.status !== "same");
        body = `<section class="blk"><div class="blk-h"><h3>Where the code differs</h3><span class="aside"><span class="a">+${fp.add}</span> <span class="d">${MINUS}${fp.del}</span> lines from #${b.id} to #${a.id}</span></div>
          <div class="actions" style="margin:0 0 12px"><button type="button" class="nav-btn primary" data-act="diff" data-a="${b.id}" data-b="${a.id}">Open the full diff</button></div>
          <div class="footprint">${changed.slice(0, 24).map((e) => `<button type="button" class="fp-row" data-act="diff" data-a="${b.id}" data-b="${a.id}" data-key="${esc(e.key)}"><span class="fp-ic">${kindIcon(e.kind)}</span><span class="fp-name">${entryLabel(e)}</span><span class="fp-stat">${entryStat(e)}</span></button>`).join("")}</div></section>`;
      }
      $("#inspector").innerHTML = `<div class="insp">${head}<div class="insp-body" role="tabpanel">${body}</div></div>`;
      if (tab === "curves") mountCurve($("#curve-host"), [{ rec: b, color: "var(--muted)", ref: true }, { rec: a, color: famVar(a) }], this.curveMode);
    },
  };
  function symKey(r, sym) {
    const s = String(sym).replace(/\(.*$/, "").replace(/^.*\./, "").trim();
    const hit = r.blocks.find((b) => b.name === s && b.k !== "code");
    return hit ? hit.key : "";
  }

  // =====================================================================
  // Search
  // =====================================================================
  const Search = {
    items: [],
    cur: -1,
    init() {
      const input = $("#search"), box = $("#search-results");
      this.input = input; this.box = box;
      input.addEventListener("input", () => this.run());
      input.addEventListener("focus", () => { if (input.value) this.run(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { this.move(1); e.preventDefault(); }
        else if (e.key === "ArrowUp") { this.move(-1); e.preventDefault(); }
        else if (e.key === "Enter") { this.choose(this.cur >= 0 ? this.cur : 0); e.preventDefault(); }
        else if (e.key === "Escape") { this.close(); input.blur(); }
      });
      box.addEventListener("mousedown", (e) => { const it = e.target.closest(".sr-item"); if (it) { e.preventDefault(); this.choose(+it.dataset.i); } });
      document.addEventListener("click", (e) => { if (!e.target.closest(".search")) this.close(); });
    },
    run() {
      const q = this.input.value.trim().toLowerCase();
      if (!q) { this.close(); return; }
      const res = [];
      const num = /^#?(\d+)$/.exec(q);
      for (const r of RECS) {
        let score = 0;
        if (num && +num[1] === r.id) score = 100;
        const name = r.short.toLowerCase();
        if (name.startsWith(q)) score = Math.max(score, 60);
        else if (name.includes(q)) score = Math.max(score, 45);
        const hay = (r.descText + " " + r.contribText + " " + ((r.edge && (r.edge.title + " " + r.edge.summary)) || "")).toLowerCase();
        if (!score && hay.includes(q)) score = 20;
        if (!score) for (const t of r.tech.keys()) if (techLabel(t).toLowerCase().includes(q)) { score = 12; break; }
        if (score) res.push({ type: "rec", id: r.id, score });
      }
      res.sort((x, y) => y.score - x.score || y.id - x.id);
      const techs = [];
      for (const t of TECHS.values()) {
        if (!RECS.some((r) => r.tech.has(t.id))) continue;
        const l = (t.label + " " + t.id + " " + (t.desc || "")).toLowerCase();
        if (l.includes(q)) techs.push({ type: "tech", id: t.id, score: t.label.toLowerCase().startsWith(q) ? 2 : 1 });
      }
      techs.sort((x, y) => y.score - x.score);
      this.items = res.slice(0, 8).concat(techs.slice(0, 6));
      this.cur = this.items.length ? 0 : -1;
      this.draw();
    },
    draw() {
      if (!this.items.length) { this.box.innerHTML = `<div class="sr-group">No matches</div>`; this.box.hidden = false; return; }
      let html = "", lastType = null;
      this.items.forEach((it, i) => {
        if (it.type !== lastType) { html += `<div class="sr-group">${it.type === "rec" ? "Records" : "Techniques (highlight on the tree)"}</div>`; lastType = it.type; }
        if (it.type === "rec") {
          const r = byId.get(it.id);
          html += `<div class="sr-item" role="option" data-i="${i}" aria-selected="${i === this.cur}"><span class="sr-id">#${r.id}</span><span>${esc(r.short)}</span><span class="sr-sub">${r.steps}</span></div>`;
        } else {
          const n = RECS.filter((r) => r.tech.has(it.id)).length;
          html += `<div class="sr-item" role="option" data-i="${i}" aria-selected="${i === this.cur}"><span class="sr-id">◇</span><span>${esc(techLabel(it.id))}</span><span class="sr-sub">${n} record${n === 1 ? "" : "s"}</span></div>`;
        }
      });
      this.box.innerHTML = html;
      this.box.hidden = false;
    },
    move(d) { if (!this.items.length) return; this.cur = (this.cur + d + this.items.length) % this.items.length; this.draw(); },
    choose(i) {
      const it = this.items[i];
      if (!it) return;
      if (it.type === "rec") select(it.id); else setLens({ type: "tech", id: it.id });
      this.close();
      this.input.blur();
    },
    close() { this.box.hidden = true; },
  };

  // =====================================================================
  // Views, theme, keyboard, boot
  // =====================================================================
  function setView(v) {
    if (!HAS_D3 && (v === "tree" || v === "timeline")) v = "outline";
    state.view = v;
    store.set("view", v);
    $$(".views button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    $("#view-tree").hidden = v !== "tree";
    $("#view-outline").hidden = v !== "outline";
    $("#view-timeline").hidden = v !== "timeline";
    $("#view-genome").hidden = v !== "genome";
    $("#view-memory").hidden = v !== "memory";
    Legend.sync();
    if (v === "memory") MemoryView.render();
    if (v === "timeline" && HAS_D3) TimelineView.render();
    if (v === "genome") GenomeView.render();
    if (v === "outline") OutlineView.sync(true);
    if (v === "tree" && HAS_D3 && !TreeView.placed) { TreeView.initialView(TreeView.introOK); TreeView.placed = true; }
  }
  $$(".views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  function effectiveDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function applyThemeChange() { readTheme(); if (HAS_D3) TreeView.colorNumbers(); }
  $("#theme-btn").addEventListener("click", () => {
    const next = effectiveDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    store.set("theme", next);
    applyThemeChange();
  });
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyThemeChange); } catch (e) { /* old browsers */ }
  try { new MutationObserver(applyThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch (e) { /* ignore */ }

  // resizable side panel (drag the divider, arrow keys when focused, double-click to reset)
  (function initSplitter() {
    const sp = $("#splitter"), main = $(".main");
    if (!sp || !main) return;
    const apply = (w) => main.style.setProperty("--insp-w", Math.round(w) + "px");
    const clampW = (w) => Math.max(360, Math.min(window.innerWidth * 0.72, w));
    const saved = store.get("inspW", null);
    if (saved) apply(clampW(saved));
    const cur = () => $("#inspector").getBoundingClientRect().width;
    let x0 = 0, w0 = 0;
    const move = (e) => apply(clampW(w0 - (e.clientX - x0)));
    const up = () => {
      sp.classList.remove("drag"); document.body.style.cursor = "";
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      store.set("inspW", Math.round(cur()));
      if (HAS_D3) TreeView.drawViewport();
    };
    sp.addEventListener("pointerdown", (e) => {
      x0 = e.clientX; w0 = cur();
      sp.classList.add("drag"); document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
      e.preventDefault();
    });
    sp.addEventListener("dblclick", () => { main.style.removeProperty("--insp-w"); store.set("inspW", null); });
    sp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      apply(clampW(cur() + (e.key === "ArrowLeft" ? 40 : -40)));
      store.set("inspW", Math.round(cur()));
      e.preventDefault(); e.stopPropagation();
    });
  })();

  const help = $("#help");
  $("#help-btn").addEventListener("click", () => { help.hidden = false; $("#help-close").focus(); });
  $("#help-close").addEventListener("click", () => { help.hidden = true; });
  help.addEventListener("click", (e) => { if (e.target === help) help.hidden = true; });

  function siblings(id) { const r = byId.get(id); return r.parent ? byId.get(r.parent).children : [id]; }
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    const typing = /INPUT|SELECT|TEXTAREA/.test(tag);
    if (e.key === "Escape") {
      if (!help.hidden) { help.hidden = true; return; }
      if (DiffUI.isOpen()) { DiffUI.close(); return; }
      if (typing) return;
      if (state.picking) { state.picking = false; update({ focus: false }); return; }
      if (state.cmp) { clearCompare(); return; }
      if (state.lens) { setLens(null); return; }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey) return;
    if (DiffUI.isOpen() || !help.hidden) return;
    const r = byId.get(state.sel);
    let handled = true;
    switch (e.key) {
      case "ArrowLeft": if (r.parent) select(r.parent); break;
      case "ArrowRight": { const c = bestChild(r); if (c) select(c); break; }
      case "ArrowUp":
      case "ArrowDown": {
        const d = e.key === "ArrowUp" ? -1 : 1;
        if (state.view === "outline") {
          const vis = OutlineView.visible; const i = vis.indexOf(state.sel);
          if (i >= 0 && vis[i + d] != null) select(vis[i + d]);
        } else {
          const sib = siblings(state.sel); const i = sib.indexOf(state.sel);
          if (sib[i + d] != null) select(sib[i + d]);
        }
        break;
      }
      case "j": if (byId.has(state.sel + 1)) select(state.sel + 1); break;
      case "k": if (byId.has(state.sel - 1)) select(state.sel - 1); break;
      case "c": if (state.cmp) clearCompare(); else if (r.parent) setCompare(r.parent); break;
      case "d": { const base = state.cmp || r.parent; if (base) DiffUI.open(base, state.sel); break; }
      case "1": setView("tree"); break;
      case "2": setView("outline"); break;
      case "3": setView("timeline"); break;
      case "4": setView("genome"); break;
      case "5": setView("memory"); break;
      case "f": if (state.view === "tree" && HAS_D3) TreeView.fit(true); break;
      case "/": $("#search").focus(); break;
      case "?": help.hidden = false; break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  function summaryLine() {
    const cur = RECS.filter((r) => r.wr).sort((a, b) => a.steps - b.steps)[0];
    const base = byId.get(36);
    const contributors = new Set();
    for (const r of RECS) (r.contrib.match(/>@?([^<]+)</g) || []).forEach((m) => contributors.add(m));
    const speed = base ? ((base.steps / cur.steps - 1) * 100).toFixed(1) : null;
    $("#summary-line").innerHTML = `<b>${RECS.length}</b> accepted results · best <b>#${cur.id}</b> reaches 3.28 val loss in <b>${cur.steps}</b> steps${speed ? `, a ${speed}% speedup over the tuned Muon baseline (#36, ${base.steps})` : ""}`;
    $("#help-source").innerHTML = `Data: <a href="${esc(META.source)}" target="_blank" rel="noopener">records/track_3_optimization</a> at commit <span class="mono">${esc(META.commit.slice(0, 7))}</span>. Scripts are taken from each record's official log; means and run counts come from the README table, with values recomputed from the logs shown when they differ. Summaries, technique tags and hyperparameter tables were written by reading each script and its diff against its parent.`;
  }

  function boot() {
    const saved = store.get("theme", null);
    if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    readTheme();
    const h = parseHash();
    if (h) { state.sel = h.sel; state.cmp = h.cmp; }
    summaryLine();
    Legend.init();
    DiffUI.init();
    Inspector.init();
    Search.init();
    OutlineView.init();
    if (HAS_D3) { TreeView.init(); TimelineView.init(); TreeView.introOK = !h; }
    else {
      $("#view-tree").innerHTML = `<p class="empty" style="padding:24px">The tree view needs the d3 library, which could not be loaded. The Outline and Genome views still work.</p>`;
      $("#view-timeline").innerHTML = `<p class="empty" style="padding:24px">The timeline needs the d3 library, which could not be loaded.</p>`;
    }
    setView(state.view);
    update({ focus: false });
    if (HAS_D3 && state.view === "tree" && !TreeView.placed) { TreeView.initialView(true); TreeView.placed = true; }
    if (h && h.diff) DiffUI.open(h.diff[0], h.diff[1]);
    window.addEventListener("hashchange", () => {
      const hh = parseHash();
      if (!hh) return;
      if (hh.diff) { DiffUI.open(hh.diff[0], hh.diff[1]); return; }
      if (hh.sel !== state.sel || hh.cmp !== state.cmp) { state.sel = hh.sel; state.cmp = hh.cmp; update({ focus: true }); }
    });
    let rt = null;
    try {
      new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (state.view === "timeline" && HAS_D3) TimelineView.render(); if (HAS_D3) TreeView.drawViewport(); }, 120); }).observe($("#stage"));
    } catch (e) { /* ignore */ }
  }
  boot();
})();
