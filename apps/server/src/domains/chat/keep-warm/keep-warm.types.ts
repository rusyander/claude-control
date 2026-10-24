import type { GroupEconomy } from '@agentdeck/contracts/group-economy';
import type { SplitGroupKeepWarm } from '@agentdeck/contracts/chat-handoff';

/**
 * Чего ждёт группа, которой пинг держит кэш: вопроса или разрешения человеку,
 * конца паузы, места в очереди тяжёлых шагов. Ожидание сброса лимита подписки
 * пинга не получает вовсе: запрос отказал бы так же, а после сброса группа
 * пойдёт сама; `limitUntil` впереди к тому же глушит пинги всех групп.
 */
export type KeepWarmWait = 'ask' | 'paused' | 'heavy-queue';

/** Последний вызов модели сессии — по хвосту её транскрипта. */
export interface SessionCallTail {
  /** Конец последнего вызова модели, мс эпохи (время записи транскрипта). */
  lastCallAt: number;
  /** Окно этого вызова: вход + чтение кэша + запись в кэш. */
  contextTokens: number;
  /**
   * Срок кэша по последней записи в кэш: `1h` — запись ушла в часовой,
   * `5m` — запись была, а часовой части в ней нет, `unknown` — записей в хвосте нет.
   */
  ttl: '1h' | '5m' | 'unknown';
}

/** Учёт пингов одного ожидания сессии (`keep-warm.json`). */
export interface KeepWarmSessionState {
  /** Ожидание, к которому относится счёт: `lastCallAt` сессии на его начале. */
  waitKey: number;
  /** Пинги этого ожидания, дошедшие до модели: сорвавшийся до неё потолок не тратит. */
  pings: number;
  /** Последняя попытка пинга — повтор сорвавшегося не раньше `KEEP_WARM_RETRY_MS`. */
  lastPingAt?: number;
  /** Последний пинг, прочитавший окно из кэша, — кэш с этого момента тёплый. */
  warmedAt?: number;
  /** Пинг записал кэш без часовой части: CLI идёт на 5m, пинги этого ожидания бесполезны. */
  ttl5m?: true;
  /**
   * Пинг этого ожидания не прочитал окно (промах): префикс пинга разошёлся с
   * ходом группы, и следующий пинг заплатил бы ту же перезапись. До нового
   * вызова модели пингов нет.
   */
  missed?: true;
  /**
   * Расход пингов этого ожидания, дошедших до модели, в токенах по цене входа.
   * Есть — итог ожидания ещё не подведён (`settleWait`); подведён — поля нет.
   */
  spent?: number;
  /** Окно, которое пинги держат: окно последнего вызова перед ожиданием. */
  contextTokens?: number;
  /** Модель хода группы — цена перезаписи окна. */
  model?: string;
  /** Счёт группы в учёте (`keepWarmGroupKey`), куда уходит итог ожидания. */
  group?: string;
  /** Параметры хода группы для пинга после перезапуска панели (`KeepWarmTemplate`). */
  template?: KeepWarmTemplate;
  /** Когда запись трогали: старые записи вычищаются. */
  touchedAt: number;
}

/**
 * Параметры хода группы, из которых собирается пинг после перезапуска панели.
 * Только то, что задаёт префикс и не несёт секретов: окружение и `platform*`
 * реестр пересчитывает на каждом старте сам, а в окружении бывают ключи.
 */
export interface KeepWarmTemplate {
  cwd: string;
  command?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  permissionPrompt?: { runId: string; baseUrl: string; tokenFile?: string };
  appendSystemPrompt?: string;
  configDir?: string;
  settingSources?: string;
  /** Источник прогона (`RunMeta.origin`): от него зависит маршрут контура. */
  origin?: string;
}

export interface KeepWarmFile {
  sessions: Record<string, KeepWarmSessionState>;
  /** Лимит подписки отказал пингу — до этого момента пингов нет ни у кого. */
  limitedUntil?: number;
  /**
   * Счёт пингов группы (`keepWarmGroupKey`) — своим срезом, а не в записи
   * разделения: запись конвейера, собранная до `await`, его не сотрёт (как F-42).
   */
  groups?: Record<string, SplitGroupKeepWarm>;
}

export interface KeepWarmInput {
  economy: Pick<GroupEconomy, 'keepWarm' | 'keepWarmPings' | 'cacheTtl'> | undefined;
  /** Порог окна сторожа (`coldContextTokens`): меньше — остывший кэш дёшев, пинг не окупится. */
  coldContextTokens: number;
  /** Чего ждёт группа; нет — она не ждёт, и греть нечего. */
  wait: KeepWarmWait | undefined;
  /** Ход сессии идёт (процесс в работе) — модель сама держит кэш. */
  running: boolean;
  tail: SessionCallTail | undefined;
  state: KeepWarmSessionState | undefined;
  /** Лимит подписки исчерпан — пинг либо откажут, либо он съест последнее. */
  rateLimited: boolean;
  now: number;
}

export type KeepWarmSkip =
  | 'off'
  | 'ttl-5m'
  /** В хвосте нет записи в кэш — часовой кэш не подтверждён (локальная модель, контур). */
  | 'ttl-unknown'
  /** Пинг этого ожидания промахнулся мимо кэша (`missed`). */
  | 'miss'
  | 'not-waiting'
  | 'running'
  | 'no-transcript'
  | 'small'
  | 'rate-limited'
  | 'cap'
  | 'not-yet'
  | 'cold';

export type KeepWarmDecision =
  { kind: 'ping'; waitKey: number; pings: number } | { kind: 'skip'; reason: KeepWarmSkip };
