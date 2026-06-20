#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const a1AiCoreRepo = "https://github.com/SamStep74/A1-AI-Core.git";
const a1AiCoreRef = "f917e8a1fd72d48d6e227300a0c069c70ace6f1e";

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function a1AiCacheDir() {
  if (process.env.A1_AI_CORE_CACHE_DIR) {
    return path.resolve(process.env.A1_AI_CORE_CACHE_DIR, a1AiCoreRef);
  }
  const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "a1-ai-core", a1AiCoreRef);
}

function ensureCachedA1AiCore() {
  const target = a1AiCacheDir();
  if (!existsSync(path.join(target, "package.json"))) {
    mkdirSync(path.dirname(target), { recursive: true });
    runGit(["clone", "--depth", "1", a1AiCoreRepo, target]);
  }
  runGit(["fetch", "--depth", "1", "origin", a1AiCoreRef], { cwd: target });
  runGit(["checkout", "--detach", a1AiCoreRef], { cwd: target });
  const actualRef = runGit(["rev-parse", "HEAD"], { cwd: target });
  if (actualRef !== a1AiCoreRef) {
    throw new Error(`A1-AI-Core cache is at ${actualRef}, expected ${a1AiCoreRef}`);
  }
  return target;
}

function loadA1Ai() {
  const candidates = [
    process.env.A1_AI_CORE_PATH && path.resolve(process.env.A1_AI_CORE_PATH),
    "@a1/ai",
    path.resolve(repoRoot, "..", "..", "A1-AI-Core"),
    path.resolve(repoRoot, "..", "A1-AI-Core"),
  ].filter(Boolean);
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
  const bootstrapped = ensureCachedA1AiCore();
  const mod = require(bootstrapped);
  if (typeof mod.runProductResearchCli !== "function") {
    throw new Error(`${bootstrapped} does not export runProductResearchCli`);
  }
  return mod;
}

const { runProductResearchCli } = loadA1Ai();
const exitCode = await runProductResearchCli({
  repoRoot,
  argv: process.argv.slice(2),
  env: process.env,
});
if (exitCode) process.exitCode = exitCode;
