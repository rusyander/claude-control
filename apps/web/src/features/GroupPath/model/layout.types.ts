import type { PathAnchor } from '@agentdeck/contracts';
import type { PathRow } from './pathRows.types';

/** Строка с номером: стадии не нумеруются — они разделители, а не шаги. */
export interface NumberedRow {
  row: PathRow;
  /** Номер шага с единицы. */
  number: number;
  /** Индекс строки в `rows` — по нему решается, есть ли «+» после неё. */
  index: number;
}

/**
 * Что рисует конструктор. У конвейера: стадия — тонкий разделитель, шаги
 * одного скилла (и свои шаги, вставленные внутрь него) — сворачиваемый блок,
 * остальное — отдельные строки. У сценария — только строки.
 */
export type LayoutItem =
  | { kind: 'stage'; stage: PathAnchor; row: PathRow; index: number }
  | { kind: 'row'; item: NumberedRow }
  | { kind: 'block'; skillId: string; items: NumberedRow[] };
