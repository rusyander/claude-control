import { WATCH_SEEN_HEADER, type WatchClientSignal } from '@agentdeck/contracts';

/**
 * Проблемы страницы для фонового наблюдателя панели.
 *
 * Шлёт ТОЛЬКО пока наблюдатель включён: флаг ставит опрос статуса
 * (`entities/Watcher`), и до первого ответа, как и после выключения, ни одного
 * запроса не уходит. Отправка — голым `fetch` в обход обёртки ниже и мимо
 * клиента API: иначе отказ самого `/api/watcher/events` стал бы новой
 * «проблемой запроса» и пошёл бы по кругу.
 *
 * Что собирается: ошибки окна и отказы промисов, падения отрисовки (граница
 * ошибок зовёт `reportRenderCrash`), `console.error`/`console.warn` (туда же
 * пишет React), неудавшиеся запросы, которых сервер не видел (обрыв сети,
 * 5xx прокси; видел — в ответе его заголовок `x-agentdeck-watch`), ответ API не
 * того вида и загрузка дольше порога (`watchQueryCache`).
 *
 * Одинаковое подряд глушится на несколько секунд: ошибка в цикле отрисовки
 * повторяется десятки раз в секунду, а склеить её сервер и так склеит — незачем
 * слать ему сотню одинаковых запросов.
 */

const ENDPOINT = '/api/watcher/events';
const REPEAT_WINDOW_MS = 5000;
const MESSAGE_MAX = 2000;
const STACK_MAX = 8000;
/** Пределы схемы сервера: длиннее — 400, и сигнал терялся молча (F-338). */
const ROUTE_MAX = 300;
const PATH_MAX = 500;
/** Как часто смотреть на идущие загрузки. */
const STUCK_POLL_MS = 1000;
const DEFAULT_STUCK_MS = 30_000;

let enabled = false;
let installed = false;
let stuckLoadingMs = DEFAULT_STUCK_MS;
const recent = new Map<string, number>();
/** Ошибки, уже ушедшие сигналом: React пишет их ещё и в консоль — второй раз не шлём. */
const reported = new WeakSet<object>();

export function setWatchCaptureEnabled(next: boolean): void {
  enabled = next;
  if (next) installWatchCapture();
}

export function isWatchCaptureEnabled(): boolean {
  return enabled;
}

/** Пороги приходят со статусом наблюдателя — один источник на сервер и страницу. */
export function setWatchThresholds(thresholds: { stuckLoadingMs?: number }): void {
  if (thresholds.stuckLoadingMs && thresholds.stuckLoadingMs > 0) {
    stuckLoadingMs = thresholds.stuckLoadingMs;
  }
}

function currentRoute(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.pathname;
}

/** Отправить сигнал, если наблюдатель включён. Никогда не бросает. */
export function reportClientSignal(signal: WatchClientSignal): void {
  if (!enabled) return;
  const key = `${signal.kind}|${signal.message}|${signal.path ?? ''}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return;
  recent.set(key, now);
  if (recent.size > 200) recent.clear();

  const route = signal.route ?? currentRoute();
  const body: WatchClientSignal = {
    ...signal,
    message: signal.message.slice(0, MESSAGE_MAX) || signal.kind,
    ...(signal.stack ? { stack: signal.stack.slice(0, STACK_MAX) } : {}),
    ...(signal.path ? { path: signal.path.slice(0, PATH_MAX) } : {}),
    route: route?.slice(0, ROUTE_MAX),
  };
  try {
    void rawFetch()(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Отправка сигнала не имеет права ломать страницу.
  }
}

function describe(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message || value.name, ...(value.stack ? { stack: value.stack } : {}) };
  }
  if (typeof value === 'string') return { message: value };
  try {
    return { message: JSON.stringify(value) ?? String(value) };
  } catch {
    return { message: String(value) };
  }
}

function remember(value: unknown): void {
  if (value !== null && typeof value === 'object') reported.add(value);
}

/** Упавшая отрисовка (граница ошибок, страница ошибки маршрута). */
export function reportRenderCrash(error: unknown, componentStack?: string | null): void {
  remember(error);
  const { message, stack } = describe(error);
  const combined = [stack, componentStack].filter(Boolean).join('\n');
  reportClientSignal({ kind: 'render-crash', message, ...(combined ? { stack: combined } : {}) });
}

/**
 * Сбой отрисовки — наблюдателю и в консоль, именно в этом порядке. Запись в
 * консоль раньше сигнала перехват консоли успевал отправить как
 * `console-error`, и один сбой уходил дважды (ревью 28.09 F-87): сигнал сперва
 * помечает ошибку отправленной, и перехват её пропускает.
 */
export function logRenderCrash(
  label: string,
  error: unknown,
  componentStack?: string | null,
): void {
  reportRenderCrash(error, componentStack);
  if (componentStack) console.error(label, error, componentStack);
  else console.error(label, error);
}

/** Путь запроса со служебным `/api` в начале — как его видит сервер. */
function apiPath(url: string | undefined): string | undefined {
  const bare = url?.split('?')[0];
  if (!bare) return undefined;
  let path = bare;
  try {
    // Полный адрес (`http://host/api/x`) — только путь.
    if (/^https?:\/\//.test(bare)) path = new URL(bare).pathname;
  } catch {
    return undefined;
  }
  return path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Запрос страницы к API, которого сервер не видел: обрыв сети (`status` 0) или
 * 5xx без заголовка сервера (ответил прокси, сервер лежит). 4xx и 5xx,
 * записанные сервером, здесь не шлются — иначе один отказ считался бы дважды.
 */
export function reportApiFailure(input: {
  method?: string;
  url?: string;
  status?: number;
  message: string;
  /** Сервер уже записал этот отказ (заголовок `x-agentdeck-watch`). */
  seenByServer?: boolean;
}): void {
  if (input.seenByServer) return;
  const status = input.status ?? 0;
  if (status > 0 && status < 500) return;
  const path = apiPath(input.url);
  if (path?.includes('/watcher')) return;
  reportClientSignal({
    kind: 'api-failure',
    message: input.message,
    status,
    ...(input.method ? { method: input.method.toUpperCase() } : {}),
    ...(path ? { path } : {}),
  });
}

/**
 * Ответ API не того вида: ждали JSON, пришли HTML или текст (прокси отдал
 * страницу, маршрут вернул не то). Такой ответ «успешен» для HTTP и тихо ломает
 * экран дальше по коду.
 */
export function reportContractMismatch(input: {
  method?: string;
  url?: string;
  status?: number;
  contentType?: string;
  body: unknown;
}): void {
  const path = apiPath(input.url);
  if (!path || path.includes('/watcher')) return;
  const sample = typeof input.body === 'string' ? input.body.trim().slice(0, 120) : '';
  reportClientSignal({
    kind: 'contract-mismatch',
    // Текст сигнала читает модель наблюдателя — по-английски, как всё, что
    // панель шлёт агентам (F-306).
    message: `Response is not JSON (${input.contentType || 'no content type'}): ${sample || typeof input.body}`,
    ...(input.method ? { method: input.method.toUpperCase() } : {}),
    path,
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
}

/** Ответ API ждали JSON, а пришло это? Пустое тело (204) — не расхождение. */
export function looksLikeWrongShape(body: unknown, contentType: string | undefined): boolean {
  if (typeof body !== 'string' || body.trim() === '') return false;
  return /text\/html/i.test(contentType ?? '') || /^\s*<(!doctype|html)/i.test(body);
}

/** `console.log('a %s b', x)` → строка, как её показала бы консоль. */
export function formatConsoleArgs(args: readonly unknown[]): { message: string; stack?: string } {
  const [head, ...rest] = args;
  const queue = [...rest];
  let text = '';
  if (typeof head === 'string') {
    text = head.replace(/%[sdifoOc%]/g, (token) => {
      if (token === '%%') return '%';
      if (queue.length === 0) return token;
      const value = queue.shift();
      if (token === '%c') return '';
      return describe(value).message;
    });
  } else if (head !== undefined) {
    queue.unshift(head);
  }
  const error = args.find((arg): arg is Error => arg instanceof Error);
  const tail = queue.map((value) => describe(value).message);
  const message = [text, ...tail].filter(Boolean).join(' ').trim();
  return { message, ...(error?.stack ? { stack: error.stack } : {}) };
}

/** Стек места вызова без двух верхних кадров — самой обёртки и этого помощника. */
function callerStack(): string | undefined {
  const stack = new Error('console').stack;
  if (!stack) return undefined;
  const lines = stack.split('\n');
  return [lines[0], ...lines.slice(3)].join('\n');
}

/** Ошибка из записи уже ушла сигналом (граница ошибок, окно) — React просто её повторил. */
const alreadyReported = (args: readonly unknown[]): boolean =>
  args.some((arg) => arg !== null && typeof arg === 'object' && reported.has(arg));

/** Обернуть метод консоли; возвращает, чем снять обёртку. */
function wrapConsole(level: 'error' | 'warn'): () => void {
  // Обёртка вызывает настоящий метод как был.
  const previous = console[level];
  const original = previous.bind(console);
  let active = true;
  const wrapper = (...args: unknown[]): void => {
    original(...args);
    if (!active || !enabled) return;
    try {
      if (alreadyReported(args)) return;
      const { message, stack } = formatConsoleArgs(args);
      if (!message) return;
      const where = stack ?? callerStack();
      // Сигнал — микрозадачей позже: React 19 в разработке пишет пойманную
      // границей ошибку в консоль ДО componentDidCatch, и немедленный сигнал
      // уходил console-error рядом с render-crash (F-344). К микрозадаче граница
      // уже пометила ошибку, и повтор отсеивается здесь.
      queueMicrotask(() => {
        if (!active || !enabled || alreadyReported(args)) return;
        reportClientSignal({
          kind: level === 'error' ? 'console-error' : 'console-warn',
          message,
          ...(where ? { stack: where } : {}),
        });
      });
    } catch {
      // Сбор никогда не ломает то, за чем смотрит.
    }
  };
  console[level] = wrapper;
  return () => {
    active = false;
    if (console[level] === wrapper) console[level] = previous;
  };
}

let nativeFetch: typeof fetch | undefined;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Настоящий `fetch` — мимо обёртки: сигналы наблюдателю не должны наблюдаться. */
function rawFetch(): typeof fetch {
  return nativeFetch ?? fetch;
}

/**
 * Обёртка `fetch` для запросов в обход клиента API (потоки, долгие прогоны):
 * обрыв сети и 5xx, которых сервер не видел, — сигнал. Отмена — не сбой.
 */
function wrapFetch(): () => void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return () => undefined;
  const previous = window.fetch;
  const original = previous.bind(window);
  nativeFetch = original;
  let active = true;
  const wrapper = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!active) return original(input, init);
    const url = urlOf(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const isApi = url.includes('/api/') && !url.includes('/api/watcher');
    try {
      const response = await original(input, init);
      if (enabled && isApi && response.status >= 500 && !response.headers.get(WATCH_SEEN_HEADER)) {
        reportApiFailure({
          method,
          url,
          status: response.status,
          message: `Response ${response.status}`,
        });
      }
      return response;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (enabled && isApi && !aborted) {
        reportApiFailure({ method, url, message: describe(error).message });
      }
      throw error;
    }
  };
  window.fetch = wrapper;
  return () => {
    active = false;
    if (window.fetch === wrapper) window.fetch = previous;
  };
}

/**
 * Снятие прежней установки живёт на `window`, а не в модуле: горячая
 * перезагрузка исполняет модуль заново (`installed` снова `false`), и новая
 * установка оборачивала консоль и `fetch` поверх старой, у которой свой
 * `enabled` оставался включённым, — каждый сбой уходил дважды (F-343).
 */
const UNINSTALL_KEY = '__agentdeckWatchCaptureUninstall';

/** Слушатели окна, консоль и `fetch` — один раз на страницу. */
export function installWatchCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const holder = window as unknown as Record<string, (() => void) | undefined>;
  holder[UNINSTALL_KEY]?.();
  const onError = (event: ErrorEvent): void => {
    remember(event.error);
    const { message, stack } = describe(event.error ?? event.message);
    reportClientSignal({ kind: 'window-error', message, ...(stack ? { stack } : {}) });
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    remember(event.reason);
    const { message, stack } = describe(event.reason);
    reportClientSignal({ kind: 'unhandled-rejection', message, ...(stack ? { stack } : {}) });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const undo: Array<() => void> = [
    () => window.removeEventListener('error', onError),
    () => window.removeEventListener('unhandledrejection', onRejection),
  ];
  if (typeof console !== 'undefined') {
    undo.push(wrapConsole('error'), wrapConsole('warn'));
  }
  undo.push(wrapFetch());
  holder[UNINSTALL_KEY] = () => {
    for (const step of undo) step();
  };
}

/** Минимум от кэша запросов React Query — чтобы общий слой не зависел от библиотеки. */
export interface WatchableQueryCache {
  getAll: () => ReadonlyArray<{
    queryHash: string;
    queryKey: readonly unknown[];
    state: { fetchStatus: string };
  }>;
}

/** Ключ запроса для отчёта: первые два элемента — место, без конкретных значений. */
function queryPlace(key: readonly unknown[]): string {
  return key
    .slice(0, 2)
    .map((part) => (typeof part === 'string' ? part : typeof part))
    .join('/');
}

/**
 * Зависшая загрузка: запрос страницы «загружается» дольше порога. Каждое
 * зависание — один сигнал (пока тот же запрос не закончится и не начнётся
 * снова). Смотрим раз в секунду и только пока наблюдатель включён.
 * Возвращает, чем остановить.
 */
/** Один обход на кэш, сколько бы экранов ни держали статус наблюдателя. */
const cacheWatches = new WeakMap<WatchableQueryCache, { users: number; stop: () => void }>();

export function watchQueryCache(cache: WatchableQueryCache, now = () => Date.now()): () => void {
  const existing = cacheWatches.get(cache);
  if (existing) {
    existing.users += 1;
  } else {
    cacheWatches.set(cache, { users: 1, stop: startCacheWatch(cache, now) });
  }
  let released = false;
  return () => {
    const entry = cacheWatches.get(cache);
    if (released || !entry) return;
    released = true;
    entry.users -= 1;
    if (entry.users > 0) return;
    entry.stop();
    cacheWatches.delete(cache);
  };
}

function startCacheWatch(cache: WatchableQueryCache, now: () => number): () => void {
  const started = new Map<string, number>();
  const flagged = new Set<string>();
  const tick = (): void => {
    if (!enabled) {
      started.clear();
      flagged.clear();
      return;
    }
    const at = now();
    const fetching = new Set<string>();
    for (const query of cache.getAll()) {
      if (query.state.fetchStatus !== 'fetching') continue;
      fetching.add(query.queryHash);
      const since = started.get(query.queryHash) ?? at;
      started.set(query.queryHash, since);
      if (flagged.has(query.queryHash) || at - since < stuckLoadingMs) continue;
      flagged.add(query.queryHash);
      reportClientSignal({
        kind: 'stuck-loading',
        message: `Loading took longer than ${Math.round(stuckLoadingMs / 100) / 10} s: ${queryPlace(query.queryKey)}`,
        path: queryPlace(query.queryKey),
        durationMs: at - since,
      });
    }
    for (const hash of [...started.keys()]) {
      if (fetching.has(hash)) continue;
      started.delete(hash);
      flagged.delete(hash);
    }
  };
  const timer = setInterval(tick, STUCK_POLL_MS);
  return () => clearInterval(timer);
}
