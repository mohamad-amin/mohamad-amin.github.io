# Analyst brief: modded-nanogpt Track 3 (optimization benchmark) record lineage

We are building an interactive explorer of the 46 accepted results ("records") of the
modded-nanogpt optimization track. Every record is a single self-contained PyTorch training
script for the *same* GPT-2-small architecture/data/batch size; only the optimizer, its
hyperparameters, schedules and initialization may change. The metric is the number of
steps needed to reach val loss 3.28 (lower is better).

Your job: for each record assigned to you, read its code, its diff against its parent, and
its docs, then write one JSON file with an accurate, information-dense analysis.
Accuracy matters more than prose: every claim must be grounded in the code you read.
Prefer exact constant values copied from code. Do not invent things. If the README
claim and the code disagree, say so in `parent_check` / `caveats`.

## Files (all paths relative to WORK = /tmp/claude-0/-home-user-mohamad-amin-github-io/df0d2291-046c-5f62-b377-24d78774fbdd/scratchpad/work)

- `table.md` — the README "Notable results history" table (id, steps, evidence, description, date, contributors) and lineage.
- `code/rec_XX.py` — the exact script of record XX (two-digit id), extracted from its official log.
- `diffs/cXX_pYY.diff` — unified diff from parent YY's script to child XX's script.
  `diffs/cXX_pZZ_nearest.diff` exists when the textually-closest earlier script ZZ differs from the declared parent YY.
- `readmes/rec_XX.md` — the record's own README / PR summary when one exists (very useful, but verify against code).
- `../modded-nanogpt/records/track_3_optimization/README.md` — the benchmark README (rules, active-techniques list for #46).

Tips: the scripts share a common skeleton (Dataloader / Architecture / Optimizer / Setup /
Init & Optim Hyperparams / Training and Validation). Changes concentrate in the Optimizer
and Hyperparams sections. Many later scripts gate techniques by module-level constants or
`os.environ.get(...)` defaults — a technique only counts as ACTIVE if its default
configuration actually enables it (e.g. `CONTRA_MUON_COEFF = 0` means Contra-Muon is OFF,
even if the function is still present). Distinguish real behavioral changes from
refactors, renamed variables, comments, logging, and dead code.

## Technique taxonomy (use these ids; add a new id only if truly needed, and list it in `new_technique_ids`)

Base optimizer for hidden (2-D block) matrices — exactly the ones that apply:
- `muon` Muon: momentum (Nesterov) → Newton–Schulz orthogonalization → aspect-ratio scale.
- `adam_hidden` Adam/AdamW on hidden matrices.
- `spectral_descent` Muon with mu=0 (no momentum).
- `muon_sq` Muon² (arXiv 2604.09967).
- `normuon` NorMuon: Adam-style per-neuron/row second-moment normalization of the orthogonalized update.
- `normuon_lite` "NorMuon-lite": Adafactor-style row/col variance normalization (Skylight-001 style), applied around NS.
- `newton_muon` Newton-Muon (activation-covariance right preconditioning).
- `pmuon` PMuon (bilateral streaming covariance power preconditioning).
- `muown` Muown (Muon with integrated row-norm control).
- `dynmuon` DynMuon.
- `shampoo` Shampoo (two-sided Kronecker preconditioner with root power).
- `one_sided_shampoo` One-sided Shampoo.
- `soap` SOAP (Adam in the Shampoo eigenbasis) used as the hidden optimizer.
- `kl_soap` KL-SOAP.
- `sinksoap` SinkSOAP (Gram–Sinkhorn SOAP-style preconditioning).
- `psgd_kron` PSGD with Kronecker whitening preconditioners.

Preconditioning add-ons on top of Muon:
- `soap_muon_mlp` SOAP-style preconditioning of the momentum before NS, MLP matrices only.
- `soap_muon_attn` SOAP-style preconditioning on (some) attention matrices, incl. trust gate.
- `soap_muon_all` SOAP-Muon on ALL hidden matrices.

Update shaping / geometry:
- `hyperball` hyperball constraint: hidden-matrix norms kept fixed (update projected/renormalized onto a sphere).
- `uw_floor` u/w floor: scale update up when ‖u‖_F/‖w‖_F < target (weight-decay-free).
- `row_floor` per-output-row u/w floor (RowUpdateFloor).
- `radial_brake` radial brake + radius rescale (dampen outward radial component; pin the norm).
- `cwd` Cautious Weight Decay.
- `contra_muon` Contra-Muon (subtract normalized raw-gradient component around the polar step).
- `soft_muon` Soft-Muon (soft/Schatten orthogonalization).
- `tempered_polar` Tempered-Polar.
- `aurora` Aurora leverage-uniform / row-balanced polar.
- `circuit_muon` Circuit-Muon (attention V/O per-head coupling).
- `soda_anchor` SODA-style anchor correction toward initialization.

Wrappers / outer loops:
- `muloco` MuLoCo outer Nesterov SGD.
- `ema_nesterov` EMA-Nesterov lookahead wrapper.
- `rre` RRE vector extrapolation.

Schedules:
- `linear_cooldown` stable-then-linear-decay LR schedule (baseline WSD style).
- `powercool` PowerCool power-law cooldown.
- `split_cooldown` different cooldown fractions for aux Adam vs hidden matrices.
- `lr_warmup` LR warmup.
- `mu_schedule` Muon momentum warmup and/or cooldown.
- `early_stop` the claimed step is earlier than the scheduled `train_steps` (evaluated mid-cooldown).

Initialization:
- `zero_proj_init` zero-initialized projection (output) weights.
- `per_module_init_std` per-module init std.
- `depth_scaled_fc_init` depth-scaled mlp.fc init.
- `cgi_gain_init` CGI / Rademacher paired RMSNorm-gain init.

Readout / late-training tricks (evaluation-time or last-steps weight transforms):
- `tail_refinterp` final step moves weights backward along an update-EMA.
- `fixed_ref_interp` capture reference weights at some step and interpolate/extrapolate at report time.
- `trail_delta` TrailDelta / BroadDelta endpoint pulses.
- `phase_readout` normalized orthogonal phase readout.
- `anchor_readout` final readout toward an earlier anchor checkpoint.
- `tail_ema` Tail-EMA: evaluate a blend of current weights and their EMA.

Auxiliary Adam (embedding / lm-head / 1-D params):
- `aux_adam` AdamW for embed/head/1-D params (baseline).
- `aux_beta2_split` per-family beta2 for aux params.

## Canonical hyperparameter keys (use these keys in `hparams` when applicable; values are strings copied from code)

- `steps.scheduled` (train_steps in code), `steps.claimed` (README step count)
- `hidden.optimizer` (name), `hidden.lr`, `hidden.wd`, `hidden.momentum`, `hidden.nesterov`, `hidden.ns_iters`, `hidden.beta2`, `hidden.eps`
- `aux.optimizer`, `aux.embed_lr`, `aux.head_lr`, `aux.scalar_lr`, `aux.betas`, `aux.eps`, `aux.wd`
- `schedule.kind`, `schedule.cooldown_frac` (or `schedule.hidden_cooldown_frac` / `schedule.aux_cooldown_frac`), `schedule.warmup_steps`, `schedule.power`, `schedule.end_step`
- `init.hidden_std`, `init.embed_std`, `init.proj`, `init.bias`, `init.gains`
- technique-specific: `<technique_id>.<param>` e.g. `uw_floor.target`, `contra_muon.coeff`, `soap_muon_all.precond_freq`, `ema_nesterov.gamma`, `tail_ema.horizon`, `cwd.coeff`.
Keep the dict focused (typically 10–30 keys): the knobs a researcher would want to compare.

## Output: one file per record at `analysis/rec_XX.json` (two-digit id), schema:

```json
{
  "id": 16,
  "parent": 14,
  "short_name": "≤ 22 chars node label, e.g. 'SOAP-attn trust gate'",
  "edge": {
    "title": "≤ 70 chars: what this record changes relative to its parent",
    "summary": "2–4 sentences: what changed vs the parent, and the mechanism/intuition. Precise, no hype.",
    "changes": [
      {"type": "added|removed|modified|tuned|refactor", "label": "≤ 40 chars", "detail": "1–2 sentences grounded in code", "symbols": ["function_or_class_or_constant names"]}
    ],
    "hparams_changed": [ {"key": "hidden.lr", "label": "Muon lr", "from": "0.025", "to": "0.035"} ],
    "techniques_added": ["..."], "techniques_removed": ["..."], "techniques_modified": ["..."],
    "parent_check": "consistent | or a short note if the code suggests a different base",
    "noise": "short note on refactor/cosmetic-only parts of the diff a reader can ignore (or empty)"
  },
  "techniques": [ {"id": "muon", "note": "≤ 100 chars detail specific to this record (values, scope)"} ],
  "hparams": { "hidden.lr": "0.025" },
  "mechanisms": [
    {"id": "technique id introduced/first seen in this record", "name": "Display name", "explain": "2–3 sentences: how it works in this code", "symbols": ["muon_update"]}
  ],
  "caveats": "anything uncertain or contradictory (or empty)",
  "new_technique_ids": []
}
```

Rules: `changes` should cover every behaviorally relevant change (ordered by importance; 2–10 items). Put pure refactors in at most one `refactor` item. `techniques` is the FULL list of what is active in this record (not just the delta). `mechanisms` only for techniques that this record introduces into its lineage (can be empty). Validate each file with `python3 -c "import json;json.load(open(PATH))"`. Do not modify any other files.
