import type { PlatformSpendRecord } from '@agentdeck/contracts';
import type {
  CoreContourLinkReply,
  CoreContourRunReply,
  HopBudgetNotice,
  HopContours,
  HopUserGatewayState,
} from '@agentdeck/contracts/core/hops';

/**
 * Учёт контуров для панели (этап 10, C3b): считает звено ядра — запросы CLI идут через шлюз
 * человека на его хосте звеньев, — панель читает карточку, расход и бюджет оттуда же. Своего
 * учёта и своего шлюза у панели нет (C3d).
 */

/** Что панель читает: последний ответ ядра держится в памяти — синхронным читателям. */
export interface ContourReader {
  /** След и счётчики звена; ядро ещё ни разу не ответило — `undefined`. */
  live(): HopContours | undefined;
  /** Дни расхода по контурам из последнего ответа ядра (нет ответа — пусто). */
  records(): Record<string, PlatformSpendRecord>;
  /** Перечитать у ядра. `false` — ядро не ответило, в памяти остался прошлый ответ. */
  refresh(): Promise<boolean>;
  /** Снять отметку «бюджет исчерпан» (и на звене, и на карточке). */
  clearExhausted(platformId: string): Promise<boolean>;
  /** Извещения о бюджете с `seq` больше `after`; звена нет — пусто. */
  notices(after: number): Promise<HopBudgetNotice[]>;
  /**
   * Факты прогона чужого CLI через контур: сжималась ли история по метке прогона и сколько
   * вызовов инструментов прошло с `sinceMs`. Не бросает: ядро молчит — `{summarized: false}`
   * (подсказка пропадёт, ответ чата не встанет).
   */
  runFacts(runTag: string, sinceMs: number): Promise<CoreContourRunReply>;
  /** Id сообщений, перед которыми контур сжал историю (лента Claude). Ядро молчит — пусто. */
  summarizedIds(): Promise<Set<string>>;
}

export type PanelContours = ContourReader;

/**
 * Адрес звена для запросов самой панели в контур — картинки, презентации (метка
 * `panelHopTag`, C3b (iv)): ключ, маска, расход и след — те же, что у запросов CLI этого контура.
 */
export interface ContourLinker {
  /**
   * Каждый зов спрашивает ядро: оно держит адрес, пока факты контура те же, и перерегистрирует
   * звено после правки карточки; `fresh` — новая заглушка (хост отверг прежнюю — 401). Бросает `ContourLinkError`:
   * 404 контура нет или выключен, 409 звено не приняло контур, 503 ядра или звена нет.
   */
  link(platformId: string, fresh?: boolean): Promise<CoreContourLinkReply>;
  /**
   * То же для прямого вызова API панели по ключу (Q5): маршрут `api-key:<cli>` или
   * `api-key:endpoint:<id>`, метка `panel:<routeId>`. 404 — профиль или ключ не сохранён.
   */
  linkRoute(routeId: string, fresh?: boolean): Promise<CoreContourLinkReply>;
}

export interface CoreContours extends PanelContours, ContourLinker {
  /**
   * Порт шлюза человека у ядра из последнего ответа (`listening`); 0 — не слушает или ядро ещё
   * не ответило. По нему прогоны CLI идут через контур (`PlatformRoutingDeps.gatewayPort`).
   */
  userGatewayPort(): number;
  /** Шлюз человека, как его назвало ядро (ждёт порт, слушает, причина); нет ответа — `null`. */
  userGateway(): HopUserGatewayState | null;
  /**
   * Контур записан в state.json — ядро настраивает шлюз человека сейчас (`POST /v1/contours/apply`,
   * s10 G7), а не на своём такте. Не бросает: `false` — ядро не ответило в срок (тогда правку
   * подхватит его такт, как раньше).
   */
  apply(): Promise<boolean>;
  /** Опрос ядра раз в `intervalMs`: синхронные читатели видят цифру не старше шага. */
  start(): void;
  /** Остановить опрос и дописать очередь записей (сколько успеет ядро). */
  stop(): Promise<void>;
}
