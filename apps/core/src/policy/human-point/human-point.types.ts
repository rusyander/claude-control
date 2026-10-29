import type { AskActionKind } from '@agentdeck/contracts/core/model-tools';

/** Пункты закрытого списка (06 §Human points): 1 слияние … 10 одобрение запуска / деления. */
export type HumanPointItem = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface HumanPointInput {
  /** Откуда вопрос: `ask_human` модели или `blocker` (доступ → пункт 4). */
  source: 'ask_human' | 'blocker';
  /** Типизированное действие; `null` — вопрос без действия, он вне списка всегда. */
  action: { kind: AskActionKind; target: string } | null;
  question: string;
  options: string[];
  recommendation: string;
  blocking: boolean;
}

/** Политика человека, из которой берутся пункты 5 и 9 (только его конфиг, не файлы репозитория). */
export interface HumanPointPolicy {
  /** Пункт 5: классы действий, которые человек отметил «спрашивать». */
  actionClasses: readonly string[];
  /** Пункт 5: классы путей человека (маски от корня копии). */
  pathGlobs: readonly string[];
  /** Пункт 5: `grantRequired` — правка этих масок без гранта задачи. */
  grantRequired: readonly { globs: readonly string[]; ops: readonly ('edit' | 'exec-db')[] }[];
  /** Пункт 9: записи в трекер / фордж, которые политика держит на «спрашивать». */
  trackerWrites: 'ask' | 'auto';
  forgeWrites: 'ask' | 'auto';
}

export interface ReportFork {
  question: string;
  options: string[];
  recommendation: string;
}

export type HumanPointDecision =
  | { point: HumanPointItem; blocking: boolean; reason: string }
  | { point: null; blocking: false; fork: ReportFork; reason: string };
