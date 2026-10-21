import type {
  GroupSignalSeverity,
  GroupWatch,
  GroupWatchRule,
} from '@agentdeck/contracts/group-watch';
import type { LearnedDurations } from './check-signature.ts';

/**
 * Событие сторожа — общий язык живого потока (`stream-events.ts`) и хвоста
 * транскрипта (`transcript-events.ts`). Время `t` — мс эпохи, его ставит
 * источник: в чистых функциях часов нет.
 */
export type WatchEvent =
  /** Начало хода: прогон стартовал (поток) или пришла реплика человека/панели (транскрипт). */
  | { kind: 'start'; t: number }
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
  | { kind: 'toolResult'; t: number; id: string; chars: number }
  /** Сжатие окна; `manual` — `/compact` по просьбе, не буря (R3 его не считает). */
  | { kind: 'compact'; t: number; manual?: boolean }
  /** Замер пятичасового окна; `rejected` — лимит исчерпан (R10). */
  | { kind: 'limit'; t: number; utilization?: number; resetsAt?: number; rejected?: boolean }
  /** Вставка CLI в окно (`environment`, `diagnostics`, контекст хуков) — знаки по роду. */
  | { kind: 'insert'; t: number; type: string; chars: number }
  | { kind: 'end'; t: number };

/** Вызов модели в кольце состояния. */
export interface WatchCall {
  t: number;
  ctx: number;
  cacheRead: number;
  cw1h: number;
  cw5m: number;
  out: number;
  model?: string;
  weight: number;
  sidechain?: boolean;
}

export interface OpenTool {
  name: string;
  startedAt: number;
  /** Срок самого вызова (Bash `timeout`); нет — срок по умолчанию инструмента. */
  timeoutMs?: number;
  background?: boolean;
  question?: string;
}

/** Состояние одной сессии. Ограничено: кольцо вызовов 200, списки и словари — по своим потолкам. */
export interface WatchState {
  calls: WatchCall[];
  lastEventAt: number;
  /** Ход начался, и первого вызова после него ещё не было — для R2. */
  awaitingFirstCall: boolean;
  lastCallAt?: number;
  /** Окно первого вызова сессии, если сторож его видел, — база свежего старта. */
  firstCtx?: number;
  openTools: Record<string, OpenTool>;
  compactions: number[];
  /** Подпись проверки → запуски подряд без правки между. */
  checks: Record<string, { runs: number; lastAt: number; command: string }>;
  /** Путь → чтения подряд без правки этого файла. */
  reads: Record<string, { count: number; lastAt: number }>;
  lastEditAt?: number;
  subagents: Array<{ at: number; description: string; agentType: string; stage?: string }>;
  insertChars: Record<string, number>;
  writeOps: Array<{ at: number; op: string; stage?: string }>;
  panelReads: Array<{ at: number; path: string }>;
  sleepPolls: Array<{ at: number; command: string }>;
  /** `write1h` — часть записи в часовой кэш: остальное пишется по цене пятиминутного. */
  coldWrites: Array<{
    at: number;
    write: number;
    write1h: number;
    ctx: number;
    gapMs: number;
    base: number;
  }>;
  limits: Array<{ t: number; utilization: number; resetsAt: number }>;
  rejectedAt?: number;
  rejectedResetsAt?: number;
  endedAt?: number;
}

/** Что сторож знает о звене в момент оценки — из хранилища разделения, не из потока. */
export interface WatchNode {
  chatId: string;
  groupIndex: number;
  stage?: string;
  running: boolean;
  paused: boolean;
  /** Открытый вопрос человеку: с какого момента и текст (R1b). */
  ask?: { since: number; question?: string };
  /** У сессии живая аренда очереди тяжёлых шагов — долгая проверка, не зависание. */
  heavyLease?: boolean;
  /** Звено доставки группы ещё впереди: пуш и MR — его работа (R6). */
  deliverAhead?: boolean;
}

/** Условие правила сейчас: активно ли, числа и подстановки строки. */
export interface RuleHit {
  rule: GroupWatchRule;
  severity: GroupSignalSeverity;
  numbers: Record<string, number>;
  params?: Record<string, string>;
  /** Когда условие возникло (для поля `at` сигнала). */
  since: number;
}

/** Окружение оценки: пороги, корень панели (R7), каталог копии. */
export interface WatchContext {
  settings: GroupWatch;
  /** Корень репозитория самой панели: чтение оттуда из копии — R7. */
  panelRoot?: string;
  /** Каталог, в котором идёт звено (копия): чтения внутри неё — свои. */
  cwd?: string;
  /** Опыт длительностей очереди тяжёлых шагов: долгий скрипт — тоже проверка (R4). */
  learned?: LearnedDurations;
}
