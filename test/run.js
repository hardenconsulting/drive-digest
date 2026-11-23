const esbuild = require("esbuild");
const { spawnSync } = require("child_process");
const path = require("path");

const outfile = path.join(__dirname, "../.test-dist/briefingLogic.js");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../src/briefingLogic.ts")],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
});

const result = spawnSync(
  process.execPath,
  ["--test", path.join(__dirname, "logic.test.js")],
  { stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
