#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadA1Ai() {
  const candidates = [
    "@a1/ai",
    path.resolve(repoRoot, "..", "..", "A1-AI-Core"),
    path.resolve(repoRoot, "..", "A1-AI-Core"),
  ];
  for (const candidate of candidates) {
    try {
      const mod = require(candidate);
      if (typeof mod.runProductResearchCli !== "function") {
        throw new Error(`${candidate} does not export runProductResearchCli`);
      }
      return mod;
    } catch (error) {
      const missingSelf = error
        && error.code === "MODULE_NOT_FOUND"
        && (error.message || "").includes(`'${candidate}'`);
      if (!missingSelf) throw error;
    }
  }
  throw new Error("Cannot load @a1/ai product research runner. Install @a1/ai or keep A1-AI-Core as a nearby checkout.");
}

const { runProductResearchCli } = loadA1Ai();
const exitCode = await runProductResearchCli({
  repoRoot,
  argv: process.argv.slice(2),
  env: process.env,
});
if (exitCode) process.exitCode = exitCode;
