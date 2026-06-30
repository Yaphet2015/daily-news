#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = '/Users/suosuo/workspace/personal/daily-news';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimePath = path.join(__dirname, 'runtime.mjs');

function resolveRepoRoot() {
  if (process.env.DAILY_NEWS_REPO?.trim()) {
    return path.resolve(process.cwd(), process.env.DAILY_NEWS_REPO.trim());
  }
  return DEFAULT_REPO_ROOT;
}

function resolveTsxLoader(repoRoot) {
  const require = createRequire(path.join(repoRoot, 'noop.cjs'));
  return require.resolve('tsx', { paths: [repoRoot] });
}

function run() {
  const repoRoot = resolveRepoRoot();
  let tsxLoader;

  try {
    tsxLoader = resolveTsxLoader(repoRoot);
  } catch (error) {
    console.error(
      `daily-news agent could not resolve repo-local tsx from ${repoRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, ['--import', tsxLoader, runtimePath, ...process.argv.slice(2)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DAILY_NEWS_REPO: repoRoot,
    },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`daily-news agent stopped by signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

run();
