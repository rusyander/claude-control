import {
  PUBLISH_READY_NEXT,
  type PublishReadyDecision,
  type PublishReadyInput,
  type PublishReadyNext,
  type ReadyUnmetCode,
} from '@agentdeck/contracts/core/publish';

/**
 * Что делает ядро после отказа готовности. Тот же словарь, что `PUBLISH_NEXT` дирижёра (части не
 * импортируют дирижёра, 00 §Parts — совпадение держит тест проводки).
 */
export const READY_NEXT = PUBLISH_READY_NEXT;
export type ReadyNext = PublishReadyNext;

export interface ReadyUnmet {
  code: ReadyUnmetCode;
  subject: string;
  next: string;
}

export type { PublishReadyDecision, PublishReadyInput };
