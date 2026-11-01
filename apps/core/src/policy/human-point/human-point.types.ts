import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import type { AskActionKind } from '@agentdeck/contracts/core/model-tools';

/** Пункты закрытого списка (06 §Human points): 1 слияние … 10 одобрение запуска / деления. */
export type HumanPointItem = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Пункты, которые источник ядра называет прямо (G15): судья права (3 адрес сервиса, 5 грант),
 * сверка outbox (4), круги (6), бюджет (7), шаг сценария (8), запуск (10).
 */
export type NamedPoint = 3 | 4 | 5 | 6 | 7 | 8 | 10;

export interface HumanPointInput {
  /**
   * Откуда вопрос (G15): `ask_human` / `blocker` модели судятся по действию; остальные источники —
   * ядро, и пункт у них свой, из закрытой таблицы источника.
   */
  source: HumanAskSource;
  /** Пункт, названный ядром; у вопросов модели — всегда `null`. */
  point: NamedPoint | null;
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

/**
 * `refused` — источник назвал пункт не из своей строки (или модель назвала пункт вообще): вопроса
 * нет, ошибка видна в журнале, а не превращена в развилку или в чужой пункт (P20).
 */
export type HumanPointDecision =
  | { point: HumanPointItem; blocking: boolean; reason: string }
  | { point: null; blocking: false; fork: ReportFork; reason: string }
  | { point: null; blocking: false; refused: true; reason: string };
