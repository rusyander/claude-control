import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RedBeforeResult, VerdictName } from '@agentdeck/contracts/core/records';
import type { Gate, GateKind } from '@agentdeck/contracts/core/scenario';
import type { RequirementsDecision } from '../requirements/requirements.types.ts';

/**
 * Ворота шага сценария (CD§1, 02 §Gates): каждое закрывается только типизированным фактом —
 * вердиктом судьи требований, записью проверки ядра, доказанным «красным до», замечаниями ревью
 * по уровню, подтверждением ревью по индексу ворот. Проза модели ворота не открывает (P32, F16).
 */

/** Последняя запись проверки ядра по `checkId` в этой задаче и её свежесть на текущем дереве. */
export interface CheckStanding {
  recordId: string;
  verdict: VerdictName;
  /** Ключ записи равен ключу на текущем дереве (G22); старая зелёная запись ворота не открывает. */
  current: boolean;
}

/** Последнее принятое заявление шага ревью: сколько в нём замечаний уровня `blocking`. */
export interface ReviewStanding {
  stepId: string;
  blocking: number;
}

export interface GateFacts {
  /** Шаг сценария, чьи ворота судятся: подтверждение ревью ссылается на него и индекс ворот. */
  stepDefId: string;
  requirements: RequirementsDecision;
  /** Нет ключа — запись по проверке не делалась (`absent`); не прочиталась — `unknown`. */
  checks: Record<string, Fact<CheckStanding>>;
  redBefore: Fact<RedBeforeResult[]>;
  /** `absent` — ревью в задаче ещё не было. */
  review: Fact<ReviewStanding>;
  /** Последнее подтверждение ревью по индексу ворот ЭТОГО шага (`{kind:'gate', stepDefId, index}`). */
  confirmations: Record<number, 'confirmed' | 'refuted'>;
}

export interface GateUnmet {
  index: number;
  kind: GateKind;
  reason: string;
}

/** Решение класса `gates` (реестр `core/decisions.ts`): единственный судья — `evaluateGates`. */
export interface GatesDecision {
  passed: boolean;
  /** Каждое закрытое ворото названо с причиной (P01: отказ называет все условия). */
  unmet: GateUnmet[];
}

export type { Gate };
