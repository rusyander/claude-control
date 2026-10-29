import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCmdShim } from '../../../platform/__fixtures__/shims.ts';

/**
 * Подставной CLI под настоящим именем на PATH: `replay-cli.mjs` за обёрткой npm (Windows) или
 * исполняемым скриптом с shebang (POSIX) — переходник находит его тем же разрешением команды,
 * что и живой CLI.
 */

export const REPLAY_CLI = fileURLToPath(new URL('./replay-cli.mjs', import.meta.url));

/** Записи живых CLI рядом с их переходниками (`adapters/<cli>/__fixtures__`). */
export function fixturePath(cli: string, name: string): string {
  return fileURLToPath(new URL(`../../${cli}/__fixtures__/${name}.jsonl`, import.meta.url));
}

export function installReplay(binDir: string, command: string): void {
  if (process.platform === 'win32') {
    const pkg = join(binDir, 'node_modules', 'replay-cli');
    mkdirSync(pkg, { recursive: true });
    copyFileSync(REPLAY_CLI, join(pkg, 'cli.mjs'));
    writeFileSync(join(binDir, `${command}.cmd`), npmCmdShim('node_modules\\replay-cli\\cli.mjs'));
    return;
  }
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, command);
  writeFileSync(script, readFileSync(REPLAY_CLI, 'utf8'));
  chmodSync(script, 0o755);
}

export interface ReplayRun {
  fixture?: string;
  dump: string;
  stderr?: string;
  exit?: number;
  eager?: boolean;
}

/** Переменные проигрыша — в закреплённое окружение сеанса. */
export function replayEnv(run: ReplayRun): Record<string, string> {
  return {
    ...(run.fixture ? { REPLAY_FIXTURE: run.fixture } : {}),
    REPLAY_DUMP: run.dump,
    ...(run.stderr === undefined ? {} : { REPLAY_STDERR: run.stderr }),
    ...(run.exit === undefined ? {} : { REPLAY_EXIT: String(run.exit) }),
    ...(run.eager ? { REPLAY_EAGER: '1' } : {}),
  };
}

export interface ReplayDump {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: Record<string, unknown>[];
}

export function readDump(file: string): ReplayDump | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ReplayDump;
}
