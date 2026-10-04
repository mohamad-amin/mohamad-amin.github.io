"""Assemble the single-file explorer in two flavours:
   - out/artifact.html : page content only (the Artifact host supplies doctype/head/body)
   - out/index.html    : a complete document for GitHub Pages
"""
import json
import os
import sys

WORK = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(WORK, "src")
OUT = os.path.join(WORK, "out")
os.makedirs(OUT, exist_ok=True)

TITLE = "Modded-NanoGPT Optimizer Lineage"
DESC = ("Interactive lineage tree of the modded-nanogpt Track 3 optimization records: what each record changed "
        "relative to its parent, technique genomes, hyperparameters, validation curves and structure-aware code diffs.")
D3 = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
FONTS = ("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800"
         "&family=Instrument+Sans:wght@400..700&family=JetBrains+Mono:wght@400;600&display=swap")

css = open(os.path.join(SRC, "app.css"), encoding="utf-8").read()
body = open(os.path.join(SRC, "body.html"), encoding="utf-8").read()
js = open(os.path.join(SRC, "app.js"), encoding="utf-8").read()
data = open(os.path.join(WORK, "data.json"), encoding="utf-8").read()
data_safe = data.replace("</", "<\\/").replace("<!--", "<\\!--")

head_bits = f"""<title>{TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<style>
{css}
</style>"""
scripts = f"""<script src="{D3}"></script>
<script type="application/json" id="lineage-data">{data_safe}</script>
<script>
{js}
</script>"""

artifact = f"{head_bits}\n{body}\n{scripts}\n"
open(os.path.join(OUT, "artifact.html"), "w", encoding="utf-8").write(artifact)

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="{DESC}">
{head_bits}
</head>
<body>
{body}
{scripts}
</body>
</html>
"""
open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page)
print(f"artifact.html {len(artifact)/1e6:.2f} MB, index.html {len(page)/1e6:.2f} MB")
