import type {
  CommitConvention,
  PublishTextConfig,
  TextRule,
  TextVerdict,
} from '@agentdeck/contracts/core/publish';

/**
 * Решение класса `publish-text` (contracts `decisions.ts`): тот же вердикт сита, под именем класса,
 * чтобы проверка P01 видела судью в его модуле.
 */
export type PublishTextDecision = TextVerdict;

export interface TextSieveContext {
  config: PublishTextConfig;
  /** Соглашение репозитория; `null` — не прочитано: подпись DCO решает только `config`. */
  convention: CommitConvention | null;
  /** Каталоги машины, которые не уходят наружу: дом ядра, копия единицы, исходный репозиторий. */
  localRoots: readonly string[];
}

export interface RefusedSpan {
  rule: Exclude<TextRule, 'trailer'>;
  start: number;
  end: number;
}
