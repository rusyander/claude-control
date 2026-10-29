import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coreSince, newestCore } from './main.ts';
import { coreCheck, loopbackUrl, type CoreVerifyDeps } from './core-discovery.ts';
import { createCoreClient } from './core-client.ts';
import { identityOfPid } from '../platform/process-identity.ts';
import { hasValue } from '../platform/os-kind.ts';

/**
 * core-s2 F-19: мост несёт bearer сессии только самому ядру этого дома — loopback-адрес строки,
 * дом файла, порт слушает процесс строки с тем же стартом. Иначе адреса нет.
 */

const PORT = 47_123;

function home(cores: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-discovery-'));
  const path = join(dir, 'procs.json');
  writeFileSync(path, JSON.stringify({ v: 1, cores, servers: [] }));
  return path;
}

function entry(path: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    build: 'b',
    pid: 4242,
    pidStart: 'start-4242',
    bootId: 'boot-1',
    port: PORT,
    url: `http://127.0.0.1:${PORT}`,
    startedAt: 100,
    home: join(path, '..'),
    portDecision: { rejected: [] },
    ...over,
  };
}

// Таблица TCP: порт строки слушает `listener` на loopback (нет — никто); живой процесс — `start`.
function deps(
  listener: number | undefined,
  start: string | undefined,
): CoreVerifyDeps & { asked: number } {
  const counted = {
    asked: 0,
    tcp: async () => {
      counted.asked += 1;
      const rows =
        listener === undefined
          ? []
          : [
              {
                state: 'listen' as const,
                localAddress: '127.0.0.1',
                localPort: PORT,
                remoteAddress: '0.0.0.0',
                remotePort: 0,
                pid: listener,
              },
            ];
      return { value: rows };
    },
    isAlive: async (id: { pid: number; start: string }) => {
      if (start === undefined) return 'unknown' as const;
      return id.start === start ? ('alive' as const) : ('dead' as const);
    },
  };
  return counted;
}

describe('core-s2 MCP bridge — only the core of this home gets the session bearer', () => {
  it('F-19 a non-loopback, foreign-scheme, credentialed or path URL from procs.json is never followed', async () => {
    for (const url of [
      'http://evil.example:80/',
      'https://127.0.0.1:47123',
      'http://localhost:47123',
      'http://user:pw@127.0.0.1:47123',
      'http://127.0.0.1:47124',
      'http://127.0.0.1:47123/steal',
      'http://127.0.0.1:47123/?x=1',
      'http://[::1]:47123',
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'mcp-discovery-'));
      const path = join(dir, 'procs.json');
      writeFileSync(path, JSON.stringify({ v: 1, cores: [entry(path, { url })], servers: [] }));
      expect(await newestCore(path, 'http://127.0.0.1:1')).toBeNull();
      expect(await coreSince(path, 0)).toBeNull();
    }
  });

  it('F-19 a loopback URL whose row names another home, whose port another process holds, or whose start differs → no address', async () => {
    const path = home([]);
    const own = entry(path);
    const check = (d: CoreVerifyDeps) => coreCheck(d);
    writeFileSync(
      path,
      JSON.stringify({ v: 1, cores: [{ ...own, home: '/elsewhere' }], servers: [] }),
    );
    expect(
      await newestCore(path, 'http://127.0.0.1:1', check(deps(4242, 'start-4242'))),
    ).toBeNull();
    writeFileSync(path, JSON.stringify({ v: 1, cores: [own], servers: [] }));
    expect(
      await newestCore(path, 'http://127.0.0.1:1', check(deps(9999, 'start-4242'))),
    ).toBeNull();
    expect(
      await newestCore(path, 'http://127.0.0.1:1', check(deps(undefined, 'start-4242'))),
    ).toBeNull();
    expect(await newestCore(path, 'http://127.0.0.1:1', check(deps(4242, 'other')))).toBeNull();
    expect(await coreSince(path, 0, check(deps(4242, undefined)))).toBeNull();
  });

  it('F-19 the verified core is named once and then remembered; the refused address itself is not re-named', async () => {
    const path = home([]);
    writeFileSync(path, JSON.stringify({ v: 1, cores: [entry(path)], servers: [] }));
    const d = deps(4242, 'start-4242');
    const check = coreCheck(d);
    expect(await newestCore(path, 'http://127.0.0.1:1', check)).toBe(`http://127.0.0.1:${PORT}`);
    expect(await coreSince(path, 50, check)).toBe(`http://127.0.0.1:${PORT}`);
    expect(d.asked).toBe(1);
    expect(await newestCore(path, `http://127.0.0.1:${PORT}/`, check)).toBeNull();
    expect(await coreSince(path, 100, check)).toBeNull();
  });

  // Без подмен: настоящая таблица TCP и настоящая проверка жизни (OS_VERIFY по умолчанию).
  it('F-19 real OS check: a planted row naming a foreign listener gets no address and the client sends it no bearer; the true listener is found', async () => {
    const server = createServer((s) => s.destroy());
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as AddressInfo).port;
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      const other = await identityOfPid(sleeper.pid ?? -1);
      const self = await identityOfPid(process.pid);
      if (!hasValue(other) || !hasValue(self)) throw new Error('identity unreadable');
      const path = home([]);
      const planted = entry(path, {
        port,
        url: `http://127.0.0.1:${port}`,
        pid: other.value.pid,
        pidStart: other.value.start,
      });
      writeFileSync(path, JSON.stringify({ v: 1, cores: [planted], servers: [] }));
      const sent: string[] = [];
      const client = createCoreClient({
        url: 'http://127.0.0.1:1/',
        token: 'session-bearer',
        // Окно с запасом на чтение таблицы TCP: иначе срок истёк бы раньше, чем адрес сменится.
        retryForMs: 3_000,
        stepMs: 20,
        timeoutMs: 50,
        http: async (call) => {
          sent.push(call.url);
          return call.url.startsWith('http://127.0.0.1:1/')
            ? { kind: 'unreachable', reason: 'ECONNREFUSED', refused: true }
            : { kind: 'reply', status: 200, body: {} };
        },
        rediscover: (current) => newestCore(path, current),
      });
      await client.post('/v1/session/permit', {});
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((url) => url.startsWith('http://127.0.0.1:1/'))).toBe(true);
      // Тот же порт, строка названа его настоящим владельцем — адрес находится (проверка не глуха).
      const own = { ...planted, pid: self.value.pid, pidStart: self.value.start };
      writeFileSync(path, JSON.stringify({ v: 1, cores: [own], servers: [] }));
      expect(await newestCore(path, 'http://127.0.0.1:1')).toBe(`http://127.0.0.1:${port}`);
    } finally {
      sleeper.kill();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 30_000);

  it('F-19 loopbackUrl keeps exactly http://127.0.0.1:<row port>', () => {
    expect(loopbackUrl({ url: 'http://127.0.0.1:5/', port: 5 })).toBe('http://127.0.0.1:5');
    expect(loopbackUrl({ url: 'not a url', port: 5 })).toBeNull();
    expect(loopbackUrl({ url: 'http://127.0.0.1:5#x', port: 5 })).toBeNull();
  });
});
