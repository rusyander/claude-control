import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckCall } from '@agentdeck/contracts/core/model-tools';
import type { LiveTask } from '../../journal/resume.ts';
import type { RecordOrigin, VerdictName } from '@agentdeck/contracts/core/records';
import type { PermissionAsk, RawToolCall } from '../../adapters/adapter.types.ts';
import type { HumanPointPolicy } from '../../policy/human-point/human-point.types.ts';
import type { PendingPermits } from '../../policy/permit/pending.ts';
import type { PermitCodec, PermitContext } from '../../policy/permit/permit.types.ts';

/** Сессия, которой ядро выдало токен, — по журналу задачи (03: токен сессии = её шаг). */
export interface SessionBinding {
  taskId: string;
  sessionId: string;
  stepId: string;
  unitId: string;
  stepKind: string;
}

/** Вердикт записи проверки (04 §Decision rules); зелёными считаются только `pass*`. */
export type RecordVerdict = VerdictName;

/**
 * Что `step_done` знает о записи: вердикт и привязка — чья задача, кто исполнил, какая проверка.
 * Захваченная сеансом запись — обратная связь, не доказательство (02:61, P92).
 */
export interface RecordFacts {
  verdict: RecordVerdict;
  checkId: string;
  taskId: string | null;
  origin: RecordOrigin;
}

export interface ModelToolDeps {
  /**
   * Хранилище записей проверок (04) — только репозитории задачи `taskId`; до фазы 3 его нет —
   * каждый номер `absent`.
   */
  records(recordId: string, taskId: string): Fact<RecordFacts>;
  humanPolicy: HumanPointPolicy;
  /** Живая проверка (зона C, `conductor/checks`); нет — ответ без вердикта (`CHECK_ABSENT`). */
  check?(task: LiveTask, b: SessionBinding, call: CheckCall): Promise<unknown>;
}

/** Что нужно ответу на вопрос о праве одной сессии: её переходник, кодек и факты копии. */
export interface PermitCallDeps {
  gate: PendingPermits;
  codec: PermitCodec;
  mapPermission(call: RawToolCall): PermissionAsk;
  context: PermitContext;
  /** Сколько ждать, пока поток сессии покажет запрос инструмента (мс). */
  settleMs: number;
}
