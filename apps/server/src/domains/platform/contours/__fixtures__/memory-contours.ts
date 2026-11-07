import type {
  PlatformExhaustedScope,
  PlatformGatewayEvent,
  PlatformSpendRecord,
  PlatformUsageRecord,
} from '@agentdeck/contracts';
import type {
  CoreContourLinkReply,
  HopBudgetNotice,
  HopContours,
  HopUserGatewayState,
} from '@agentdeck/contracts/core/hops';
import { ContourLinkError } from '../contours.ts';
import type { CoreContours } from '../contours.types.ts';

/** Расход одного ответа контура — форма `SpendDelta` книги контуров звена. */
export interface MemoryContourUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Одна запись фикстуры — то, что книга контуров звена кладёт себе с одного запроса CLI через
 * шлюз ядра: след, расход, отказ по бюджету, сжатие истории. Снаружи в учёт звена записать
 * нельзя (запись идёт только трафиком звена) — это форма самой фикстуры, не протокола.
 */
export interface MemoryContourRecord {
  platformId: string;
  event?: PlatformGatewayEvent;
  usage?: MemoryContourUsage;
  exhausted?: { at: string; scope?: PlatformExhaustedScope; level?: string };
  summarized?: { at: string; path: string; messageId?: string; runTag?: string };
}

/**
 * Учёт контуров без ядра — для тестов панели. Дней и денег он не считает (это дело звена ядра,
 * C3b, и его тестов). `record` — то, что звено записало бы, пропустив запрос CLI через шлюз
 * ядра: тест кладёт запись сам, а живую часть (`live`)
 * фикстура складывает из записей теми же правилами, что звено (`contour-book.ts`: след новыми
 * сверху, не больше 50; отказ — статус ≥ 400; счётчик расхода по контуру считает и пустой ответ).
 * Шлюз человека (`setUserGateway`) и адрес звена (`setLink`) задаёт тест; не задан — ядро молчит.
 */
export interface MemoryContours extends CoreContours {
  /** Записать запрос в учёт, как это сделало бы звено ядра. */
  record(message: MemoryContourRecord): void;
  /** Записи в порядке `record`. */
  sent: MemoryContourRecord[];
  /** Состояние шлюза человека у ядра (`null` — ядро не ответило). */
  setUserGateway(state: HopUserGatewayState | null): void;
  /** Ответ `link`/`linkRoute`; не задан — 503, как без ядра. */
  setLink(reply: CoreContourLinkReply | undefined): void;
  /** Сколько раз спросили ядро свежим (`refresh`). */
  refreshes: number;
  /** Сколько раз попросили ядро применить контур (`apply`). */
  applies: number;
  /** Записи одного контура с расходом (`usage`) — то, что раньше ложилось днём в state.json. */
  usageOf(platformId: string): MemoryContourUsage[];
  /** Заменить живую часть целиком (`undefined` — снова складывать из записей). */
  setLive(live: HopContours | undefined): void;
  setRecords(records: Record<string, PlatformSpendRecord>): void;
  setNotices(notices: HopBudgetNotice[]): void;
  /** Снятые отметки «исчерпан» по порядку нажатий. */
  cleared: string[];
}

const EVENTS_KEPT = 50;

function liveOf(sent: MemoryContourRecord[]): HopContours {
  const events: PlatformGatewayEvent[] = [];
  const usage = new Map<string, PlatformUsageRecord>();
  let failures = 0;
  const summarized = [];
  for (const item of sent) {
    if (item.event) {
      events.unshift(item.event);
      if (item.event.status >= 400) failures += 1;
    }
    if (item.usage) {
      const current = usage.get(item.platformId);
      usage.set(item.platformId, {
        platformId: item.platformId,
        requests: (current?.requests ?? 0) + 1,
        promptTokens: (current?.promptTokens ?? 0) + item.usage.promptTokens,
        completionTokens: (current?.completionTokens ?? 0) + item.usage.completionTokens,
        totalTokens: (current?.totalTokens ?? 0) + item.usage.totalTokens,
        at: new Date().toISOString(),
      });
    }
    if (item.summarized) {
      const link = item.summarized.messageId
        ? ('message' as const)
        : item.summarized.runTag
          ? ('run' as const)
          : ('none' as const);
      summarized.unshift({
        at: item.summarized.at,
        platformId: item.platformId,
        path: item.summarized.path,
        link,
      });
    }
  }
  return {
    since: 0,
    requests: events.length,
    failures,
    usage: [...usage.values()],
    events: events.slice(0, EVENTS_KEPT),
    summarized: { total: summarized.length, recent: summarized },
    notices: [],
  };
}

/** Шлюз человека у ядра слушает на `port` — для тестов, где прогон идёт через контур. */
export function listeningGateway(port: number): HopUserGatewayState {
  return { port, state: 'listening', since: Date.now(), routes: [] };
}

export function memoryContours(): MemoryContours {
  let userGateway: HopUserGatewayState | null = null;
  let link: CoreContourLinkReply | undefined;
  let live: HopContours | undefined;
  let records: Record<string, PlatformSpendRecord> = {};
  let notices: HopBudgetNotice[] = [];
  const sent: MemoryContourRecord[] = [];
  const cleared: string[] = [];
  const linked = (): Promise<CoreContourLinkReply> =>
    link ? Promise.resolve(link) : Promise.reject(new ContourLinkError(503, 'Ядро не найдено'));
  const self: MemoryContours = {
    sent,
    cleared,
    refreshes: 0,
    applies: 0,
    apply: () => {
      self.applies += 1;
      return Promise.resolve(true);
    },
    setUserGateway: (state) => {
      userGateway = state;
    },
    setLink: (reply) => {
      link = reply;
    },
    userGateway: () => userGateway,
    userGatewayPort: () =>
      userGateway?.state === 'listening' && userGateway.port > 0 ? userGateway.port : 0,
    link: () => linked(),
    linkRoute: () => linked(),
    start: () => undefined,
    stop: () => Promise.resolve(),
    usageOf: (platformId) =>
      sent.flatMap((item) => (item.platformId === platformId && item.usage ? [item.usage] : [])),
    setLive: (next) => {
      live = next;
    },
    setRecords: (next) => {
      records = next;
    },
    setNotices: (next) => {
      notices = next;
    },
    record: (message) => {
      sent.push(message);
      // Отметку «исчерпан» складываем по правилу книги (`exhausted`): прежние scope и уровень не
      // наследуются. Дни и деньги — нет: их счёт проверяют тесты звена и `contour-spend`.
      if (!message.exhausted) return;
      const {
        exhaustedScope: _scope,
        exhaustedLevel: _level,
        ...rest
      } = records[message.platformId] ?? { platformId: message.platformId, days: [] };
      records = {
        ...records,
        [message.platformId]: {
          ...rest,
          exhaustedAt: message.exhausted.at,
          ...(message.exhausted.scope ? { exhaustedScope: message.exhausted.scope } : {}),
          ...(message.exhausted.level ? { exhaustedLevel: message.exhausted.level } : {}),
        },
      };
    },
    live: () => live ?? liveOf(sent),
    records: () => records,
    refresh: () => {
      self.refreshes += 1;
      return Promise.resolve(true);
    },
    clearExhausted: (platformId) => {
      cleared.push(platformId);
      const record = records[platformId];
      if (!record?.exhaustedAt) return Promise.resolve(false);
      const {
        exhaustedAt: _gone,
        exhaustedScope: _scope,
        exhaustedLevel: _level,
        ...rest
      } = record;
      records = { ...records, [platformId]: rest };
      return Promise.resolve(true);
    },
    notices: (after) => Promise.resolve(notices.filter((item) => item.seq > after)),
    // Те же правила, что у звена (`control.ts` `contour-run`/`contour-summarized`): сжатие — по
    // метке прогона, вызовы — по следу с `sinceMs`; запросов не было — поля вызовов нет.
    runFacts: (runTag, sinceMs) => {
      const summarized = sent.some((item) => item.summarized?.runTag === runTag);
      const events = sent.flatMap((item) =>
        item.event && Date.parse(item.event.at) >= sinceMs ? [item.event] : [],
      );
      const toolCalls = events.reduce(
        (sum, event) => sum + (event.toolCalls ?? 0) + (event.nativeCalls ?? 0),
        0,
      );
      return Promise.resolve({ summarized, ...(events.length > 0 ? { toolCalls } : {}) });
    },
    summarizedIds: () =>
      Promise.resolve(
        new Set(
          sent.flatMap((item) => (item.summarized?.messageId ? [item.summarized.messageId] : [])),
        ),
      ),
  };
  return self;
}
