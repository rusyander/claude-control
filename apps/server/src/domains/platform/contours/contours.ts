import type { PlatformGatewayEvent, PlatformSpendRecord } from '@agentdeck/contracts';
import type {
  CoreContourLinkReply,
  CoreContourNoticesReply,
  CoreContourRunReply,
  CoreContoursReply,
  CoreContourSummarizedReply,
  CoreContoursApplyReply,
  HopContours,
  HopUserGatewayState,
} from '@agentdeck/contracts/core/hops';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../../lib/listen-identity/listen-identity.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import {
  forwardToCore,
  locateCore,
  verifyCore,
  type CoreLocation,
} from '../../core-proxy/core-proxy.ts';
import type { CoreContours } from './contours.types.ts';

/**
 * Клиент учёта контуров ядра (`/v1/contours*`, C3b) — тем же путём, что пересылка вопросов:
 * строка `procs.json`, сверка ОС до отправки токена (F-19), запрос на loopback. Кода ядра здесь
 * нет (граница depcruise).
 *
 * Читатели панели синхронные (карточка контура в `describePlatform`, маршрутизация, статус
 * шлюза), поэтому последний ответ ядра держится в памяти и обновляется опросом; ручки, которым
 * нужна свежая цифра (карточка расхода), зовут `refresh` перед чтением.
 *
 * Записей панель не шлёт: своего шлюза у неё нет (C3d), запросы CLI учитывает шлюз человека на
 * хосте звеньев ядра. Его порт приходит с каждым ответом; сменился — `onUserGatewayPort`.
 */

export const CONTOURS_POLL_MS = 5_000;
/** Сверенная строка ядра живёт столько: сверка ОС — внешний процесс, а опрос идёт каждые 5 с. */
const VERIFIED_TTL_MS = 30_000;
const READ_FAILED = 'not read';
const RUN_FAILED = 'run facts not read';
const SUMMARIZED_FAILED = 'summarized ids not read';
const EVENTS_FAILED = 'events not handled';
const APPLY_FAILED = 'apply not answered';
/** Сколько конец хода чата и лента ждут ядро: дольше — без подсказки, но без зависания. */
export const FACTS_TIMEOUT_MS = 3_000;

export interface CoreContoursOptions {
  /** Дом ядра (`procs.json`, `token`). */
  home: () => string;
  identity?: (port: number) => CoreIdentityDeps;
  intervalMs?: number;
  factsTimeoutMs?: number;
  log: (line: string) => void;
  /**
   * Шлюз человека у ядра слушает на новом порту (первый ответ или смена). Порт 0 сюда не
   * приходит: ядро молчит — CLI держат прошлый адрес, переписывать их конфиги незачем.
   */
  onUserGatewayPort?: (port: number) => void;
  /**
   * События книги контуров из каждого успешного ответа (новые сверху, не больше 50): по ним
   * сторож контура узнаёт отказ, пахнущий правами (`createRightsFeed`). Ядро молчит — не зовётся.
   */
  onEvents?: (events: readonly PlatformGatewayEvent[]) => void;
}

/** Отказ адреса звена: статус ядра (503 — ядра нет) и его слова — их увидит человек. */
export class ContourLinkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCoreContours(options: CoreContoursOptions): CoreContours {
  const identity = options.identity ?? createCoreIdentityDeps();
  let verified: { core: CoreLocation; at: number } | undefined;
  let live: HopContours | undefined;
  let records: Record<string, PlatformSpendRecord> = {};
  // Шлюз человека у ядра из последнего ответа: ядро не ответило — держится прошлый (хост звеньев
  // переживает ядро, и шлюз на нём жив, пока жив хост).
  let userGateway: HopUserGatewayState | null = null;
  const gatewayPort = (): number =>
    userGateway?.state === 'listening' && userGateway.port > 0 ? userGateway.port : 0;
  let announcedPort = 0;
  let pollTimer: NodeJS.Timeout | undefined;
  const lastFailure = new Map<string, string>();

  const located = async (): Promise<CoreLocation> => {
    const core = locateCore(options.home());
    if ('missing' in core) throw new Error(core.missing);
    const cached = verified;
    if (cached && cached.core.url === core.url && Date.now() - cached.at < VERIFIED_TTL_MS)
      return core;
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven))
      throw new Error(
        `core entry not verified: ${'unknown' in proven ? proven.unknown : 'absent'}`,
      );
    verified = { core, at: Date.now() };
    return core;
  };

  const call = async <T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await forwardToCore(await located(), {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      // Ядро ответило отказом — строку держим заново сверенной: отказ мог дать чужой процесс.
      verified = undefined;
      throw new Error(`${method} ${path}: ${response.status}`);
    }
    return (await response.json()) as T;
  };

  /**
   * Одна строка на смену причины — у каждого действия своя: недоступное ядро не пишет журнал на
   * каждый ответ модели, и опрос с записями вперемешку не повторяет одно и то же по очереди.
   */
  const failed = (what: string, error: unknown): void => {
    const reason = reasonOf(error);
    if (lastFailure.get(what) === reason) return;
    lastFailure.set(what, reason);
    options.log(`contours: ${what}: ${reason}`);
  };

  /**
   * Граница ожидания для чтений, которых ждёт человек: таймер отказа и тот же сигнал для запроса.
   * Таймер срабатывает и после выигранной гонки — отказ помечен обработанным, иначе уронил бы
   * процесс.
   */
  const deadline = (): { signal: AbortSignal; expired: Promise<never> } => {
    const signal = AbortSignal.timeout(options.factsTimeoutMs ?? FACTS_TIMEOUT_MS);
    const expired = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }),
    );
    expired.catch(() => undefined);
    return { signal, expired };
  };

  const refresh = async (): Promise<boolean> => {
    try {
      const { signal } = deadline();
      const reply = await call<CoreContoursReply>('GET', '/v1/contours', undefined, signal);
      live = reply.live;
      records = reply.records;
      userGateway = reply.userGateway ?? null;
      lastFailure.delete(READ_FAILED);
      const port = gatewayPort();
      if (port > 0 && port !== announcedPort) {
        announcedPort = port;
        options.onUserGatewayPort?.(port);
      }
      // Отказ читателя событий — не отказ ядра: ответ уже принят, опрос о нём не врёт.
      try {
        options.onEvents?.(reply.live.events);
      } catch (error) {
        failed(EVENTS_FAILED, error);
      }
      return true;
    } catch (error) {
      failed(READ_FAILED, error);
      return false;
    }
  };

  /**
   * Контур записан — ядро настраивает шлюз человека сейчас. Ответ несёт состояние шлюза после
   * применения: читатели статуса видят его без следующего опроса. Не бросает: ядро не ответило в
   * срок — `false`, правку подхватит его такт.
   */
  const apply = async (): Promise<boolean> => {
    const { signal, expired } = deadline();
    try {
      const reply = await Promise.race([
        call<CoreContoursApplyReply>('POST', '/v1/contours/apply', {}, signal),
        expired,
      ]);
      userGateway = reply.userGateway ?? null;
      lastFailure.delete(APPLY_FAILED);
      return reply.applied;
    } catch (error) {
      failed(APPLY_FAILED, error);
      return false;
    }
  };

  /**
   * Чтение, которого ждёт ответ человеку (конец хода чата, лента): не дольше `FACTS_TIMEOUT_MS`.
   * Не вышло — `fallback` и строка в журнал (одна на смену причины).
   */
  const factsRead = async <T>(what: string, path: string, fallback: T): Promise<T> => {
    const { signal, expired } = deadline();
    try {
      const reply = await Promise.race([call<T>('GET', path, undefined, signal), expired]);
      lastFailure.delete(what);
      return reply;
    } catch (error) {
      failed(what, error);
      return fallback;
    }
  };

  /** Адрес звена у ядра: отказ — `ContourLinkError` с кодом ядра; связь не прошла — 503. */
  const askLink = async (path: string, body: object): Promise<CoreContourLinkReply> => {
    let core: CoreLocation;
    try {
      core = await located();
    } catch (error) {
      throw new ContourLinkError(503, serverText('core-link-missing', { reason: reasonOf(error) }));
    }
    let response: Response;
    try {
      response = await forwardToCore(core, { method: 'POST', path, body });
    } catch (error) {
      verified = undefined;
      throw new ContourLinkError(
        503,
        serverText('core-link-unreachable', { reason: reasonOf(error) }),
      );
    }
    if (!response.ok) {
      if (response.status !== 404 && response.status !== 409) verified = undefined;
      const said = ((await response.json().catch(() => ({}))) as { error?: unknown }).error;
      throw new ContourLinkError(
        response.status,
        typeof said === 'string' ? said : `${path}: ${response.status}`,
      );
    }
    return (await response.json()) as CoreContourLinkReply;
  };

  return {
    live: () => live,
    records: () => records,
    refresh,
    apply,
    async clearExhausted(platformId) {
      const reply = await call<{ cleared: boolean }>(
        'POST',
        `/v1/contours/${encodeURIComponent(platformId)}/clear-exhausted`,
      );
      await refresh();
      return reply.cleared;
    },
    async notices(after) {
      const reply = await call<CoreContourNoticesReply>(
        'GET',
        `/v1/contours/notices?after=${after}`,
      );
      return reply.notices;
    },
    runFacts: (runTag, sinceMs) =>
      factsRead<CoreContourRunReply>(
        RUN_FAILED,
        `/v1/contours/run?tag=${encodeURIComponent(runTag)}&since=${Math.max(0, Math.floor(sinceMs))}`,
        { summarized: false },
      ),
    async summarizedIds() {
      const reply = await factsRead<CoreContourSummarizedReply>(
        SUMMARIZED_FAILED,
        '/v1/contours/summarized',
        { messageIds: [] },
      );
      return new Set(reply.messageIds);
    },
    // Без своей памяти: адрес держит ядро и сверяет его с ТЕКУЩИМИ фактами контура (манифест,
    // адрес, маска). Память здесь отдавала бы звено, записанное до правки карточки, — ручку
    // картинок, объявленную позже, такое звено не знает (404 вместо картинки).
    link: (platformId, fresh = false) =>
      askLink(`/v1/contours/${encodeURIComponent(platformId)}/link`, fresh ? { fresh } : {}),
    linkRoute: (routeId, fresh = false) =>
      askLink('/v1/links', fresh ? { routeId, fresh } : { routeId }),
    userGatewayPort: gatewayPort,
    userGateway: () => userGateway,
    start() {
      if (pollTimer) return;
      void refresh();
      pollTimer = setInterval(() => void refresh(), options.intervalMs ?? CONTOURS_POLL_MS);
      pollTimer.unref?.();
    },
    async stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    },
  };
}
