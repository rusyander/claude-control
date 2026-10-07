import type { WatcherProblemCode } from '@agentdeck/contracts';

/**
 * Фоновый наблюдатель панели на телефоне: значок на главной и окно сводки.
 * Отдельным модулем, как `home/`: общий словарь правят несколько разделов разом.
 * Тексты свои, короче панельных: на телефоне их читают на ходу, а подробности —
 * в отчёте и в панели.
 */

/** 1 раздел, 2 раздела, 5 разделов (11–14 — всегда третья форма). */
function form(count: number, one: string, few: string, many: string): string {
  const tail = count % 10;
  const tens = count % 100;
  if (tail === 1 && tens !== 11) return one;
  if (tail >= 2 && tail <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

const problem: { [code in WatcherProblemCode]: string } = {
  cli_missing: 'Claude Code не найден: проблемы пишутся в отчёт, но сверить их с кодом нечем.',
  report_unwritable: 'Отчёт не записывается: нет доступа к файлу. Сбои панель хранит у себя.',
  analysis_failed: 'Последний разбор не удался. Проблемы уйдут модели вместе со следующей.',
  hourly_cap: 'Достигнут потолок разборов в час. Разбор продолжится сам со следующим часом.',
  route_refused:
    'Разбор не запущен: выбранный маршрут его не пускает. Причина — в сводке наблюдателя в панели.',
};

export const watcherRu = {
  chip: (time: string) => `Наблюдатель · ${time}`,
  chipA11y: (time: string, state: string) =>
    `Фоновый наблюдатель включён, работает ${time}${state ? `, ${state}` : ''}. Открыть сводку`,
  stateAnalyzing: 'идёт разбор',
  stateProblem: 'есть проблема',
  title: 'Фоновый наблюдатель',
  running: (time: string) => `Работает ${time}`,
  analyzing: 'Идёт разбор',
  findings: (count: number, remarks: number) =>
    `В отчёте ${count} ${form(count, 'раздел', 'раздела', 'разделов')}` +
    (remarks > 0
      ? `, из них ${remarks} ${form(remarks, 'замечание', 'замечания', 'замечаний')}`
      : ''),
  pending: (count: number) =>
    `Ждут разбора: ${count} ${form(count, 'проблема', 'проблемы', 'проблем')}`,
  hourlyCap: (used: number, limit: number) => `Разборов за этот час: ${used} из ${limit}`,
  spend: (text: string) => `Расход: ${text}`,
  spendEstimate: 'оценка по тарифам API, не счёт',
  report: 'Отчёт',
  problemTitle: 'Наблюдатель не может сделать свою работу',
  problem,
  turnOff: 'Выключить',
  turnOffFailed: (reason: string) => `Не выключился: ${reason}`,
  // Включение остаётся делом панели — так же сказано в её справке.
  onlyPanel: 'Включают наблюдатель в панели: Настройки → Общие.',
  close: 'Закрыть',
  duration: { h: 'ч', m: 'м', s: 'с' },
};

export type WatcherTexts = typeof watcherRu;
