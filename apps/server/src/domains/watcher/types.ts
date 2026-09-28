import type {
  WatchEntryClass,
  WatchSeverity,
  WatchSignalKind,
  WatchSignalSource,
  WatchVerdict,
  WatcherProblem,
  WatcherSpend,
} from '@agentdeck/contracts';

/** Сырой сигнал о сбое — до склейки одинаковых. */
export interface WatchSignal {
  source: WatchSignalSource;
  kind: WatchSignalKind;
  message: string;
  stack?: string;
  /** Маршрут страницы (клиент) или шаблон маршрута сервера. */
  route?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Для `slow-request` и `stuck-loading`: сколько длилось. */
  durationMs?: number;
  /** Процесс, о котором сигнал (`cli-exit`), — чтобы отсеять собственный разбор. */
  pid?: number;
  /** Конец stderr CLI (`cli-exit`) — улика; причина из него уже в `message`. */
  output?: string;
  /** ISO; не задан — момент приёма. */
  at?: string;
}

/** Что модель сказала об одном сбое. */
export interface WatchFinding {
  title: string;
  happened: string;
  context: string;
  verdict: Exclude<WatchVerdict, 'pending'>;
  /** `apps/server/src/x.ts:42`; пусто — модель места не нашла. */
  location?: string;
  fix?: string;
  /** Почему так вышло — объяснение причины по коду. */
  rootCause?: string;
  /** Шаги воспроизведения. */
  steps?: string;
  /** Слово модели о важности; нет — остаётся оценка по виду сигнала. */
  severity?: WatchSeverity;
}

/** Замечание модели: дефект, замеченный рядом при сверке, без сбоя на деле. */
export interface WatchRemark {
  title: string;
  explanation: string;
  location?: string;
  fix?: string;
  severity: WatchSeverity;
  /** Раздел, при разборе которого замечено (`WR-3` или отпечаток). */
  relatedTo?: string;
  /** То же замечание, что уже есть в отчёте (`WR-7`): повтор, а не новое. */
  sameAs?: string;
}

/** Сбой после склейки: одна запись на отпечаток. */
export interface WatchEvent {
  /** Отпечаток — он же id раздела в метках отчёта. */
  id: string;
  /**
   * Короткий номер для людей и агентов — `WR-12`. Не меняется, пока раздел
   * есть в отчёте: «починил WR-12» однозначно и через неделю.
   */
  ref: string;
  entryClass: WatchEntryClass;
  severity: WatchSeverity;
  source: WatchSignalSource;
  kind: WatchSignalKind;
  message: string;
  stack?: string;
  /** Конец stderr CLI последнего повтора, секреты замаскированы. */
  output?: string;
  route?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Самое долгое из наблюдавшихся (медленный ответ, зависшая загрузка). */
  durationMs?: number;
  firstSeen: string;
  lastSeen: string;
  count: number;
  /** Сколько повторов уже видела модель; меньше `count` — сбой ждёт разбора. */
  analyzedCount: number;
  finding?: WatchFinding;
  /** Для замечания — что сказала модель. */
  remark?: WatchRemark;
  /** Разделы, которые модель признала той же причиной и влила сюда. */
  merged?: string[];
}

/** Состояние наблюдателя на диске: переживает перезапуск панели. */
export interface WatcherState {
  enabled: boolean;
  since?: string;
  spend: WatcherSpend;
  problem?: WatcherProblem;
  /** Моменты запуска разборов за последний час — для потолка в час. */
  runTimes?: string[];
}

/** Итог одного разбора: находки по id и расход. */
export interface AnalysisOutcome {
  ok: boolean;
  findings: Map<string, WatchFinding>;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    model?: string;
  };
  /** Замечания модели сверх сбоев. */
  remarks: WatchRemark[];
  /** Сбой → раздел той же причины, куда его влить. */
  merges: Map<string, string>;
  error?: string;
  /** Разбор снят выключением — это не сбой, отчёт не трогается. */
  stopped?: boolean;
}
