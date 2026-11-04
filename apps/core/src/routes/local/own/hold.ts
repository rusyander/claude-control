import { join } from 'node:path';
import type {
  LocalHoldBody,
  LocalHoldRefusal,
  LocalHoldView,
  LocalReleaseReply,
} from '@agentdeck/contracts/core/local-hold';
import type { RouteLease, RouteRecorder } from '@agentdeck/contracts/core/routes';
import { writeFileAtomic } from '../../../platform/safe-io/atomic-write.ts';
import { ensureDir, readBytesSync } from '../../../platform/safe-io/files.ts';
import { removeVerified } from '../../../platform/safe-io/remove.ts';
import { RouteRefused } from '../../lease.ts';
import { readLeaseState } from './lease-state.ts';
import { createOwnRoute, type OwnRoute, type OwnRouteOptions } from './own.ts';

/**
 * Удержание своей модели панелью (этап 10, зона C) — кнопки раздела «Локальные модели» поверх
 * маршрута `local:own`, а не второй сервер моделей рядом с ним:
 * - слот карты общий с задачами ядра (одна очередь слотов на процесс): держит задача — отказ
 *   `local_slot_busy` сразу, кнопка не ждёт и вторую модель на карту не грузит;
 * - память карты судит `fit` маршрута до загрузки: не влезает — отказ без загрузки;
 * - удержание переживает ядро: запись `hold.json` + запись аренды маршрута; новое ядро на загрузке
 *   возвращает себе живой сервер (`restore`), а не поднимает второй;
 * - умерший сервер поднимается заново, когда по постоянному адресу пришёл запрос (`target`):
 *   не больше `reviveMax` неудач подряд с растущей паузой — модель, падающая при загрузке, не
 *   грузится всю ночь на каждый повтор CLI (так было у панели до L6).
 * Один удерживаемый сервер на ядро; новая модель — сначала освобождение прежней полным
 * протоколом (выгрузка, остановка дерева, память карты прочитана назад).
 */

export const HOLD_ROUTE_ID = 'local:own:panel';
/** Держатель аренды в журнале: не задача, а кнопка человека в панели. */
export const HOLD_TASK_ID = 'panel-hold';
const HOLD_FILE = 'hold.json';

export interface LocalHoldOptions {
  /** Каталог удержания в доме ядра: `hold.json` и каталог аренд маршрута. */
  workRoot: string;
  /** Журнал ядра для решений маршрута вне задачи (`fit`, `endpoint`, ресурсы). */
  journal: RouteRecorder;
  core?: { bootId: string };
  /** Чтения и сроки маршрута (тесты: подставная память, короткие сроки, своя очередь слотов). */
  route?: Partial<Omit<OwnRouteOptions, 'id' | 'server' | 'models' | 'workRoot'>>;
  /** Аргументы перед своими у сервера (скрипт подставного маршрутизатора в тестах). */
  leadArgs?: readonly string[];
  now?: () => number;
  reviveMax?: number;
  reviveBackoffMs?: number;
  /** Сколько верить прочитанной живости сервера, прежде чем спросить снова. */
  liveCacheMs?: number;
}

export interface HoldRecord {
  v: 1;
  server: LocalHoldBody['server'];
  model: LocalHoldBody['model'];
  meta?: Record<string, unknown>;
  since: string;
  /** Нет — выдача не завершилась (ядро упало на полпути): возврат освобождает всё найденное. */
  lease?: RouteLease;
}

export type HoldOutcome =
  { ok: true; view: LocalHoldView } | { ok: false; code: LocalHoldRefusal; reason: string };

/** Сервер удержания за постоянным адресом: куда слать и что о нём знает окно (`window.ts`). */
export interface HoldServed {
  origin: string;
  /** Имя модели (`model.id`): его роутер llama-server читает в `?model=`. */
  model: string;
  /** Окно сервера, токенов: `model.contextTokens`, иначе `ctx-size` аргументов; неизвестно — нет. */
  context?: number;
  /** Замер панели (`meta.promptTokensPerSecond`): срок первого байта под длину промпта. */
  promptTokensPerSecond?: number;
  /** Запуск целиком (`specKey`): кеш слота другого запуска не годится. */
  shape: string;
  /** Каталог `--slot-save-path` из аргументов запуска. */
  slotDir?: string;
}

export type HoldTarget = HoldServed | { refused: string; reason: string };

/** Что окно знает о сервере удержания — из записи удержания, без похода на сервер. */
export function servedOf(record: HoldRecord, origin: string): HoldServed {
  const args = record.model.args ?? {};
  const ctx = Number(args['ctx-size']);
  const context =
    record.model.contextTokens ?? (Number.isInteger(ctx) && ctx > 0 ? ctx : undefined);
  const speed = Number(record.meta?.promptTokensPerSecond);
  const slotDir = args['slot-save-path'];
  return {
    origin,
    model: record.model.id,
    ...(context ? { context } : {}),
    ...(Number.isFinite(speed) && speed > 0 ? { promptTokensPerSecond: speed } : {}),
    shape: specKey(record),
    ...(slotDir ? { slotDir } : {}),
  };
}

export interface LocalHold {
  hold(body: LocalHoldBody): Promise<HoldOutcome>;
  release(): Promise<LocalReleaseReply>;
  /**
   * Адрес живого сервера удержания для постоянного порта; мёртвый — подъём с паузами.
   * `stale` — адрес, который только что не принял соединение: его кэш живости сбрасывается.
   */
  target(stale?: string): Promise<HoldTarget>;
  view(front: LocalHoldView['front']): Promise<LocalHoldView>;
  /** Загрузка ядра: вернуть удержание прошлого ядра (слот занят его живым сервером). */
  restore(): Promise<void>;
}

const REVIVE_MAX = 3;
const REVIVE_BACKOFF_MS = 30_000;
const LIVE_CACHE_MS = 2_000;

const sortedEntries = (record: Readonly<Record<string, string>> | undefined): [string, string][] =>
  Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));

/** Одна и та же модель с тем же запуском — второй загрузки не нужно. */
function specKey(body: Pick<HoldRecord, 'server' | 'model'>): string {
  const { server, model } = body;
  return JSON.stringify([
    server.command,
    sortedEntries(server.env),
    model.id,
    model.path,
    model.sizeBytes,
    model.contextTokens ?? null,
    model.needBytes ?? null,
    sortedEntries(model.args),
  ]);
}

type ReleaseFacts = Pick<LocalReleaseReply, 'verified' | 'leaks'>;

/**
 * Мёртвый сервер (сбой, ООМ, снят мимо ядра) выгрузку ответом не подтвердит — протокол аренды
 * честно пишет «unload unproven». Для кнопки и подъёма доказательство другое: дерево снято
 * доказанно и память карты вернулась к базе. Тогда эта строка — факт, а не утечка; любая другая
 * утечка (дерево живо, память не вернулась) остаётся утечкой.
 */
export function settleUnload(outcome: ReleaseFacts): ReleaseFacts {
  const unproven = outcome.leaks.filter((leak) => leak.reason.startsWith('unload unproven'));
  const proven =
    outcome.verified.some((fact) => fact.fact.startsWith('tree stopped')) &&
    outcome.verified.some((fact) => fact.fact.startsWith('vram back'));
  if (unproven.length === 0 || !proven) return outcome;
  return {
    verified: [
      ...outcome.verified,
      ...unproven.map((leak) => ({
        rid: leak.rid,
        fact: `model gone with the stopped server tree, vram back (${leak.reason})`,
      })),
    ],
    leaks: outcome.leaks.filter((leak) => !unproven.includes(leak)),
  };
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createLocalHold(options: LocalHoldOptions): LocalHold {
  const now = options.now ?? Date.now;
  const leasesRoot = join(options.workRoot, 'leases');
  const recordPath = join(options.workRoot, HOLD_FILE);
  const reviveMax = options.reviveMax ?? REVIVE_MAX;
  const backoffMs = options.reviveBackoffMs ?? REVIVE_BACKOFF_MS;
  const liveCacheMs = options.liveCacheMs ?? LIVE_CACHE_MS;
  let route: { key: string; route: OwnRoute } | undefined;
  let failures = 0;
  let nextAt = 0;
  let cause: string | undefined;
  let liveAt: { at: number; origin: string; leaseId: string } | undefined;
  // Все изменения удержания — по очереди: две кнопки разом не поднимут два сервера.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  function readRecord(): HoldRecord | undefined {
    const bytes = readBytesSync(recordPath);
    if (!('value' in bytes)) return undefined;
    try {
      const parsed = JSON.parse(bytes.value.toString('utf8')) as HoldRecord;
      return parsed.v === 1 && parsed.server && parsed.model ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  function writeRecord(record: HoldRecord): void {
    ensureDir(options.workRoot);
    writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  function dropRecord(): void {
    removeVerified(recordPath);
    liveAt = undefined;
  }

  /** Маршрут под запуск записи: тот же запуск — тот же экземпляр (его аренды в памяти). */
  function routeFor(record: Pick<HoldRecord, 'server' | 'model'>): OwnRoute {
    const key = specKey(record);
    if (route?.key === key) return route.route;
    const created = createOwnRoute({
      ...options.route,
      id: HOLD_ROUTE_ID,
      server: {
        command: record.server.command,
        ...(options.leadArgs ? { leadArgs: options.leadArgs } : {}),
        ...(record.server.env ? { env: record.server.env } : {}),
      },
      models: [
        {
          id: record.model.id,
          path: record.model.path,
          sizeBytes: record.model.sizeBytes,
          ...(record.model.contextTokens === undefined
            ? {}
            : { contextTokens: record.model.contextTokens }),
          ...(record.model.args ? { args: record.model.args } : {}),
          ...(record.model.needBytes === undefined ? {} : { needBytes: record.model.needBytes }),
        },
      ],
      workRoot: leasesRoot,
      ...(options.core ? { core: options.core } : {}),
      journal: options.journal,
    });
    route = { key, route: created };
    return created;
  }

  /** Освободить записанное удержание полным протоколом; запись уходит, исход — вызывающему. */
  async function releaseRecord(record: HoldRecord): Promise<LocalReleaseReply> {
    const own = routeFor(record);
    const outcome = record.lease
      ? await own.release(record.lease, options.journal)
      : await own.shutdown(options.journal);
    dropRecord();
    return { released: true, ...settleUnload(outcome) };
  }

  async function acquireFor(
    body: Pick<HoldRecord, 'server' | 'model' | 'meta'>,
  ): Promise<HoldOutcome> {
    const own = routeFor(body);
    // Слот держит задача ядра (или аренда другого ядра): кнопка не встаёт в очередь — отказ сразу.
    if (own.slotHeld())
      return {
        ok: false,
        code: 'local_slot_busy',
        reason: 'the GPU slot is held by a core task; one model per GPU',
      };
    const base: HoldRecord = {
      v: 1,
      server: body.server,
      model: body.model,
      ...(body.meta ? { meta: body.meta } : {}),
      since: new Date(now()).toISOString(),
    };
    // Запись — до выдачи: ядро, упавшее посреди запуска, найдёт её и освободит найденное.
    writeRecord(base);
    try {
      const lease = await own.acquire(
        { taskId: HOLD_TASK_ID, model: body.model.id, release: { keep: HOLD_TASK_ID } },
        options.journal,
      );
      writeRecord({ ...base, lease });
      return { ok: true, view: await viewOf(null) };
    } catch (error) {
      dropRecord();
      if (error instanceof RouteRefused) {
        const code: LocalHoldRefusal =
          error.code === 'model_absent' ? 'model_absent' : 'route_unavailable';
        return { ok: false, code, reason: error.reason };
      }
      return { ok: false, code: 'local_start_failed', reason: reasonOf(error) };
    }
  }

  async function liveOrigin(record: HoldRecord): Promise<string | undefined> {
    const lease = record.lease;
    if (!lease) return undefined;
    if (liveAt && liveAt.leaseId === lease.leaseId && now() - liveAt.at < liveCacheMs)
      return liveAt.origin;
    const endpoint = await routeFor(record).endpoint(lease, options.journal);
    if (!endpoint) {
      liveAt = undefined;
      return undefined;
    }
    liveAt = { at: now(), origin: endpoint.baseUrl, leaseId: lease.leaseId };
    return endpoint.baseUrl;
  }

  async function viewOf(front: LocalHoldView['front']): Promise<LocalHoldView> {
    const record = readRecord();
    const origin = record ? await liveOrigin(record) : undefined;
    const state = record?.lease
      ? readLeaseState(join(leasesRoot, record.lease.leaseId))
      : undefined;
    return {
      held: record
        ? {
            model: record.model.id,
            origin: state?.server?.origin ?? null,
            pid: state?.server?.identity.pid ?? null,
            since: record.since,
            ...(record.meta ? { meta: record.meta } : {}),
          }
        : null,
      live: origin !== undefined,
      front,
      ...(failures > 0 && cause
        ? {
            failure: {
              attempts: failures,
              cause,
              retryAt: Number.isFinite(nextAt) ? new Date(nextAt).toISOString() : null,
            },
          }
        : {}),
    };
  }

  return {
    hold: (body) =>
      serial(async () => {
        const current = readRecord();
        if (current && specKey(current) === specKey(body) && (await liveOrigin(current))) {
          if (body.meta) writeRecord({ ...current, meta: body.meta });
          return { ok: true, view: await viewOf(null) };
        }
        if (current) {
          const released = await releaseRecord(current);
          // Память карты не вернулась после прежнего — вторая модель туда не грузится.
          if (released.leaks.length > 0)
            return {
              ok: false,
              code: 'route_unavailable',
              reason: `previous hold not released: ${released.leaks.map((l) => l.reason).join('; ')}`,
            };
        }
        // Человек запустил сам — счёт неудачных подъёмов снят.
        failures = 0;
        nextAt = 0;
        cause = undefined;
        return acquireFor(body);
      }),

    release: () =>
      serial(async () => {
        failures = 0;
        nextAt = 0;
        cause = undefined;
        const record = readRecord();
        if (!record) return { released: false, verified: [], leaks: [] };
        return releaseRecord(record);
      }),

    async target(stale) {
      // Кэш живости (LIVE_CACHE_MS) выдал бы адрес сервера, умершего мгновение назад.
      if (stale !== undefined && liveAt?.origin === stale) liveAt = undefined;
      const record = readRecord();
      if (!record)
        return {
          refused: 'local_not_held',
          reason: 'no local model is held; start it in the panel',
        };
      const origin = await liveOrigin(record);
      if (origin) return servedOf(record, origin);
      return serial(async (): Promise<HoldTarget> => {
        // Пока ждали очередь, кнопка могла освободить или поднять заново.
        const fresh = readRecord();
        if (!fresh) return { refused: 'local_not_held', reason: 'the hold was released' };
        const again = await liveOrigin(fresh);
        if (again) return servedOf(fresh, again);
        if (failures >= reviveMax || now() < nextAt)
          return {
            refused: 'local_revive_capped',
            reason: `model server down; ${failures} restart(s) failed: ${cause ?? 'unknown'}`,
          };
        const released = await releaseRecord(fresh);
        const outcome =
          released.leaks.length > 0
            ? ({
                ok: false,
                code: 'route_unavailable',
                reason: `dead server not released: ${released.leaks.map((l) => l.reason).join('; ')}`,
              } as const)
            : await acquireFor(fresh);
        if (outcome.ok) {
          failures = 0;
          nextAt = 0;
          cause = undefined;
          const live = readRecord();
          const revived = live ? await liveOrigin(live) : undefined;
          if (live && revived) return servedOf(live, revived);
          return { refused: 'local_start_failed', reason: 'restarted server is not answering' };
        }
        failures += 1;
        cause = outcome.reason;
        nextAt =
          failures >= reviveMax
            ? Number.POSITIVE_INFINITY
            : now() + backoffMs * 2 ** (failures - 1);
        // Запись остаётся без аренды (та освобождена): человек видит причину, следующий подъём
        // после паузы начинает с чистого места, кнопка «Запустить» — сразу.
        const { lease: _released, ...wanted } = fresh;
        writeRecord(wanted);
        return { refused: outcome.code, reason: outcome.reason };
      });
    },

    view: (front) => viewOf(front),

    restore: () =>
      serial(async () => {
        const record = readRecord();
        if (!record) return;
        const own = routeFor(record);
        await own.restore();
        // Выдача не дошла до записи аренды: держать нечего, найденное освобождается.
        if (!record.lease) await releaseRecord(record);
      }),
  };
}
