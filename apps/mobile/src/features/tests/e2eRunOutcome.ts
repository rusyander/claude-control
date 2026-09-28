import type { ProjectTestE2eRun } from '@agentdeck/contracts';
import type { Dictionary } from '../../shared/config/i18n';

type E2eWords = Dictionary['tests']['e2e'];

/** Итог прогона автотестов и его тон — без React, чтобы проверять тестом. */
export interface E2eRunOutcome {
  tone: 'plain' | 'success' | 'danger' | 'warning';
  text: string;
}

/**
 * Текст ошибки запуска. Код, которого нет в словаре телефона (сервер новее
 * APK), давал `undefined` — ошибочный прогон не рисовал ничего (F-193); теперь
 * слово за текстом сервера. «Раннер не установлен» называет папку и команду
 * установки, как панель: без них совет «поставьте» нечем выполнить (F-359).
 */
function errorText(run: ProjectTestE2eRun, e2e: E2eWords): string {
  const fallback = run.error ?? e2e.error['e2e-run-spawn'];
  if (!run.errorCode) return fallback;
  if (run.errorCode === 'e2e-run-not-installed' && run.errorParams) {
    return e2e.notInstalledAt(run.errorParams.dir, run.errorParams.install);
  }
  return (e2e.error as Partial<Record<string, string>>)[run.errorCode] ?? fallback;
}

/**
 * Итог прогона словами тестировщика — тот же расчёт, что у панели
 * (`e2eRunOutcome` веба): сперва «прошло или упало» по `summary`, потом что не
 * легло на кейсы, потом странный код выхода при зелёных тестах.
 *
 * Прежде карточка писала «Последний прогон закончен.» над красным набором:
 * `summary` и `exitCode` не читались, а красным красилась только ошибка запуска.
 */
export function e2eRunOutcome(
  run: ProjectTestE2eRun | undefined,
  e2e: E2eWords,
): E2eRunOutcome | undefined {
  if (!run) return undefined;
  if (run.status === 'running') return { tone: 'plain', text: e2e.running(run.command) };
  if (run.status === 'error') return { tone: 'danger', text: errorText(run, e2e) };
  const lines: string[] = [];
  const summary = run.summary;
  if (run.status === 'stopped') lines.push(run.runId ? e2e.stopped : e2e.stoppedNoReport);
  if (summary) {
    if (summary.total === 0) lines.push(e2e.resultEmpty);
    else if (summary.failed > 0) {
      lines.push(e2e.resultRed(summary.failed, summary.total, summary.passed));
    } else lines.push(e2e.resultGreen(summary.passed, summary.total));
    if (summary.skipped > 0) lines.push(e2e.resultSkipped(summary.skipped));
  }
  const unmatched = run.imported?.unmatched ?? 0;
  if (unmatched > 0) lines.push(e2e.unmatched(unmatched));
  const failed = summary?.failed ?? 0;
  const code = run.exitCode;
  const exitOdd = typeof code === 'number' && code !== 0 && failed === 0 && run.status === 'done';
  if (exitOdd) lines.push(e2e.exitOdd(code));
  // Красное — только упавшие тесты; «проверьте» — всё, что не даёт считать
  // прогон зелёным: остановка, пустой отчёт, тесты без кейса, странный код.
  const doubtful =
    run.status === 'stopped' || !summary || summary.total === 0 || unmatched > 0 || exitOdd;
  let tone: E2eRunOutcome['tone'] = doubtful ? 'warning' : 'success';
  if (failed > 0) tone = 'danger';
  return { tone, text: lines.join(' ') };
}
