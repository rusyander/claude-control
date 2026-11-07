import type { IntakeCard, IntakeSource } from '@agentdeck/contracts/core/intake';
import type { LeadAlwaysAsk } from '@agentdeck/contracts/core/lead';

/**
 * Приём задачи ведущим (этап 11, W2-6, P133-P134): источник → карточка → решение «принять самой
 * или спросить». Источник — снимок (трекер, текст, голос, пункт группы); тело снимка — данные под
 * маской DLP, ни настройку, ни политику публикации оно не меняет.
 */

/** Источники тела оценки: `source` или `sources`; оба сразу — противоречие, названное отказом. */
export type SourcesRead = { ok: true; sources: IntakeSource[] } | { ok: false; problem: string };

/** Требование свёртки, из которого строится строка критерия карточки (одна нумерация, P134). */
export interface AcceptanceRow {
  id: string;
  text: string;
  source: 'request' | 'ticket' | 'review' | 'human';
}

/** Вход суда приёма: источники, собранная карточка и `lead.alwaysAsk` действующих настроек. */
export interface IntakeInput {
  sources: readonly IntakeSource[];
  card: IntakeCard;
  alwaysAsk: readonly LeadAlwaysAsk[];
}

/** Карточка собрана или отказана единым судом схемы: каждая причина названа. */
export type CardBuilt = { ok: true; card: IntakeCard } | { ok: false; issues: string[] };
