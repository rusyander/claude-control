import type { KnobView } from '@agentdeck/contracts';

/**
 * «Авто» — у группы своего значения нет, число выбирает скилл. Закреплённое
 * число — своё, даже если равно умолчанию скилла: скилл поменяет умолчание,
 * а группа останется при своём.
 */
export function isAutoKnob(knob: Pick<KnobView, 'auto'>): boolean {
  return knob.auto;
}
