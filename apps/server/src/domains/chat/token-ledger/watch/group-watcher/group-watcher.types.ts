import type { GroupWatch, GroupSignal, GroupWatchRecord } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import type { RunWatchFeed } from '../../../ChatRunRegistry/ChatRunRegistry.types.ts';
import type { LearnedDurations } from '../check-signature.ts';
import type { LimitPoint } from '../rules.ts';
import type { WatchEvent, WatchNode, WatchState } from '../watch.types.ts';

export interface ResumeSeed {
  lastCallAt: number;
  firstCtx?: number;
  /** Пинг тёплого кэша после последнего вызова (`warmed`). */
  warmedAt?: number;
  /** Чтение кэша последнего вызова — след R2 у чужого CLI. */
  lastCacheRead?: number;
}

/** Звено, к которому относится разговор: из связи в хранилище разделения. */
export interface WatchTarget {
  /** Ключ разговора для ссылки «открыть чат» — под ним связь записана. */
  chatId: string;
  parentChatId: string;
  groupIndex: number;
  stage?: string;
  /** Каталог копии звена: чтения внутри неё — свои (R7). */
  cwd?: string;
  /**
   * Одиночный чат панели (A1): связи с деревом нет. Тогда `parentChatId` — сам чат,
   * `groupIndex` — `CHAT_SCOPE_INDEX`, сигналы — в своём срезе, правила — `SINGLE_RULES`.
   */
  scope?: 'chat';
}

/** Где лежат сигналы одиночных чатов: ключ чата → блок `{ signals }` как есть с диска. */
export interface ChatSignalStore {
  get: (chatId: string) => unknown;
  /** Записать в память; на диск — `saveChat` сторожа. `undefined` — стереть. */
  set: (chatId: string, record: GroupWatchRecord | undefined) => void;
  all: () => Record<string, unknown>;
}

/** Живость группы по всем её ключам — для R22 (группа стоит без хода). */
export interface GroupLive {
  /** Прогон идёт или процесс ждёт свой фон. */
  running: boolean;
  /** Вопрос или запрос прав ждёт человека. */
  ask: boolean;
  /** Ждёт места в очереди тяжёлых шагов или держит аренду. */
  queued: boolean;
  /** Дерево на паузе («Остановить всё»). */
  paused: boolean;
}

/** Где лежат сигналы групп: родитель → номер группы → блок `{ signals }` как есть с диска. */
export interface WatchSignalStore {
  get: (parentChatId: string, groupIndex: number) => unknown;
  /** Записать в память; на диск — `save` сторожа. `undefined` — стереть. */
  set: (parentChatId: string, groupIndex: number, record: GroupWatchRecord | undefined) => void;
  /** Все блоки: сироты ищутся по ним, а не по записям разделения. */
  all: () => Record<string, Record<string, unknown>>;
}

export interface GroupWatcherDeps {
  settings: () => GroupWatch;
  /** Звено по ключам прогона; не звено группы — `undefined`, сторож молчит. */
  resolve: (chatId: string, sessionId?: string) => WatchTarget | undefined;
  /** Живая запись группы: статус и путь. Сигналы — в `signals`. */
  group: (parentChatId: string, groupIndex: number) => SplitPlanGroupRecord | undefined;
  /**
   * Срез сигналов (F-42), пишет только сторож. Нет — блок `watch` на самой
   * записи группы: так работают проверки сторожа без хранилища.
   */
  signals?: WatchSignalStore;
  /** Записать сигналы родителя на диск. */
  save: (parentChatId: string) => void;
  /** Срез сигналов одиночных чатов; нет — в памяти сторожа (проверки). */
  chatSignals?: ChatSignalStore;
  /** Записать сигналы одиночного чата на диск и разослать вкладкам. */
  saveChat?: (chatId: string) => void;
  /**
   * Живость группы для R22; нет — R22 молчит. `keys` — ключи её разговоров, которые
   * сторож видит под наблюдением (к ключам из связей дерева).
   */
  groupLive?: (
    parentChatId: string,
    group: SplitPlanGroupRecord,
    keys: readonly string[],
  ) => GroupLive;
  /** Когда группа последний раз писала (переписка её звеньев) — затравка тишины R22 после перезапуска. */
  groupSeenAt?: (parentChatId: string, group: SplitPlanGroupRecord) => number | undefined;
  /** Все разделения (живые записи): закрыть активные сигналы, за которыми сессии нет. */
  plans?: () => Record<string, { groups: readonly SplitPlanGroupRecord[] }>;
  /** Что знает панель о звене сейчас: идёт ли группа, вопрос человеку, очередь. */
  node: (target: WatchTarget, keys: readonly string[]) => Omit<WatchNode, 'chatId' | 'groupIndex'>;
  /** Каталог транскриптов субагентов сессии; нет — хвоста нет. */
  subagentDir?: (sessionId: string) => string | undefined;
  /**
   * Транскрипт самой сессии — для прогона без потока (`detached`) и начала окна после перезапуска.
   * `hint` — у чужого CLI: чей формат, каталог копии и начало хода (по ним ищется
   * файл первого хода, пока id сессии ещё не известен).
   */
  transcript?: (sessionId: string, hint?: TranscriptHint) => string | undefined;
  /** Настоящий ключ разговора: временный `new-…` после рождения сессии — её id. */
  canonical?: (chatId: string) => string;
  /** Замеры окна всех прогонов аккаунта (журнал лимита) — к живым замерам потока для R9. */
  limitSamples?: () => readonly LimitPoint[];
  /** Сигнал «внимание»/«тревога» поднят впервые — уведомить (каналы решают сами). */
  notify?: (signal: GroupSignal, target: WatchTarget) => void;
  panelRoot?: string;
  /** Домашний каталог и путь 8.3 → полный: чтения панели (R7) под любым написанием. */
  home?: string;
  realPath?: (path: string) => string | undefined;
  learned?: () => LearnedDurations | undefined;
  /**
   * Свой срок остывания кэша чужого CLI (проверки, `AGENTDECK_FOREIGN_COLD_AFTER_MS`) —
   * тот же, что у решения «начать новую сессию»; нет — срок провайдера.
   */
  foreignColdAfterMs?: () => number | undefined;
  /** Слушает ли порт на этой машине — по последней пробе (R36); нет — R36 молчит. */
  portAlive?: (port: number) => boolean;
  now?: () => number;
  makeId?: () => string;
  log?: (message: string, error?: unknown) => void;
}

/** Подсказка поиска переписки чужого CLI: провайдер, каталог копии, начало хода. */
export interface TranscriptHint {
  provider: string;
  cwd?: string;
  since?: number;
}

/**
 * Лента сторожа: реестр прогонов Claude (`RunWatchFeed`) и чужой CLI — его старт
 * несёт провайдера: переписку CLI сторож читает своим разбором (`foreign-events`).
 * `local` — ход идёт на локальной модели: кэша провайдера нет, R2 молчит.
 */
export type GroupWatchFeed =
  | Exclude<RunWatchFeed, { kind: 'start' }>
  | (Extract<RunWatchFeed, { kind: 'start' }> & { provider?: string; local?: boolean });

export interface Session {
  state: WatchState;
  target: WatchTarget;
  keys: Set<string>;
  sessionId?: string;
  /** Чужой CLI (`codex`, `qwen`…): переписка — его формата, субагентов Claude у него нет. */
  provider?: string;
  /** Нынешний ход чужого CLI — на локальной модели (R2 без сигнала). */
  local?: boolean;
  /** Начало нынешнего хода: файл первого хода, начатый после него, читается с начала. */
  turnAt?: number;
  node: Omit<WatchNode, 'chatId' | 'groupIndex'>;
  /** Хвост субагентов дал вызовы в этом ходе — остаток сверки в поток не берём (двойной счёт). */
  tailCalls: number;
  readTail?: (row: unknown) => WatchEvent[];
  /** Прогон без потока (подхвачен после перезапуска): сессия читается из своего транскрипта. */
  detached?: boolean;
  /** Ход начат и не кончен: чужой CLI идёт мимо реестра, живость его группы (R22) — отсюда. */
  turnOpen?: boolean;
  readMain?: (row: unknown) => WatchEvent[];
}
