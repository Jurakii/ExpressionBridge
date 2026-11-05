// Copies the Maya module into resources/maya-module so the VSIX carries it (see `prepackage`).
const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "..", "maya", "MayaExpressionBridge");
const target = path.join(__dirname, "..", "resources", "maya-module");

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc"),
});
console.log(`Bundled ${source} -> ${target}`);
