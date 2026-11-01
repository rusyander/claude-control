import type { HumanAskSource } from '@agentdeck/contracts/core/journal';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import type { Scenario, ScenarioRef, StepDef } from '@agentdeck/contracts/core/scenario';
import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { SendOrigin } from '@agentdeck/contracts/core/user-layer';
import type { LiveTask } from '../../journal/resume.ts';
import type { PublishNext } from '../next/next.types.ts';
import type { RoutingEnv, StepRouting } from '../scenario/index.ts';

/**
 * Шов исполнителя дирижёра (этап 4, CD§9): исполнитель (`conductor/run/`) зовёт зоны только через
 * эти крючки, зоны не зовут друг друга. Типы решений живут у владельцев (P01: `NextStepDecision`
 * в `conductor/next/`, `SafepointDecision` в `conductor/safepoint/`), здесь — только шов.
 */

export interface UnitCtx {
  taskId: string;
  unitId: string;
  repoKey: string;
  /** null, пока крючок копии (зона F) её не подготовил. */
  copyDir: string | null;
}

export interface StepCtx extends UnitCtx {
  stepId: string;
  def: StepDef;
  round: number;
  sessionId: string | null;
  /**
   * Куда идёт шаг (зона A, `routeStep`): модель по суду `tier` и продолжение сессии. Есть у шага
   * с сессией модели с первого запуска; исполнитель уровень сам не выбирает.
   */
  routing?: StepRouting;
}

export type BriefSectionId =
  | 'task'
  | 'step'
  | 'knowledge'
  | 'requirements'
  | 'handoff'
  | 'failing'
  | 'findings'
  | 'external-edits'
  | 'human-message'
  | 'answer'
  | 'ownership'
  | 'copy-setup'
  | 'profile'
  | 'reminder'
  | 'threads';

export interface BriefSection {
  id: BriefSectionId;
  text: string;
  /** Модуль-владелец — для журнала и ленты. */
  from: string;
}

export type HookVerdict =
  { ok: true } | { ok: false; stop: 'step' | 'unit'; code: string; reason: string };

export interface Outgoing {
  text: string;
  /** `hint` — пачка подсказок наблюдателя в конце хода, id = decisionId последней (этап 8, F8). */
  ref: { kind: 'message' | 'answer' | 'late-answer' | 'reminder' | 'hint'; id: string };
}

/**
 * Каждая зона отдаёт один `ConductorHooks` из `bootstrap/conductor-wiring/<zone>.ts`; `index.ts`
 * складывает их в постоянном порядке. Нет крючка — зона в этой точке ничего не решает.
 */
export interface ConductorHooks {
  /** F — копия, D — карта владения. */
  onUnitStart?(u: UnitCtx): Promise<{ verdict: HookVerdict; sections: BriefSection[] }>;
  /** A — бриф и уровень модели, C, E, F. */
  preStep?(s: StepCtx): Promise<{ verdict: HookVerdict; sections: BriefSection[] }>;
  /** B — напоминания, E — доставка сообщений и ответов. */
  onTurnEnd?(
    s: StepCtx,
    turn: { seq: number; hadStepDone: boolean },
  ): Promise<{ send: Outgoing[] }>;
  /** C, D, F. */
  postStep?(
    s: StepCtx,
    claim: StepDoneCall | null,
  ): Promise<{ verdict: HookVerdict; facts: Record<string, unknown> }>;
  /**
   * F — состав финальной проверки, P — композиция коммитов под этот состав. `prior` — сложенный
   * итог крючков раньше по порядку сборки: поздний крючок видит id состава раннего.
   */
  onFinalGate?(
    u: UnitCtx,
    prior?: { verdict: HookVerdict; compositionId: string | null },
  ): Promise<{ verdict: HookVerdict; compositionId: string | null }>;
  /**
   * P — шаг публикации (05 §Push and MR): готовность, синхронизация, push, MR, единственное чтение.
   * `compositionId` — состав последней сданной финальной проверки единицы. `null` — крючок не
   * публикует этот шаг (ответ даст другой крючок).
   */
  onPublish?(s: StepCtx, compositionId: string | null): Promise<PublishOutcome | null>;
  /** E — уборка, F — снятие копии. */
  onUnitEnd?(u: UnitCtx): Promise<void>;
  /** E — отчёт и уборка. */
  onTaskEnd?(taskId: string, at: 'ended'): Promise<void>;
}

/**
 * Итог шага публикации: опубликовано (MR есть, чтение сделано) или один отказ со всеми
 * несоблюдёнными условиями и тем, что дальше (P03). Ожидание форжа — тоже отказ (`wait-forge`).
 */
export type PublishOutcome =
  { kind: 'published'; mrIid: number } | { kind: 'refused'; next: PublishNext; unmet: string[] };

/**
 * Один подъём вопроса для всех источников (G15): MCP `ask_human`/`blocker`, отказ допуска, сам
 * дирижёр (точки 6/7/8/10) и сверка outbox (`reconcile`, точка 4).
 */
export interface HumanPointRaise {
  source: HumanAskSource;
  stepId: string | null;
  sessionId: string | null;
  action: { kind: string; target: string } | null;
  /** Точки ядра названы прямо; MCP и допуск идут через `decideHumanPoint`. */
  point: 4 | 6 | 7 | 8 | 10 | null;
  dedupe: string | null;
  question: string;
  options: string[];
  recommendation: string;
  blocking: boolean;
}

/** Выход `conductor/next` — живёт у судьи (`conductor/next/next.types.ts`), здесь только ссылка. */
export type { NextAction } from '../next/next.types.ts';

/** События живой сессии шага, уже без истории прикреплённого потока (F-105). */
export interface SessionEvents {
  turnEnded(): void;
  /** Инструмент запрошен (`+1`) или вернул результат (`-1`): безопасная точка (G10). */
  tool(delta: 1 | -1): void;
  ended(): void;
}

/**
 * Дорога сессии для исполнителя: прикрепить прежнюю живую или запустить новую, послать, снять.
 * Ядро — `bootstrap/conductor-wiring/loop.ts` поверх `SessionRoad`; тесты — подделка.
 */
export interface SessionPort {
  open(
    s: StepCtx,
    brief: BriefSection[],
    on: SessionEvents,
  ): Promise<{ ok: true; sessionId: string; resumed: boolean } | { ok: false; reason: string }>;
  /**
   * `cmdId` — ключ дубля: та же отправка после перезапуска ядра не уходит второй раз. `origin` —
   * чья отправка (P37): слово человека получает строку `agentdeck-from: human`; нет — платформа.
   */
  send(sessionId: string, text: string, cmdId: string, origin?: SendOrigin): Promise<void>;
  end(sessionId: string, mode: 'soft' | 'tree'): Promise<void>;
}

export interface RunDeps {
  hooks: readonly ConductorHooks[];
  scenarioOf(ref: ScenarioRef): Scenario | undefined;
  sessions: SessionPort;
  /** Один подъём вопроса (G15) — `raiseHumanPoint` зоны E. */
  raise(r: HumanPointRaise): { kind: string; askId?: string };
  /** Каталог копии единицы, когда крючок копии её сделал; иначе null. */
  copyDirOf?(unitId: string): string | null;
  now(): number;
  note?(event: string, data: Record<string, unknown>): void;
  /**
   * Шаг ухода за открытыми вопросами (E: напоминания, срок): ожидание без событий иначе их не
   * сделает. По умолчанию минута.
   */
  upkeepEveryMs?: number;
  /** Экономика этапа 5 (окно, продолжение, бриф, токены); нет — шаги идут, как на этапе 4. */
  economy?: RunEconomy;
}

/**
 * Порт экономики исполнителя (этап 5, W): судьи живут у владельцев (окно — L, модель и
 * продолжение — E, бриф и дельта — C), здесь только то, что исполнитель у них спрашивает.
 * Собирает его `bootstrap/economy-wiring/continuation.ts`.
 */
export interface RunEconomy {
  /** Вердикты окна маршрута сейчас: книга окон (L) и сеть до маршрута (P116). */
  windows(routeId: string): readonly WindowDecision[];
  /** Вход суда маршрута шага: окна всех маршрутов набора задачи (судья `tier` пропускает держащие). */
  routingEnv?(task: LiveTask): RoutingEnv;
  /** Бриф сверх бюджета — причина с корзинами (03:136); `null` — в бюджете. До запуска сессии. */
  briefRefusal?(task: LiveTask, s: StepCtx, sections: readonly BriefSection[]): string | null;
  /**
   * Первое сообщение открытой сессии: бриф новому сеансу, дельта возобновлённому разговору;
   * `null` — модель уже всё видела. Пишет `brief.sent` (C). Бросает `BriefOverBudget`. Шагу
   * ревью к нему — пакет единицы (дифф читается из git, поэтому ответ может быть обещанием).
   */
  opening?(
    task: LiveTask,
    s: StepCtx,
    sessionId: string,
    sections: readonly BriefSection[],
  ): string | null | Promise<string | null>;
  /** Выученный предел токенов шага (p90 × 1.5); нет — только сценарий. */
  learnedTokens?(
    task: LiveTask,
    step: { stepId: string; unitId: string; kind: string },
  ): number | undefined;
  /** Перепроверка окна без срока сброса (сеть, исчерпание), мс; по умолчанию 5 с. */
  recheckMs?: number;
  /**
   * Прогрев кэша (G8): по живым сессиям в конце хода — каким послать слово прогрева (решает E,
   * `decideKeepWarm`). Отправляет и журналит исполнитель; зовётся по такту.
   */
  keepWarm?(task: LiveTask, idle: readonly IdleSession[]): KeepWarmPing[];
  /** Такт прогрева, мс; по умолчанию минута. */
  keepWarmTickMs?: number;
}

/** Живая сессия в конце хода, без открытого инструмента. */
export interface IdleSession {
  sessionId: string;
  stepId: string;
  /** seq конца последнего хода шага (пинг его не двигает): новое ожидание — новый счёт пингов. */
  turnSeq: number;
  /** Шаг стоит не по воле модели: открыт вопрос человеку по нему — ход кэш не держит. */
  parked: boolean;
}

export interface KeepWarmPing {
  sessionId: string;
  word: string;
  /** Числа и причины решения — в строку журнала. */
  reasons: string[];
  numbers: Record<string, number>;
}

export interface RunHandle {
  /** Исполнитель остановлен: живые сессии сняты `soft`, задача не тронута — её продолжит `resume()`. */
  stop(sessions?: 'end' | 'keep'): Promise<void>;
  /**
   * Ближайшее «ждать», когда в этом процессе ничего не идёт: ни одной работающей сессии, ни
   * таймера срока. Ответ — причина ожидания (конец задачи, вопрос человеку, фаза 6).
   */
  idle(): Promise<string>;
  /** Решить заново сейчас: часы прыгнули (сон машины) или срок вычислен вне таймера. */
  wake(): void;
}

/** Живая сессия шага в этом процессе (конец хода не журналится, F08). */
export interface LiveSession {
  sessionId: string;
  turnEnd: { seq: number } | null;
  ended: boolean;
  toolsOpen: number;
  /** seq последней нашей отправки: `step_done` после неё — ход «с заявлением». */
  sentSeq: number;
  /** seq журнала, на котором для этого конца хода уже искали недоставленное слово человека. */
  checkedSeq?: number;
  /**
   * Идёт ход прогрева (G8): его конец и инструменты не события шага — конец хода шага остаётся
   * прежним, напоминание и суд `next` пинга не видят.
   */
  warming?: boolean;
}
