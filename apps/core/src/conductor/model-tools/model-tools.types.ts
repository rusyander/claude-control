import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CheckCall } from '@agentdeck/contracts/core/model-tools';
import type { LiveTask } from '../../journal/resume.ts';
import type { VerdictName } from '@agentdeck/contracts/core/records';
import type { EvidenceNow, EvidenceRecord } from '../requirements/requirements.types.ts';
import type { PermissionAsk, RawToolCall } from '../../adapters/adapter.types.ts';
import type { HumanPointPolicy } from '../../policy/human-point/human-point.types.ts';
import type { PendingPermits } from '../../policy/permit/pending.ts';
import type { PermitCodec, PermitContext } from '../../policy/permit/permit.types.ts';
import type { UnitDiffDeps } from './unit-diff.ts';
import type { WalkPort } from '../../adapters/browser/browser.types.ts';

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
 * Что `step_done` знает о записи: вердикт и привязка — чья задача, кто исполнил, какая проверка —
 * и ключ с единицей (G22: доказательство — запись с ключом текущего дерева). Захваченная сеансом
 * запись — обратная связь, не доказательство (02:61, P92).
 */
export type RecordFacts = EvidenceRecord;

/**
 * Чтения `step_done` сверх записи (F-051, G22, P92): ключ проверки записи на ТЕКУЩЕМ дереве копии
 * шага (той же дорогой, какой его считает вход проверок), класс проверки и замыкание единицы, и
 * файлы, изменённые единицей против базы. Нет читателя — «покрыто» не принимается: свежесть не
 * доказана (P44).
 */
export interface EvidenceReader {
  now(task: LiveTask, b: SessionBinding, record: RecordFacts): Promise<Fact<EvidenceNow>>;
  changed(task: LiveTask, b: SessionBinding): Promise<Fact<string[]>>;
}

export interface ModelToolDeps {
  /**
   * Хранилище записей проверок (04) — только репозитории задачи `taskId`; до фазы 3 его нет —
   * каждый номер `absent`.
   */
  records(recordId: string, taskId: string): Fact<RecordFacts>;
  evidence?: EvidenceReader;
  /**
   * Политика человека ЭТОЙ задачи (06:22): пол платформы ∪ `humanPoints` конфига ∪ строки
   * `grantRequired` её проекта — читается на каждый вопрос, правка конфига действует сразу.
   */
  humanPolicy(task: LiveTask, b: SessionBinding): HumanPointPolicy;
  /** Живая проверка (зона C, `conductor/checks`); нет — ответ без вердикта (`CHECK_ABSENT`). */
  check?(task: LiveTask, b: SessionBinding, call: CheckCall): Promise<unknown>;
  /**
   * Дифф единицы шага для `unit_diff`: копия и закреплённая база единицы сессии. Нет — инструмент
   * отказывает «не подключено»; `unknown` — копию или базу не назвать, тело не читается.
   */
  unitDiff?(task: LiveTask, b: SessionBinding): Fact<UnitDiffDeps>;
  /**
   * Браузер, доступы стенда и маска сессии шага `walk` (этап 12, P177/P178). Нет — инструменты
   * браузера отвечают `not-wired`; жест вне умений (`browse_gesture`) пишется пробелом и без него.
   */
  walk?: WalkPort;
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
