// Render markdown snippets to HTML with marked (GFM). Input/output: JSON {key: markdown} -> {key: html}
const fs = require("fs");
const path = require("path");
let marked;
try { ({ marked } = require(path.join(__dirname, "node_modules", "marked"))); }
catch (e) { ({ marked } = require("marked")); }  // falls back to NODE_PATH
marked.setOptions({ gfm: true, breaks: false });
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = {};
for (const [k, v] of Object.entries(input)) {
  out[k] = k.startsWith("inline:") ? marked.parseInline(v) : marked.parse(v);
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
