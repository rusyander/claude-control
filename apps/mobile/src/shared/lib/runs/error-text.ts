import type { AgentRun } from './types';

/**
 * Строка ошибки прогона для экрана (s10 G7): текст самой панели по коду (отказ ядра в ходе чата)
 * — переводом кода на языке телефона, строка CLI — как есть. Словарь передаёт экран
 * (`serverMessage`): модуль без react-native, его читают проверки в среде node.
 */
export function runErrorText(
  run: Pick<AgentRun, 'error' | 'errorPanel'>,
  translate: (code: string, params?: Record<string, string>) => string | undefined,
): string | undefined {
  if (!run.error) return undefined;
  const panel = run.errorPanel;
  if (!panel || panel.message !== run.error) return run.error;
  return translate(panel.code, panel.params) || run.error;
}
