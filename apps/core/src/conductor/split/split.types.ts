import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { SplitCheckDecision, SplitDeliverable } from '../split-check/index.ts';

/** Предложенная единица, как её пишет `split.proposed` (02:65-68). */
export type ProposedUnit = JournalDataV1['split.proposed']['units'][number];

/** Кто предложил и откуда: шаг плана/деления/разбора или правка человека (`cmdId`). */
export interface ProposalSource {
  by: JournalDataV1['split.proposed']['by'];
  stepId: string | null;
  cmdId?: string;
}

/** Что проверка деления знает кроме самих единиц: что сдаём, файлы репозиториев. */
export interface SplitFlowInput {
  deliverable: SplitDeliverable;
  knownFiles?: Readonly<Record<string, readonly string[]>>;
}

/** Решение по одному предложению: строка `decision` и `split.decided` уже в журнале. */
export interface SplitOutcome {
  splitId: string;
  decision: SplitCheckDecision;
  decidedSeq: number;
}

/** Что делать после принятого деления (политика запуска, G16). */
export type AfterAccept =
  | { kind: 'launched'; units: string[] }
  | {
      kind: 'launch-refused';
      /** `split-not-approvable` — нечего запускать; `preflight-failed` — дорога упала. */
      code: 'split-not-approvable' | 'preflight-failed';
      reasons: string[];
    }
  | { kind: 'asked'; raise: string };
