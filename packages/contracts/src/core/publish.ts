/**
 * Публикатор ядра (05 §Commit shape, §Readiness, фаза 6): один сит на весь исходящий текст, одна
 * функция готовности с одним отказом, форма коммитов, закрытие пуша сессий.
 */

export const TEXT_KINDS = ['commit', 'mr-title', 'mr-body', 'reply', 'tracker-comment'] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/** На каждое правило — убитый мутант (P62); `secret` — сток P61 в опубликованном тексте. */
export const TEXT_RULES = [
  'trailer',
  'uuidv7',
  'record-id',
  'local-path',
  'company-name',
  'process-word',
  'secret',
] as const;
export type TextRule = (typeof TEXT_RULES)[number];

/** Подпись снимается молча (`stripped`), остальное — отказ с местом: текст правит шаг, а не сит. */
export type TextVerdict =
  | { kind: 'pass'; text: string }
  | { kind: 'stripped'; text: string; removed: { rule: 'trailer'; line: string }[] }
  | {
      kind: 'refused';
      spans: { rule: Exclude<TextRule, 'trailer'>; start: number; end: number }[];
    };

/** `<coreHome>/publish-text.json`; нет файла → `{ companyNames: [], requireSignOff: false }` (G9). */
export interface PublishTextConfig {
  companyNames: string[];
  requireSignOff: boolean;
}

/** Соглашение о сообщениях, найденное по истории репозитория. */
export interface CommitConvention {
  conventional: boolean;
  language: string;
  signedOffShare: number;
}

export const READY_UNMET = [
  'composition-mismatch',
  'tree-moved',
  'base-conflict',
  'requirements',
  'coverage-gap',
  'sieve',
  'text',
  'human-point',
  'forge-unknown',
] as const;
export type ReadyUnmetCode = (typeof READY_UNMET)[number];

export const SIEVE_NAMES = [
  'secret',
  'debug-leftover',
  'conflict-marker',
  'committed-env',
  'large-file',
  'lockfile-gap',
  'destructive-migration',
  'undeclared-env',
  'untested-code',
  'unowned-removal',
] as const;
export type SieveName = (typeof SIEVE_NAMES)[number];

export interface SieveFinding {
  sieve: SieveName;
  file: string;
  detail: string;
}

export interface PublishReadyInput {
  unitId: string;
  compositionId: string;
  compositionTreeFp: string;
  outgoingTreeFp: string;
  baseOnServer: { ref: string; sha: string } | { unknown: string };
  mergeTree: 'clean' | 'conflict' | { unknown: string };
  requirements: 'met' | { unmet: string[] };
  coverage: { policy: 'warn' | 'refuse'; gaps: string[] | { unknown: string } };
  sieves: SieveFinding[];
  texts: { kind: TextKind; verdict: TextVerdict['kind'] }[];
  openHumanPoints: number[];
}

/**
 * Решение `publisher/ready` (F01 F08): разрешить или ОДИН отказ со всеми несбывшимися условиями и
 * тем, что ядро делает дальше. Тот же `inputsHash` — то же решение без пересчёта.
 */
export type PublishReadyDecision =
  | { kind: 'allow'; inputsHash: string }
  | {
      kind: 'refuse';
      unmet: { code: ReadyUnmetCode; subject: string; next: string }[];
      next: PublishReadyNext;
      inputsHash: string;
    };

/** Что ядро делает после отказа готовности. `regate` — дерево ушло от состава финальной проверки. */
export const PUBLISH_READY_NEXT = [
  'fix-step',
  'resolve-conflict',
  'ask',
  'wait-forge',
  'regate',
] as const;
export type PublishReadyNext = (typeof PUBLISH_READY_NEXT)[number];

export const COMMIT_SHAPES = ['kept', 'squashed', 're-messaged'] as const;
export type CommitShape = (typeof COMMIT_SHAPES)[number];

/** Что ядро записало в копию части; сверка дрейфа читает это из журнала, а не из памяти. */
export interface ClosureRecord {
  unitId: string;
  copyDir: string;
  pushurls: Record<string, string>;
  hooksPath: string;
  hooksDirFp: string;
  /** `alias.*` общего конфига при создании копии — база сверки дрейфа общего конфига. */
  commonAliases: Record<string, string>;
}

export const FORGED_EVIDENCE = ['remote-sha', 'forge-event', 'config-drift'] as const;
export type ForgedEvidence = (typeof FORGED_EVIDENCE)[number];
export const FORGED_PUBLISH = 'forged-publish';

/** 05:85 — каждый цикл пишется `publish.backoff`; потолок ожидания машины ≤ 30 минут. */
export const BACKOFF_MINUTES = [1, 2, 5, 10, 30] as const;
