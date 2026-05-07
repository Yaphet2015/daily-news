import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DIAGNOSTIC_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'TWITTER_PROXY',
  'ENABLED_SOURCES',
  'TERM_PROGRAM',
] as const;

const RESOLVED_COMMANDS = ['node', 'npm', 'twitter', 'curl'] as const;

type DiagnosticEnvKey = (typeof DIAGNOSTIC_ENV_KEYS)[number];
type ResolvedCommand = (typeof RESOLVED_COMMANDS)[number];

export interface EnvironmentFingerprint {
  cwd: string;
  execPath: string;
  argv: string[];
  ppid: number;
  parentCommand: string;
  path: string | undefined;
  resolvedCommands: Record<ResolvedCommand, string>;
  env: Record<DiagnosticEnvKey, string | undefined>;
  dataFiles: {
    stateJson: boolean;
    pendingDraftJson: boolean;
  };
}

interface EnvironmentFingerprintDeps {
  argv?: string[];
  cwd?: () => string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  fileExists?: (filepath: string) => Promise<boolean>;
  getParentCommand?: (ppid: number) => Promise<string>;
  ppid?: number;
  resolveCommand?: (name: string) => Promise<string>;
}

function firstLine(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? 'unknown error';
}

async function defaultResolveCommand(name: string): Promise<string> {
  const { stdout } = await execFileAsync('which', [name]);
  const resolved = String(stdout).trim();
  return resolved || '<not found>';
}

async function defaultGetParentCommand(ppid: number): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(ppid)]);
  const command = String(stdout).trim();
  return command || '<not found>';
}

async function defaultFileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

async function safeResolve(label: string, resolve: () => Promise<string>): Promise<string> {
  try {
    return await resolve();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<unavailable: ${label}: ${firstLine(message)}>`;
  }
}

export function shouldLogEnvironmentDiagnostics(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DAILY_NEWS_ENV_DIAGNOSTICS?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export async function buildEnvironmentFingerprint(
  deps: EnvironmentFingerprintDeps = {},
): Promise<EnvironmentFingerprint> {
  const cwd = deps.cwd?.() ?? process.cwd();
  const env = deps.env ?? process.env;
  const resolveCommand = deps.resolveCommand ?? defaultResolveCommand;
  const getParentCommand = deps.getParentCommand ?? defaultGetParentCommand;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const ppid = deps.ppid ?? process.ppid;

  const resolvedCommands = Object.fromEntries(
    await Promise.all(
      RESOLVED_COMMANDS.map(async (name) => [
        name,
        await safeResolve(name, () => resolveCommand(name)),
      ]),
    ),
  ) as Record<ResolvedCommand, string>;

  const diagnosticEnv = Object.fromEntries(
    DIAGNOSTIC_ENV_KEYS.map((key) => [key, env[key]]),
  ) as Record<DiagnosticEnvKey, string | undefined>;

  return {
    cwd,
    execPath: deps.execPath ?? process.execPath,
    argv: deps.argv ?? process.argv,
    ppid,
    parentCommand: await safeResolve('parent process', () => getParentCommand(ppid)),
    path: env.PATH,
    resolvedCommands,
    env: diagnosticEnv,
    dataFiles: {
      stateJson: await fileExists(path.join(cwd, 'data', 'state.json')),
      pendingDraftJson: await fileExists(path.join(cwd, 'data', 'pending-draft.json')),
    },
  };
}

export async function logEnvironmentDiagnostics(
  log: (message: string) => void = console.log,
  deps: EnvironmentFingerprintDeps = {},
): Promise<void> {
  const fingerprint = await buildEnvironmentFingerprint(deps);
  log(
    `[env:diagnostics] ${JSON.stringify(fingerprint, (_key, value) =>
      value === undefined ? null : value,
    )}`,
  );
}
