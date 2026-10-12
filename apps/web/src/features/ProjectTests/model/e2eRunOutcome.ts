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
  const unmatched = run.imported?.unmatched ?? 0;
  // «(build)» — пакет не собрался, а не тест без кейса: у него своя строка.
  const buildFailed = run.buildFailed ?? 0;
  const orphans = unmatched - buildFailed;
  if (run.status === 'stopped') {
    lines.push(t(run.runId ? 'testsE2e.run.stopped' : 'testsE2e.run.stoppedNoReport'));
  }
  if (summary) {
    // Тесты в отчёте есть, кейсов у них нет: «в отчёте нет ни одного теста» было бы неправдой.
    lines.push(
      summary.total === 0 && orphans > 0
        ? t(run.adopted ? 'testsE2e.run.resultAdoptedAfter' : 'testsE2e.run.resultNoCases', {
            count: orphans,
          })
        : headline(summary, t),
    );
    if (summary.skipped > 0) {
      lines.push(t('testsE2e.run.resultSkipped', { count: summary.skipped }));
    }
  }
  if (buildFailed > 0) lines.push(t('testsE2e.run.buildFailed', { count: buildFailed }));
  // Заведённые из этого прогона — уже с кейсами: строка «без кейса» о них не говорит.
  if (orphans > 0 && !run.adopted) {
    const names = run.unmatchedNames ?? [];
    const more = orphans - names.length;
    // Своей команде кейсы заводит кнопка под итогом, папке e2e — «Обновить из папки».
    lines.push(
      t(run.adoptable || run.own ? 'testsE2e.run.unmatchedAdopt' : 'testsE2e.run.unmatched', {
        count: orphans,
        names: [
          ...names,
          ...(more > 0 ? [t('testsE2e.run.unmatchedMore', { count: more })] : []),
        ].join(', '),
      }),
    );
  }
  const failed = summary?.failed ?? 0;
  // Код выхода странен, только если упасть было нечему: тесты без кейса и
  // несобравшийся пакет — сами по себе причина ненулевого кода.
  const exitOdd =
    typeof run.exitCode === 'number' &&
    run.exitCode !== 0 &&
    failed === 0 &&
    unmatched === 0 &&
    run.status === 'done';
  if (exitOdd) lines.push(t('testsE2e.run.exitOdd', { code: run.exitCode }));
  // Красное — упавшие тесты и несобравшийся пакет; «проверьте» — всё, что не
  // даёт считать прогон зелёным: остановка, пустой отчёт, тесты без кейса,
  // странный код выхода.
  const doubtful =
    run.status === 'stopped' || !summary || summary.total === 0 || orphans > 0 || exitOdd;
  let tone: E2eRunOutcome['tone'] = doubtful ? 'warning' : 'success';
  if (failed > 0 || buildFailed > 0) tone = 'danger';
  return { tone, lines, ...(run.runId ? { runId: run.runId } : {}) };
}
