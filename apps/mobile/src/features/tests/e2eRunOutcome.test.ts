import { describe, expect, it } from 'vitest';
import type { ProjectTestE2eRun } from '@agentdeck/contracts';
import { ru } from '../../shared/config/i18n/ru';
import { e2eRunOutcome } from './e2eRunOutcome';

const e2e = ru.tests.e2e;

const run = (part: Partial<ProjectTestE2eRun>): ProjectTestE2eRun =>
  ({
    projectPath: '/p',
    command: 'npx playwright test',
    status: 'done',
    startedAt: '2026-09-28T00:00:00.000Z',
    ...part,
  }) as ProjectTestE2eRun;

describe('e2eRunOutcome (телефон)', () => {
  it('красный набор — «упало N из M» красным, а не «закончен»', () => {
    const outcome = e2eRunOutcome(
      run({
        exitCode: 1,
        runId: 'r1',
        summary: { total: 5, passed: 3, failed: 2, skipped: 0, blocked: 0 },
      }),
      e2e,
    );
    expect(outcome).toEqual({ tone: 'danger', text: 'Упало 2 из 5, прошло 3.' });
  });

  it('зелёный набор — «прошли все» зелёным; пропуски отдельной строкой', () => {
    expect(
      e2eRunOutcome(
        run({
          exitCode: 0,
          runId: 'r1',
          summary: { total: 4, passed: 3, failed: 0, skipped: 1, blocked: 0 },
        }),
        e2e,
      ),
    ).toEqual({ tone: 'success', text: 'Прошли все: 3 из 4. Пропущено: 1.' });
  });

  it('ненулевой код при зелёных тестах, тесты без кейса, пустой отчёт — «проверьте», не зелёный', () => {
    expect(
      e2eRunOutcome(
        run({ exitCode: 2, summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 } }),
        e2e,
      )?.tone,
    ).toBe('warning');
    expect(
      e2eRunOutcome(
        run({
          summary: { total: 2, passed: 2, failed: 0, skipped: 0, blocked: 0 },
          imported: { read: 2, matched: 1, unmatched: 1 },
        }),
        e2e,
      ),
    ).toEqual({ tone: 'warning', text: 'Прошли все: 2 из 2. Без кейса: 1.' });
    expect(
      e2eRunOutcome(
        run({ summary: { total: 0, passed: 0, failed: 0, skipped: 0, blocked: 0 } }),
        e2e,
      ),
    ).toEqual({ tone: 'warning', text: 'В отчёте нет ни одного теста.' });
  });

  it('остановка до отчёта и сбой запуска', () => {
    expect(e2eRunOutcome(run({ status: 'stopped' }), e2e)).toEqual({
      tone: 'warning',
      text: e2e.stoppedNoReport,
    });
    expect(e2eRunOutcome(run({ status: 'error', errorCode: 'e2e-run-no-report' }), e2e)).toEqual({
      tone: 'danger',
      text: e2e.error['e2e-run-no-report'],
    });
    expect(e2eRunOutcome(undefined, e2e)).toBeUndefined();
  });
});

describe('ошибка запуска: код, которого нет в словаре, и подстановки (F-193, F-359)', () => {
  it('неизвестный код (сервер новее телефона) — текст сервера, а не пустота', () => {
    const outcome = e2eRunOutcome(
      run({
        status: 'error',
        errorCode: 'e2e-run-future' as ProjectTestE2eRun['errorCode'],
        error: 'Сервер объяснил словами.',
      }),
      e2e,
    );
    expect(outcome).toEqual({ tone: 'danger', text: 'Сервер объяснил словами.' });
  });

  it('раннер не установлен — телефон называет папку и команду установки', () => {
    const outcome = e2eRunOutcome(
      run({
        status: 'error',
        errorCode: 'e2e-run-not-installed',
        errorParams: { dir: 'e2e', install: 'npm install' },
      }),
      e2e,
    );
    expect(outcome?.text).toContain('e2e');
    expect(outcome?.text).toContain('npm install');
  });
});
