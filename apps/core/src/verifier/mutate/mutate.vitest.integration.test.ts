import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPlan } from './run.ts';
import { findVitestEntry, vitestRunner } from './vitest-runner.ts';

/**
 * Самопроверка мутанта на настоящем vitest (план зоны B: killed / survived / not-applied /
 * baseline-red): одноразовый репозиторий в temp, тесты без импорта vitest (`--globals`), раннер —
 * тот же vitest, что у ядра. Судит json-отчёт: убит = названный тест упал на своём утверждении.
 */

const SOURCE = [
  'export const add = (a, b) => a + b;',
  'export const mul = (a, b) => a * b;',
  '',
].join('\n');
const SPEC = [
  "import { add, mul } from './src/sum.mjs';",
  "describe('sum', () => {",
  "  it('adds', () => { expect(add(1, 2)).toBe(3); });",
  "  it('weak', () => { expect(typeof mul(2, 3)).toBe('number'); });",
  "  it('red', () => { expect(add(1, 1)).toBe(3); });",
  '});',
  '',
].join('\n');

describe('verifier/mutate on real vitest', () => {
  it('a throwaway repo: killed, survived, not-applied, baseline-red and a non-compiling mutant (survived, named) — file restored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mut-int-'));
    expect(spawnSync('git', ['init', '-q'], { cwd: dir }).status).toBe(0);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'sum.mjs'), SOURCE);
    writeFileSync(join(dir, 'sum.test.mjs'), SPEC);
    const here = dirname(fileURLToPath(import.meta.url));
    const entry = findVitestEntry(here);
    expect(entry).toBeDefined();
    const row = (find: string, replace: string, test: string) => ({
      file: 'src/sum.mjs',
      find,
      replace,
      test,
      spec: 'sum.test.mjs',
    });
    const results = await runPlan(
      [
        row('a + b', 'a - b', 'sum > adds'),
        row('a * b', 'a + b', 'sum > weak'),
        row('no such text', 'x', 'sum > adds'),
        row('a * b', 'a / b', 'sum > red'),
        row('a + b;', 'a + ;', 'sum > adds'),
      ],
      { root: dir, runner: vitestRunner({ entry: entry ?? '', extraArgs: ['--globals'] }) },
    );
    expect(results.map((r) => [r.outcome, r.detail.split(':')[0]])).toEqual([
      ['killed', 'упал'],
      ['survived', 'тест зелёный с мутантом (exit 0)'],
      ['not-applied', 'find встречается 0 раз, нужно ровно 1'],
      ['baseline-red', 'красный без мутации'],
      ['survived', 'не убит тестом'],
    ]);
    expect(readFileSync(join(dir, 'src', 'sum.mjs'), 'utf8')).toBe(SOURCE);
  }, 180_000);
});
