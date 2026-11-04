import type { TFunction } from 'i18next';

/**
 * Состояние задачи ядра словами — одно на список задач, ленту задачи и страницу групп. Состояние,
 * которого нет в карте (ядро новее панели), показывается как есть, а не пустой плашкой.
 */
export function taskStateLabel(t: TFunction, state: string): string {
  return t(`coreTimeline.taskState.${state}`, { defaultValue: state });
}

const MACHINE_KEY = { unit: 'unitState', step: 'stepState', session: 'sessionState' } as const;
export type CoreMachine = keyof typeof MACHINE_KEY;

/**
 * Состояние единицы, шага или сессии ядра словами (отчёт, строки ленты). Сырое `ready-to-publish`
 * в русской рамке читалось как недоделка; неизвестное состояние — как есть, как у задачи.
 */
export function machineStateLabel(t: TFunction, machine: CoreMachine, state: string): string {
  return t(`coreTimeline.${MACHINE_KEY[machine]}.${state}`, { defaultValue: state });
}
