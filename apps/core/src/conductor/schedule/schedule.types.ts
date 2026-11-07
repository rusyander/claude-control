import type { QueueClass } from '@agentdeck/contracts/core/records';

/**
 * Порядок работ (02:80-82): кто из ждущих единиц получает свободный слот сессии. Кандидат —
 * единица со следующим шагом наготове; класс берётся по виду этого шага.
 */

export interface ScheduleCandidate {
  unitId: string;
  /** Вид следующего шага сценария (`StepKind`); класс — `stepClassOf`. */
  stepKind: string;
  /** Единица уже шла (у неё был шаг): ближайшая к концу идёт первой. */
  started: boolean;
  /** Остаток оценки начатой единицы; `null` — не известен. */
  remainingMs: number | null;
  /** Выученная длительность новой единицы по её области; `null` — истории нет. */
  learnedMs: number | null;
  /** С какого момента кандидат ждёт слота — FIFO и старение. */
  waitingSince: number;
  /** Места сеансов: предел держащих для этого кандидата — min(профиль, `sessionSlots`). */
  limit?: number;
  /** Места сеансов: маршрут шага и его ёмкость (`null` — без своего предела). */
  route?: string;
  routeCap?: number | null;
}

export interface ScheduleInput {
  candidates: readonly ScheduleCandidate[];
  freeSlots: number;
  now: number;
  /** За каждые `agingMs` ожидания кандидат поднимается на класс: никто не голодает. */
  agingMs: number;
  /**
   * Места сеансов (этап 11): места, которые уже держат (без чатов). Задано — судья выдаёт места
   * по пределам кандидатов и ёмкости маршрутов, `freeSlots` — сколько мест машины свободно.
   */
  held?: readonly { route: string }[];
}

/** Почему кандидат без места: предел держащих (или ждёт за головой очереди) либо полный маршрут. */
export type SeatBlock = 'slot' | 'route';

export interface ScheduleRow {
  unitId: string;
  cls: QueueClass;
  /** Ранг после старения: меньше — раньше. */
  rank: number;
  why: string;
}

export interface ScheduleDecision {
  /** Все кандидаты по порядку. */
  order: ScheduleRow[];
  /** Первые `freeSlots` из порядка — им слот сейчас. */
  grant: string[];
  reasons: string[];
  /** Места сеансов: кто ждёт и почему. */
  blocked?: Record<string, SeatBlock>;
}

/**
 * Место сеанса шага (этап 11, D9, P141): что исполнитель задачи знает о шаге, которому нужен
 * сеанс модели. Предел профиля, `sessionSlots` и ёмкость маршрута считает проводка
 * распределителя — исполнитель их не знает.
 */
export interface SeatAsk {
  taskId: string;
  stepId: string;
  unitId: string;
  stepKind: string;
  routeId: string;
  /** Сеанс чата: строка «interactive», вне счёта мест. */
  interactive: boolean;
  started: boolean;
  remainingMs: number | null;
  learnedMs: number | null;
}

/** Кто держит место, за которым ждёт шаг: задача и её сеанс (`null` — сеанс ещё не открыт). */
export interface SeatHolder {
  taskId: string;
  sessionId: string | null;
}

export type SeatAnswer =
  | { granted: true; ticketId: string; decision: ScheduleDecision }
  | {
      granted: false;
      ticketId: string | null;
      reason: string;
      holder: SeatHolder | null;
      decision: ScheduleDecision | null;
    };

/**
 * Порт распределителя для исполнителя задачи (`RunDeps.allocator`). Нет порта — места не
 * считаются (ядро до этапа 11 и тесты исполнителя без распределителя).
 */
export interface SeatPort {
  /** Взять место шагу (повтор того же шага — тот же билет). */
  acquire(ask: SeatAsk): Promise<SeatAnswer>;
  /** Сеанс открыт: держатель места — его хост (личность читается из журнала задачи). */
  bind(taskId: string, stepId: string, sessionId: string): void;
  /** Вернуть место (конец сеанса, пауза, вопрос человеку). Нет места — ничего. */
  release(taskId: string, stepId: string, why: string): void;
  /** Будить исполнителя, когда место где-то освободилось; вернёт отписку. */
  subscribe(wake: () => void): () => void;
}
