import type {
  ProjectTestAutomationCommand,
  ProjectTestAutomationFormat,
} from '@agentdeck/contracts';

/**
 * Поля правки своей команды прогона — строками, как их держат поля ввода.
 * Чистые функции без React: что уйдёт на сервер, проверяется тестом.
 */
export interface AutomationDraft {
  command: string;
  report: string;
  format: ProjectTestAutomationFormat;
  /** Минуты строкой: пустое поле — «без потолка», а не ноль. */
  timeout: string;
}

export const AUTOMATION_FORMATS: readonly ProjectTestAutomationFormat[] = [
  'junit',
  'go-test-json',
  'cargo-test',
];

export function draftFrom(automation: ProjectTestAutomationCommand | undefined): AutomationDraft {
  return {
    command: automation?.command ?? '',
    report: automation?.report ?? '',
    format: automation?.format ?? 'junit',
    timeout: automation?.timeoutMinutes ? String(automation.timeoutMinutes) : '',
  };
}

/**
 * Тело записи. Пустой отчёт и вид `junit` не пишутся вовсе — сервер так же
 * читает их отсутствие, и файл проекта остаётся коротким. Потолок — только
 * положительное число: «0» и «абв» значат «без потолка», а не отказ.
 */
export function draftToSave(draft: AutomationDraft): ProjectTestAutomationCommand {
  const minutes = Number(draft.timeout.trim());
  const report = draft.report.trim();
  return {
    command: draft.command.trim(),
    ...(report ? { report } : {}),
    ...(draft.format !== 'junit' ? { format: draft.format } : {}),
    ...(Number.isFinite(minutes) && minutes > 0 ? { timeoutMinutes: Math.round(minutes) } : {}),
  };
}

/** Правка ничего не меняет — «Сохранить» не нужна. */
export function sameAutomation(
  draft: AutomationDraft,
  saved: ProjectTestAutomationCommand | undefined,
): boolean {
  const next = draftToSave(draft);
  return (
    next.command === (saved?.command ?? '') &&
    (next.report ?? '') === (saved?.report ?? '') &&
    (next.format ?? 'junit') === (saved?.format ?? 'junit') &&
    (next.timeoutMinutes ?? 0) === (saved?.timeoutMinutes ?? 0)
  );
}
