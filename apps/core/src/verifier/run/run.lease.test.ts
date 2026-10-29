import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckEntry } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import { runCheck } from './run.ts';
import type { RunDeps, RunSpec } from './run.types.ts';
import { verdictOf } from './verdict.ts';

/**
 * Прогон под арендой: удар сердца, который бросил (B1r3-F01, A1r3-F04), — не причина ронять ядро,
 * и команда репозитория `./gradlew` ищется в копии, а не в каталоге ядра (B1r3-F02). Настоящий
 * дочерний node; подставлены только эпоха стенда и удар аренды.
 */

const CHILD = fileURLToPath(new URL('./__fixtures__/child.mjs', import.meta.url));
const roots: string[] = [];
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'adk-runl-'));
  roots.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const ENTRY: CheckEntry = {
  id: 'unit-tests',
  class: 'test-runner',
  argv: ['vitest', 'run'],
  cwd: '',
  unit: 'package',
  requiredAt: ['publish'],
  baseDependent: false,
  inputs: [],
  envAllow: [],
  tools: [],
  artifacts: [],
  needs: [],
  source: 'detected',
};

function pinned(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function spec(argv: string[], cwd = root()): RunSpec {
  return {
    checkRunId: `run-${Math.random().toString(16).slice(2)}`,
    taskId: 'task-1',
    entry: ENTRY,
    argv,
    cwd,
    env: pinned(),
    tempRoot: join(cwd, 'tmp'),
    deadlineMs: 60_000,
  };
}

const deps: RunDeps = { now: Date.now, standEpoch: () => 7, graceMs: 300 };

describe('check runner lease and command resolution (B1r3-F01, B1r3-F02)', () => {
  it('a heartbeat that throws is an unknown beat: the run goes on to its own exit, the core lives', async () => {
    let beats = 0;
    const result = await runCheck(
      spec([process.execPath, '-e', 'setTimeout(() => process.exit(0), 2500)']),
      {
        leaseId: 'lease-throw',
        beatMs: 50,
        heartbeat: () => {
          beats += 1;
          throw new Error('EPERM: operation not permitted, rename lease');
        },
      },
      deps,
    );
    expect(beats).toBeGreaterThan(2);
    expect(result.end).toBe('exit');
    expect(verdictOf(result)).toEqual({ kind: 'pass' });
  }, 30_000);

  it('a relative command (`./tool`) resolves inside the copy (cwd), never against the core cwd', async () => {
    const copy = root();
    // Скрипт репозитория: node-скрипт с шебангом — запускается без оболочки на любой ОС.
    writeFileSync(join(copy, 'tool.mjs'), `#!/usr/bin/env node\n${readFileSync(CHILD, 'utf8')}`);
    chmodSync(join(copy, 'tool.mjs'), 0o755);
    const result = await runCheck(
      spec(['./tool.mjs', 'env', '0'], copy),
      {
        leaseId: 'lease-rel',
        beatMs: 1_000,
        heartbeat: () => 'ok',
      },
      deps,
    );
    expect(result.reason).toBeUndefined();
    expect(result.end).toBe('exit');
    expect(result.log).toMatch(/"lease":"lease-rel"/);
  }, 30_000);

  it('A1r2-F04 a red run carries the runner own failed count beside the parsed names', async () => {
    const s = spec([
      process.execPath,
      '-e',
      "console.log(' FAIL  a.test.ts > a > one\\n      Tests  2 failed | 1 passed (3)'); process.exit(1)",
    ]);
    const result = await runCheck(
      { ...s, entry: { ...ENTRY, filter: { kind: 'vitest', argv: ['-t', '{names}'] } } },
      { leaseId: 'lease-count', beatMs: 1_000, heartbeat: () => 'ok' },
      deps,
    );
    expect(result.end).toBe('exit');
    expect(result.failedCount).toBe(2);
    // Разобрано меньше, чем упало, — это и видит флаки.
    expect(result.failing.length).toBeLessThan(2);
  }, 30_000);

  // A2-F03 (решение владельца): оболочки у ядра нет — `./gradlew.bat` не запускается, и это
  // no-verdict(env) с подсказкой в журнале записи, никогда fail(red) и не падение.
  it.runIf(process.platform === 'win32')(
    'A2-F03 a batch wrapper is refused: no-verdict(env), the record log names the way out',
    async () => {
      const copy = root();
      writeFileSync(join(copy, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
      const result = await runCheck(
        spec(['./gradlew.bat', 'check'], copy),
        { leaseId: 'lease-bat', beatMs: 1_000, heartbeat: () => 'ok' },
        deps,
      );
      expect(result.end).toBe('spawn-failed');
      expect(verdictOf(result)).toEqual({ kind: 'no-verdict', reason: 'env' });
      expect(result.log).toMatch(/not started: .*gradlew\.bat/);
      expect(result.log).toMatch(/put the tool itself in PATH .*or run the wrapper yourself/);
    },
    30_000,
  );
});
