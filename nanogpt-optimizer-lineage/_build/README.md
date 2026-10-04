# Optimizer Lineage: build pipeline

This folder generates `../index.html`, the interactive explorer of the
[modded-nanogpt Track 3 optimization records](https://github.com/KellerJordan/modded-nanogpt/tree/master/records/track_3_optimization).
Jekyll does not publish folders whose names start with `_`, so nothing here ships with the site.

## Rebuild

```bash
cd nanogpt-optimizer-lineage/_build
git clone https://github.com/KellerJordan/modded-nanogpt.git   # or point MODDED_NANOGPT at a checkout
npm install --no-save marked@12.0.2                             # markdown → HTML for the per-record docs
python3 extract.py      # records_raw.json, pairdist.json, nearest.json (scripts, seed stats, curves, docs)
python3 reconcile.py    # analysis/ → analysis_final/ (consistent technique tags and deltas)
python3 build.py        # data.json
python3 make_html.py    # out/index.html (site) and out/artifact.html (body-only variant)
cp out/index.html ../index.html
```

`extract.py` checks the mean val loss it recomputes from the raw seed logs against the README table and
prints `<-- CHECK` where they disagree (3 of 46 records at the time of writing; the README values are shown
in the page, with the recomputed ones noted when they differ).

## What lives where

| File | Role |
| - | - |
| `lineage.py` | Parent of every record (declared in the README, or inferred from code + chronology) and borrowed-idea links |
| `analysis/rec_XX.json` | Per-record annotations: change summary vs parent, technique genome, hyperparameters, mechanisms, caveats. Written by reading each script and its diff against its parent, following `BRIEF.md` |
| `reconcile.py` | Applies one set of tagging rules across all records and recomputes each edge's added/removed techniques from the genomes |
| `structure.py` | Splits a script into sections, functions, classes and per-section code, which the structure-aware diff matches by name |
| `build.py` | Code-line dictionary, block structure, curves, sanitized docs, families and taxonomy → `data.json` |
| `src/` | The page: `app.css`, `body.html`, `app.js` (vanilla JS + d3 from jsDelivr) |

## Adding a new record

1. Pull the latest modded-nanogpt and re-run `extract.py`. New rows of the README table are picked up automatically.
2. Add the record's parent to `lineage.py`.
3. Write `analysis/rec_XX.json` following the schema in `BRIEF.md`.
4. If the record belongs to a new family, add it to `FAMILY_OF` in `build.py`. Then run the rest of the steps above.
