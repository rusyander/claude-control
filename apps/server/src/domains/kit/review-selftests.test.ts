import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Самопроверки инструментов deep-review из набора (план полос, свип, сборка отчёта, стенд посева дефектов, карточки для
 * публикации на форже) — перенесённые из личного слоя тесты, запущенные против инструментов НАБОРА: путь к каждому инструменту
 * передаётся через окружение, так что мутант набора (AGENTDECK_KIT_UNDER_TEST) проверяется теми же тестами.
 * Самопроверка печатает «ok»/«FAIL» на проверку и «N passed, M failed» в конце; код выхода 1 — хоть одна красная.
 */

const KIT = process.env.AGENTDECK_KIT_UNDER_TEST || builtinKitDir();
const SELFTESTS = join(import.meta.dirname, '__fixtures__', 'review-selftests');
const tool = (name: string) => join(KIT, 'tools', name);

function selftest(name: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      REVIEW_PLAN_TOOL: tool('review-plan.mjs'),
      REVIEW_SWEEP_TOOL: tool('review-sweep.mjs'),
      REVIEW_MERGE_TOOL: tool('review-merge.mjs'),
      REVIEW_BENCH_TOOL: tool('review-bench.mjs'),
      REVIEW_PUBLISH_TOOL: tool('review-publish.mjs'),
    };
    const child = spawn(process.execPath, [join(SELFTESTS, name)], { env });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('close', (code) => done({ code, out }));
  });
}
const failures = (out: string) => out.split('\n').filter((l) => l.startsWith('FAIL  '));
const passed = (out: string) => Number(/(\d+) passed, (\d+) failed/.exec(out)?.[1] ?? 0);

describe('самопроверки инструментов deep-review против набора', () => {
  // Нижняя граница — число проверок сейчас: самопроверка, у которой молча пропала часть, тоже красная.
  it.each([
    ['review-plan.selftest.mjs', 199],
    ['review-sweep.selftest.mjs', 85],
    ['review-merge.selftest.mjs', 73],
    ['review-bench.selftest.mjs', 106],
    ['review-publish.selftest.mjs', 28],
  ])(
    '%s — код 0, ни одной красной, не меньше %i проверок',
    async (name, floor) => {
      const { code, out } = await selftest(name);
      expect(failures(out), out.slice(-2000)).toEqual([]);
      expect(code, out.slice(-2000)).toBe(0);
      expect(passed(out)).toBeGreaterThanOrEqual(floor);
    },
    300_000,
  );
});
