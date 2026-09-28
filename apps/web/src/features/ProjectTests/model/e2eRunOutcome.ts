import type { ProjectTestE2eRun, ProjectTestRunSummary } from '@agentdeck/contracts';

/** Строки итога прогона автотестов и их тон — без React, чтобы проверять их тестом. */
export interface E2eRunOutcome {
  tone: 'subtle' | 'success' | 'danger' | 'warning';
  lines: string[];
  /** Запись истории прогонов, куда легли результаты, — для ссылки «открыть прогон». */
  runId?: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** Первая строка итога: упало ли что-нибудь и сколько. */
function headline(summary: ProjectTestRunSummary, t: Translate): string {
  if (summary.total === 0) return t('testsE2e.run.resultEmpty');
  if (summary.failed > 0) {
    return t('testsE2e.run.resultRed', {
      failed: summary.failed,
      total: summary.total,
      passed: summary.passed,
    });
  }
  return t('testsE2e.run.resultGreen', { passed: summary.passed, total: summary.total });
}

/**
 * Итог прогона словами тестировщика: сперва «прошло или упало», потом что не
 * легло на кейсы — по именам, потом странное (код выхода при зелёных тестах).
 *
 * Раньше итог начинался с «Готово.» и над красным набором, счёт «результатов /
 * легло / без кейса» не говорил, сколько упало, а «Код выхода 1» стоял всегда —
 * хотя ненулевой код при упавших тестах ничего не добавляет: это и есть их падение.
 */
export function e2eRunOutcome(
  run: ProjectTestE2eRun | undefined,
  t: Translate,
): E2eRunOutcome | undefined {
  if (!run || run.status === 'running') return undefined;
  if (run.status === 'error') {
    return {
      tone: 'danger',
      lines: [
        run.errorCode
          ? t(`testsE2e.run.error.${run.errorCode}`, run.errorParams ?? {})
          : (run.error ?? ''),
      ].filter(Boolean),
    };
  }
  const lines: string[] = [];
  const summary = run.summary;
  if (run.status === 'stopped') {
    lines.push(t(run.runId ? 'testsE2e.run.stopped' : 'testsE2e.run.stoppedNoReport'));
  }
  if (summary) {
    lines.push(headline(summary, t));
    if (summary.skipped > 0) {
      lines.push(t('testsE2e.run.resultSkipped', { count: summary.skipped }));
    }
  }
  const unmatched = run.imported?.unmatched ?? 0;
  if (unmatched > 0) {
    const names = run.unmatchedNames ?? [];
    const more = unmatched - names.length;
    lines.push(
      t('testsE2e.run.unmatched', {
        count: unmatched,
        names: [
          ...names,
          ...(more > 0 ? [t('testsE2e.run.unmatchedMore', { count: more })] : []),
        ].join(', '),
      }),
    );
  }
  const failed = summary?.failed ?? 0;
  const exitOdd =
    typeof run.exitCode === 'number' && run.exitCode !== 0 && failed === 0 && run.status === 'done';
  if (exitOdd) lines.push(t('testsE2e.run.exitOdd', { code: run.exitCode }));
  // Красное — только упавшие тесты; «проверьте» — всё, что не даёт считать
  // прогон зелёным: остановка, пустой отчёт, тесты без кейса, странный код выхода.
  const doubtful =
    run.status === 'stopped' || !summary || summary.total === 0 || unmatched > 0 || exitOdd;
  let tone: E2eRunOutcome['tone'] = doubtful ? 'warning' : 'success';
  if (failed > 0) tone = 'danger';
  return { tone, lines, ...(run.runId ? { runId: run.runId } : {}) };
}
