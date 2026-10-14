import type { Health } from './llama-client.ts';
import type { ServerRecord } from './server.ts';

/**
 * Присмотр за сервером моделей: пока запись о нём есть (человек его не останавливал),
 * умерший сервер поднимается заново с теми же параметрами.
 *
 * Зачем. Ночной прогон на локальной модели живёт часами, а llama-server может упасть
 * (нехватка видеопамяти, когда её заняла другая программа; сбой драйвера). Раньше
 * его поднимала только панель при запуске, и мёртвый сервер оставался мёртвым: Claude
 * Code повторял запрос ~2,7 минуты и сдавался, а запись о сервере висела без процесса.
 *
 * Что считается «упал». Запись есть, `/health` молчит и процесса нет — сразу. Процесс
 * жив, но `/health` молчит `HUNG_AFTER_MISSES` проверок подряд — завис: снимается и
 * поднимается так же. Модель в загрузке (`loading`) — жива, ждём. Пока панель сама
 * запускает или перезапускает сервер (`busy`), присмотр молчит: иначе он принял бы
 * её же остановку за падение.
 *
 * Потолок и пауза: `MAX_RESTARTS` подъёмов за `RESTART_WINDOW_MS` — потолок. Дальше присмотр
 * не сдаётся (ночью некому нажать «Запустить», а причина бывает временной: видеопамять, занятая
 * чужой программой, освобождается), но и не бьётся серией: одна попытка за `RESTART_WINDOW_MS`.
 * Всё это время сообщение (`notice`, `gave-up`) остаётся: число попыток, последняя ошибка и
 * время следующей — его читает карточка сервера и текст ошибки шлюза. Удачный подъём или запуск
 * человеком (`reset`) снимают потолок целиком.
 */

export const SUPERVISE_INTERVAL_MS = 15_000;
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;
/** Проверок подряд без ответа у ЖИВОГО процесса, после которых он считается зависшим (≈2 минуты). */
export const HUNG_AFTER_MISSES = 8;

export interface ServerNotice {
  /** `restarted` — упал и поднят; `gave-up` — потолок подъёмов исчерпан; `failed` — подъём не удался. */
  kind: 'restarted' | 'gave-up' | 'failed';
  at: number;
  /** Сколько подъёмов предпринято с последнего удачного (в `gave-up` растёт и после потолка). */
  restarts: number;
  /** При `gave-up`: когда присмотр попробует снова (мс с начала эпохи). */
  nextTryAt?: number;
  /** Что сказал последний неудачный подъём. */
  reason?: string;
}

export type ReviveResult = 'restarted' | 'failed' | 'capped' | 'busy' | 'none' | 'alive';

export interface SupervisorDeps {
  record: () => ServerRecord | undefined;
  health: () => Promise<Health | undefined>;
  pidAlive: (pid: number) => boolean;
  /** Снять зависший процесс. */
  kill: (record: ServerRecord) => void;
  /**
   * Поднять сервер по записи; отказ — исключением. `cancelled` — человек нажал «Стоп», пока
   * подъём шёл: запускать процесс уже не нужно (L4c, F4).
   */
  restart: (record: ServerRecord, control: { cancelled: () => boolean }) => Promise<void>;
  /** Панель сама запускает или останавливает сервер. */
  busy: () => boolean;
  now?: () => number;
  intervalMs?: number;
}

export interface ServerSupervisor {
  /** Одна проверка; вызывается таймером. */
  tick(): Promise<ReviveResult>;
  /** Шлюз получил отказ в соединении: поднять сейчас, если сервер мёртв и потолок не исчерпан. */
  revive(): Promise<ReviveResult>;
  notice(): ServerNotice | undefined;
  /** Запись о сервере, которую присмотр помнит, даже когда сама запись пропала (неудачный подъём стирает её). */
  target(): ServerRecord | undefined;
  /** Человек остановил сервер: помнить нечего, воскрешать нечего. */
  forget(): void;
  /** Сервер поднят и отвечает (панель или человек запустили его): с этого момента присмотр поднимает его сам, если упадёт. */
  observe(record: ServerRecord): void;
  /** Человек сам запустил сервер: потолок и сообщение сбрасываются. */
  reset(): void;
  start(): void;
  stop(): void;
}

export function createServerSupervisor(deps: SupervisorDeps): ServerSupervisor {
  const now = deps.now ?? Date.now;
  let attempts: number[] = [];
  /** Подъёмов с последнего удачного: число в сообщении, не зависит от скольжения окна. */
  let tried = 0;
  /** Потолок исчерпан: дальше — одна попытка за `RESTART_WINDOW_MS`, пока подъём не удастся. */
  let exhausted = false;
  let lastAttemptAt = 0;
  /** Растёт на каждый «Стоп» человека: подъём, начатый до него, не пишет исход и не берёт сервер под присмотр. */
  let generation = 0;
  let notice: ServerNotice | undefined;
  let misses = 0;
  /** Последняя запись, виденная при жизни сервера (или при подъёме): по ней поднимаем, если файл записи стёрт. */
  let remembered: ServerRecord | undefined;
  /** Сервер был жив при нас: только тогда таймер поднимает его сам (после перезагрузки мёртвая запись — не повод грузить модель). */
  let watching = false;
  let inFlight: Promise<ReviveResult> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const recent = (): number => {
    const from = now() - RESTART_WINDOW_MS;
    attempts = attempts.filter((at) => at > from);
    return attempts.length;
  };

  async function recover(record: ServerRecord, hung: boolean): Promise<ReviveResult> {
    if (recent() >= MAX_RESTARTS) exhausted = true;
    if (exhausted && now() - lastAttemptAt < RESTART_WINDOW_MS) {
      notice = {
        kind: 'gave-up',
        at: now(),
        restarts: Math.max(tried, recent()),
        nextTryAt: lastAttemptAt + RESTART_WINDOW_MS,
        ...(notice?.reason ? { reason: notice.reason } : {}),
      };
      return 'capped';
    }
    attempts.push(now());
    lastAttemptAt = now();
    tried += 1;
    const started = generation;
    const control = { cancelled: () => started !== generation };
    try {
      if (hung) deps.kill(record);
      await deps.restart(record, control);
      if (control.cancelled()) return 'none';
      misses = 0;
      watching = true;
      // Удачный подъём снимает потолок: следующий сбой снова получает быстрые попытки.
      const wasExhausted = exhausted;
      exhausted = false;
      if (wasExhausted) attempts = [];
      notice = { kind: 'restarted', at: now(), restarts: wasExhausted ? tried : recent() };
      tried = 0;
      return 'restarted';
    } catch (error) {
      // Человек остановил сервер, пока он поднимался: падение подъёма — следствие Стопа, не сбой.
      if (control.cancelled()) return 'none';
      const reason = error instanceof Error ? error.message : String(error);
      if (recent() >= MAX_RESTARTS) exhausted = true;
      notice = {
        kind: exhausted ? 'gave-up' : 'failed',
        at: now(),
        restarts: tried,
        reason,
        ...(exhausted ? { nextTryAt: lastAttemptAt + RESTART_WINDOW_MS } : {}),
      };
      return 'failed';
    }
  }

  /** Состояние сервера по записи: `undefined` — жив или записи нет, иначе нужен подъём. */
  async function diagnose(): Promise<{ record: ServerRecord; hung: boolean } | 'alive' | 'none'> {
    const live = deps.record();
    if (live) remembered = live;
    const record = live ?? remembered;
    if (!record) return 'none';
    const health = await deps.health();
    if (health !== undefined) {
      misses = 0;
      watching = true;
      return 'alive';
    }
    // Файл записи стёрт (неудачный подъём), а сервера нет: поднимать по запомненной записи.
    if (!live || !deps.pidAlive(record.pid)) return { record, hung: false };
    misses += 1;
    return misses >= HUNG_AFTER_MISSES ? { record, hung: true } : 'alive';
  }

  async function check(byTimer: boolean): Promise<ReviveResult> {
    if (deps.busy()) return 'busy';
    const state = await diagnose();
    if (state === 'none') {
      misses = 0;
      return 'none';
    }
    if (state === 'alive') return 'alive';
    // Таймер не будит модель, которая при нас не жила: сервер после перезагрузки поднимает человек или запрос.
    if (byTimer && !watching) return 'none';
    // Пока шла проверка, панель могла начать свой запуск.
    if (deps.busy()) return 'busy';
    return recover(state.record, state.hung);
  }

  /** Один подъём за раз: тик и шлюз не запускают два процесса на один порт. */
  function single(byTimer: boolean): Promise<ReviveResult> {
    inFlight ??= check(byTimer).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /** Запрос шлюза ждёт идущую проверку и проверяет заново: её исход мог быть «не мой случай». */
  async function reviveNow(): Promise<ReviveResult> {
    if (inFlight) await inFlight.catch(() => undefined);
    return single(false);
  }

  return {
    tick: () => single(true),
    revive: reviveNow,
    notice: () => notice,
    target: () => remembered,
    observe(record) {
      remembered = record;
      watching = true;
      misses = 0;
    },
    forget() {
      generation += 1;
      remembered = undefined;
      watching = false;
      misses = 0;
    },
    reset() {
      attempts = [];
      tried = 0;
      exhausted = false;
      lastAttemptAt = 0;
      notice = undefined;
      misses = 0;
    },
    start() {
      if (timer) return;
      timer = setInterval(
        () => void single(true).catch(() => undefined),
        deps.intervalMs ?? SUPERVISE_INTERVAL_MS,
      );
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
