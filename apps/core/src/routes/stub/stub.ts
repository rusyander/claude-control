import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ReleaseOutcome,
  Route,
  RouteAcquireSpec,
  RouteCaps,
  RouteEndpoint,
  RouteLease,
  RouteRecorder,
  RouteResource,
} from '@agentdeck/contracts/core/routes';
import { DIALECT_IDS, type DialectId } from '@agentdeck/stub-model';
import { absent, readFact } from '../../lib/facts/read-fact.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { helperEnv, launchDetached } from '../../platform/detached-launch.ts';
import { factReason, hasValue, sleep } from '../../platform/os-kind.ts';
import { allocatePort, bindLoopback, LOOPBACK, type BindProbe } from '../../platform/ports.ts';
import {
  createLivenessProbe,
  identityOfPid,
  type LivenessProbe,
  type ProcessIdentity,
} from '../../platform/process-identity.ts';
import { liveEndpoint } from '../endpoint.ts';
import { stopTree } from '../../platform/tree-stop.ts';
import { routeFactDecls } from '../facts.ts';
import { createResource, releaseOf, RouteAborted, RouteRefused, throwIfAborted } from '../lease.ts';
import { TREE_MARKER_NAME } from '../local/own/server.ts';
import {
  encodeStubConfig,
  STUB_IDENTITY_PATH,
  type StubScriptSource,
  type StubServerConfig,
} from './stub-config.ts';

export type { StubScriptSource } from './stub-config.ts';

/**
 * Маршрут-заглушка (11 R:PR-09): общая библиотека `packages/stub-model` в маршруте с теми же
 * возможностями и фактами, что у любого другого. Сервер — ОТДЕЛЬНЫЙ процесс (`stub-server.ts`),
 * как у настоящих маршрутов: провайдер и свой сервер моделей переживают ядро, и проверка
 * «ядро убито посреди аренды» (P10) меряет ядро, а не гибель адреса вместе с ним.
 *
 * Аренда: порт вне 5170–5180, процесс через платформу отвязанным (своя группа и сессия, вне
 * задания ядра на Windows, метка дерева = rid ресурса, без каналов вывода — мёртвое ядро не рвёт
 * ему трубу), готовность — по пути личности. Ссылка
 * ресурса `stub-server` несёт всё для возврата: адрес, диалект, pid и время старта. Перезапущенное
 * ядро отдаёт журнальную аренду в `endpoint()` — маршрут возвращается к тому же серверу, второго не
 * поднимает. Освобождение — остановка дерева по личности (pid + старт: чужой процесс с тем же pid
 * не задет) и ЧТЕНИЕ, что порт свободен; иначе утечка. Чистая остановка ядра — `shutdown()`:
 * снимает все серверы маршрута, вернувшиеся тоже; падение ядра их оставляет.
 */

export interface StubRouteOptions {
  /** Имя сценария — хвост id маршрута `stub:<имя>`. */
  name: string;
  script: StubScriptSource;
  /** Модели, которые отдаёт заглушка; по умолчанию одна `stub-model`. */
  models?: string[];
  contextTokens?: number;
  /** Файл следа (в домашнем каталоге ядра теста), дописывается. */
  trace?: string;
  /** Проба порта: выбор и проверка «порт свободен» после остановки (подменяется в тестах). */
  bind?: BindProbe;
  /** Живость по личности для `endpoint()` (F-73); подменяется в тестах (номер ушёл другому). */
  probe?: LivenessProbe;
  /** Сколько ждать ответа пути личности (по умолчанию 15 с). */
  startTimeoutMs?: number;
  /**
   * Windows: запуск через WMI — вне задания ядра (ядро в задании без разрешения выхода, как у
   * хоста сессии). Окружение туда не доходит, поэтому настройка идёт аргументом; метки дерева
   * у такого сервера нет, остановка — по личности (своих потомков сервер не заводит).
   */
  breakaway?: boolean;
}

/** Номер ещё занят (дешёвая проверка в цикле готовности; личность сверена при запуске). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс есть, но чужой по правам: жив.
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Маршрут-заглушка: обычный маршрут + чистая остановка вместе с ядром. */
export interface StubRoute extends Route {
  /** Остановить все серверы, которые маршрут держит (свои и вернувшиеся), с записью исхода. */
  shutdown(record: RouteRecorder): Promise<ReleaseOutcome>;
}

/** Диалекты — из самой библиотеки-заглушки: один источник, новый протокол пакета виден маршруту сразу. */
function isStubDialect(dialect: string): dialect is DialectId {
  return (DIALECT_IDS as readonly string[]).includes(dialect);
}

export const STUB_CAPS: RouteCaps = {
  dialects: [...DIALECT_IDS],
  tools: true,
  images: false,
  streaming: true,
  maskable: true,
  offline: true,
  binding: { via: 'endpoint' },
  limitsToTell: false,
};

const DEFAULT_MODELS = ['stub-model'];
const SERVER_ENTRY = fileURLToPath(new URL('./stub-server.ts', import.meta.url));

interface Held {
  lease: RouteLease;
  rid: string;
  origin: string;
  port: number;
  dialect: RouteEndpoint['dialect'];
  identity: ProcessIdentity;
}

/** Ссылка ресурса: адрес + диалект + личность процесса (`http://127.0.0.1:N/?dialect=…&pid=…&start=…`). */
export function stubServerRef(
  origin: string,
  dialect: RouteEndpoint['dialect'],
  identity: ProcessIdentity,
): string {
  const url = new URL(origin);
  url.searchParams.set('dialect', dialect);
  url.searchParams.set('pid', String(identity.pid));
  url.searchParams.set('start', identity.start);
  return url.href;
}

export function parseStubServerRef(
  ref: string,
): Omit<Held, 'lease' | 'rid'> | { unreadable: string } {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { unreadable: `not a url: ${ref}` };
  }
  const dialect = url.searchParams.get('dialect') ?? '';
  const pid = Number(url.searchParams.get('pid'));
  const start = url.searchParams.get('start') ?? '';
  const port = Number(url.port);
  if (url.hostname !== LOOPBACK || !Number.isInteger(port) || port <= 0)
    return { unreadable: `not a loopback port: ${ref}` };
  if (!isStubDialect(dialect)) return { unreadable: `unknown dialect in ${ref}` };
  if (!Number.isInteger(pid) || pid <= 0 || !start)
    return { unreadable: `no process identity in ${ref}` };
  return { origin: url.origin, port, dialect, identity: { pid, start } };
}

/** Кто отвечает на пути личности порта: владелец (rid) или «не прочитано» с причиной. */
async function ownerOf(origin: string): Promise<{ value: unknown } | { unknown: string }> {
  try {
    const reply = await fetch(`${origin}${STUB_IDENTITY_PATH}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!reply.ok) return { value: undefined };
    const body = (await reply.json()) as { owner?: unknown };
    return { value: body.owner };
  } catch (error) {
    return { unknown: `${STUB_IDENTITY_PATH} did not answer: ${(error as Error).message}` };
  }
}

async function answersAsOwner(origin: string, owner: string): Promise<boolean> {
  const read = await ownerOf(origin);
  return 'value' in read && read.value === owner;
}

export function createStubRoute(options: StubRouteOptions): StubRoute {
  const id = `stub:${options.name}`;
  // Сервер работает в папке маршрута, а не настройки: относительный путь модуля сценария
  // нашёл бы там другой файл или ничего.
  const script = options.script;
  if (!Array.isArray(script) && !isAbsolute(script.module))
    throw new Error(`${id}: script module must be an absolute path, got ${script.module}`);
  const servers = new Map<string, Held>();
  const released = new Set<string>();
  const models = options.models ?? DEFAULT_MODELS;
  const bind = options.bind ?? bindLoopback;
  const probe = options.probe ?? createLivenessProbe();

  async function startServer(
    owner: string,
    signal: RouteAcquireSpec['signal'],
  ): Promise<{ origin: string; port: number; identity: ProcessIdentity }> {
    const failures: string[] = [];
    const ABORTED = 'aborted by the caller';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new RouteAborted('stub start');
      const { port } = await allocatePort(bind);
      const config: StubServerConfig = {
        port,
        owner,
        models,
        script: options.script,
        ...(options.trace ? { trace: options.trace } : {}),
      };
      // Отвязанный запуск, а не обычный потомок: на Windows libuv кладёт потомков в задание
      // процесса с «убить при закрытии» — смерть ядра унесла бы сервер (P10 красный именно так).
      const started = await launchDetached({
        file: process.execPath,
        args: [
          '--experimental-strip-types',
          '--no-warnings',
          SERVER_ENTRY,
          encodeStubConfig(config),
        ],
        cwd: dirname(SERVER_ENTRY),
        env: { ...helperEnv(), [TREE_MARKER_NAME]: owner },
        ...(options.breakaway ? { breakaway: true } : {}),
      });
      if (!started.ok) throw new Error(`stub server did not start: ${started.reason}`);
      const { pid } = started;
      const exited = (): string | undefined =>
        pidAlive(pid) ? undefined : `exited early (pid ${pid})`;
      const identity = await identityOfPid(pid);
      const origin = `http://${LOOPBACK}:${port}`;
      const deadline = Date.now() + (options.startTimeoutMs ?? 15_000);
      let problem: string | undefined = hasValue(identity)
        ? undefined
        : 'absent' in identity
          ? `exited early (pid ${pid} gone before its identity was read)`
          : `identity unread: ${factReason(identity)}`;
      while (!problem) {
        // Прерывание вызывающего — посреди ожидания готовности (до 15 с на попытку), не после.
        if (signal?.aborted) problem = ABORTED;
        else if (await answersAsOwner(origin, owner)) break;
        problem ??= exited();
        if (!problem && Date.now() > deadline)
          problem = `no identity answer in ${options.startTimeoutMs ?? 15_000} ms`;
        if (!problem) await sleep(100);
      }
      if (!problem && hasValue(identity)) return { origin, port, identity: identity.value };
      failures.push(`port ${port}: ${problem ?? 'unknown'}`);
      // Личность не прочиталась при запуске — ещё одно чтение перед остановкой: снимаем по
      // номеру + старту, а не голым номером (номер мог уйти другому процессу).
      const stopAs = hasValue(identity) ? identity : await identityOfPid(pid);
      if (hasValue(stopAs))
        await stopTree(stopAs.value, {
          group: true,
          marker: { name: TREE_MARKER_NAME, value: owner },
        });
      // Личность не прочитать дважды, процесс жив: номер наш — запущен этим вызовом мгновения
      // назад и с тех пор жив; иначе сервер остался бы жить без аренды.
      else if (!('absent' in stopAs) && pidAlive(pid)) process.kill(pid);
      if (problem === ABORTED) throw new RouteAborted('stub start');
      // Ранний выход бывает и от порта, занятого между пробой и запуском: тогда новый порт.
      if (!problem?.startsWith('exited early')) break;
    }
    throw new Error(`stub server did not start: ${failures.join('; ')}`);
  }

  async function acquire(spec: RouteAcquireSpec, record: RouteRecorder): Promise<RouteLease> {
    throwIfAborted(spec, 'stub start');
    const dialect = spec.dialect ?? DIALECT_IDS[0] ?? 'anthropic-messages';
    // Диалект вне заглушки — отказ до запуска: иначе сервер поднялся бы с ссылкой, которую
    // перезапущенное ядро не прочтёт, и его освобождение стало бы утечкой живого сервера.
    if (!isStubDialect(dialect))
      throw new RouteRefused(
        'no_channel',
        `${id} speaks ${DIALECT_IDS.join(', ')}, not ${dialect}`,
      );
    const rid = newId();
    const server = await startServer(rid, spec.signal);
    let resource: RouteResource;
    try {
      throwIfAborted(spec, 'stub start');
      resource = await createResource(
        record,
        'stub-server',
        stubServerRef(server.origin, dialect, server.identity),
        releaseOf(spec),
        rid,
      );
    } catch (error) {
      // Ресурс не записан (журнал отказал) или аренда прервана — сервер никто больше не найдёт:
      // ни в аренде, ни в журнале. Снять здесь же, по личности и метке дерева (rid).
      const report = await stopTree(server.identity, {
        group: true,
        marker: { name: TREE_MARKER_NAME, value: rid },
      });
      const unproven =
        report.unknown ??
        (report.residual.length > 0
          ? `residual ${report.residual.map((p) => p.pid).join(', ')}`
          : '');
      if (!unproven) throw error;
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${why}; stub server pid ${server.identity.pid} not proven stopped: ${unproven}`,
        {
          cause: error,
        },
      );
    }
    const lease: RouteLease = {
      leaseId: newId(),
      routeId: id,
      model: spec.model,
      resources: [resource],
    };
    servers.set(lease.leaseId, { lease, rid, dialect, ...server });
    return lease;
  }

  /** Вернуться к серверу журнальной аренды (перезапущенное ядро): по ссылке ресурса, без запуска. */
  function attach(lease: RouteLease): Held | { unreadable: string } {
    const resource = lease.resources.find((r) => r.kind === 'stub-server');
    if (!resource) return { unreadable: `lease ${lease.leaseId} has no stub-server resource` };
    const parsed = parseStubServerRef(resource.ref);
    if ('unreadable' in parsed) return parsed;
    const held: Held = { lease, rid: resource.rid, ...parsed };
    servers.set(lease.leaseId, held);
    return held;
  }

  async function release(lease: RouteLease, record: RouteRecorder): Promise<ReleaseOutcome> {
    const outcome: ReleaseOutcome = { verified: [], leaks: [] };
    const resource = lease.resources.find((r) => r.kind === 'stub-server');
    if (!resource || released.has(lease.leaseId)) return outcome;
    const held = servers.get(lease.leaseId) ?? attach(lease);
    // Отметка до первого ожидания — второй одновременный вызов не снимает тот же сервер дважды.
    servers.delete(lease.leaseId);
    released.add(lease.leaseId);
    try {
      return await stopAndRecord(held, resource, record);
    } catch (error) {
      // Ни «проверено», ни утечка не записаны: аренда снова на руках, повтор сделает работу,
      // а не вернёт пустой исход, неотличимый от чистого.
      released.delete(lease.leaseId);
      if (!('unreadable' in held)) servers.set(lease.leaseId, held);
      throw error;
    }
  }

  async function stopAndRecord(
    held: Held | { unreadable: string },
    resource: RouteResource,
    record: RouteRecorder,
  ): Promise<ReleaseOutcome> {
    const outcome: ReleaseOutcome = { verified: [], leaks: [] };
    const leak = async (reason: string): Promise<ReleaseOutcome> => {
      await record.leak(resource.rid, reason);
      outcome.leaks.push({ rid: resource.rid, reason });
      return outcome;
    };
    if ('unreadable' in held) return leak(`server ref unreadable: ${held.unreadable}`);
    const report = await stopTree(held.identity, {
      group: true,
      marker: { name: TREE_MARKER_NAME, value: held.rid },
    });
    const reasons: string[] = [];
    if (report.unknown) reasons.push(`server stop unproven: ${report.unknown}`);
    else if (report.residual.length > 0)
      reasons.push(`server residual: ${report.residual.map((p) => p.pid).join(', ')}`);
    // Сверка по миру: порт снова берётся — сервер закрыт; не берётся — кто-то его держит.
    try {
      const probe = await bind(held.port);
      await probe.close();
    } catch (error) {
      reasons.push(
        `port ${held.port} still bound after close: ${(error as { code?: string }).code ?? String(error)}`,
      );
    }
    if (reasons.length > 0) return leak(reasons.join('; '));
    const count = report.targeted.length;
    const fact = `server stopped (${count} process${count === 1 ? '' : 'es'}), port ${held.port} free after close`;
    await record.verified(resource.rid, fact);
    outcome.verified.push({ rid: resource.rid, fact });
    return outcome;
  }

  async function shutdown(record: RouteRecorder): Promise<ReleaseOutcome> {
    const total: ReleaseOutcome = { verified: [], leaks: [] };
    const failures: string[] = [];
    // Отказ одного освобождения не оставляет остальные серверы жить: обходим все, потом называем.
    for (const held of [...servers.values()]) {
      try {
        const one = await release(held.lease, record);
        total.verified.push(...one.verified);
        total.leaks.push(...one.leaks);
      } catch (error) {
        failures.push(
          `${held.lease.leaseId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0)
      throw new Error(`${id}: ${failures.length} release(s) failed: ${failures.join('; ')}`);
    return total;
  }

  return {
    kind: 'stub',
    id,
    caps: STUB_CAPS,
    facts: routeFactDecls(),
    read: {
      availability: () => readFact('route.availability', () => ({ state: 'startable' as const })),
      models: () => readFact('route.models', () => models.map((model) => ({ id: model }))),
      limit: () => readFact('route.limit', () => ({ kind: 'none' as const })),
      price: () => readFact('route.price', () => ({ unit: 'none' as const })),
      credential: () =>
        readFact('route.credential', () => ({ kind: 'none' as const, present: true })),
      context: () =>
        readFact('route.context', () =>
          options.contextTokens === undefined ? absent() : options.contextTokens,
        ),
    },
    acquire,
    endpoint: async (lease, record) => {
      // Ошибка вызывающего (отпущенная или чужая аренда) — бросок; состояние мира — решение.
      if (released.has(lease.leaseId))
        throw new Error(`stub lease ${lease.leaseId} was released by ${id}`);
      if (lease.routeId !== id) throw new Error(`lease of ${lease.routeId} given to ${id}`);
      const held = servers.get(lease.leaseId) ?? attach(lease);
      const found = 'unreadable' in held ? undefined : held;
      // Мёртвый сервер — отказ, а не адрес: его номер и порт мог взять чужой процесс, туда ушли
      // бы запросы задачи (F-73). Личность — pid + старт; порт — путь личности отвечает НАШИМ rid.
      return liveEndpoint({
        lease,
        server: found
          ? `stub server pid ${found.identity.pid} start ${found.identity.start} ${found.origin}`
          : `stub lease ${lease.leaseId} (${'unreadable' in held ? held.unreadable : ''})`,
        ...(found
          ? {
              target: {
                identity: found.identity,
                endpoint: { baseUrl: found.origin, dialect: found.dialect, keyRef: null },
              },
            }
          : {}),
        isAlive: (identity, question) => probe.isAlive(identity, question),
        health: async () => {
          if (!found) return { unknown: 'no server' };
          const owner = await ownerOf(found.origin);
          if ('unknown' in owner) return owner;
          return owner.value === found.rid ? 'answers' : 'wrong';
        },
        record,
      });
    },
    release,
    shutdown,
  };
}
