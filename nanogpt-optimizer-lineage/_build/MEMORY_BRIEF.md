# Analyst brief: optimizer-state memory of each Track 3 record

Goal: for each assigned record, measure how much persistent optimizer-side state the training
procedure keeps, as a multiple of the number of parameters it applies to, so the explorer can show
"Muon = 1×, Adam = 2×, …" and group records by memory category.

WORK = /tmp/claude-0/-home-user-mohamad-amin-github-io/df0d2291-046c-5f62-b377-24d78774fbdd/scratchpad/work

Inputs (read-only):
- `code/rec_XX.py` — the exact script of record XX (two-digit id).
- `analysis_final/rec_XX.json` — an existing, code-grounded analysis of the record (techniques, hparams,
  mechanisms, caveats). Its `caveats`/`parent_check` say when the run configuration differs from the
  script defaults (settings passed as environment variables). Count the state of the configuration that
  actually ran, exactly as that analysis does.
- `../modded-nanogpt/records/track_3_optimization/results/20260513_shampoo_1_4_power/distributed_shampoo/`
  — the Shampoo library that records #21 and #35 import (read it to know what state it allocates for the
  logged configuration).

## The model (identical in every record)

| Parameters | Shape | Count |
| - | - | - |
| attn.q, attn.k, attn.v, attn.proj weights (×12 blocks) | 768×768 each | 589,824 each |
| mlp.fc weight (×12) | 3072×768 | 2,359,296 |
| mlp.proj weight (×12) | 768×3072 | 2,359,296 |
| **Hidden matrices total H** | 72 matrices | **84,934,656** |
| embed.weight | 50304×768 | 38,633,472 |
| proj.weight (LM head) | 50304×768 | 38,633,472 |
| 1-D params (all biases, RMSNorm gains) | vectors | ≈153,216 |
| **Auxiliary total A** (embed + head + 1-D) | | **≈77,420,160** |
| **All parameters P = H + A** | | **≈162,354,816** |

Useful ratios: the 48 attention matrices are 1/3 of H, the 24 MLP matrices are 2/3 of H.
A Kronecker factor of size d×d for a matrix with d rows/cols: for a 768×768 matrix each side factor is 1×
that matrix; for a 768×3072 (or 3072×768) matrix the 3072-side factor is 4× the matrix and the 768-side
factor is 0.25× the matrix.

## What to count

Count every tensor that persists across steps and is kept for the optimization procedure:
optimizer state (momentum, second moments, Kronecker/covariance factors, eigenbases, inverse roots or
whitening matrices, grafting states), wrapper/outer-loop state (outer momentum, anchors, snapshots of
weights, EMA of weights or of updates, RRE checkpoint histories), and readout copies (reference weights,
tail EMA). Count elements, not bytes (ignore dtype, but mention bf16/fp32 in `notes` when it matters).

Ignore: anything O(rows + cols) per matrix or smaller (row/column statistics such as NorMuon or Adafactor
vectors, scalars, norms), and temporaries that only live inside one step. Ignore the model weights and
gradients themselves.

If a buffer exists only for part of the run (for example a tail EMA that starts at step 2400), count it
(peak memory) and set `"when": "late, from step N"`.

## How to express it

- `hidden_x`: total counted state that applies to the hidden matrices, divided by H. Compute matrix-shaped
  statistics exactly from the shapes above and the set of matrices they apply to (e.g. SOAP on MLP only →
  its factors cover only the 24 MLP matrices). Round to 2 decimals.
- `components`: the breakdown of `hidden_x` (each component's own multiple of H; they must sum to
  `hidden_x` up to rounding). `kind` is one of:
  `momentum` (first-moment / momentum / EMA-of-gradient buffers),
  `second_moment` (elementwise second-moment buffers, e.g. Adam v, SOAP v in the eigenbasis),
  `preconditioner` (Kronecker factors, covariance or Gram statistics, PSGD Q factors, inverse roots),
  `eigenbasis` (stored eigenvector matrices),
  `weight_copy` (EMA of weights, snapshots, anchors, reference weights, outer-loop copies, checkpoint histories),
  `other`.
- `aux_x`: counted state on the auxiliary parameters (embed + head + 1-D), divided by A (AdamW m and v → 2.0;
  add any wrapper copies that also cover them, e.g. an EMA over all parameters adds 1.0 there too).
- `total_x`: (hidden_x · H + aux_x · A) / P, rounded to 2 decimals.

Example, the baseline (#1): Muon keeps one momentum buffer per hidden matrix → hidden_x = 1.0 with one
component {"name": "Muon momentum", "kind": "momentum", "x": 1.0}; aux AdamW keeps m and v → aux_x = 2.0;
total_x = (1.0·H + 2.0·A)/P = 1.48.

## Output: `memory/rec_XX.json` (two-digit id), exactly this shape

```json
{
  "id": 1,
  "hidden_x": 1.0,
  "components": [
    {"name": "Muon momentum", "kind": "momentum", "x": 1.0, "applies_to": "all 72 hidden matrices", "when": "always"}
  ],
  "aux_x": 2.0,
  "aux_note": "AdamW m and v on embedding, LM head and 1-D params",
  "total_x": 1.48,
  "notes": "≤ 2 sentences: anything a reader should know (e.g. state in bf16, a buffer allocated but unused, ignored small vectors)",
  "evidence": ["short pointers into the code, e.g. 'Muon.step: state[\"momentum\"] = torch.zeros_like(p)'"]
}
```

Be exact and grounded: name the code that allocates each buffer in `evidence`. If something is ambiguous
(e.g. a library default you cannot fully confirm), make the best reading and say so in `notes`.
Validate each file with python3 (json.load; components sum ≈ hidden_x within 0.02; total_x formula).
Do not modify any other file.
