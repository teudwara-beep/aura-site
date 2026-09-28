"use strict";
const fs = require("node:fs");
const path = require("node:path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate HTML IDs: ${[...new Set(duplicates)].join(", ")}`);
if ((html.match(/<main\b/gi) || []).length !== 1) throw new Error('The site should have one main landmark.');
for (const asset of ["./css/styles.css", "./js/app.js", "./assets/favicon.svg", "./manifest.webmanifest"]) {
  if (!html.includes(asset)) throw new Error(`Missing asset reference: ${asset}`);
}
for (const asset of ["css/styles.css", "js/app.js", "assets/favicon.svg", "manifest.webmanifest"]) {
  if (!fs.existsSync(path.join(__dirname, "..", asset))) throw new Error(`Missing file: ${asset}`);
}
if (/<style\b/i.test(html) || /<script\s*>(?!\s*<)/i.test(html)) {
  throw new Error("Inline style/script block found; keep page code in separate files.");
}
console.log(`HTML checks passed (${ids.length} unique IDs; CSS, JavaScript, and manifest files found).`);
