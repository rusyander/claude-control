import { apiClient } from '@shared/api/client';
import { normalizeProjectPath } from '@shared/lib/workspace';
import { aggregateStatus, runStatus, type RunStatus } from './status';
import { selectActiveRuns, type ActiveRunView } from './selectors';

/**
 * Стор прогонов агента. В отличие от одного стрима на страницу, здесь их может
 * быть несколько сразу: агент продолжает работать в проекте, даже когда ты
 * переключился на другой таб. Каждый прогон — свой процесс на сервере и свой
 * поток событий; стор сводит их статусы по проектам для цветных точек на табах.
 *
 * Обновления иммутабельны (новый объект прогона на каждое событие) — этого ждёт
 * `useSyncExternalStore`. Снимок статусов по проектам кэшируется и пересчитывается
 * только при смене статуса или по таймеру зависания, а не на каждый токен текста,
 * иначе лента табов перерисовывалась бы на каждую букву ответа.
 */

export interface StreamedTool {
  name: string;
  input: string;
}

/** Запрос агента на разрешение инструмента — ждёт «Разрешить»/«Запретить». */
export interface PendingPermission {
  toolName: string;
  input: unknown;
  toolUseId: string;
}

export interface AgentRun {
  /** Стабильный id прогона — chatId, с которым он стартовал. */
  id: string;
  sessionId?: string;
  /** Каталог проекта — для группировки статусов (undefined = домашний чат). */
  projectPath?: string;
  status: RunStatus;
  text: string;
  thinking: string;
  tools: StreamedTool[];
  costUsd?: number;
  /** Токенов израсходовано в этом прогоне (input+output+cache). */
  tokens: number;
  limitResetsAt?: number;
  error?: string;
  /** В последнем ходе агент задал вопрос человеку (AskUserQuestion). */
  askedQuestion: boolean;
  /** Запросы на права, ждущие ответа человека (интерактивный permission-prompt). */
  permissions: PendingPermission[];
  /** Последний отправленный запрос — для кнопки «Повторить». */
  lastPrompt?: string;
  /** Разрешались ли правки в прошлом запуске — для повтора с теми же правами. */
  allowEdits?: boolean;
  /** Модель и глубина продумывания прошлого запуска — для повтора теми же. */
  model?: string;
  effort?: string;
  lastEventAt: number;
}

export interface StartInput {
  chatId: string;
  prompt: string;
  sessionId?: string;
  files?: { name: string; base64: string }[];
  allowEdits?: boolean;
  /** Каталог проекта: серверу — для нового чата, стору — для группировки. */
  projectPath?: string;
  /** Полный доступ (bypassPermissions) — для «Разрешить и продолжить». */
  fullAccess?: boolean;
  /** Модель для разговора (алиас/полное имя); пусто = по умолчанию. */
  model?: string;
  /** Глубина продумывания (--effort); пусто = по умолчанию. */
  effort?: string;
}

type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreation: number }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string }
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' };

export const EMPTY_RUN: AgentRun = {
  id: '',
  status: 'idle',
  text: '',
  thinking: '',
  tools: [],
  tokens: 0,
  askedQuestion: false,
  permissions: [],
  lastEventAt: 0,
};

const runs = new Map<string, AgentRun>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

/** Последний полученный seq по прогону — точка догоняния при переподключении. */
const lastSeqs = new Map<string, number>();
/** Сколько раз пробуем переподключиться при обрыве, прежде чем сдаться. */
const MAX_RECONNECT = 5;

/** Сколько раз сам перезапускаем прогон, упавший по «мигнувшей» причине. */
const autoRetries = new Map<string, number>();
const MAX_AUTO_RETRIES = 2;

/**
 * Похоже ли падение на временное (сеть моргнула, сервис перегружен, таймаут) —
 * такое чиним сами перезапуском, не дёргая пользователя. Настоящие ошибки
 * (нет прав, неверный ключ, отказ модели) сюда не попадают — их показываем.
 */
function isTransientError(message: string | undefined): boolean {
  if (!message) return false;
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|Connection error|overloaded|temporarily|timed?\s?out|\b50[234]\b|\b529\b/i.test(
    message,
  );
}

let onFinished: (() => void) | undefined;
let onBackgroundEvent: ((run: AgentRun) => void) | undefined;
/** Новый запрос прав по любому прогону — для карточки, звука и тоста. */
let onPermissionRequest: ((run: AgentRun) => void) | undefined;
/** Чат, открытый на экране: его завершение не уведомляем — пользователь и так видит. */
let activeId: string | undefined;
let statusSnapshot = new Map<string, RunStatus>();
let activeRunsSnapshot: ActiveRunView[] = [];
/** Накопленная стоимость всех прогонов за сессию (прогоны очищаются, счётчик — нет). */
let totalCostUsd = 0;
/** Накопленные токены всех прогонов за сессию. */
let totalTokensUsed = 0;
let watchdog: ReturnType<typeof setInterval> | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Пересобрать снимок статусов по проектам (с поправкой на зависание). */
function rebuildStatuses(): void {
  const now = Date.now();
  const byProject = new Map<string, RunStatus[]>();

  for (const run of runs.values()) {
    if (!run.projectPath) continue;
    const key = normalizeProjectPath(run.projectPath);
    const status = runStatus({
      status: run.status,
      lastEventAt: run.lastEventAt,
      now,
      pendingPermission: run.permissions.length > 0,
    });
    const list = byProject.get(key) ?? [];
    list.push(status);
    byProject.set(key, list);
  }

  const next = new Map<string, RunStatus>();
  for (const [key, list] of byProject) next.set(key, aggregateStatus(list));
  statusSnapshot = next;

  // Пульт агентов и счётчик работают из того же снимка.
  activeRunsSnapshot = selectActiveRuns([...runs.values()], now);
}

/** Таймер зависания: раз в 20 c пересобираем статусы, чтобы «молчащий» стал красным. */
function ensureWatchdog(): void {
  if (watchdog || typeof window === 'undefined') return;
  watchdog = setInterval(() => {
    let hasRunning = false;
    for (const run of runs.values()) if (run.status === 'running') hasRunning = true;
    if (!hasRunning) return;
    rebuildStatuses();
    emit();
  }, 20_000);
}

function setRun(id: string, patch: Partial<AgentRun>): void {
  const current = runs.get(id) ?? { ...EMPTY_RUN, id };
  runs.set(id, { ...current, ...patch });
}

/**
 * Ключ прогона по id чата. Новый чат стартует под временным id (`new-…`), а
 * потом получает настоящий sessionId; чтобы отображение не потеряло прогон при
 * смене id, ищем и по sessionId.
 */
function findKey(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (runs.has(id)) return id;
  for (const [key, run] of runs) if (run.sessionId === id) return key;
  return undefined;
}

function applyEvent(id: string, event: ChatEvent): void {
  const run = runs.get(id);
  if (!run) return;

  const next: AgentRun = { ...run, lastEventAt: Date.now() };
  let firePermission = false;
  switch (event.kind) {
    case 'session':
      next.sessionId = event.sessionId;
      break;
    case 'text':
      next.text = run.text + event.text;
      break;
    case 'thinking':
      next.thinking = run.thinking + event.text;
      break;
    case 'tool':
      next.tools = [...run.tools, { name: event.name, input: JSON.stringify(event.input) }];
      // Вопрос человеку — повод для жёлтой точки, когда ход завершится.
      if (event.name === 'AskUserQuestion') next.askedQuestion = true;
      break;
    case 'limit':
      next.limitResetsAt = event.resetsAt;
      break;
    case 'usage': {
      const spent = event.input + event.output + event.cacheRead + event.cacheCreation;
      next.tokens = run.tokens + spent;
      totalTokensUsed += spent;
      break;
    }
    case 'done':
      next.costUsd = event.costUsd;
      next.sessionId = event.sessionId || run.sessionId;
      // Копим стоимость по всем прогонам: отдельные прогоны потом очищаются.
      totalCostUsd += event.costUsd;
      break;
    case 'error':
      next.error = event.message;
      break;
    case 'permission': {
      // Новый запрос прав — добавляем (без дублей по toolUseId).
      const already = run.permissions.some((p) => p.toolUseId === event.toolUseId);
      next.permissions = already
        ? run.permissions
        : [
            ...run.permissions,
            { toolName: event.toolName, input: event.input, toolUseId: event.toolUseId },
          ];
      firePermission = !already;
      break;
    }
    case 'permissionResolved':
      next.permissions = run.permissions.filter((p) => p.toolUseId !== event.toolUseId);
      break;
  }
  runs.set(id, next);
  // Запрос/ответ прав меняют «важность» прогона (жёлтая точка) — пересобираем.
  if (event.kind === 'permission' || event.kind === 'permissionResolved') rebuildStatuses();
  emit();
  if (firePermission) onPermissionRequest?.(next);
}

function finalize(id: string): void {
  const run = runs.get(id);
  if (!run) return;
  const status: RunStatus = run.error ? 'error' : run.askedQuestion ? 'waiting' : 'idle';
  const isActive = activeId != null && (activeId === run.id || activeId === run.sessionId);

  // Фоновый прогон: текст ответа уже в истории, на экране его нет — освобождаем
  // память, но статус (цвет точки) и текст ошибки сохраняем. Завершённый прогон
  // не держит висящих запросов прав — их снимаем.
  const finalized: AgentRun = isActive
    ? { ...run, status, permissions: [] }
    : { ...run, status, text: '', thinking: '', tools: [], permissions: [] };
  runs.set(id, finalized);
  rebuildStatuses();
  emit();

  // Уведомляем только о фоновых проектных прогонах: активный виден и так, а
  // фоновый агент мог задать вопрос или упасть, пока ты в другом табе.
  if (!isActive && finalized.projectPath && onBackgroundEvent) onBackgroundEvent(finalized);
}

/** Пауза с учётом прерывания — между попытками переподключения. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Прочитать SSE-поток прогона в стор. Пинг-комментарии (`: ping`) пропускаем.
 * Возвращает, как поток завершился: `clean` — пришло терминальное событие
 * (done/error); `gone` — сервер сообщил, что прогона больше нет; `dirty` —
 * поток оборвался без терминала (повод переподключиться).
 */
async function pumpStream(
  id: string,
  response: Response,
  controller: AbortController,
): Promise<'clean' | 'dirty' | 'gone'> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false;

  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      // Прерывание кнопкой — наверх; сетевой обрыв — переподключаемся.
      if (controller.signal.aborted) throw error;
      return 'dirty';
    }
    if (chunk.done) break;

    buffer += decoder.decode(chunk.value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.split('\n').find((piece) => piece.startsWith('data:'));
      if (!line) continue; // пинг-комментарий
      const parsed = JSON.parse(line.slice(5)) as { kind: string; seq?: number };
      if (typeof parsed.seq === 'number') lastSeqs.set(id, parsed.seq);
      if (parsed.kind === 'gone') return 'gone';
      if (parsed.kind === 'done' || parsed.kind === 'error') sawTerminal = true;
      applyEvent(id, parsed as unknown as ChatEvent);
    }
  }
  return sawTerminal ? 'clean' : 'dirty';
}

/** Открыть один поток: `send` стартует прогон (POST), `attach` подключается (GET). */
async function openStream(
  id: string,
  input: StartInput,
  controller: AbortController,
  mode: 'send' | 'attach',
): Promise<'clean' | 'dirty' | 'gone'> {
  let response: Response;
  if (mode === 'send') {
    response = await fetch(`${apiClient.defaults.baseURL}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
  } else {
    const from = lastSeqs.get(id) ?? 0;
    response = await fetch(`${apiClient.defaults.baseURL}/chat/${id}/stream?from=${from}`, {
      method: 'GET',
      signal: controller.signal,
    });
  }

  if (!response.ok) {
    if (mode === 'send') throw new Error(`Сервер ответил ${response.status}`);
    return 'dirty';
  }
  if (!response.body) {
    if (mode === 'send') throw new Error('Пустой ответ сервера');
    return 'dirty';
  }
  return pumpStream(id, response, controller);
}

/**
 * Вести прогон: открыть поток и, если он оборвётся без завершения, автоматически
 * переподключиться, догнав пропущенное с последнего seq. Сдаёмся после
 * `MAX_RECONNECT` попыток — тогда финализируем по тому, что успели получить, а
 * ответ подтянется из истории.
 */
async function runStream(
  id: string,
  input: StartInput,
  controller: AbortController,
  initial: 'send' | 'attach',
): Promise<void> {
  try {
    let outcome = await openStream(id, input, controller, initial);
    let attempt = 0;
    while (outcome === 'dirty' && !controller.signal.aborted && attempt < MAX_RECONNECT) {
      attempt += 1;
      await sleep(Math.min(500 * 2 ** attempt, 5000), controller.signal);
      if (controller.signal.aborted) break;
      outcome = await openStream(id, input, controller, 'attach');
    }
  } catch (error) {
    // Прерывание кнопкой — не ошибка.
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      const run = runs.get(id);
      if (run) {
        runs.set(id, { ...run, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    controllers.delete(id);
    lastSeqs.delete(id);

    // Упал по временной причине (сеть моргнула, перегрузка) — сами перезапускаем
    // тем же запросом, продолжая сессию. Пользователю ошибку не показываем и не
    // пищим: для него это просто «агент чуть задумался». Бюджет попыток ограничен.
    const run = runs.get(id);
    const spent = autoRetries.get(id) ?? 0;
    const willAutoRetry = Boolean(
      run && run.error && isTransientError(run.error) && spent < MAX_AUTO_RETRIES && run.lastPrompt,
    );

    if (willAutoRetry) {
      autoRetries.set(id, spent + 1);
      setRun(id, { status: 'running', error: undefined, lastEventAt: Date.now() });
      rebuildStatuses();
      emit();
      const delay = Math.min(1000 * 2 ** (spent + 1), 4000);
      setTimeout(() => agentRuns.retry(id, { auto: true }), delay);
    } else {
      autoRetries.delete(id);
      finalize(id);
      onFinished?.();
    }
  }
}

export const agentRuns = {
  /** Запустить (или перезапустить) прогон под данным chatId. */
  start(input: StartInput): void {
    ensureWatchdog();
    const id = input.chatId;
    controllers.get(id)?.abort();
    const controller = new AbortController();
    controllers.set(id, controller);
    lastSeqs.set(id, 0);

    // Тот же разговор мог начаться под временным id (`new-…`), а продолжается уже
    // под настоящим sessionId. Старый прогон-двойник убираем, чтобы не копился.
    if (input.sessionId) {
      for (const [key, run] of runs) {
        if (key !== id && run.sessionId === input.sessionId) {
          controllers.get(key)?.abort();
          controllers.delete(key);
          runs.delete(key);
        }
      }
    }

    const prev = runs.get(id);
    setRun(id, {
      id,
      // Идентификатор сессии — ниточка разговора, сохраняем между ходами.
      sessionId: input.sessionId ?? prev?.sessionId,
      projectPath: input.projectPath ?? prev?.projectPath,
      status: 'running',
      text: '',
      thinking: '',
      tools: [],
      tokens: 0,
      costUsd: undefined,
      error: undefined,
      askedQuestion: false,
      permissions: [],
      // Запоминаем запрос, права, модель и глубину — для кнопки «Повторить».
      lastPrompt: input.prompt,
      allowEdits: input.allowEdits,
      model: input.model,
      effort: input.effort,
      lastEventAt: Date.now(),
    });
    rebuildStatuses();
    emit();

    // Поток отвязан от вкладки: обрыв связи сам переподключается, догоняя
    // пропущенное, а сервер тем временем держит агента живым.
    void runStream(id, input, controller, 'send');
  },

  /**
   * Подхватить прогоны, которые идут на сервере, но которых нет в этом сторе, —
   * после перезагрузки страницы. Тянем каждый с нуля, восстанавливая вывод.
   */
  async resumeActive(): Promise<void> {
    let active: { chatId: string; sessionId?: string; projectPath?: string; seq: number }[];
    try {
      const response = await apiClient.get('/chat/active');
      active = response.data as typeof active;
    } catch {
      return;
    }

    for (const info of active) {
      if (runs.has(info.chatId) || controllers.has(info.chatId)) continue;
      ensureWatchdog();
      const controller = new AbortController();
      controllers.set(info.chatId, controller);
      lastSeqs.set(info.chatId, 0);
      setRun(info.chatId, {
        id: info.chatId,
        sessionId: info.sessionId,
        projectPath: info.projectPath,
        status: 'running',
        text: '',
        thinking: '',
        tools: [],
        tokens: 0,
        costUsd: undefined,
        error: undefined,
        askedQuestion: false,
        permissions: [],
        lastEventAt: Date.now(),
      });
      rebuildStatuses();
      emit();
      void runStream(info.chatId, { chatId: info.chatId, prompt: '' }, controller, 'attach');
    }
  },

  /** Остановить прогон: сервер убивает процесс, клиент перестаёт читать поток. */
  stop(id: string): void {
    const key = findKey(id) ?? id;
    void apiClient.post(`/chat/${key}/stop`).catch(() => undefined);
    controllers.get(key)?.abort();
  },

  /**
   * Повторить прогон тем же запросом. `fullAccess` — перезапуск с полным
   * доступом (bypassPermissions), когда агент встал из-за прав. `auto` — это
   * автоматический перезапуск после временного сбоя: бюджет авто-попыток он не
   * обнуляет, а ручной («Повторить») — начинает счёт заново.
   */
  retry(id: string, options?: { fullAccess?: boolean; auto?: boolean }): void {
    const run = getRun(id);
    if (!run.lastPrompt) return;
    const key = run.id || id;
    if (!options?.auto) autoRetries.delete(key);
    agentRuns.start({
      chatId: key,
      prompt: run.lastPrompt,
      sessionId: run.sessionId,
      projectPath: run.projectPath,
      allowEdits: run.allowEdits,
      model: run.model,
      effort: run.effort,
      fullAccess: options?.fullAccess,
    });
  },

  /**
   * Продолжить упавший/остановленный разговор: просим агента продолжить с того
   * места, где он замолчал, не переспрашивая исходную задачу. Сессию не теряем.
   */
  continue(id: string, prompt: string): void {
    const run = getRun(id);
    autoRetries.delete(run.id || id);
    agentRuns.start({
      chatId: run.id || id,
      prompt,
      sessionId: run.sessionId,
      projectPath: run.projectPath,
      allowEdits: run.allowEdits,
      model: run.model,
      effort: run.effort,
    });
  },

  /** Остановить все идущие прогоны разом — кнопка «Остановить всех» в пульте. */
  stopAll(): void {
    for (const key of [...controllers.keys()]) {
      void apiClient.post(`/chat/${key}/stop`).catch(() => undefined);
      controllers.get(key)?.abort();
    }
  },

  /** Убрать прогон из стора (например, когда его ответ уже есть в истории). */
  clear(id: string): void {
    const key = findKey(id);
    if (!key) return;
    controllers.get(key)?.abort();
    controllers.delete(key);
    runs.delete(key);
    rebuildStatuses();
    emit();
  },

  /**
   * Спрятать потоковый текст прогона, сохранив статус: когда ответ уже есть в
   * истории, дубль на экране не нужен, но жёлтая/красная точка (вопрос/ошибка)
   * должна остаться.
   */
  quiet(id: string): void {
    const key = findKey(id);
    if (!key) return;
    const run = runs.get(key);
    if (!run) return;
    runs.set(key, { ...run, text: '', thinking: '', tools: [] });
    emit();
  },

  /** Колбэк по завершении любого прогона — страница обновляет список чатов. */
  setOnFinished(callback: (() => void) | undefined): void {
    onFinished = callback;
  },

  /** Какой чат открыт на экране — чтобы не уведомлять о его же завершении. */
  setActiveId(id: string | undefined): void {
    activeId = id;
  },

  /** Колбэк по завершении ФОНОВОГО проектного прогона — для тоста-уведомления. */
  setOnBackgroundEvent(callback: ((run: AgentRun) => void) | undefined): void {
    onBackgroundEvent = callback;
  },

  /** Колбэк на новый запрос прав любого прогона — звук/тост/карточка. */
  setOnPermissionRequest(callback: ((run: AgentRun) => void) | undefined): void {
    onPermissionRequest = callback;
  },

  /** Ответить на запрос прав (клик «Разрешить»/«Запретить»). */
  decidePermission(
    id: string,
    toolUseId: string,
    behavior: 'allow' | 'deny',
    message?: string,
  ): void {
    const run = getRun(id);
    const key = run.id || id;
    // Локально убираем карточку сразу — не ждём эха с сервера.
    const current = runs.get(key);
    if (current) {
      runs.set(key, {
        ...current,
        permissions: current.permissions.filter((p) => p.toolUseId !== toolUseId),
      });
      rebuildStatuses();
      emit();
    }
    void apiClient
      .post(`/chat/${key}/permission-decision`, { toolUseId, behavior, message })
      .catch(() => undefined);
  },
};

export function getRun(id: string | undefined): AgentRun {
  const key = findKey(id);
  return (key && runs.get(key)) || EMPTY_RUN;
}

export function getProjectStatuses(): Map<string, RunStatus> {
  return statusSnapshot;
}

export function getActiveRuns(): ActiveRunView[] {
  return activeRunsSnapshot;
}

export function getTotalCost(): number {
  return totalCostUsd;
}

export function getTotalTokens(): number {
  return totalTokensUsed;
}

export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
