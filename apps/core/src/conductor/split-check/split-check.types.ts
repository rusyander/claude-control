import type { LeadRole } from '@agentdeck/contracts/core/lead';

/**
 * Вход и выход проверки деления (02 §Split, P39). Предложение плана уже приведено к одной форме:
 * имя, репозиторий, свои пути, зависимости по именам, флаг контракта, оценка (`null` — не дана).
 */

export interface SplitUnit {
  name: string;
  repoKey: string;
  ownedPaths: readonly string[];
  deps: readonly string[];
  contract: boolean;
  estimate: { minutes: number | null; tokens: number | null };
  /**
   * Этап 11 (D6, P137) — кусок плана ведущего: проверка, роль, критерии, входы, спецификация
   * механики. Судятся, только когда у входа есть `plan` (задача ведущего, предложение плана).
   */
  check?: string;
  /** Строка, а не `LeadRole`: правка человека и журнал приносят что угодно — судит проверка. */
  role?: string;
  acRefs?: readonly string[];
  inputs?: readonly { from: string; iface: string }[];
  spec?: { files?: readonly string[]; interface?: string; check?: string };
}

/**
 * Договор плана ведущего (этап 11, D6): что проверка деления судит сверх P39. Нет — предложение
 * не ведущего (сценарий без ведения, соло ядра, правка человека): правила плана не действуют.
 */
export interface SplitPlanContract {
  /** Проверка решается реестром проверок репозитория куска; реестр не прочитан — нет. */
  resolvesCheck(repoKey: string, checkId: string): boolean;
  /** id требований, ещё не закрытых (`open`/`unknown`): их обязаны покрыть `acRefs` кусков. */
  openRequirements: readonly string[];
}

/** Кусок `mechanical` без полной спецификации идёт как `implement`, причина названа. */
export interface SplitDemotion {
  unit: string;
  missing: string[];
}

/**
 * Что задача сдаёт. Ревью: число MR посчитал разбор (02:19); `null` — не посчитал, и деление
 * ревью не на что опереть.
 */
export type SplitDeliverable = { kind: 'change' } | { kind: 'review'; mrCount: number | null };

export interface SplitCapacity {
  /** Сколько единиц идёт одновременно. */
  slots: number;
  /** Сколько минут работы вмещает окно; `null` — окно не моделируется (фаза 5). */
  minutes: number | null;
}

export interface SplitCheckInput {
  units: readonly SplitUnit[];
  deliverable: SplitDeliverable;
  capacity: SplitCapacity;
  /**
   * Известные файлы репозитория (по `repoKey`, из истории git): две маски пересекаются, только если
   * есть файл под обеими. Нет списка — пересечение судится по префиксам, с запасом.
   */
  knownFiles?: Readonly<Record<string, readonly string[]>>;
  /** Регистр путей не различается (Windows, macOS по умолчанию). */
  foldCase: boolean;
  /**
   * Репозитории задачи: единица в чужом репозитории — отказ (`unknown-repo`), её ветку не от чего
   * растить. Нет списка — репозиторий не судится.
   */
  repoKeys?: readonly string[];
  /** Договор плана ведущего (этап 11); нет — только правила P39. */
  plan?: SplitPlanContract;
}

export const SPLIT_PROBLEM_CODES = [
  'no-units',
  'unknown-repo',
  'duplicate-name',
  'unknown-dep',
  'self-dep',
  'cycle',
  'shared-path',
  'one-review',
  'review-count-unknown',
  // Договор плана ведущего (этап 11, D6): все пробелы — в том же одном отказе.
  'no-check',
  'unknown-check',
  'bad-role',
  'uncovered-requirement',
  'input-not-dep',
  'no-skeleton',
] as const;
export type SplitProblemCode = (typeof SPLIT_PROBLEM_CODES)[number];

export interface SplitProblem {
  code: SplitProblemCode;
  units: string[];
  detail: string;
}

/** Ребро порядка: `from` раньше `to`. `contract` — неявное ребро контракта к потребителю (G19). */
export interface SplitEdge {
  from: string;
  to: string;
  why: 'dep' | 'contract';
}

export interface SplitQueued {
  unit: string;
  why: 'slots' | 'window';
}

export interface SplitSuggestion {
  code: 'resplit';
  unit: string;
  detail: string;
}

export type SplitCheckDecision =
  | {
      verdict: 'accepted';
      solo: boolean;
      /** Порядок запуска и публикации — топологический, при равенстве порядок предложения. */
      order: string[];
      edges: SplitEdge[];
      queued: SplitQueued[];
      suggestions: SplitSuggestion[];
      reasons: string[];
      /** Роль каждого куска после проверки (только с договором плана). */
      roles?: Record<string, LeadRole>;
      /** Куски `mechanical`, пониженные до `implement` (только с договором плана). */
      demoted?: SplitDemotion[];
    }
  | { verdict: 'refused'; problems: SplitProblem[]; reasons: string[] };
