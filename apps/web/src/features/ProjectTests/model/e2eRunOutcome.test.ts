import { describe, it, expect } from 'vitest';
import type { ProjectTestE2eRun } from '@agentdeck/contracts';
import { e2eRunOutcome } from './e2eRunOutcome';

/** Ключ и подстановки вместо перевода: проверяем, какую фразу выбрал итог. */
const t = (key: string, params?: Record<string, unknown>): string =>
  params && Object.keys(params).length > 0 ? `${key} ${JSON.stringify(params)}` : key;

const run = (patch: Partial<ProjectTestE2eRun>): ProjectTestE2eRun => ({
  status: 'done',
  command: 'npx --no-install playwright test --reporter=list,junit',
  startedAt: '2026-09-27T10:00:00.000Z',
  finishedAt: '2026-09-27T10:01:00.000Z',
  log: '',
  runId: 'run-1',
  exitCode: 0,
  imported: { read: 3, matched: 3, unmatched: 0 },
  summary: { total: 3, passed: 3, failed: 0, skipped: 0, blocked: 0 },
  ...patch,
});

describe('e2eRunOutcome', () => {
  it('идёт или не было — итога нет', () => {
    expect(e2eRunOutcome(undefined, t)).toBeUndefined();
    expect(e2eRunOutcome(run({ status: 'running' }), t)).toBeUndefined();
  });

  it('зелёный набор: «прошли все», ссылка на запись, код выхода не показан', () => {
    expect(e2eRunOutcome(run({}), t)).toEqual({
      tone: 'success',
      lines: ['testsE2e.run.resultGreen {"passed":3,"total":3}'],
      runId: 'run-1',
    });
  });

  it('красный набор: не «Готово», а сколько упало; код 1 — это и есть падение', () => {
    const outcome = e2eRunOutcome(
      run({ exitCode: 1, summary: { total: 3, passed: 1, failed: 2, skipped: 0, blocked: 0 } }),
      t,
    );
    expect(outcome?.tone).toBe('danger');
    expect(outcome?.lines).toEqual(['testsE2e.run.resultRed {"failed":2,"total":3,"passed":1}']);
  });

  it('без кейса — по именам, остаток числом; тон «проверьте»', () => {
    const outcome = e2eRunOutcome(
      run({
        imported: { read: 9, matched: 2, unmatched: 7 },
        unmatchedNames: ['a', 'b', 'c', 'd', 'e'],
      }),
      t,
    );
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.lines[1]).toBe(
      'testsE2e.run.unmatched {"count":7,"names":"a, b, c, d, e, testsE2e.run.unmatchedMore {\\"count\\":2}"}',
    );
  });

  it('ненулевой код при зелёных тестах — отдельная строка', () => {
    const outcome = e2eRunOutcome(run({ exitCode: 3 }), t);
    expect(outcome?.tone).toBe('warning');
    expect(outcome?.lines.at(-1)).toBe('testsE2e.run.exitOdd {"code":3}');
  });

  it('остановлен до отчёта — так и сказано, ссылки нет', () => {
    expect(
      e2eRunOutcome(
        run({ status: 'stopped', runId: undefined, summary: undefined, imported: undefined }),
        t,
      ),
    ).toEqual({ tone: 'warning', lines: ['testsE2e.run.stoppedNoReport'] });
  });

  it('пустой отчёт и пропуски', () => {
    expect(
      e2eRunOutcome(run({ summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 } }), t)
        ?.lines,
    ).toEqual(['testsE2e.run.resultEmpty']);
    expect(
      e2eRunOutcome(
        run({ summary: { total: 4, passed: 3, failed: 0, skipped: 1, blocked: 0 } }),
        t,
      ),
    ).toMatchObject({
      tone: 'success',
      lines: [
        'testsE2e.run.resultGreen {"passed":3,"total":4}',
        'testsE2e.run.resultSkipped {"count":1}',
      ],
    });
  });

  it('ошибка — её код переводом с подстановками', () => {
    expect(
      e2eRunOutcome(
        run({
          status: 'error',
          errorCode: 'e2e-run-not-installed',
          errorParams: { dir: 'e2e', install: 'npm install' },
        }),
        t,
      ),
    ).toEqual({
      tone: 'danger',
      lines: ['testsE2e.run.error.e2e-run-not-installed {"dir":"e2e","install":"npm install"}'],
    });
  });
});
