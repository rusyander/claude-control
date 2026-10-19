import type { UsageLimits, UsageLimitsStatus } from '@agentdeck/contracts';
import type { CredentialsLookup } from '../../lib/credentials/credentials.ts';
import { oauthTokenOf } from './oauth-token.ts';
import { parseUsageResponse } from './parse-usage.ts';
import { latestJournalWindows } from './journal-fallback.ts';

/**
 * Лимиты подписки для боковой панели: один кэш на сервер, общий для всех вкладок
 * и телефона.
 *
 * Источник — тот же адрес, который зовёт сам CLI для `/usage`. Ходит туда только
 * сервер и не чаще раза в `everyMs` (минута): ответ меняется целыми процентами,
 * и чаще смотреть незачем, а чужой сервер своими 429 наказывает весь аккаунт.
 * Таймер ходит, только пока кто-то слушает поток `/api/events` (открыта вкладка
 * или телефон); изменилось — `changed()`, и вкладки перечитывают маршрут.
 * Первый `get()` после тишины сам идёт за свежим ответом.
 *
 * Отказ сервера не стирает последних окон: они остаются со своим `observedAt`, а
 * `status` говорит, почему новых нет. Окно, чей сброс уже прошёл, при отказе
 * убирается — загрузка после сброса неизвестна.
 */

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Без этого заголовка сервер OAuth-токен для этого адреса не принимает (так шлёт CLI). */
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_EVERY_MS = 60_000;
const TIMEOUT_MS = 8_000;
/** Сеть или 5xx: следующая попытка не раньше. */
const RETRY_MS = 2 * 60_000;
/** 401/403: токен не тот — ждать, пока CLI войдёт заново. */
const AUTH_RETRY_MS = 5 * 60_000;
/** 429 без `retry-after` и потолок для слишком длинного. */
const RATE_RETRY_MS = 5 * 60_000;
const RATE_RETRY_MAX_MS = 30 * 60_000;
/** Как часто таймер смотрит, пора ли; сам запрос — по `everyMs`. */
const TICK_MS = 10_000;

export interface UsageLimitsDeps {
  /** Доступ CLI к аккаунту — `readClaudeCredentials(root)` на каждый запрос. */
  credentials: () => CredentialsLookup;
  /** Каталог данных панели — журнал замеров прогонов, запасной источник. */
  appDataDir: () => string;
  /** Сколько слушателей у потока событий: таймер ходит, только пока они есть. */
  listeners: () => number;
  /** Окна или статус изменились — разослать. */
  changed: () => void;
  fetch?: typeof fetch;
  now?: () => number;
  everyMs?: number;
}

export interface UsageLimitsMonitor {
  /** Текущий снимок; устарел — сначала свежий ответ (одна попытка на всех). */
  get: () => Promise<UsageLimits>;
  /** Одна попытка сейчас, если не идёт другая и не ждём паузы после отказа. */
  refresh: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

function retryAfterMs(header: string | null): number {
  const seconds = header ? Number(header) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return RATE_RETRY_MS;
  return Math.min(Math.max(seconds * 1000, DEFAULT_EVERY_MS), RATE_RETRY_MAX_MS);
}

/** Ключ сравнения: момент замера в него не входит, иначе рассылка шла бы каждую минуту. */
function signature(limits: UsageLimits): string {
  return JSON.stringify([limits.status, limits.source, limits.windows]);
}

export function createUsageLimits(deps: UsageLimitsDeps): UsageLimitsMonitor {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const everyMs = deps.everyMs ?? DEFAULT_EVERY_MS;

  let snapshot: UsageLimits = {
    status: 'unavailable',
    windows: [],
    observedAt: null,
    source: null,
  };
  /** Окна последнего удачного ответа сервера — отдельно от запасного источника. */
  let lastOauth: { at: number; windows: UsageLimits['windows'] } | undefined;
  let nextAt = 0;
  let inflight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const settle = (next: UsageLimits): void => {
    const before = signature(snapshot);
    snapshot = next;
    if (signature(next) !== before) deps.changed();
  };

  /** Отказ: прежние окна сервера или замер прогона — что свежее; прошедшие сбросы — вон. */
  const fail = (status: UsageLimitsStatus, waitMs: number): void => {
    const at = now();
    nextAt = at + waitMs;
    const journal = latestJournalWindows(deps.appDataDir(), at);
    const kept =
      journal && journal.at > (lastOauth?.at ?? 0)
        ? { ...journal, source: 'chat-run' as const }
        : lastOauth && { ...lastOauth, source: 'oauth' as const };
    const windows = (kept?.windows ?? []).filter(
      (window) => window.resetsAt === null || window.resetsAt > at,
    );
    const shown = kept && windows.length > 0 ? kept : undefined;
    settle({
      status,
      windows,
      observedAt: shown?.at ?? null,
      source: shown?.source ?? null,
    });
  };

  const attempt = async (): Promise<void> => {
    const token = oauthTokenOf(deps.credentials(), now());
    // Нечем спрашивать: повтор — по обычному шагу, CLI мог войти за это время.
    if ('status' in token) return fail(token.status, everyMs);
    let response: Response;
    try {
      response = await doFetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token.token}`, 'anthropic-beta': OAUTH_BETA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail('unavailable', RETRY_MS);
    }
    if (response.status === 401 || response.status === 403) {
      return fail('unauthorized', AUTH_RETRY_MS);
    }
    if (response.status === 429) {
      return fail('rate-limited', retryAfterMs(response.headers.get('retry-after')));
    }
    if (!response.ok) return fail('unavailable', RETRY_MS);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail('unavailable', RETRY_MS);
    }
    const windows = parseUsageResponse(body);
    if (!windows) return fail('unavailable', RETRY_MS);
    const at = now();
    nextAt = at + everyMs;
    lastOauth = { windows, at };
    settle({ status: 'ok', windows, observedAt: at, source: 'oauth' });
  };

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    if (now() < nextAt) return Promise.resolve();
    inflight = attempt().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    get: async () => {
      await refresh();
      return snapshot;
    },
    refresh,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        if (deps.listeners() > 0) void refresh();
      }, TICK_MS);
      // Таймер не держит процесс: выход панели его не ждёт.
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
