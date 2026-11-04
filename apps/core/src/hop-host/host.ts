import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { newId } from '../lib/ids/uuidv7.ts';
import { layoutOf } from '../platform/core-home.ts';
import { acquireExclusive, releaseExclusive, type LockHolder } from '../platform/exclusive-lock.ts';
import { hasValue, factReason } from '../platform/os-kind.ts';
import { allocatePort, isReserved, LOOPBACK } from '../platform/ports.ts';
import { createLivenessProbe, identityOfPid } from '../platform/process-identity.ts';
import { registerServer, unregisterServer } from '../platform/procs-file.ts';
import { ensureTokenFile } from '../platform/token-file.ts';
import { rulesFrom, type HopContext } from './context.ts';
import { CONTOUR_SPEND_FILE, ContourBook } from './contour-book/contour-book.ts';
import { panelContours } from './contour-book/panel-state.ts';
import { adoptPanelSummarized } from './gateway/summarized-ledger/summarized-ledger.ts';
import { handleControlRequest } from './control.ts';
import { handleDlpRequest } from './dlp/dlp-hop.ts';
import { handleGatewayRequest } from './gateway/handler.ts';
import { readJsonFile, writeJsonFile } from './gateway/json-file.ts';
import { ThinkTailModels } from './gateway/think-models.ts';
import type { HopHostConfig, HopPorts, PortSubstitution } from './host.types.ts';
import { respondJson } from './http.ts';
import { createKeySource } from './keys.ts';
import { hopLayoutOf } from './paths.ts';
import { SpendBook, type PriceOf } from './spend.ts';
import { TagRegistry } from './tags.ts';
import { HopTrace } from './trace.ts';
import { UPSTREAM_RETRY_PAUSE_MS } from './upstream.ts';
import { startDlpProxy, type DlpProxy } from './dlp-proxy/dlp-proxy.ts';
import { startUserGateway, type UserGateway } from './user-gateway/user-gateway.ts';

/**
 * Хост звеньев (11 §Hop chain, план §2 H): отдельный процесс, один на дом ядра. Держит три
 * слушателя на loopback — управление, DLP-звено, шлюз — и переживает ядро и панель: сеанс CLI
 * ходит в звено, а не в ядро, поэтому убитое посреди запроса ядро ответа не обрывает (P123).
 *
 * Единственность — замок `hops/host.lock` (держатель мёртв ⇒ замок свободен сразу): второй
 * хост на тот же дом значил бы второго писателя `spend/` (G2). Порты записаны в
 * `hops/ports.json` и после перезапуска берутся ТЕ ЖЕ — у живого сеанса CLI адрес звена уже
 * в окружении; занятый порт заменяется новым и называется подстановкой.
 */

export const DEFAULT_STALL_MS = 120_000;
export const DEFAULT_FLUSH_MS = 1_000;

export interface HopHostDeps {
  price?: PriceOf;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RunningHopHost {
  ports: HopPorts;
  substitutions: PortSubstitution[];
  ctx: HopContext;
  close(): Promise<void>;
}

export class HopHostBusy extends Error {
  constructor(reason: string) {
    super(`hop host already running for this home: ${reason}`);
  }
}

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

function serve(handler: Handler): Server {
  return createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      // Брошенное ручкой не роняет хост: другие сеансы идут через него же.
      if (!response.headersSent) respondJson(response, 500, { error: { message: String(error) } });
      else response.destroy();
    });
  });
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * Записанный порт — если свободен и вне 5170-5180; иначе новый от ОС (с отказом от
 * запретного диапазона) и строка подстановки.
 */
async function bindKept(
  server: Server,
  listener: keyof HopPorts,
  recorded: number | undefined,
  substitutions: PortSubstitution[],
): Promise<number> {
  if (recorded !== undefined && !isReserved(recorded)) {
    try {
      return await listenOn(server, recorded);
    } catch (error) {
      const reason = (error as { code?: string }).code ?? String(error);
      const actual = await bindFresh(server);
      substitutions.push({ listener, recorded, actual, reason });
      return actual;
    }
  }
  const actual = await bindFresh(server);
  if (recorded !== undefined)
    substitutions.push({ listener, recorded, actual, reason: 'reserved 5170-5180' });
  return actual;
}

async function bindFresh(server: Server): Promise<number> {
  let last = 'no attempt';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { port } = await allocatePort();
    try {
      return await listenOn(server, port);
    } catch (error) {
      // Порт заняли между пробой и привязкой — следующий от ОС.
      last = (error as { code?: string }).code ?? String(error);
    }
  }
  throw new Error(`hop host: no loopback port (${last})`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export async function startHopHost(
  config: HopHostConfig,
  deps: HopHostDeps = {},
): Promise<RunningHopHost> {
  const layout = hopLayoutOf(config.home);
  mkdirSync(layout.dir, { recursive: true });
  mkdirSync(layout.spendDir, { recursive: true });
  const now = deps.now ?? Date.now;
  const self = await identityOfPid(process.pid);
  if (!hasValue(self)) throw new Error(`hop host identity: ${factReason(self)}`);
  const probe = createLivenessProbe();
  const me: LockHolder = {
    leaseId: newId(),
    pid: process.pid,
    pidStart: self.value.start,
    bootId: config.ownerBootId ?? 'hop-host',
    build: 'hop-host',
    acquiredAt: now(),
  };
  const isAlive = (id: { pid: number; start: string }) => probe.isAlive(id);
  const lock = await acquireExclusive(layout.lock, me, { isAlive, isSilent: () => true, now });
  if (!lock.acquired) throw new HopHostBusy(lock.reason);

  const servers: Server[] = [];
  let flushTimer: NodeJS.Timeout | undefined;
  let registered = false;
  let userGateway: UserGateway | undefined;
  let dlpProxy: DlpProxy | undefined;
  const procs = layoutOf(config.home).procs;
  const procsDeps = { isAlive, me };
  try {
    const token = ensureTokenFile(layout.token).token;
    const stateDir = layout.dir;
    adoptPanelSummarized(stateDir, config.panelAppData ?? undefined);
    const ctx: HopContext = {
      tags: new TagRegistry(layout.tags),
      spend: new SpendBook(layout.spendDir, layout.exhausted, deps.price),
      contours: new ContourBook(
        join(stateDir, CONTOUR_SPEND_FILE),
        panelContours(config.panelAppData ?? undefined),
        now(),
      ),
      trace: new HopTrace(layout.trace),
      keys: createKeySource(config.panelAppData ?? undefined),
      rules: rulesFrom(config.panelAppData ?? undefined),
      language: config.language ?? 'ru',
      stallMs: config.stallMs ?? DEFAULT_STALL_MS,
      retryPauseMs: config.retryPauseMs ?? UPSTREAM_RETRY_PAUSE_MS,
      stateDir,
      thinkTail: new ThinkTailModels(stateDir),
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    };
    let recorded: Partial<HopPorts> = {};
    try {
      recorded = readJsonFile<Partial<HopPorts>>(layout.ports, {});
    } catch {
      recorded = {};
    }
    const substitutions: PortSubstitution[] = [];
    const ports = { control: 0, dlp: 0, gateway: 0 } as HopPorts;
    userGateway = startUserGateway({ ctx });
    dlpProxy = startDlpProxy({
      panelAppData: config.panelAppData ?? null,
      language: ctx.language,
      now,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const controlDeps = {
      ctx,
      token,
      ports,
      substitutions,
      pid: process.pid,
      panelAppData: config.panelAppData ?? null,
      userGateway,
      dlpProxy,
    };
    const handlers: Record<keyof HopPorts, Handler> = {
      control: (request, response) => handleControlRequest(controlDeps, request, response),
      dlp: (request, response) => handleDlpRequest(ctx, request, response),
      gateway: (request, response) => handleGatewayRequest(ctx, request, response),
    };
    for (const listener of ['control', 'dlp', 'gateway'] as const) {
      const server = serve(handlers[listener]);
      servers.push(server);
      const want = recorded[listener];
      ports[listener] = await bindKept(
        server,
        listener,
        typeof want === 'number' ? want : undefined,
        substitutions,
      );
    }
    writeJsonFile(layout.ports, ports);
    await registerServer(
      procs,
      {
        kind: 'hop-host',
        id: 'hop-host',
        pid: process.pid,
        pidStart: self.value.start,
        port: ports.control,
        ownerBootId: me.bootId,
        startedAt: now(),
        dlpPort: ports.dlp,
        gatewayPort: ports.gateway,
      },
      procsDeps,
    );
    registered = true;
    flushTimer = setInterval(() => {
      ctx.spend.flush();
      ctx.contours.flush();
    }, config.flushMs ?? DEFAULT_FLUSH_MS);
    flushTimer.unref();

    let closed: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closed ??= (async () => {
        clearInterval(flushTimer);
        ctx.spend.flush();
        ctx.contours.flush();
        await userGateway?.stop();
        await dlpProxy?.stop();
        await Promise.all(servers.map(closeServer));
        await unregisterServer(
          procs,
          { kind: 'hop-host', id: 'hop-host', pid: process.pid },
          procsDeps,
        ).catch(() => undefined);
        ctx.trace.close();
        releaseExclusive(layout.lock, me.leaseId);
      })());
    return { ports, substitutions, ctx, close };
  } catch (error) {
    clearInterval(flushTimer);
    await userGateway?.stop();
    await dlpProxy?.stop();
    await Promise.all(servers.filter((s) => s.listening).map(closeServer));
    if (registered)
      await unregisterServer(
        procs,
        { kind: 'hop-host', id: 'hop-host', pid: process.pid },
        procsDeps,
      ).catch(() => undefined);
    releaseExclusive(layout.lock, me.leaseId);
    throw error;
  }
}
