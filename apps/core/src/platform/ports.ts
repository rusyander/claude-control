import { createServer, type Server } from 'node:net';

/**
 * Порт ядра (00 §Processes, 09 §ports, P59): выбирается настоящей привязкой к 127.0.0.1, а не
 * пробой «свободен ли». На Windows Hyper-V/WinNAT держат исключённые диапазоны, где `connect`
 * говорит «свободно», а `bind` отказывает — поэтому порт даёт сама ОС (`bind :0`). Никогда не
 * внутри 5170–5180: там живут панель (5178) и шлюз контура (5179 по умолчанию, R:S1-04).
 * Отвергнутые кандидаты держатся открытыми до конца выбора, чтобы ОС не выдала их снова, и
 * попадают в решение — подстановка порта журналируется (01 §Facts).
 */

export const RESERVED_PORTS = { from: 5170, to: 5180 } as const;
export const LOOPBACK = '127.0.0.1';

export interface PortDecision {
  port: number;
  rejected: { port: number; reason: string }[];
}

export interface BoundProbe {
  port: number;
  close(): Promise<void>;
}

export type BindProbe = (port: number) => Promise<BoundProbe>;

export function isReserved(port: number): boolean {
  return port >= RESERVED_PORTS.from && port <= RESERVED_PORTS.to;
}

/** Настоящая привязка к loopback (без брандмауэра: только 127.0.0.1). */
export const bindLoopback: BindProbe = (port) =>
  new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: bound,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });

export async function allocatePort(
  bind: BindProbe = bindLoopback,
  maxAttempts = 32,
): Promise<PortDecision> {
  const held: BoundProbe[] = [];
  const rejected: PortDecision['rejected'] = [];
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let probe: BoundProbe;
      try {
        probe = await bind(0);
      } catch (error) {
        rejected.push({
          port: 0,
          reason: `bind failed: ${(error as { code?: string }).code ?? String(error)}`,
        });
        continue;
      }
      if (isReserved(probe.port)) {
        rejected.push({ port: probe.port, reason: 'reserved 5170-5180' });
        held.push(probe);
        continue;
      }
      await probe.close();
      return { port: probe.port, rejected };
    }
    throw new Error(
      `no port outside ${RESERVED_PORTS.from}-${RESERVED_PORTS.to} after ${maxAttempts} binds`,
    );
  } finally {
    await Promise.all(held.map((probe) => probe.close()));
  }
}

/**
 * Выбрать порт и поднять на нём слушателя. Между закрытием пробы и `listen` порт мог занять
 * чужой процесс — тогда новый выбор, а прежний порт уходит в отвергнутые с причиной.
 */
export async function listenOnAllocatedPort(
  listen: (port: number) => Promise<void>,
  bind: BindProbe = bindLoopback,
  maxRounds = 5,
): Promise<PortDecision> {
  const rejected: PortDecision['rejected'] = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const decision = await allocatePort(bind);
    rejected.push(...decision.rejected);
    try {
      await listen(decision.port);
      return { port: decision.port, rejected };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
      rejected.push({ port: decision.port, reason: `listen ${code}` });
    }
  }
  throw new Error('core could not listen on an allocated port');
}
