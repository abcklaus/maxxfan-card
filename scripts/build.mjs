// Baut dist/maxxfan-card.js und setzt die Version aus package.json ein.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const src = readFileSync("src/maxxfan-card.js", "utf8").replace("__VERSION__", pkg.version);

mkdirSync("dist", { recursive: true });
writeFileSync("dist/maxxfan-card.js", src);
console.log(`dist/maxxfan-card.js (${(src.length / 1024).toFixed(1)} KB)`);
