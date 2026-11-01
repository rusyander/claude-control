import type { GRANT_OPS, HumanAskSource } from '@agentdeck/contracts/core/journal';

export type GrantOp = (typeof GRANT_OPS)[number];

/**
 * Вопрос, как его видит карточка. Своя форма, а не тип ленты: срез фич не тянет соседний срез,
 * страница передаёт сюда факты вопроса из свёртки ленты (структурно совпадают).
 */
export interface AskCardAsk {
  askId: string;
  point: number;
  source: HumanAskSource;
  question: string;
  options: string[];
  defaultAction: string | null;
  /** Деление вопроса запуска — для `approve-split`. */
  splitId: string | null;
  /** Цель отказа права — путь гранта по умолчанию. */
  permit: { action: string; target: string } | null;
  /** Репозиторий шага — проект гранта по умолчанию. */
  repoKey: string | null;
}

export type AskChoice =
  | { type: 'option'; option: string; cancelReason: string }
  | { type: 'text'; text: string }
  | { type: 'grant'; project: string; globs: string[]; ops: GrantOp[] };
