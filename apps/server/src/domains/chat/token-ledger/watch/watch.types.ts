import type { ToolErrorKind } from './tool-outcome.ts';

/**
 * Событие сторожа — общий язык живого потока (`stream-events.ts`) и хвоста
 * транскрипта (`transcript-events.ts`). Время `t` — мс эпохи, его ставит
 * источник: в чистых функциях часов нет.
 */
export type WatchEvent =
  /**
   * Начало хода: прогон стартовал (поток) или пришла реплика человека/панели (транскрипт).
   * `fresh` — прогон начал НОВЫЙ разговор (без `--resume`): его первый вызов — первый
   * запрос сессии (R19). Транскрипт этого не знает и флаг не ставит.
   * `prev` и `cause` — у нового разговора группы (R34): последний вызов прошлого
   * разговора группы и почему панель начала новый. Ставит сторож, не поток.
   */
  | {
      kind: 'start';
      t: number;
      fresh?: true;
      prev?: { t: number; ctx: number; model?: string };
      cause?: FreshCause;
      /** Длина вводной хода, знаков (R37): промпт прогона или реплика транскрипта. */
      chars?: number;
    }
  | {
      kind: 'call';
      t: number;
      model?: string;
      input: number;
      cacheRead: number;
      cacheWrite: number;
      cacheWrite1h: number;
      output: number;
      /** Вызов субагента: в вес и «живость» идёт, в окно сессии — нет. */
      sidechain?: boolean;
      /**
       * Остаток сверки потока с итогом хода: вес без хозяина (субагенты, которых
       * поток не разложил, внутренние вызовы CLI). В расход группы (R8) идёт, в
       * расход субагентов (R13) — нет: веер без единого запуска был бы выдумкой.
       */
      remainder?: boolean;
      /**
       * Итог хода, а не один запрос: CLI назвал только сумму всех запросов хода (поток
       * Gemini CLI). В расход идёт, окно разговора (R19, R2, R34) по нему не судится.
       */
      turnTotal?: true;
    }
  | {
      kind: 'tool';
      t: number;
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Стадия звена в момент вызова (R5, R6) — ставит проводка, не поток. */
      stage?: string;
      sidechain?: boolean;
    }
  | {
      kind: 'toolResult';
      t: number;
      id: string;
      chars: number;
      /** Вызов не уложился в свой срок, мс (R15) — `tool-outcome.ts`. */
      timedOutMs?: number;
      /** Вызов отбит стражем или правом: чей отказ (R18) — `tool-outcome.ts`. */
      denied?: string;
      /** Вызов кончился ошибкой (R24, R29, R30) — `tool-outcome.ts`. */
      isError?: true;
      errorKind?: ToolErrorKind;
      /** Голова ошибки под маской: повтор той же ошибки (R24). */
      errorHead?: string;
      /** Вызов ушёл в фон под этим id (R16, фон долго) — `bg-tasks.ts`. */
      bgTaskId?: string;
    }
  /** Фоновая задача кончилась (`<task-notification>`): её запись закрыта (R16). */
  | { kind: 'bgDone'; t: number; taskId: string; status?: string }
  /** Текст ответа модели (не размышление): хвост хода — вопрос текстом (R27), вердикт ревью (R33). */
  | { kind: 'say'; t: number; text: string }
  /** Запрос к модели сорвался и повторяется (`system/api_error`, `api_retry`) — R30. */
  | { kind: 'apiError'; t: number; head: string }
  /** Сжатие окна; `manual` — `/compact` по просьбе, не буря (R3 его не считает). */
  | { kind: 'compact'; t: number; manual?: boolean }
  /** Замер пятичасового окна; `rejected` — лимит исчерпан (R10). */
  | {
      kind: 'limit';
      t: number;
      utilization?: number;
      resetsAt?: number;
      rejected?: boolean;
      /** Замер недельного окна (R9), не пятичасового. */
      week?: true;
    }
  /** Вставка CLI в окно (`environment`, `diagnostics`, контекст хуков) — знаки по роду. */
  | { kind: 'insert'; t: number; type: string; chars: number }
  /** Модель пишет текст или думает: сессия жива, хотя ни вызова, ни инструмента нет (R1). */
  | { kind: 'activity'; t: number }
  | { kind: 'end'; t: number };

/**
 * Почему панель начала новый разговор поверх тёплого (R34). Нужные: передача
 * доставке, её эскалация, звено правок, ревью, перепроверка MR, передача по блоку,
 * смена стадии. Не нужные: вводная остывшего разговора, начатая на тёплом кэше,
 * и смена модели на тёплом продолжении — запись окна заново, без которой можно было обойтись.
 */
export type FreshCause =
  | 'escalation'
  | 'deliver'
  | 'fix'
  | 'review'
  | 'recheck'
  | 'handoff'
  | 'stage'
  | 'cold-brief'
  | 'model-switch';

/**
 * Холодное продолжение у чужого CLI (R2). `off` — сигнала нет вовсе: локальная
 * модель кэша провайдера не платит, а CLI без известного формата переписки не
 * даёт следа. `readDrop` — кэш провайдера остывает за `afterMs` (свой срок, не
 * часовой Claude), а записи кэша провайдер не сообщает: след — чтение кэша,
 * упавшее после паузы, когда до неё кэш читался.
 */
export type ColdCacheRule = { kind: 'off' } | { kind: 'readDrop'; afterMs: number };
