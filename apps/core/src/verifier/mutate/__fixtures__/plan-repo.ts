import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MutantPlanRow } from '@agentdeck/contracts/core/records';
import { expect } from 'vitest';
import type { TestRunner, TestRunOutcome } from '../mutate.types.ts';

/** Общий образец тестов мутанта: репозиторий с одним исходником, подставной раннер, строка плана. */

export const SOURCE = 'export const add = (a, b) => a + b;\n';

// Репозитории — в temp прогона (vitest.temp-sandbox.ts): каталог уходит целиком в конце набора.
export function repo(source: string = SOURCE): string {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0);
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'sum.mjs'), source);
  return dir;
}

export const stateDir = (dir: string): string => join(dir, '.git', 'mustfail');
export const journals = (dir: string): string[] =>
  existsSync(stateDir(dir))
    ? readdirSync(stateDir(dir)).filter((n) => n.startsWith('journal-'))
    : [];

export const scopeOf = (dir: string): string =>
  spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
    .stdout.trim()
    .replace(/\\/g, '/')
    .toLowerCase();

/** Подставной раннер: судит по тексту исходника, как настоящий тест судил бы по поведению. */
export function fakeRunner(
  dir: string,
  judge: (source: string) => TestRunOutcome,
  seen: string[] = [],
): TestRunner {
  return {
    run: async () => {
      const source = readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8');
      seen.push(source);
      return judge(source);
    },
  };
}

export const ran = (
  status: 'passed' | 'failed' | 'skipped',
  fileErrors: string[] = [],
): TestRunOutcome => ({
  kind: 'ran',
  tests: [{ path: 'sum > adds', status }],
  fileErrors,
  exit: status === 'passed' ? 0 : 1,
});

export const byBehaviour = (source: string): TestRunOutcome => {
  if (source.includes('SYNTAX('))
    return { kind: 'ran', tests: [], fileErrors: ['sum.test.mjs: SyntaxError'], exit: 1 };
  return ran(source.includes('a - b') ? 'failed' : 'passed');
};

export const row = (find: string, replace: string, test = 'sum > adds'): MutantPlanRow => ({
  file: 'src/sum.mjs',
  find,
  replace,
  test,
  spec: 'sum.test.mjs',
});
