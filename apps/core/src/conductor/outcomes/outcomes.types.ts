import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  ComposeDecision,
  CompositionUnit,
  RedBeforeResult,
} from '@agentdeck/contracts/core/records';
import type { CheckDeps, CheckService } from '../checks/index.ts';

/**
 * Исходы на своём этапе (04:56-86, F-037/F-041/F-107): «красный до» после шага работы над багом и
 * итог на финальной проверке. Входы — те же чтения, что у входа проверки (`CheckDeps` очереди):
 * реестр, ключ, хранилище, окружение, очередь; второго набора чтений нет.
 */
export interface OutcomeDeps {
  service: Pick<CheckService, 'requestCheck'>;
  checks: Pick<
    CheckDeps,
    | 'queue'
    | 'store'
    | 'registry'
    | 'key'
    | 'env'
    | 'quarantine'
    | 'run'
    | 'tempRoot'
    | 'now'
    | 'newId'
    | 'standEpoch'
  >;
  /** Как часто итог переспрашивает идущий прогон (мс). */
  pollMs?: number;
  /** Сколько итог ждёт один прогон (мс); по умолчанию 30 мин. */
  waitMs?: number;
}

export interface UnitRepo {
  taskId: string;
  stepId: string | null;
  project: string;
  copyDir: string;
  /** Закреплённая база задачи (`task.created.repos[].baseRef`). */
  baseRef: string;
}

export interface RedBeforeInput extends UnitRepo {
  /** `StepDef.regression.checkId` — раннер тестов, которым доказывается тест фикса. */
  checkId: string;
  /** Сколько тестов фикса доказывать (по умолчанию 5): каждый — два прогона. */
  cap?: number;
  deadlineMs?: number;
}

export interface RedBeforeDecision {
  checkId: string;
  /** Тесты фикса: прошли на итоге и лежат в изменённых файлах тестов. */
  tests: { file: string; name: string }[];
  results: RedBeforeResult[];
  /** Тест, чьё доказательство не состоялось (запись не легла, ключ не прочитан), — с причиной. */
  unknown: { test: string; why: string }[];
  /** Хотя бы один тест красный на базе и зелёный на итоге (P94). */
  proven: boolean;
}

export interface FinalGateInput extends UnitRepo {
  unitId: string;
  /** 04:83 — настройка сценария; по умолчанию `warn`. */
  coverage?: 'warn' | 'require';
  /**
   * Исходный репозиторий единицы — там лежит блок тестов (`.agent/tests`, в копию не попадает).
   * Нет — покрытие кейсами `unknown`, а не «покрыто» (G18).
   */
  sourceRepo?: string;
  scenarioRequired?: string[];
  /** Сколько раз итог гоняет недостающее и решает снова (по умолчанию 3). */
  rounds?: number;
}

export interface FinalGateOutcome {
  compositionId: string;
  decision: ComposeDecision;
  rounds: number;
  /** Прогоны, что итог запускал сам (ядро), — по раундам. */
  ran: { round: number; checkId: string; unit: string; grade: string; outcome: string }[];
  /** Записи итога — для прогонов кейсов блока тестов. */
  units: CompositionUnit[];
  /** Изменённый файл → кейсы блока тестов (`<группа>:<id>`); не прочитано — причина (G18). */
  coverage?: Fact<Record<string, string[]>>;
}
