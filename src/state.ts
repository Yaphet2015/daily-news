import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunState } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', 'data', 'state.json');

export async function readState(): Promise<RunState> {
  if (!existsSync(STATE_PATH)) {
    return { lastRunTime: 0 };
  }
  const raw = await readFile(STATE_PATH, 'utf-8');
  return JSON.parse(raw) as RunState;
}

export async function writeState(state: RunState): Promise<void> {
  const dir = dirname(STATE_PATH);
  await mkdir(dir, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}
