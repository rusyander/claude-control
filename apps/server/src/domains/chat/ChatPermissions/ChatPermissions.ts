/**
 * Брокер интерактивных прав. Мини-MCP-сервер (permission-prompt-server.mjs) по
 * запросу агента дёргает `/api/chat/permission-request`; тот держит ответ здесь,
 * пока человек не нажмёт «Разрешить»/«Запретить» в интерфейсе. Ключ — пара
 * «разговор + tool_use_id»: в одном ходе агент может спросить не раз.
 *
 * Безопасный дефолт — «запретить»: по таймауту или остановке разговора висящие
 * запросы отклоняются, а не зависают навсегда.
 */

export interface PermissionRequest {
  runId: string;
  toolName: string;
  input: unknown;
  toolUseId: string;
  /**
   * Чем ответят: обычная карточка прав или ворота ветки (первая правка в
   * основной копии). Сводке ожиданий (`chat-inbox.ts`) нужно различать: у ворот
   * другие ответы и другой маршрут.
   */
  kind?: 'permission' | 'branchGate';
}

/** Висящий запрос глазами сводки: что спрошено и когда. */
export interface PendingPermissionInfo extends PermissionRequest {
  askedAt: string;
}

/**
 * Ответ на запрос прав в чате. Имя намеренно не `PermissionDecision`: так
 * зовётся правило настроек (`allow`/`ask`/`deny`) в контрактах, а здесь — ответ
 * человека конкретному запросу агента.
 */
export interface ChatPermissionReply {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
  /**
   * Решал не человек: запрос истёк (срок брокера) или CLI перестал его ждать.
   * Карточка обязана сказать «истекло», а не «запрещено».
   */
  expired?: true;
}

/** Чем закончился ответ человека на запрос. */
export type PermissionDecideOutcome =
  /** Ответ принят — агент его получит. */
  | 'ok'
  /** Запрос умер раньше ответа: CLI его оборвал или истёк срок. Ответ ничего не запустит. */
  | 'expired'
  /** Такого запроса нет: уже отвечен (с другого устройства) или не существовал. */
  | 'unknown'
  /**
   * Запроса ещё нет, но разговор жив: панель только что перезапустилась, а мост
   * прав повторит вопрос через секунды. Ответ отложен и будет выдан повтору
   * (`answer(…, { hold: true })`).
   */
  | 'held';

/** Как отвечать на запрос, которого брокер не знает. */
export interface AnswerOptions {
  /**
   * Разговор жив, и запрос может прийти повтором: после перезапуска панели
   * карточка в открытой вкладке кликабельна раньше, чем мост прав достучится до
   * нового сервера (он повторяет с паузами). Без удержания клик пропадал
   * («нет такого»), а повторный вопрос ждал второго клика, которого никто не
   * делал.
   */
  hold?: boolean;
}

/** Сколько отложенный ответ ждёт повтора вопроса: мост повторяет секунды, запас — с лихвой. */
export const EARLY_ANSWER_MS = 10 * 60_000;

interface Pending {
  resolve: (decision: ChatPermissionReply) => void;
  timer: LongTimer;
  info: PendingPermissionInfo;
}

/**
 * Жёсткий предел CLI на один вызов MCP-инструмента — `MCP_TOOL_TIMEOUT`, по
 * умолчанию 1e8 мс (27,8 ч). Проверено живьём на claude 2.1.282: сигнал
 * прогресса этот предел НЕ сбрасывает (с ним вызов всё равно обрывается ровно на
 * сроке), сбрасывает он только счётчик простоя
 * (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, его держит `permission-prompt-server.mjs`).
 */
export const CLI_TOOL_CAP_MS = 100_000_000;

/**
 * Сколько запрос ждёт человека — чуть меньше, чем его способен ждать CLI.
 *
 * Было полчаса, потом год, и оба числа лгали. Полчаса — это счётчик простоя
 * CLI, а не наш выбор: телефон затем и нужен, чтобы ответить, когда человек
 * далеко, и полчаса не хватало. Год же был обещанием, которого CLI не держит:
 * он обрывает вызов на своём жёстком пределе, после чего карточка висела, а
 * ответ на неё ничего не запускал. Честный срок — предел CLI за вычетом запаса:
 * брокер сам отвечает «истекло» РАНЬШЕ, чем CLI молча уйдёт, и человек видит
 * правду, а не кнопку, которая ничего не делает. Предел читается из окружения
 * СЕРВЕРА — того, что CLI наследует при запуске. Но CLI берёт `env` ещё из
 * `settings.json` конфига и из параметров прогона: убавленный там предел брокер
 * не видит, и CLI сдаётся первым. Тогда карточку гасит результат вызова
 * (`toolResult` → «истекло»), а не этот срок.
 */
export function permissionWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MCP_TOOL_TIMEOUT);
  const cap = Number.isFinite(raw) && raw > 0 ? raw : CLI_TOOL_CAP_MS;
  // Запас — десятая доля, но не больше десяти минут: хватает, чтобы наш отказ
  // успел дойти до CLI раньше его собственного обрыва.
  return Math.max(1_000, cap - Math.min(10 * 60_000, cap / 10));
}

/** Срок по умолчанию (без `MCP_TOOL_TIMEOUT` в окружении) — ≈27,6 ч. */
export const DEFAULT_TIMEOUT_MS = permissionWaitMs({});

/** Сколько умерших запросов помнить, чтобы ответ на них получил «истекло», а не «нет такого». */
const MAX_EXPIRED = 500;

/** Текст отказа агенту, когда срок брокера вышел. */
export const EXPIRED_WAIT = 'The wait for a decision has expired.';

/**
 * Предел одного `setTimeout` — 2^31−1 мс, около 24,8 суток. Больше Node не
 * ждёт, а срабатывает СРАЗУ (с предупреждением); нарезка держит любой срок.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface LongTimer {
  handle?: ReturnType<typeof setTimeout>;
}

function startLongTimer(ms: number, fire: () => void): LongTimer {
  const timer: LongTimer = {};
  const arm = (left: number): void => {
    const step = Math.min(left, MAX_TIMER_MS);
    timer.handle = setTimeout(() => (left > step ? arm(left - step) : fire()), step);
  };
  arm(Math.max(0, ms));
  return timer;
}

function clearLongTimer(timer: LongTimer): void {
  if (timer.handle) clearTimeout(timer.handle);
}

export class PermissionBroker {
  private pending = new Map<string, Pending>();

  /** Умершие запросы (ключ → когда): ответ на них — «истекло», а не молчаливое «принято». */
  private expired = new Map<string, number>();

  /** Отвеченные запросы (ключ → когда): второй ответ на них — «нет такого», а не отложенный. */
  private answered = new Map<string, number>();

  /** Ответы, пришедшие раньше вопроса (ключ → решение и когда): их ждёт повтор моста. */
  private early = new Map<string, { decision: ChatPermissionReply; at: number }>();

  private key(runId: string, toolUseId: string): string {
    return `${runId}::${toolUseId}`;
  }

  /**
   * Запросить решение пользователя. Ждёт клика; по сроку — «запретить» с
   * пометкой «истекло». Срок по умолчанию — `permissionWaitMs()` на момент
   * запроса.
   */
  request(
    request: PermissionRequest,
    timeoutMs = permissionWaitMs(),
  ): Promise<ChatPermissionReply> {
    return new Promise((resolve) => {
      const key = this.key(request.runId, request.toolUseId);
      // Дубль по тому же tool_use — прежний снимаем (не должно случаться).
      // Вместе с обещанием обязательно гасим и его таймер: он удаляет запись по
      // КЛЮЧУ, а под ключом к тому времени лежит уже новый запрос — по сроку
      // стёрло бы живой, клик после этого не находил бы ничего.
      const replaced = this.pending.get(key);
      if (replaced) {
        clearLongTimer(replaced.timer);
        replaced.resolve({ behavior: 'deny', message: 'Replaced by a newer request.' });
      }
      this.expired.delete(key);

      // Человек ответил раньше, чем вопрос дошёл до этого сервера (перезапуск
      // панели): ответ ждал здесь — выдаём сразу, второго клика не нужно.
      const early = this.early.get(key);
      this.early.delete(key);
      if (early && Date.now() - early.at <= EARLY_ANSWER_MS) {
        this.remember(this.answered, key);
        resolve(early.decision);
        return;
      }

      const timer = startLongTimer(timeoutMs, () => {
        this.pending.delete(key);
        this.markExpired(key);
        resolve({ behavior: 'deny', message: EXPIRED_WAIT, expired: true });
      });

      this.pending.set(key, {
        resolve,
        timer,
        info: { ...request, askedAt: new Date().toISOString() },
      });
    });
  }

  /** Ответить на запрос (клик пользователя). false — если запрос уже снят. */
  decide(runId: string, toolUseId: string, decision: ChatPermissionReply): boolean {
    return this.answer(runId, toolUseId, decision) === 'ok';
  }

  /**
   * Ответить на запрос и узнать, что с ответом стало. Отличает умерший запрос от
   * несуществующего: на умерший человек обязан услышать «истекло», иначе он
   * думает, что разрешил, а не запустилось ничего.
   */
  answer(
    runId: string,
    toolUseId: string,
    decision: ChatPermissionReply,
    options: AnswerOptions = {},
  ): PermissionDecideOutcome {
    const key = this.key(runId, toolUseId);
    const pending = this.pending.get(key);
    if (!pending) {
      // Порядок решает: умерший запрос — «истекло» всегда, удержание его не
      // оживляет; отвеченный — «нет такого» (второе устройство опоздало).
      if (this.expired.has(key)) return 'expired';
      if (this.answered.has(key) || !options.hold || !toolUseId) return 'unknown';
      this.early.set(key, { decision, at: Date.now() });
      this.trim(this.early);
      return 'held';
    }
    clearLongTimer(pending.timer);
    this.pending.delete(key);
    this.remember(this.answered, key);
    pending.resolve(decision);
    return 'ok';
  }

  /** Запомнить ключ с отметкой времени, не давая памяти расти без предела. */
  private remember(map: Map<string, number>, key: string): void {
    map.set(key, Date.now());
    this.trim(map);
  }

  private trim(map: Map<string, unknown>): void {
    for (const oldest of map.keys()) {
      if (map.size <= MAX_EXPIRED) break;
      map.delete(oldest);
    }
  }

  /**
   * CLI вернул результат вызова `toolUseId`, а запрос прав по нему ещё висит —
   * значит, CLI его оборвал (счётчик простоя, жёсткий предел) и ответа не ждёт.
   * Запрос снимается как истёкший. Живой ответ сюда не попадает: `answer`
   * снимает запрос раньше, чем CLI исполнит вызов и вернёт результат.
   * Возвращает снятый запрос (или ничего).
   */
  expire(toolUseId: string): PendingPermissionInfo | undefined {
    if (!toolUseId) return undefined;
    const suffix = `::${toolUseId}`;
    // CLI закончил вызов, не дождавшись повтора вопроса: отложенный ответ не
    // достанется уже никому — и не должен ожить на чужом повторе.
    for (const key of this.early.keys()) if (key.endsWith(suffix)) this.early.delete(key);
    for (const [key, pending] of this.pending) {
      if (!key.endsWith(suffix)) continue;
      clearLongTimer(pending.timer);
      this.pending.delete(key);
      this.markExpired(key);
      pending.resolve({
        behavior: 'deny',
        message: 'The CLI stopped waiting for an answer to this request.',
        expired: true,
      });
      return { ...pending.info };
    }
    return undefined;
  }

  /** Умер ли запрос (истёк срок или CLI его оборвал). */
  isExpired(runId: string, toolUseId: string): boolean {
    return this.expired.has(this.key(runId, toolUseId));
  }

  private markExpired(key: string): void {
    this.expired.set(key, Date.now());
    for (const oldest of this.expired.keys()) {
      if (this.expired.size <= MAX_EXPIRED) break;
      this.expired.delete(oldest);
    }
  }

  /** Все висящие запросы — по всем разговорам, в порядке поступления. */
  list(): PendingPermissionInfo[] {
    return [...this.pending.values()].map((pending) => ({ ...pending.info }));
  }

  /** Есть ли по разговору висящие запросы. */
  hasPending(runId: string): boolean {
    const prefix = `${runId}::`;
    for (const key of this.pending.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  /** Снять все висящие запросы разговора (остановка) — как «запретить». */
  cancelRun(runId: string): void {
    const prefix = `${runId}::`;
    for (const key of this.early.keys()) if (key.startsWith(prefix)) this.early.delete(key);
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      clearLongTimer(pending.timer);
      this.pending.delete(key);
      pending.resolve({ behavior: 'deny', message: 'The conversation was stopped.' });
    }
  }
}
