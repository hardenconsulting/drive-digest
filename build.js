const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "dist");

esbuild.buildSync({
  entryPoints: ["src/index.ts"],
  outfile: "dist/bundle.js",
  bundle: true,
  format: "iife",
  target: "es2020",
  // Top-level functions so the Apps Script editor can list/run them.
  footer: {
    js: [
      "function runDailyBriefing(){ return globalThis.__gasExports.runDailyBriefing(); }",
      "function installDailyTrigger(){ return globalThis.__gasExports.installDailyTrigger(); }",
      "function showBriefingConfig(){ return globalThis.__gasExports.showBriefingConfig(); }",
    ].join("\n"),
  },
});

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(
  path.join(__dirname, "src", "appsscript.json"),
  path.join(distDir, "appsscript.json"),
);

console.log("Build fertig: dist/bundle.js, Manifest nach dist/ kopiert.");
