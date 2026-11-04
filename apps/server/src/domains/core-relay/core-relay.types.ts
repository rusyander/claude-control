import type { RelayNotice } from '@agentdeck/contracts/core/relay';

/** Одно событие SSE ядра: `id:` = `seq` строки журнала, `event:` = её вид, `data:` = строка JSON. */
export interface CoreSseEvent {
  id: string | null;
  event: string | null;
  data: string;
}

/** Задача из списка ядра — ровно то, что нужно пересылке. */
export interface RelayTask {
  taskId: string;
  live: boolean;
  title: string | null;
}

/** Что пересылке нужно от ядра. Настоящий доступ — `core-access.ts` (прокладка зоны C). */
export interface CoreRelayCore {
  /** Список задач; ядра нет или оно не сверилось — исключение (пересылка ждёт следующего круга). */
  tasks(): Promise<RelayTask[]>;
  /**
   * Состояние вопроса в виде задачи: `null` — вопроса в виде нет (вид отстал от журнала), такой
   * считается открытым: пропустить вопрос хуже, чем сообщить о нём.
   */
  askState(taskId: string, askId: string): Promise<string | null>;
  /** Поток событий задачи с места `lastEventId`; кончается, когда ядро закрыло поток. */
  events(
    taskId: string,
    lastEventId: string | undefined,
    signal: AbortSignal,
  ): AsyncIterable<CoreSseEvent>;
}

/** Вопрос ядра, о котором пора сообщить. */
export interface RelayAsk {
  notice: RelayNotice;
  question: string;
}

export interface CoreRelayDeps {
  core: CoreRelayCore;
  /** `<дом панели>/core-relay.json`: курсоры и отправленные вопросы. */
  statePath: string;
  /**
   * Сообщить людям (push, Telegram). `true` — хоть один канал принял; `false` (или исключение) —
   * сообщить некуда или все каналы упали: вопрос ждёт в `pending` и уходит следующим кругом.
   */
  deliver(ask: RelayAsk): Promise<boolean>;
  /**
   * Есть ли сейчас куда сообщать (настроен хоть один канал) — дешёвая проверка без сети. Нет —
   * ждущие вопросы не трогаются (ни вида задачи, ни попытки). Не задано — каналы считаются есть.
   */
  ready?(): boolean;
  /** Ссылка панели на задачу с вопросом. */
  link(taskId: string, askId: string): string;
  log(line: string): void;
  /** Шаг опроса списка задач. */
  intervalMs?: number;
}

export interface CoreRelay {
  /** Один круг: список задач, потоки живых открыты, потоки ушедших закрыты. */
  tick(): Promise<void>;
  start(): void;
  /** Закрыть потоки и таймер; дождаться, пока потоки допишут курсоры. */
  stop(): Promise<void>;
}
