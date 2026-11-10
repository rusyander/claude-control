import type { Fact } from '@agentdeck/contracts/core/facts';
import type { RequirementVerdict } from '@agentdeck/contracts/core/journal';
import type { StepDoneCall, StepDoneEvidenceCode } from '@agentdeck/contracts/core/model-tools';
import type { CheckClass, RecordOrigin, VerdictName } from '@agentdeck/contracts/core/records';

/**
 * Судья требований (02 §Requirements, F16, P01): входы — только типизированные строки журнала
 * (извлечение, принятые заявления шагов, подтверждения ревью, снятия человеком, исход «выведен»),
 * никогда проза модели (P32).
 */

export interface RequirementRow {
  id: string;
  /** Номер для показа («R3»); модель цитирует id (G3). */
  ordinal: number;
  text: string;
  source: 'request' | 'ticket' | 'review' | 'human';
  stepId: string | null;
  seq: number;
}

/** Принятое заявление шага (`step.claimed`): доказательства уже прошли суд `step_done`. */
export interface ClaimRow {
  seq: number;
  stepId: string;
  stepKind: string;
  claim: StepDoneCall;
  /** Второе ревью (P185): идут в счёт только его опровержения — «покрыто» и подтверждения нет. */
  cross?: true;
}

export interface RequirementsInput {
  requirements: RequirementRow[];
  /** Снятия человеком (`edit-requirements`) — единственная дорога к `waived` (G2). */
  waivers: { id: string; reason: string; seq: number }[];
  claims: ClaimRow[];
  /** Шаги, закрытые выводом по git и записям (02:47): требования до них — `unknown` до ревью. */
  derived: { stepId: string; seq: number }[];
  /** Сверки извлечения (`requirement.reviewed`) в порядке журнала. */
  reviews: { stepId: string; complete: boolean; added: string[]; seq: number }[];
  /**
   * Свежесть каждой записи, на которую опирается «покрыто», перечитанная после шага: ключ равен
   * ключу на текущем дереве — `current`. Нет строки — запись не перечитана, «покрыто» не стоит.
   */
  evidence: Record<string, EvidenceStanding>;
}

export type EvidenceStanding = 'current' | { stale: string } | { unknown: string };

export interface RequirementJudgement {
  id: string;
  ordinal: number;
  verdict: RequirementVerdict;
  evidence: string[];
  reason: string;
}

export interface RequirementsDecision {
  requirements: RequirementJudgement[];
  /** Сверка извлечения с источником есть, после последнего извлечения, и полная (P93). */
  extractionReviewed: boolean;
  /** Ворота `requirements-covered`: каждое требование типизировано, извлечение сверено (P32). */
  covered: boolean;
  /** Все причины, по которым ворота закрыты, — каждая названа (P01). */
  missing: string[];
}

/** Что `step_done` знает о записи: вердикт, привязка и ключ (G22). */
export interface EvidenceRecord {
  verdict: VerdictName;
  checkId: string;
  taskId: string | null;
  origin: RecordOrigin;
  key: string;
  unit: string;
  selection: string[];
}

/** Проверка записи сейчас: ключ на текущем дереве копии, класс и замыкание единицы (P92). */
export interface EvidenceNow {
  key: string;
  class: CheckClass;
  closure: string[];
}

export interface EvidenceFacts {
  record: Fact<EvidenceRecord>;
  now: Fact<EvidenceNow>;
  /** Файлы, изменённые единицей против её базы (`git.diff-unit`). */
  changed: Fact<string[]>;
}

export type EvidenceCode = StepDoneEvidenceCode | 'missing' | 'red' | 'no-verdict' | 'foreign-task';

export interface EvidenceProblem {
  code: EvidenceCode;
  detail: string;
}
