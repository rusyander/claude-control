import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import type { StepRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { ContourPolicy } from '../../policy/resolve/resolve.types.ts';
import type { XlChildren } from '../split/xl-wait.ts';

/**
 * Типы `conductor/next` (02 §Conductor loop): чистый суд над свёрткой журнала и живыми фактами
 * этого процесса. Исполнитель ничего не решает — он исполняет `NextAction` (P01).
 */

/** Почему шаг сценария начинается заново (G14). */
export type RoundWhy =
  | 'first'
  | 'red'
  | 'no-outcome'
  | 'review-round'
  | 'fix'
  | 'stale'
  /** Конфликт с базой (G1, G14): шаг правки сливает базу — до MR после остановленной перебазировки. */
  | 'resolve-conflict'
  /** Публикация снова: форж ожил после ожидания, вопрос человека отвечен, средство отказа сработало. */
  | 'retry';

/**
 * Что дальше после отказа шага публикации (`step.ended.reason` = `publish-refused: <next>: …`):
 * `regate` — ядро перебазировало ветку, дерево сменилось, финальная проверка заново;
 * `reintegrate` — голова единицы не в последнем зелёном слиянии интеграции (Q-1 s11): новый круг
 * ворот интеграции, публикация ждёт его зелёного (`gates/integrated.ts`).
 */
export const PUBLISH_NEXT = [
  'fix-step',
  'resolve-conflict',
  'ask',
  'wait-forge',
  'regate',
  'reintegrate',
] as const;
export type PublishNext = (typeof PUBLISH_NEXT)[number];

export type UnitEndEvent =
  'ready' | 'close' | 'published' | 'threads-found' | 'no-threads' | 'answered';

/** Пункты точки человека, которые называет сам дирижёр (G15). */
export type ConductorPoint = 6 | 7 | 8;

export type NextAction =
  /** Задача без единиц и без деления — одна единица (solo, 02:22). */
  | { kind: 'create-unit' }
  | { kind: 'start-unit'; unitId: string }
  | { kind: 'start-step'; unitId: string; stepDefId: string; round: number; why: RoundWhy }
  /** Прежняя попытка закрывается (`superseded`), следующий круг — новый `stepId` (G14). */
  | { kind: 'reenter-step'; stepId: string; round: number; why: 'red' }
  /** Шаг без живой сессии в этом процессе: прикрепить прежнюю или запустить новую. */
  | { kind: 'run-step'; stepId: string }
  /** Шаг ядра без сессии модели: `check`, `final-gate`, `ask-human`. */
  | { kind: 'run-core-step'; stepId: string }
  /** Заявление принято (`checking`): факты после шага и ворота — крючки `postStep`. */
  | { kind: 'post-step'; stepId: string }
  | { kind: 'remind'; stepId: string; sessionId: string; turnSeq: number; count: number }
  /** Ни `step_done`, ни `blocker` после напоминаний: исход по git и записям (02:47). */
  | { kind: 'derive-outcome'; stepId: string }
  | { kind: 'stop-step'; stepId: string; reason: string }
  /**
   * Пауза или срок: сессия снимается в безопасной точке (`soft`) или сразу (`tree`, G10).
   * `observer` — сессия просила паузу сигналом наблюдателя (`SessionRecord.parkAsked`, этап 8).
   */
  | {
      kind: 'park-session';
      stepId: string;
      mode: 'soft' | 'tree';
      why: 'pause' | 'budget' | 'window' | 'observer';
    }
  | { kind: 'extend-budget'; stepId: string; limitMs: number }
  /** Продление бюджета токенов шага (G10): строка `budget.state` области `tokens:step:<id>`. */
  | { kind: 'extend-tokens'; stepId: string; limitTokens: number }
  /** Ответ на вопрос шага пришёл: `waiting-human` / `round-capped` → `running`. */
  | {
      kind: 'answered';
      stepId: string;
      askId: string;
      /**
       * Ответ точки 7 исчерпанного маршрута выбрал вариант `model:<id>` / `cli:<id>` (P169):
       * исполнитель пишет правку задачи с основанием — id вопроса — до перехода шага.
       */
      override?: { field: 'model' | 'adapter'; value: string };
    }
  /** Шаг `ask-human` закрыт ответом человека (точка 8). */
  | { kind: 'close-human-step'; stepId: string; askId: string }
  /** Шаг `chat` закрыт командой человека `end-chat` (`cmdId` — основание в `step.ended`). */
  | { kind: 'close-chat'; stepId: string; cmdId: string }
  /** Шаг вопроса «ask» закрыт ядром на конце первого хода (этап 10, F2). */
  | { kind: 'close-ask'; stepId: string }
  | {
      kind: 'raise';
      point: ConductorPoint;
      stepId: string;
      dedupe: string;
      question: string;
      options: string[];
      recommendation: string;
      /** Шаг ещё идёт — сначала `round-cap` машины шага (02:51). */
      capStep: boolean;
    }
  | {
      kind: 'skip-step';
      unitId: string;
      stepDefId: string;
      round: number;
      basis: 'core';
      reason: string;
    }
  /**
   * Переход машины единицы (`core/states.ts`): `ready` — всё до публикации сделано, `published` —
   * шаг публикации сдан, `threads-found` / `no-threads` — по единственному чтению при открытии MR,
   * `answered` — хвост после публикации сдан.
   */
  | { kind: 'end-unit'; unitId: string; event: UnitEndEvent; reason: string }
  /** Родитель XL: части, чьи зависимости сданы, становятся дочерними задачами (Q-2 s11). */
  | { kind: 'launch-children'; names: string[] }
  | { kind: 'finish-task' }
  | { kind: 'fail-task'; reason: string }
  | { kind: 'cancel-task'; reason: string }
  /**
   * Ждать: `untilWorkMs` — рабочее время задачи, когда истечёт ближайший срок шага;
   * `untilWallMs` — стена, когда окно маршрута сбросится (03:157).
   */
  | {
      kind: 'wait';
      reason: string;
      untilWorkMs?: number;
      untilWallMs?: number;
      /**
       * Ждёт окно маршрута без живой сессии (этап 12): задача входит в `waiting-window` (01:119 —
       * время работы его не считает), выходит из него, когда суд велит не ждать. Нет — другое
       * ожидание (сессия, место, вопрос).
       */
      window?: { stepId: string; routeId: string };
    };

/** Факты живой сессии шага в этом процессе — их нет в журнале (конец хода не журналится, F08). */
export interface LiveStepFact {
  sessionId: string;
  /** Конец хода по нашей отправке, ещё не отвеченный дирижёром; `seq` — журнал в тот миг. */
  turnEnd: { seq: number } | null;
  /** Процесс сессии кончился (поток закрыт). */
  ended: boolean;
  /** Итог `decideSafepoint` для этой сессии сейчас. */
  safe: boolean;
}

export interface NextInput {
  state: TaskFoldState;
  scenario: Scenario;
  /** Рабочее время задачи сейчас: свёртка + живой хвост после последней строки (01 §Time). */
  workNowMs: number;
  live: Readonly<Record<string, LiveStepFact>>;
  /** Окно маршрута по `stepId` идущей попытки; нет — окно этот шаг не держит. */
  windows?: Readonly<Record<string, StepWindow>>;
  /** Выученный предел токенов по `stepId` (p90 × 1.5, `economy/budget`); нет — только сценарий. */
  learnedTokens?: Readonly<Record<string, number>>;
  /**
   * Шаги, ждущие места сеанса (этап 11, P141), с причиной: суд ждёт их, а не велит `run-step` на
   * каждой строке задачи — иначе ждущая единица заслоняла бы соседей, держащих место. Сеанс,
   * отдавший место на вопросе человеку и ждущий его назад, тоже стоит.
   */
  seats?: Readonly<Record<string, string>>;
  /**
   * Стена сейчас — срок ожидания форжа (`publish.backoff`) считается по стене строки; нет —
   * срок считается истёкшим (чистый суд без часов не держит публикацию вечно).
   */
  nowMs?: number;
  /**
   * Дети XL этой задачи (Q-2 s11, `split/xl-wait.ts`): есть — родитель кончается по ним, а не
   * на запуске; нет — задача не родитель XL.
   */
  children?: XlChildren;
  /**
   * Активный контур панели (уровень 1, s10 G7): второе ревью судит набор CLI после контура — тот
   * же, что суд `tier` шага (W3-D). Нет — без контура.
   */
  contour?: ContourPolicy;
}

/**
 * Окно маршрута, куда идёт попытка шага модели (этап 5, W): вердикты судьи `economy/window`
 * по этому маршруту сейчас. Точка 7 при исчерпании — при любом числе других годных маршрутов
 * (P169): уйти на них можно только кликом. Вердикт `offline` проводка ставит только маршрутам,
 * которым нужна сеть (P116).
 */
export interface StepWindow {
  routeId: string;
  decisions: readonly WindowDecision[];
  /**
   * Варианты клика человека у начатой задачи (P169, `tier.offers`): `model:<id>` и `cli:<id>`.
   * Окно её маршрут не двигает — точка 7 при исчерпании предлагает их. Нет — пусто.
   */
  offers?: readonly string[];
}

/** Попытка шага сценария: одна строка `step.started` и её свёртка. */
export interface Attempt {
  stepId: string;
  rec: StepRecord;
}

export interface UnitView {
  unitId: string;
  /** По `stepDefId`: попытки в порядке `startedSeq`. */
  byDef: Map<string, Attempt[]>;
  /** Незаконченная попытка (шаги единицы идут по одному). */
  active: Attempt | null;
}

/** Коды причины `step.ended` (`<code>: подробности`): по ним `next` отличает повтор от провала. */
export const END_REASON = {
  noOutcome: 'no-outcome',
  superseded: 'superseded',
  budget: 'budget',
  stopped: 'stopped',
  hook: 'hook',
  roundCap: 'round-cap',
  cleanReview: 'review-clean',
  /** Отказ публикатора одним отказом (P03): `publish-refused: <PublishNext>: <условия>`. */
  publishRefused: 'publish-refused',
  /** Нет крючка публикатора: шаг не может сдаться «да» — публикации не было. */
  publisherUnwired: 'publisher-unwired',
  /** Ответ ревьюерам без открытых нитей и конфликта (05 §After publish). */
  noThreads: 'no-threads',
  human: 'human',
  derived: 'derived',
  claimed: 'claimed',
  noRoute: 'no-route',
  briefOverBudget: 'brief-over-budget',
  /** Чат закрыт человеком (`end-chat`, этап 10). */
  endChat: 'end-chat',
  /**
   * Сеанс чата кончился без `end-chat` (CLI упал, хост умер): шаг останавливается, продолжение
   * разговора — дело возобновления (зона F2), а не молчаливый новый сеанс.
   */
  chatSessionEnded: 'chat-session-ended',
  /** Вопрос «ask» отвечен: конец первого хода закрывает шаг (этап 10, F2). */
  askAnswered: 'ask-answered',
} as const;

/**
 * Русские подписи вариантов на точки дирижёра. Английские и сверка ответа по ключу — `answers.ts`;
 * эти строки не меняются: ими записаны ответы в журналах задач, поднятых до перевода.
 */
export const ROUND_CAP_ANSWERS = {
  more: 'Ещё один круг',
  stop: 'Остановить единицу',
  cancel: 'Отменить задачу',
} as const;
export const BUDGET_ANSWERS = { more: 'Продлить срок', stop: 'Остановить шаг' } as const;
/** Точка 7 исчерпанного маршрута (P122): отметку снимает только команда человека. */
export const EXHAUSTED_ANSWERS = { wait: 'Ждать пополнения', stop: 'Остановить шаг' } as const;

/** Решение класса `next` (00 §Decision classes): действие, причины, строки-входы. */
export interface NextStepDecision {
  action: NextAction;
  reasons: string[];
  inputs: number[];
}
